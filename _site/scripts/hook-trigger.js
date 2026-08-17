const http = require('http');
const { execFileSync } = require('child_process');
const { getDataDir } = require('../lib/data-dir');
const { readLiveEndpoint } = require('../lib/runtime-endpoint');
const { StorageLayout } = require('../lib/storage-layout');
const { Logger } = require('../lib/structured-logger');

const args = process.argv.slice(2);
function arg(name, fallback = '') {
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] || fallback) : fallback;
}

const projectId = arg('--project-id', '');
const repoRoot = arg('--repo-root', arg('--repo', ''));
const fallbackHost = arg('--host', '127.0.0.1');
const fallbackPort = Number(arg('--port', process.env.KB_SITE_PORT || '5757'));
const dataDir = getDataDir();
const layout = new StorageLayout({ dataDir });
const logger = new Logger({
  layout,
  scope: 'hooks',
  settingsProvider: () => ({ levels: ['trace', 'debug', 'info', 'warn', 'error', 'fatal'], retentionDays: 365, maxTotalSizeMB: 2048 }),
  context: { component: 'git-hook', projectId },
});
const timeoutMs = 2000;

function git(gitArgs, fallback = '') {
  if (!repoRoot) return fallback;
  try {
    return execFileSync('git', ['-C', repoRoot, ...gitArgs], {
      encoding: 'utf8', windowsHide: true, timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    }).trim();
  } catch { return fallback; }
}

function target() {
  const endpoint = readLiveEndpoint(dataDir);
  return endpoint ? { host: endpoint.host, port: endpoint.port } : { host: fallbackHost, port: fallbackPort };
}

function post(body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const endpoint = target();
    const request = http.request({
      host: endpoint.host,
      port: endpoint.port,
      method: 'POST',
      path: '/api/hooks/post-commit',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: timeoutMs,
    }, response => {
      response.resume();
      response.on('end', () => resolve(response.statusCode || 0));
    });
    request.on('error', reject);
    request.on('timeout', () => request.destroy(new Error('hook notification timeout')));
    request.end(payload);
  });
}

(async () => {
  try {
    if (!projectId || !repoRoot) {
      await logger.warn('hook.notification.skipped', 'Hook payload is missing project identity or repository root.', { phase: 'validate' });
      return;
    }
    const payload = {
      schema: 'hook-event/v2',
      projectId,
      repoRoot,
      head: git(['rev-parse', 'HEAD']),
      branch: git(['branch', '--show-current']),
    };
    try {
      const status = await post(payload);
      if (status < 200 || status >= 300) {
        await logger.warn('hook.notification.failed', 'Knowledge service rejected the Hook notification.', { phase: 'notify', context: { status } });
      } else {
        await logger.debug('hook.notification.completed', 'Hook notification delivered.', { phase: 'notify' });
      }
    } catch (error) {
      await logger.warn('hook.notification.degraded', 'Knowledge service is unavailable; startup reconciliation will catch up.', { phase: 'notify', error });
    }
  } catch (error) {
    await logger.error('hook.script.failed', 'Hook trigger failed.', { phase: 'runtime', error });
  } finally {
    await logger.close();
  }
})().then(() => process.exit(0), async error => {
  try { await logger.error('hook.script.failed', 'Hook trigger failed unexpectedly.', { error }); await logger.close(); } catch {
    // Hook execution must always exit zero even when logging is unavailable.
  }
  process.exit(0);
});
