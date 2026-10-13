'use strict';
process.once('message', () => {
  const until = Date.now() + 1200;
  while (Date.now() < until) { /* Reproduce a blocking native status probe outside the HTTP process. */ }
  process.send({ ok: true, summary: { bridge: { ok: true }, clients: [{ client: 'claude', available: true }] } }, () => process.disconnect());
});
