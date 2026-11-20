'use strict';
process.once('message', ({ statusOptions }) => {
  const send = summary => process.send({ ok: true, summary }, () => process.disconnect());
  if (statusOptions.sharedOnly) return send({ bridge: { ok: true }, clients: [] });
  const client = statusOptions.clients[0];
  if (statusOptions.fixtureError) {
    return process.send({ ok: false, code: 'INTEGRATION_STATUS_EXITED' }, () => process.disconnect());
  }
  const entry = { client, available: true, developmentCapture: { ok: true, state: 'installed', installed: true } };
  if (statusOptions.fixturePartial) process.send({ kind: 'client-status', entry });
  const until = Date.now() + (client === 'claude' ? (statusOptions.fixtureDelay ?? 1200) : 0);
  while (Date.now() < until) { /* Reproduce a blocking native status probe outside the HTTP process. */ }
  send({ clients: [{ ...entry, knowledgeIntegration: { ok: true, state: 'installed' } }] });
});
