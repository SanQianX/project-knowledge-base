const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { getDataDir } = require('../lib/data-dir');
const { readLiveEndpoint } = require('../lib/runtime-endpoint');
const { StorageLayout } = require('../lib/storage-layout');
const { Logger } = require('../lib/structured-logger');
const { BridgeAdapter } = require('../lib/bridge-adapter');

let bridgeIdentityModule = null;
try {
  const bridgePackage = require('@sanqianx/ai-coding-event-bridge');
  if (bridgePackage && typeof bridgePackage.buildRepoIdentityV1 === 'function') bridgeIdentityModule = bridgePackage;
} catch (_) {
  bridgeIdentityModule = null;
}

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
  settingsProvider: () => ({ levels: ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] }),
  context: { component: 'git-hook', projectId },
});
const bridge = new BridgeAdapter({ dataDir, modulePath: arg('--bridge-module', '') });
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
    const operationId = arg('--operation-id', `op-${crypto.randomUUID()}`);
    // Canonical repo-identity/v1 from the authoritative Git working tree.
    // The old { commonDir }-only shape must never reach the Bridge again.
    let repoIdentity = null;
    if (bridgeIdentityModule) {
      const toplevel = git(['rev-parse', '--show-toplevel']);
      if (toplevel) {
        let workspaceRoot = path.resolve(toplevel);
        try { workspaceRoot = fs.realpathSync.native(workspaceRoot) || workspaceRoot; } catch { workspaceRoot = path.resolve(toplevel); }
        const commonDir = git(['rev-parse', '--path-format=absolute', '--git-common-dir']);
        const remoteRaw = git(['config', '--get', 'remote.origin.url']);
        repoIdentity = bridgeIdentityModule.buildRepoIdentityV1({
          workspaceRoot,
          commonDir: commonDir ? path.resolve(commonDir) : null,
          remote: remoteRaw ? bridgeIdentityModule.normalizeGitUrl(remoteRaw) : null,
        });
      }
    }
    const boundaryResult = await bridge.appendCommitBoundary({
      projectId,
      repoIdentity,
      commitSha: payload.head,
      parentShas: git(['show', '-s', '--format=%P', 'HEAD']).split(/\s+/).filter(Boolean),
      branch: payload.branch || null,
      committedAt: git(['show', '-s', '--format=%cI', 'HEAD']) || new Date().toISOString(),
      operationId,
    });
    payload.operationId = operationId;
    payload.boundary = boundaryResult;
    if (boundaryResult.status === 'captured') {
      await logger.debug('hook.boundary.captured', 'Commit conversation boundary was durably captured.', {
        operationId,
        phase: 'boundary',
        commitSha: payload.head,
        context: {
          bridgeCursorAtCommit: boundaryResult.boundary.bridgeCursorAtCommit,
          openTurnCount: boundaryResult.boundary.openTurnIdsAtCommit.length,
        },
      });
    } else {
      await logger.warn('hook.boundary.unavailable', 'Commit conversation boundary could not be captured.', {
        operationId,
        phase: 'boundary',
        commitSha: payload.head,
        context: { gapId: boundaryResult.gap && boundaryResult.gap.gapId, reason: boundaryResult.gap && boundaryResult.gap.reason },
      });
    }
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
