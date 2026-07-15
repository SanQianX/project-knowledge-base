// _site/scripts/hook-trigger.js
//
// Lightweight, fire-and-forget trigger invoked by `<repo>/.git/hooks/post-commit`.
// It reports the commit event to the KB server. The server resolves the
// project and starts the configured background automation. This script always
// exits 0 so a KB outage can never block a user's commit.
//
// Usage from a git hook:
//   node "<site-root>/scripts/hook-trigger.js" \
//        --kb-root <path-to-log-root> \
//        --repo  <absolute-repo-path>

const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const { getDataDir } = require('../lib/data-dir');
const { readLiveEndpoint } = require('../lib/runtime-endpoint');

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  return args[i + 1] || fallback;
}

const KB_ROOT = arg('--kb-root', '');
const REPO = arg('--repo', '');
const FALLBACK_HOST = arg('--host', '127.0.0.1');
const FALLBACK_PORT = parseInt(arg('--port', process.env.KB_SITE_PORT || '5757'), 10);

const HOOK_TIMEOUT_MS = 2000;
const LOG_FILENAME = '.hook-trigger-errors.log';
const DATA_DIR = getDataDir();

function resolveTarget() {
  const endpoint = readLiveEndpoint(DATA_DIR);
  return endpoint
    ? { host: endpoint.host, port: endpoint.port, source: 'runtime-endpoint' }
    : { host: FALLBACK_HOST, port: FALLBACK_PORT, source: 'hook-fallback' };
}

function logError(msg) {
  try {
    const logPath = path.join(DATA_DIR, LOG_FILENAME);
    const stamp = new Date().toISOString();
    fs.appendFileSync(logPath, `[${stamp}] ${msg}\n`, 'utf-8');
  } catch {}
}

function git(args, fallback = '') {
  if (!REPO) return fallback;
  try {
    return execFileSync('git', ['-C', REPO, ...args], {
      encoding: 'utf-8',
      windowsHide: true,
      timeout: HOOK_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return fallback;
  }
}

function postJson(p, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const target = resolveTarget();
    const req = http.request({
      host: target.host,
      port: target.port,
      method: 'POST',
      path: p,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
      timeout: HOOK_TIMEOUT_MS,
    }, (res) => {
      res.on('data', () => {});
      res.on('end', () => resolve({ status: res.statusCode }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.write(data);
    req.end();
  });
}

(async () => {
  if (!KB_ROOT || !REPO) process.exit(0);

  const commitHash = git(['rev-parse', 'HEAD'], '');
  const branch = git(['branch', '--show-current'], '');

  try {
    const r = await postJson('/api/hooks/post-commit', {
      repoPath: REPO,
      commitHash,
      branch,
    });
    if (r.status !== 200) {
      logError(`post-commit dispatch non-200 for repo=${REPO}: HTTP ${r.status}`);
    }
  } catch (e) {
    logError(`post-commit dispatch failed for repo=${REPO}: ${e.message}`);
  }

  process.exit(0);
})();
