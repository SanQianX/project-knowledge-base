const { DomainError } = require('./contracts');

function createRequirementMetadataAdapter(recorder, client) {
  if (!recorder || typeof recorder.recordRequirement !== 'function') {
    throw new DomainError('INVALID_ARGUMENT', 'A RequirementRecorder is required.');
  }
  return input => recorder.recordRequirement({ ...input, client });
}

module.exports = { createRequirementMetadataAdapter };
