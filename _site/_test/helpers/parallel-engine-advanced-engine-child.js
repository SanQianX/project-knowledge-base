'use strict';

// P-ENG-ADVANCED engine child wrapper. Runs in its own process with a scrubbed,
// isolated environment and starts the VENDORED knowledge-engine server module
// (byte-identical to source e5573bb) in debug mode so the documented debug
// fault-injection surface (POST /api/runs with simulateFailure) is available.
// The analyzer is the lane's declarative stand-in - real staged bytes, no real
// model output. Vendored engine code is never modified.

const { createEngineServer } = require('../../../_modules/knowledge-engine/src/server.js');
const { createStandinAnalyzer } = require('./parallel-engine-advanced-standin-analyzer.js');

async function main() {
  const dataDir = process.env.ENGADV_DATA_DIR;
  const vectorUrl = process.env.ENGADV_VECTOR_URL || 'http://127.0.0.1:9';
  const planFile = process.env.ENGADV_PLAN_FILE;
  const eventsFile = process.env.ENGADV_EVENTS_FILE;
  const concurrency = process.env.ENGADV_CONCURRENCY ? Number(process.env.ENGADV_CONCURRENCY) : undefined;
  const analyzer = createStandinAnalyzer({ planFile, eventsFile });
  const runtime = createEngineServer({
    dataDir,
    debug: true,
    analyzer,
    vectorUrl,
    consume: false,
    managed: false,
    ...(concurrency !== undefined ? { concurrency } : {}),
  });
  await runtime.ready;
  const { server } = runtime;
  const stop = async () => {
    try { await runtime.close(); process.exitCode = 0; } catch { process.exitCode = 1; }
    if (process.connected) process.disconnect();
  };
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, stop);
  process.on('message', message => { if (message?.type === 'kb:shutdown') stop(); });
  server.listen(0, '127.0.0.1', () => {
    process.stdout.write(`ENGADV-READY ${JSON.stringify({ base: `http://127.0.0.1:${server.address().port}`, pid: process.pid })}\n`);
  });
}

main().catch(error => {
  console.error(`[engadv-child] ${error.code || 'START_FAILED'}: ${error.message}`);
  process.exit(1);
});
