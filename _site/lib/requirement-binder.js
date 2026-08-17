const { SCHEMAS, DomainError, validateProjectId } = require('./contracts');
const { StorageLayout } = require('./storage-layout');
const { ProjectRegistryStore } = require('./project-registry-store');
const { ProjectStore } = require('./project-store');
const { GitReader, normalizeClient, normalizeCommit } = require('./requirement-recorder');

function unavailable(reason) {
  return { requirementIds: [], requirementBinding: 'unavailable', reason };
}

class RequirementBinder {
  constructor(options = {}) {
    this.layout = options.layout || new StorageLayout(options);
    this.projectStore = options.projectStore || new ProjectStore({ layout: this.layout });
    this.registryStore = options.registryStore || new ProjectRegistryStore({ layout: this.layout });
    this.gitReader = options.gitReader || new GitReader();
  }

  findRequirement(requirementId) {
    const id = String(requirementId || '').trim();
    if (!id) throw new DomainError('INVALID_ARGUMENT', 'requirementId is required.');
    const matches = [];
    for (const projectId of this.registryStore.listIds()) {
      const record = this.projectStore.readRequirements(projectId).find(item => item.id === id);
      if (record) matches.push(record);
    }
    if (matches.length !== 1) {
      throw new DomainError('INVALID_ARGUMENT', matches.length ? 'requirementId is not unique.' : 'requirementId was not found.');
    }
    return matches[0];
  }

  frozenClaim(input, projectId, commitSha) {
    const claim = input.claim || input.existingClaim;
    if (!claim) return null;
    if (claim.schema !== SCHEMAS.commitClaim || normalizeCommit(claim.commitSha) !== commitSha) {
      throw new DomainError('INVALID_ARGUMENT', 'Existing claim does not match the requested commit.');
    }
    if (claim.projectId && claim.projectId !== projectId) {
      throw new DomainError('INVALID_ARGUMENT', 'Existing claim belongs to a different project.');
    }
    return {
      requirementIds: Array.isArray(claim.requirementIds) ? [...claim.requirementIds] : [],
      requirementBinding: claim.requirementBinding || 'unavailable',
      reason: 'frozen-claim',
      frozen: true,
    };
  }

  async bind(input = {}) {
    const projectId = validateProjectId(input.projectId);
    const commitSha = normalizeCommit(input.commitSha, 'commitSha');
    if (!commitSha) throw new DomainError('INVALID_ARGUMENT', 'commitSha is required.');
    const frozen = this.frozenClaim(input, projectId, commitSha);
    if (frozen) return frozen;

    const config = this.projectStore.readConfig(projectId);
    const explicitIds = [...new Set([
      ...(Array.isArray(input.requirementIds) ? input.requirementIds : []),
      ...(input.requirementId ? [input.requirementId] : []),
    ].map(value => String(value || '').trim()).filter(Boolean))];
    if (explicitIds.length) {
      const records = explicitIds.map(id => this.findRequirement(id));
      if (records.some(record => record.projectId !== projectId)) {
        throw new DomainError('INVALID_ARGUMENT', 'Explicit requirementId belongs to a different project.');
      }
      return { requirementIds: records.map(record => record.id), requirementBinding: 'explicit', reason: 'explicit-requirement-id' };
    }

    const allRecords = this.projectStore.readRequirements(projectId);
    const explicitlyCommitted = allRecords.filter(record => record.explicitCommit === commitSha);
    if (explicitlyCommitted.length) {
      return {
        requirementIds: explicitlyCommitted.map(record => record.id),
        requirementBinding: 'explicit',
        reason: 'explicit-commit',
      };
    }

    if (!input.branch) return unavailable('commit-branch-unavailable');
    const branch = String(input.branch);
    const claimed = new Set(Array.isArray(input.claimedRequirementIds) ? input.claimedRequirementIds : []);
    const requestedClient = input.client ? normalizeClient(input.client) : '';
    const requestedSession = input.sessionId ? String(input.sessionId).trim() : '';
    const candidates = [];
    for (const record of allRecords) {
      if (claimed.has(record.id) || !record.headAtRecord || record.branch !== branch) continue;
      if (requestedClient && record.client !== requestedClient) continue;
      if (requestedSession && record.sessionId !== requestedSession) continue;
      let ancestor = false;
      try { ancestor = await this.gitReader.isAncestor(config.repoPath, record.headAtRecord, commitSha); } catch { ancestor = false; }
      if (ancestor) candidates.push(record);
    }
    if (!candidates.length) return unavailable('no-reliable-requirement');

    const groups = new Map();
    for (const record of candidates) {
      const key = `${record.client}\u0000${record.sessionId}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(record);
    }
    if (groups.size !== 1) return unavailable('ambiguous-sessions');
    const sequence = [...groups.values()][0].sort((left, right) => String(left.ts).localeCompare(String(right.ts)) || left.id.localeCompare(right.id));
    return {
      requirementIds: sequence.map(record => record.id),
      requirementBinding: 'session-ancestry',
      reason: 'unique-session-ancestry',
    };
  }
}

module.exports = { RequirementBinder, unavailable };
