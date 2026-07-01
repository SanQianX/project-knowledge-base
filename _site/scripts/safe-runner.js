// _site/scripts/safe-runner.js
//
// Standalone safe-mode runner. Invoked by the Windows scheduled task.
// Performs scan + analyze-commits for every enabled project, and explicitly
// never calls apply, so AI drafts cannot become trusted knowledge without a
// human at the Drafts tab.
//
// Usage:
//   node _site/scripts/safe-runner.js [--port 5757] [--host 127.0.0.1] [--slug ALL]
//
// The script does NOT spawn the server; the server must already be running.
// If the server is unreachable, the script exits with a non-zero code so the
// scheduled task registers a clear failure.

const fs = require('fs');
const path = require('path');
const http = require('http');

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  return args[i + 1] || fallback;
}
const HOST = arg('--host', '127.0.0.1');
const PORT = parseInt(arg('--port', process.env.KB_SITE_PORT || '5757'), 10);
const SLUG = arg('--slug', 'ALL');

function log(line) {
  const stamp = new Date().toISOString();
  process.stdout.write(`[${stamp}] ${line}\n`);
}

function postJson(path_, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      host: HOST, port: PORT, method: 'POST', path: path_,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: 5000,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        let json = {};
        try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
        resolve({ status: res.statusCode, data: json });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.write(data);
    req.end();
  });
}

function getJson(path_) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: HOST, port: PORT, method: 'GET', path: path_, timeout: 5000,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        let json = {};
        try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
        resolve({ status: res.statusCode, data: json });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.end();
  });
}

async function waitForServer(maxMs = 15000) {
  const deadline = Date.now() + maxMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const r = await getJson('/api/state');
      if (r.status >= 200 && r.status < 500) return true;
      lastError = new Error(`HTTP ${r.status}`);
    } catch (e) { lastError = e; }
    await new Promise(r => setTimeout(r, 500));
  }
  throw lastError || new Error('server not reachable');
}

async function pollJob(jobId, maxMs = 10 * 60 * 1000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const r = await getJson(`/api/jobs/${jobId}`);
    if (r.status === 404) {
      // Job not in the running map and not in the persisted log yet
      await new Promise(r => setTimeout(r, 1000));
      continue;
    }
    if (r.status >= 200 && r.status < 300 && r.data && r.data.job) {
      if (r.data.job.status === 'running') {
        await new Promise(r => setTimeout(r, 1500));
        continue;
      }
      return r.data.job;
    }
    throw new Error(`unexpected response: HTTP ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
  }
  throw new Error('job did not complete within timeout');
}

(async () => {
  log(`safe-runner starting: host=${HOST} port=${PORT} slug=${SLUG}`);

  try {
    await waitForServer();
  } catch (e) {
    log(`ERROR: server not reachable at http://${HOST}:${PORT}/ — ${e.message}`);
    log(`(the safe-runner requires the KB site server to be running; start it with "node _site/server.js" first.)`);
    process.exit(2);
  }

  log(`dispatching safe run (slug=${SLUG})`);
  const start = await postJson('/api/jobs/run', { mode: 'safe', slug: SLUG });
  if (start.status !== 200 || !start.data.ok) {
    log(`ERROR: failed to dispatch job: HTTP ${start.status} ${JSON.stringify(start.data)}`);
    process.exit(3);
  }
  const jobId = start.data.jobId;
  log(`dispatched jobId=${jobId}`);

  let job;
  try {
    job = await pollJob(jobId);
  } catch (e) {
    log(`ERROR: ${e.message}`);
    process.exit(4);
  }

  log(`job ${jobId} finished: status=${job.status} exitCode=${job.exitCode}`);
  if (job.summary) {
    log(`summary: ${JSON.stringify(job.summary)}`);
  }
  if (job.output) {
    const tail = job.output.split(/\r?\n/).filter(Boolean).slice(-20).join('\n');
    if (tail) log(`tail of output:\n${tail}`);
  }

  process.exit(job.exitCode || 0);
})();
