const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  SCHEMAS,
  FIELD_LIMITS,
  DomainError,
  createId,
  validateProjectId,
} = require('./contracts');
const { StorageLayout } = require('./storage-layout');
const { ProjectRegistryStore } = require('./project-registry-store');
const { ProjectStore } = require('./project-store');

const REQUIREMENT_CLIENTS = Object.freeze(['claude', 'codex', 'opencode']);
const CLIENT_ALIASES = Object.freeze({
  'claude-code': 'claude',
  claudecode: 'claude',
  'codex-cli': 'codex',
});

function requiredMetadata(value, name, maxLength = 512) {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new DomainError('INVALID_ARGUMENT', `${name} must be a non-empty identifier no longer than ${maxLength} characters.`);
  }
  return normalized;
}

function optionalMetadata(value, name, maxLength = 512) {
  if (value == null || value === '') return null;
  return requiredMetadata(value, name, maxLength);
}

function normalizeClient(client) {
  const raw = String(client || '').trim().toLowerCase();
  const normalized = CLIENT_ALIASES[raw] || raw;
  if (!REQUIREMENT_CLIENTS.includes(normalized)) {
    throw new DomainError('INVALID_ARGUMENT', `client must be one of: ${REQUIREMENT_CLIENTS.join(', ')}.`);
  }
  return normalized;
}

function normalizeCommit(value, name = 'commit') {
  if (value == null || value === '') return null;
  const normalized = String(value).trim().toLowerCase();
  if (!/^[0-9a-f]{7,64}$/.test(normalized)) {
    throw new DomainError('INVALID_ARGUMENT', `${name} must be a Git object id.`);
  }
  return normalized;
}

function requirementHash(text) {
  return `sha256:${crypto.createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

class GitReader {
  run(repoPath, args) {
    return spawnSync('git', ['-C', path.resolve(repoPath), ...args], {
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
  }

  resolveRoot(candidate) {
    const resolved = path.resolve(candidate || process.cwd());
    const gitCwd = fs.existsSync(resolved) && fs.statSync(resolved).isFile() ? path.dirname(resolved) : resolved;
    const result = this.run(gitCwd, ['rev-parse', '--show-toplevel']);
    const root = String(result.stdout || '').trim();
    if (result.status !== 0 || !root) {
      throw new DomainError('INVALID_ARGUMENT', 'repoPath must resolve to a Git worktree.');
    }
    return path.resolve(root);
  }

  currentContext(repoPath) {
    try {
      const headResult = this.run(repoPath, ['rev-parse', '--verify', 'HEAD']);
      const head = headResult.status === 0 ? normalizeCommit(String(headResult.stdout || '').trim(), 'HEAD') : null;
      const branchResult = this.run(repoPath, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
      const branch = branchResult.status === 0
        ? optionalMetadata(String(branchResult.stdout || '').trim(), 'branch', 1024)
        : null;
      return { headAtRecord: head, branch };
    } catch {
      return { headAtRecord: null, branch: null };
    }
  }

  isAncestor(repoPath, ancestor, commit) {
    const left = normalizeCommit(ancestor, 'ancestor');
    const right = normalizeCommit(commit, 'commit');
    if (!left || !right) return false;
    return this.run(repoPath, ['merge-base', '--is-ancestor', left, right]).status === 0;
  }
}

class ProjectRequirementResolver {
  constructor(options = {}) {
    this.layout = options.layout || new StorageLayout(options);
    this.registryStore = options.registryStore || new ProjectRegistryStore({ layout: this.layout });
    this.projectStore = options.projectStore || new ProjectStore({ layout: this.layout });
    this.gitReader = options.gitReader || new GitReader();
  }

  resolve(input = {}) {
    const explicitProjectId = input.projectId ? validateProjectId(input.projectId) : '';
    const registry = this.registryStore.read({ allowMissing: true });
    if (explicitProjectId) {
      if (!registry.projects[explicitProjectId]) {
        throw new DomainError('PROJECT_NOT_FOUND', 'The explicit projectId is not registered.', { status: 404 });
      }
      const config = this.projectStore.readConfig(explicitProjectId);
      if (config.enabled === false) throw new DomainError('PROJECT_NOT_FOUND', 'The explicit project is disabled.', { status: 404 });
      if (input.repoPath) {
        const root = this.gitReader.resolveRoot(input.repoPath);
        if (!this.layout.pathsEqual(root, config.repoPath)) {
          throw new DomainError('PROJECT_NOT_FOUND', 'repoPath does not match the explicit projectId.', { status: 404 });
        }
      }
      return { projectId: explicitProjectId, config };
    }

    const root = this.gitReader.resolveRoot(input.repoPath || process.cwd());
    const matches = registry.projectOrder.filter(projectId => {
      const config = this.projectStore.readConfig(projectId);
      return config.enabled !== false && this.layout.pathsEqual(config.repoPath, root);
    });
    if (matches.length === 0) {
      throw new DomainError('PROJECT_NOT_FOUND', 'No enabled project is registered for the current Git root.', { status: 404 });
    }
    if (matches.length > 1) {
      throw new DomainError('PROJECT_AMBIGUOUS', 'Multiple projects are registered for the current Git root.', { status: 409 });
    }
    const projectId = matches[0];
    return { projectId, config: this.projectStore.readConfig(projectId) };
  }
}

class RequirementRecorder {
  constructor(options = {}) {
    this.layout = options.layout || new StorageLayout(options);
    this.projectStore = options.projectStore || new ProjectStore({ layout: this.layout });
    this.gitReader = options.gitReader || new GitReader();
    this.resolver = options.resolver || new ProjectRequirementResolver({
      layout: this.layout,
      projectStore: this.projectStore,
      registryStore: options.registryStore,
      gitReader: this.gitReader,
    });
    this.logger = options.logger || null;
    this.now = options.now || (() => new Date().toISOString());
    this.createRequirementId = options.createRequirementId || (() => createId('req'));
  }

  async recordRequirement(input = {}) {
    const operationId = input.operationId || createId('op');
    try {
      const text = typeof input.text === 'string'
        ? input.text
        : typeof input.requirement === 'string' ? input.requirement : '';
      if (!text.trim()) throw new DomainError('INVALID_ARGUMENT', 'Requirement text must be non-empty.', { operationId });
      if (text.length > FIELD_LIMITS.requirement) {
        throw new DomainError('INVALID_ARGUMENT', `Requirement text exceeds ${FIELD_LIMITS.requirement} characters.`, { operationId });
      }
      const client = normalizeClient(input.client);
      const sessionId = requiredMetadata(input.sessionId, 'sessionId');
      const conversationId = optionalMetadata(input.conversationId, 'conversationId');
      const explicitCommit = normalizeCommit(input.explicitCommit, 'explicitCommit');
      const resolved = this.resolver.resolve(input);
      const gitContext = this.gitReader.currentContext(resolved.config.repoPath);
      const record = {
        schema: SCHEMAS.requirement,
        id: this.createRequirementId(),
        ts: this.now(),
        projectId: resolved.projectId,
        client,
        sessionId,
        conversationId,
        branch: gitContext.branch || null,
        headAtRecord: gitContext.headAtRecord || null,
        requirement: text,
        requirementHash: requirementHash(text),
        explicitCommit,
      };
      await this.projectStore.appendRequirement(resolved.projectId, record);
      if (this.logger && typeof this.logger.info === 'function') {
        await this.logger.info('requirement.recorded', 'User requirement recorded.', {
          operationId,
          projectId: resolved.projectId,
          requirementId: record.id,
          client,
          sessionId,
          requirementHash: record.requirementHash,
        });
      }
      return record;
    } catch (error) {
      if (error instanceof DomainError) {
        if (!error.operationId) error.operationId = operationId;
        throw error;
      }
      throw new DomainError('INVALID_ARGUMENT', 'Requirement could not be recorded durably.', {
        status: 500,
        retryable: true,
        operationId,
        cause: error,
      });
    }
  }
}

module.exports = {
  REQUIREMENT_CLIENTS,
  GitReader,
  ProjectRequirementResolver,
  RequirementRecorder,
  normalizeClient,
  normalizeCommit,
  requirementHash,
};
