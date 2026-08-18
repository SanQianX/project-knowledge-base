const { DomainError } = require('./contracts');

async function recordEmbeddedClaudeInput(options = {}) {
  if (!options.recorder || typeof options.recorder.recordRequirement !== 'function') {
    throw new DomainError('INVALID_ARGUMENT', 'A RequirementRecorder is required.');
  }
  if (typeof options.sendInput !== 'function') {
    throw new DomainError('INVALID_ARGUMENT', 'A sendInput function is required.');
  }
  const session = options.session && typeof options.session === 'object' ? options.session : {};
  const requirement = await options.recorder.recordRequirement({
    projectId: options.projectId || session.projectId,
    repoPath: options.repoPath || session.projectPath,
    client: 'claude',
    sessionId: options.sessionId || session.sessionId,
    conversationId: options.conversationId || session.claudeSessionId || null,
    text: options.text,
    explicitCommit: options.explicitCommit || null,
    operationId: options.operationId,
  });
  if (typeof options.onRecorded === 'function') await options.onRecorded(requirement);
  const result = await options.sendInput(options.text, { requirementId: requirement.id });
  return { requirementId: requirement.id, requirementHash: requirement.requirementHash, turnId: requirement.turnId || null, result };
}

function createRequirementMetadataAdapter(recorder, client) {
  if (!recorder || typeof recorder.recordRequirement !== 'function') {
    throw new DomainError('INVALID_ARGUMENT', 'A RequirementRecorder is required.');
  }
  return input => recorder.recordRequirement({ ...input, client });
}

module.exports = { recordEmbeddedClaudeInput, createRequirementMetadataAdapter };
