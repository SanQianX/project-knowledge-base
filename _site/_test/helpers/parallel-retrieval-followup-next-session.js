'use strict';
// The "next session" client for RET-007. This is a FRESH process that plays
// the role of the next conversation: it only speaks HTTP to the knowledge
// engine, exactly like a real session client does. It asserts nothing — the
// raw responses are written to the output file so the probe evaluates them
// as evidence.
//
// Usage:
//   node parallel-retrieval-followup-next-session.js \
//     --engine-url http://127.0.0.1:<port> --project-id <id> \
//     --context-query <q> --ask-query <q> --control-query <q> \
//     --session-id <id> --out <file.json>
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
function arg(name, fallback = '') {
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] || fallback) : fallback;
}

async function call(engineUrl, route, body) {
  const response = await fetch(`${engineUrl}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  return { status: response.status, ok: response.ok, body: await response.json().catch(() => null) };
}

(async () => {
  const engineUrl = arg('--engine-url');
  const projectId = arg('--project-id');
  const sessionId = arg('--session-id', 'ret007-next-session');
  const outFile = path.resolve(arg('--out'));
  if (!engineUrl || !projectId || !outFile) {
    console.error('missing --engine-url/--project-id/--out');
    process.exit(2);
  }
  const queries = {
    context: arg('--context-query'),
    ask: arg('--ask-query'),
    control: arg('--control-query'),
  };
  const result = {
    client: 'parallel-retrieval-followup-next-session',
    pid: process.pid,
    startedAt: new Date().toISOString(),
    engineUrl,
    projectId,
    sessionId,
    queries,
  };
  if (queries.context) {
    result.context = await call(engineUrl, '/api/context', { query: queries.context, projectId, client: 'workbench', sessionId });
  }
  if (queries.ask) {
    result.ask = await call(engineUrl, '/api/ask', { query: queries.ask, projectId, limit: 5 });
  }
  if (queries.control) {
    result.control = await call(engineUrl, '/api/ask', { query: queries.control, projectId, limit: 5 });
  }
  result.finishedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(result, null, 2), 'utf8');
  const anyOk = [result.context, result.ask].some(call => call && call.ok);
  console.log(JSON.stringify({ ok: anyOk, context: result.context && result.context.status, ask: result.ask && result.ask.status, control: result.control && result.control.status, out: outFile }));
  process.exitCode = anyOk ? 0 : 1;
})().catch(error => { console.error(error); process.exit(1); });
