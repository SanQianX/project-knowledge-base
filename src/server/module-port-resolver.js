'use strict';

// Dynamic module URL resolution.
//
// Managed modules used to bind fixed default ports (terminal 5760,
// vector-hub 8787, event-bridge 8790, engine 5790).  When a foreign process
// occupied one of those ports the module crash-looped and the feature stayed
// degraded.  This resolver picks the final URL BEFORE any module is spawned:
//
//   explicit env/option URL -> external service, untouched (legacy behavior)
//   healthy identity match  -> reused (standalone module keeps running)
//   otherwise               -> first free port from preferred +0..+19
//   all busy                -> NO_FREE_MODULE_PORT (loud, never silent)

function invalidUrl(value) {
  return Object.assign(new Error(`Invalid module URL: ${value}`), { code: 'INVALID_MODULE_URL' });
}

function parsePreferredUrl(value) {
  let parsed;
  try { parsed = new URL(String(value)); } catch { throw invalidUrl(value); }
  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw invalidUrl(value);
  return { parsed, port };
}

function rebuildUrl(parsed, port) {
  const host = parsed.hostname.includes(':') ? `[${parsed.hostname}]` : parsed.hostname;
  return `${parsed.protocol}//${host}:${port}`;
}

/**
 * @param {object} options
 * @param {string} options.kind module kind, used in errors/logs only
 * @param {string} options.preferredUrl default URL with an explicit port
 * @param {boolean} options.explicit true when the URL was injected explicitly
 * @param {(port: number) => Promise<boolean>} options.portFree TCP bind probe
 * @param {(url: string) => Promise<'module'|'foreign'|'unreachable'>} options.probe
 * @param {number} [options.scanRange] candidate count starting at the preferred port
 * @returns {Promise<{url: string, source: 'external'|'reused'|'dynamic', port: number, offset: number}>}
 */
async function resolveModuleUrl({ kind, preferredUrl, explicit, portFree, probe, scanRange = 20 }) {
  const { parsed, port } = parsePreferredUrl(preferredUrl);
  if (explicit) return { url: preferredUrl, source: 'external', port, offset: 0 };
  if (await probe(preferredUrl) === 'module') return { url: preferredUrl, source: 'reused', port, offset: 0 };
  const range = Math.max(1, Number.isInteger(scanRange) ? scanRange : 20);
  for (let offset = 0; offset < range && port + offset <= 65535; offset++) {
    const candidate = port + offset;
    if (await portFree(candidate)) {
      return { url: rebuildUrl(parsed, candidate), source: 'dynamic', port: candidate, offset };
    }
  }
  const last = Math.min(port + range - 1, 65535);
  throw Object.assign(new Error(`No free port found for ${kind} in ${port}-${last}.`), { code: 'NO_FREE_MODULE_PORT' });
}

module.exports = { resolveModuleUrl };
