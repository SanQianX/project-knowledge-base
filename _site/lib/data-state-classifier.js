const fs = require('fs');
const path = require('path');
const { SCHEMAS } = require('./contracts');
const { LEGACY_ASSETS, assetPath } = require('./legacy-data-manifest');

const STATES = Object.freeze({ FRESH: 'FRESH', LEGACY: 'LEGACY', V2_VALID: 'V2_VALID', MIGRATION_INCOMPLETE: 'MIGRATION_INCOMPLETE', CONFLICT: 'CONFLICT', CORRUPT: 'CORRUPT' });

function readJson(filePath) {
  if (!fs.existsSync(filePath)) return { exists: false, value: null };
  try { const raw = fs.readFileSync(filePath, 'utf8'); return { exists: true, value: JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw) }; }
  catch (error) { return { exists: true, error }; }
}
function isEmptyJson(value) {
  if (value == null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.length === 0;
  if (value.schema === SCHEMAS.projectRegistry) return Array.isArray(value.projectOrder) && value.projectOrder.length === 0;
  return Object.keys(value).length === 0;
}
function hasRecovery(root) { const recovery = path.join(root, 'recovery'); return fs.existsSync(recovery) && fs.statSync(recovery).isDirectory() && fs.readdirSync(recovery).length > 0; }
function classifyDataState(root) {
  const projects = readJson(path.join(root, 'projects.json'));
  const settings = readJson(path.join(root, 'settings.json'));
  if (projects.error || settings.error) return { state: STATES.CORRUPT, projects, settings };
  // Logs and hook diagnostics can be created before startup classification;
  // alone they are not user configuration evidence and must not turn a clean
  // install into an impossible legacy migration.
  const hasLegacyAssets = LEGACY_ASSETS.some(asset => asset.authority !== 'history' && fs.existsSync(assetPath(root, asset)));
  const isV2 = projects.value && projects.value.schema === SCHEMAS.projectRegistry && projects.value.schemaVersion === 2;
  const settingsV2 = settings.value && settings.value.schema === SCHEMAS.settings && settings.value.schemaVersion === 2;
  if (isV2 && settingsV2) return { state: STATES.V2_VALID, projects, settings, hasLegacyAssets };
  // A failed migration may have written default v2 settings before activation.
  // A non-v2 projects registry remains authoritative legacy evidence and is
  // eligible for a controlled retry; it must never be classified as Fresh.
  if (projects.exists && !isV2 && hasLegacyAssets) return { state: STATES.LEGACY, projects, settings, hasLegacyAssets };
  if (isV2 || settingsV2 || hasRecovery(root)) return { state: STATES.MIGRATION_INCOMPLETE, projects, settings, hasLegacyAssets };
  if (hasLegacyAssets) return { state: STATES.LEGACY, projects, settings, hasLegacyAssets };
  return { state: STATES.FRESH, projects, settings, hasLegacyAssets };
}

module.exports = { STATES, readJson, isEmptyJson, classifyDataState };
