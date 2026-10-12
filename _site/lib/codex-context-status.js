'use strict';

// Native read-only discovery, never trust-file edits or bypass flags. Reuse
// the module's verified stdio transport rather than a second RPC lifecycle.
async function readCodexHooks({ command, env, cwd }) {
  const { createAppServerBridge } = require('claude-ai-workbench/packages/server/lib/bridges/app-server-bridge');
  const { resolveCliInvocation } = require('claude-ai-workbench/packages/server/lib/drivers/cli-json-runner');
  const bridge = createAppServerBridge({ command, args: ['app-server'], env, cwd, resolveInvocation: resolveCliInvocation, maxRestarts: 0, idleTimeoutMs: 0, requestTimeoutMs: 10000 });
  try {
    await bridge.start();
    await bridge.request('initialize', { clientInfo: { name: 'project-knowledge-hook-status', version: '1' }, capabilities: { experimentalApi: true } });
    await bridge.notify('initialized');
    return await bridge.request('hooks/list', { cwds: [cwd] });
  } finally { await bridge.close(); }
}

module.exports = { readCodexHooks };
