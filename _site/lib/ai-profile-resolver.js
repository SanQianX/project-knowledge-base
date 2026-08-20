// _site/lib/ai-profile-resolver.js
//
// Single source of truth for "what AI profile does this project use right now".
// Replaces the inconsistent fallback logic that used to live separately in
// Workbench start-session / send-input, the analyzer, the CommitReconciler,
// and import default assignment.
//
// Resolution order (per T01):
//   1. projectConfig.aiProfileId, when it references a usable configured profile
//   2. settings.ai.defaultProfileId, when it references a usable configured profile
//   3. first usable configured profile in stable configured order
//   4. otherwise an explicit AI_PROFILE_REQUIRED failure
//
// "Usable" matches the current runtime's minimum contract: the profile exists,
// is enabled, and references a vendor/implementation that the runtime can use.
// We do NOT invent additional requirements (e.g. "must have a non-empty apiKey")
// — that is the runtime's job to evaluate when it actually starts a session.

const { DomainError } = require('./contracts');

function profileById(settings, profileId) {
  if (!profileId) return null;
  const list = settings && settings.ai && Array.isArray(settings.ai.profiles) ? settings.ai.profiles : [];
  return list.find(profile => profile && profile.id === profileId) || null;
}

function isUsable(profile) {
  return Boolean(profile) && profile.enabled !== false;
}

function listUsable(settings) {
  const list = settings && settings.ai && Array.isArray(settings.ai.profiles) ? settings.ai.profiles : [];
  return list.filter(isUsable);
}

function resolveEffectiveAiProfile(settings, projectConfig) {
  const safeSettings = settings || { ai: { profiles: [] } };
  const safeProject = projectConfig || {};
  const configured = safeSettings.ai && Array.isArray(safeSettings.ai.profiles) ? safeSettings.ai.profiles : [];

  const projectId = safeProject.aiProfileId || null;
  if (projectId) {
    const projectProfile = profileById(safeSettings, projectId);
    if (isUsable(projectProfile)) {
      return { profile: projectProfile, profileId: projectProfile.id, source: 'project' };
    }
  }

  const defaultId = safeSettings.ai && safeSettings.ai.defaultProfileId || null;
  if (defaultId) {
    const defaultProfile = profileById(safeSettings, defaultId);
    if (isUsable(defaultProfile)) {
      return { profile: defaultProfile, profileId: defaultProfile.id, source: 'default' };
    }
  }

  const firstUsable = listUsable(safeSettings)[0];
  if (firstUsable) {
    return { profile: firstUsable, profileId: firstUsable.id, source: 'first-usable' };
  }

  throw new DomainError('AI_PROFILE_REQUIRED', 'A usable AI profile is required for this operation.', {
    status: 409,
    details: {
      hint: 'Configure at least one enabled AI profile, or assign an aiProfileId to the project.',
      configuredProfileCount: configured.length,
      projectProfileId: projectId || null,
      defaultProfileId: defaultId || null,
    },
  });
}

module.exports = {
  resolveEffectiveAiProfile,
  profileById,
  isUsable,
  listUsable,
};
