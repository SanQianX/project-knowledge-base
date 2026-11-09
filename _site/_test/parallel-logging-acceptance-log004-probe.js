'use strict';
// P-LOG-ACCEPTANCE-01 LOG-004 probe: find which real APIs append project-
// attributed records (needed as the live-insert mechanism at the query/
// subscribe boundary). Lane-exclusive, evidence-only.

const fs = require('node:fs');
const path = require('node:path');

const LANE_TEMP_BASE = 'D:/SanQian.Xu/.project-knowledge-test-temp';
fs.mkdirSync(LANE_TEMP_BASE, { recursive: true });
const laneTmp = fs.mkdtempSync(path.join(LANE_TEMP_BASE, 'log004-probe-'));
process.env.TEMP = process.env.TMP = process.env.TMPDIR = laneTmp;

const { spawnServer } = require('./helpers/spawn-server');
const { waitFor } = require('./helpers/cdp-browser');
const freePort = require('./helpers/free-port');
const { createLoggingAcceptanceFixture } = require('./helpers/parallel-logging-acceptance-fixture');

const ROOT = path.resolve(__dirname, '../..');
const PROJECT_A = 'project-log004-alpha';

async function main() {
  const fixture = await createLoggingAcceptanceFixture({
    caseId: 'log004-probe',
    projects: [{ projectId: PROJECT_A, displayName: 'LOG004甲项目' }],
  });
  await fixture.logger.close();

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const server = spawnServer({ root: ROOT, port, dataDir: fixture.dataDir, tag: 'log004-probe' });
  const serverStderr = []; const serverStdout = [];
  server.child.stderr.on('data', chunk => serverStderr.push(String(chunk)));
  server.child.stdout.on('data', chunk => serverStdout.push(String(chunk)));
  server.child.on('exit', (code, signal) => out.push({ call: 'SERVER-EXIT', status: `code=${code} signal=${signal}` }));
  const out = [];
  try {
    await waitFor(async () => { try { return (await fetch(`${base}/api/health`)).ok; } catch { return false; } }, 'probe server', 20000);
    const day = new Date().toISOString().slice(0, 10);
    const projectFile = path.join(fixture.dataDir, 'logs', 'projects', PROJECT_A, `${day}.jsonl`);
    const systemFile = path.join(fixture.dataDir, 'logs', 'system', `${day}.jsonl`);
    const lines = file => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean) : []);
    const projectEvents = () => lines(projectFile).map(l => JSON.parse(l).event);
    const systemEvents = () => lines(systemFile).map(l => JSON.parse(l).event);
    const projectRecords = () => lines(projectFile).map(l => JSON.parse(l));
    let projBefore = projectEvents().length, sysBefore = systemEvents().length;

    const candidates = [
      ['GET /api/engine/snapshot?projectId', () => fetch(`${base}/api/engine/snapshot?summary=1&limit=50&projectId=${PROJECT_A}`).then(r => r.status)],
      ['GET /api/projects/<id>', () => fetch(`${base}/api/projects/${PROJECT_A}`).then(r => r.status)],
      ['GET /api/logs?projectId', () => fetch(`${base}/api/logs?pageSize=100&projectId=${PROJECT_A}`).then(r => r.status)],
      ['GET /api/logs/export?projectId', () => fetch(`${base}/api/logs/export?projectId=${PROJECT_A}`).then(r => r.status)],
      ['GET /api/engine/runs?projectId', () => fetch(`${base}/api/engine/runs?projectId=${PROJECT_A}`).then(r => r.status)],
    ];
    for (const [name, call] of candidates) {
      const status = await call();
      await new Promise(r => setTimeout(r, 400));
      const projNow = projectEvents().length, sysNow = systemEvents().length;
      out.push({ call: name, status, projectRecordsAdded: projNow - projBefore, systemRecordsAdded: sysNow - sysBefore, projectEvents: projectEvents().slice(projBefore), systemEvents: systemEvents().slice(sysBefore).slice(0, 3) });
      projBefore = projNow; sysBefore = sysNow;
    }

    // Hook POST stability: does POST /api/hooks/post-commit keep the server healthy?
    for (let i = 1; i <= 3; i += 1) {
      const op = `op-log004-probe-live-${i}-${Date.now()}`;
      let hookStatus = 'throw';
      try {
        const res = await fetch(`${base}/api/hooks/post-commit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ schema: 'hook-event/v2', projectId: PROJECT_A, repoRoot: fixture.projects[0].repo.path, operationId: op }) });
        hookStatus = `${res.status} ${JSON.stringify(await res.json().catch(() => null))}`;
      } catch (error) { hookStatus = `throw ${error.message}`; }
      await new Promise(r => setTimeout(r, 600));
      let health = 'down';
      try { health = (await fetch(`${base}/api/health`)).status; } catch (error) { health = `throw ${error.message}`; }
      const projNow = projectEvents().length;
      out.push({ call: `POST /api/hooks/post-commit #${i}`, status: hookStatus, healthAfter: health, projectRecordsAdded: projNow - projBefore, projectRecords: projectRecords().slice(projBefore) });
      projBefore = projNow;
    }
  } finally {
    try { await server.cleanup(); } finally { fixture.cleanup(); }
  }
  fs.writeFileSync(path.join(laneTmp, 'probe-result.json'), JSON.stringify({ out, serverStderr: serverStderr.join(''), serverStdout: serverStdout.join('') }, null, 2));
  console.log(JSON.stringify(out.map(row => ({ call: row.call, status: row.status, proj: row.projectRecordsAdded, sys: row.systemRecordsAdded, projEvents: row.projectEvents }))));
}

main().then(() => process.exit(0), error => { console.error('PROBE-FAIL', error); process.exit(1); });
