'use strict';
// User intent for external agent integrations.
//
// The install state alone cannot distinguish "broken, should heal" from
// "deliberately removed, must stay away": both look like hooks-absent. This
// store records the user's switch position per client so the startup repair
// event only ever touches clients the user actually connected.

const fs = require('fs');
const path = require('path');

const SCHEMA = 'project-knowledge/integration-intent/v1';
const FILENAME = 'integration-intent.json';
const STATES = new Set(['connected', 'disconnected']);

function intentPath(dataDir) {
  return path.join(path.resolve(dataDir), FILENAME);
}

function normalize(value) {
  if (!value || typeof value !== 'object' || value.schema !== SCHEMA) return null;
  const clients = {};
  for (const [client, state] of Object.entries(value.clients || {})) {
    if (STATES.has(state)) clients[client] = state;
  }
  return { schema: SCHEMA, clients };
}

function readIntent(dataDir) {
  try {
    return normalize(JSON.parse(fs.readFileSync(intentPath(dataDir), 'utf-8')));
  } catch {
    return null;
  }
}

function writeIntent(dataDir, clients) {
  const target = intentPath(dataDir);
  const temp = `${target}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(temp, JSON.stringify({ schema: SCHEMA, clients }, null, 2) + '\n', 'utf-8');
  try {
    fs.renameSync(temp, target);
  } catch {
    // Windows cannot always rename over an existing file.
    try { fs.unlinkSync(target); } catch {}
    fs.renameSync(temp, target);
  }
  return { schema: SCHEMA, clients };
}

function markIntent(dataDir, client, state) {
  if (!STATES.has(state)) throw new Error(`invalid integration intent state: ${state}`);
  const current = readIntent(dataDir);
  const clients = { ...(current?.clients || {}), [client]: state };
  return writeIntent(dataDir, clients);
}

// Migration: fill entries only for clients the file has never seen. A client
// whose hooks are already installed counts as connected (standalone install
// or pre-upgrade state); absent hooks count as disconnected — the store is
// never allowed to rewrite a decision the user already made.
function bootstrapIntent(dataDir, clientsStatus) {
  const current = readIntent(dataDir);
  const clients = { ...(current?.clients || {}) };
  let changed = false;
  for (const entry of clientsStatus || []) {
    if (!entry || !entry.client || entry.client in clients) continue;
    clients[entry.client] = entry.developmentCapture?.installed === true ? 'connected' : 'disconnected';
    changed = true;
  }
  if (!changed && current) return current;
  return writeIntent(dataDir, clients);
}

// Aggregate badge state for the single-switch UI.
function summarizeClient(entry, repair) {
  if (entry.developmentCapture?.state === 'checking' || entry.knowledgeIntegration?.state === 'checking') return 'checking';
  if (!(entry.available || entry.configFound)) return 'not-detected';
  if (entry.developmentCapture?.installed === true) return 'connected';
  if (repair?.[entry.client]?.state === 'failed') return 'error';
  return 'disconnected';
}

module.exports = { SCHEMA, FILENAME, intentPath, readIntent, markIntent, bootstrapIntent, summarizeClient };
