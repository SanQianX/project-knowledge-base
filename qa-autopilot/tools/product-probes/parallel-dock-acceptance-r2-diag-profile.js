// qa-autopilot/tools/product-probes/parallel-dock-acceptance-r2-diag-profile.js
//
// Diagnostic (not a verdict): verifies that the read-only minimax profile is
// resolvable in the isolated module store and that a session can be created
// bound to it. No model turn is dispatched, so no provider call is made.

'use strict';

const { createDockAcceptanceEnv } = require('../../../_site/_test/helpers/parallel-dock-acceptance-r2-env');

async function main() {
  const env = await createDockAcceptanceEnv({ tag: 'dock001-r2-diag', modelProfileId: 'minimax' });
  try {
    const profiles = await env.termApi('profiles');
    const list = Array.isArray(profiles.data) ? profiles.data : ((profiles.data && profiles.data.profiles) || []);
    console.log('[diag] profiles status', profiles.status);
    for (const item of list) {
      console.log('[diag] profile', JSON.stringify({
        id: item.id, name: item.name, provider: item.provider, baseUrl: item.baseUrl,
        enabled: item.enabled, credentialConfigured: item.credentialConfigured,
        credentialMasked: item.credentialMasked, defaultModel: item.models && item.models.default,
      }));
    }
    const created = await env.termApi('sessions', {
      method: 'POST',
      body: {
        context: { contextId: env.terminalProjectId, workspaceRef: env.terminalProjectId },
        aiProfileId: 'minimax',
        model: 'MiniMax-M3.1-Flash',
        permissionMode: 'bypassPermissions',
      },
    });
    console.log('[diag] create session status', created.status);
    console.log('[diag] session', JSON.stringify(created.data && created.data.session));
    const loaded = await env.termApi(`sessions/${created.data.session.sessionId}`);
    console.log('[diag] events', JSON.stringify((loaded.data && loaded.data.events || []).map(e => ({ type: e.type, sequence: e.sequence }))));
    console.log('[diag] storeScope', env.storeScope());
  } finally {
    await env.cleanup();
  }
}

main().then(() => process.exit(0)).catch((error) => { console.error('[diag] failed:', error); process.exit(1); });
