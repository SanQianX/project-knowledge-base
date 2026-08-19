const fs = require('fs');
const path = require('path');
const { validateProjectId } = require('./contracts');
const AtomicFile = require('./atomic-file');

const EXCLUSION_SCHEMA = 'conversation-exclusions/v1';
const EMBEDDED_ASSISTANT_PREFIX = 'embedded-assistant-';
const EXPLICIT_PREFIX = 'explicit-';

/**
 * T17: legacy embedded Workbench capture exclusion.
 *
 * Old builds wrote internal Workbench conversations into Development
 * Conversation as `explicit-<requirementId>` + `embedded-assistant-<requirementId>`
 * pairs (rawEventType embedded-claude-result). Those events are excluded from
 * Development Conversation presentation and from NEW commit binding. Nothing
 * is deleted: the JSONL lines stay, immutable snapshots stay untouched, and a
 * manifest is persisted for auditability. A genuine explicit MCP requirement
 * (no embedded-assistant pair) is never excluded.
 */
function isEmbeddedAssistantEvent(event) {
  if (!event) return false;
  return String(event.eventId || '').startsWith(EMBEDDED_ASSISTANT_PREFIX)
    || event.rawEventType === 'embedded-claude-result';
}

function computeConversationExclusions(projectId, events) {
  validateProjectId(projectId);
  const paired = new Set();
  for (const event of events || []) {
    const eventId = String((event && event.eventId) || '');
    if (eventId.startsWith(EMBEDDED_ASSISTANT_PREFIX)) {
      paired.add(eventId.slice(EMBEDDED_ASSISTANT_PREFIX.length));
    }
  }
  const excludedEventIds = [];
  for (const event of events || []) {
    if (!event) continue;
    const eventId = String(event.eventId || '');
    if (isEmbeddedAssistantEvent(event)) {
      excludedEventIds.push(eventId);
      continue;
    }
    if (eventId.startsWith(EXPLICIT_PREFIX) && paired.has(eventId.slice(EXPLICIT_PREFIX.length))) {
      excludedEventIds.push(eventId);
    }
  }
  return {
    schema: EXCLUSION_SCHEMA,
    projectId,
    excludedEventIds: [...new Set(excludedEventIds)].sort(),
    generatedAt: new Date().toISOString(),
  };
}

function manifestPath(layout, projectId) {
  return path.join(layout.getProjectMetadataDir(projectId), 'conversation-exclusions.json');
}

function readManifest(layout, projectId) {
  try {
    return AtomicFile.readJsonStrict(manifestPath(layout, projectId), {
      category: 'conversation-exclusions',
      validate: value => value,
    });
  } catch {
    return null;
  }
}

/**
 * Single source of truth for Development Conversation reads: applies the
 * legacy embedded-Workbench exclusion once, for both the Conversation
 * Explorer query service and new CommitConversationBinder runs. The manifest
 * is refreshed idempotently (best effort) so operators can audit what is
 * excluded; read failures never break the read itself.
 */
function readDevelopmentEvents(conversationStore, projectId) {
  const events = conversationStore.readEvents(projectId);
  const manifest = computeConversationExclusions(projectId, events);
  if (manifest.excludedEventIds.length) {
    try {
      const layout = conversationStore.layout;
      const dir = layout.getProjectMetadataDir(projectId);
      fs.mkdirSync(dir, { recursive: true });
      const previous = readManifest(layout, projectId);
      const unchanged = previous
        && Array.isArray(previous.excludedEventIds)
        && previous.excludedEventIds.length === manifest.excludedEventIds.length
        && previous.excludedEventIds.every((id, index) => id === manifest.excludedEventIds[index]);
      if (!unchanged) {
        (conversationStore.atomic || AtomicFile).writeJsonAtomic(manifestPath(layout, projectId), manifest);
      }
    } catch {
      // Manifest persistence is best effort; exclusion itself is computed
      // deterministically from the durable events on every read.
    }
  }
  if (!manifest.excludedEventIds.length) return events;
  const excluded = new Set(manifest.excludedEventIds);
  return events.filter(event => !excluded.has(String(event.eventId || '')));
}

module.exports = {
  EXCLUSION_SCHEMA,
  isEmbeddedAssistantEvent,
  computeConversationExclusions,
  readDevelopmentEvents,
};
