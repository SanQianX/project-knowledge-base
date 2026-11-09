'use strict';
// P-LOG-ACCEPTANCE-01 LOG-003 probe: API-level reproduction of the first-failure
// wait (project-scope entry count) without the browser, to bisect fixture/API
// vs UI. Lane-exclusive file, evidence-only, not a regression test.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const LANE_TEMP_BASE = 'D:/SanQian.Xu/.project-knowledge-test-temp';
fs.mkdirSync(LANE_TEMP_BASE, { recursive: true });
const laneTmp = fs.mkdtempSync(path.join(LANE_TEMP_BASE, 'log003-probe-'));
process.env.TEMP = process.env.TMP = process.env.TMPDIR = laneTmp;

const { spawnServer } = require('./helpers/spawn-server');
const { waitFor } = require('./helpers/cdp-browser');
const freePort = require('./helpers/free-port');
const { createLoggingAcceptanceFixture, writeProjectLogs } = require('./helpers/parallel-logging-acceptance-fixture');

const ROOT = path.resolve(__dirname, '../..');
const PROJECT_A = 'project-log003-alpha';
const PROJECT_B = 'project-log003-beta';
const run = crypto.randomBytes(6).toString('hex');
const OP_ALPHA = `op-log003-alpha-${run}`;

async function main() {
  const fixture = await createLoggingAcceptanceFixture({
    caseId: 'log003-probe',
    projects: [
      { projectId: PROJECT_A, displayName: 'LOG003甲项目' },
      { projectId: PROJECT_B, displayName: 'LOG003乙项目' },
    ],
  });
  await writeProjectLogs(fixture.logger, PROJECT_A, [
    ...Array.from({ length: 4 }, (_, index) => ({ level: index % 2 ? 'warn' : 'info', event: `log003.alpha.flow.${index}`, message: `甲项目流程记录 ${index}`, operationId: OP_ALPHA })),
    ...Array.from({ length: 6 }, (_, index) => ({ level: 'info', event: `log003.alpha.other.${index}`, message: `甲项目普通记录 ${index}`, operationId: `op-log003-alpha-other-${run}-${index}` })),
  ]);
  await writeProjectLogs(fixture.logger, PROJECT_B, [
    ...Array.from({ length: 8 }, (_, index) => ({ level: 'info', event: `log003.beta.${index}`, message: `乙项目记录 ${index}`, operationId: `op-log003-beta-${run}-${index}` })),
  ]);
  await fixture.logger.info('log003.system.note', '系统范围记录', {});
  await fixture.logger.close();

  const walkLogs = dir => {
    const out = [];
    const visit = p => {
      for (const name of fs.readdirSync(p)) {
        const full = path.join(p, name);
        if (fs.statSync(full).isDirectory()) visit(full); else out.push(path.relative(dir, full));
      }
    };
    visit(dir);
    return out;
  };
  console.log('DISK logs tree:', JSON.stringify(walkLogs(path.join(fixture.dataDir, 'logs'))));

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const server = spawnServer({ root: ROOT, port, dataDir: fixture.dataDir, tag: 'log003-probe', stdio: 'ignore' });
  try {
    await waitFor(async () => { try { return (await fetch(`${base}/api/health`)).ok; } catch { return false; } }, 'probe server', 20000);
    const get = async suffix => {
      const res = await fetch(`${base}/api/logs${suffix}`);
      const body = await res.json();
      return { status: res.status, count: (body.entries || []).length, levels: [...new Set((body.entries || []).map(e => e.level))], projects: [...new Set((body.entries || []).map(e => e.projectId))] };
    };
    console.log('PROJECT A:', JSON.stringify(await get(`?pageSize=100&projectId=${PROJECT_A}`)));
    console.log('PROJECT B:', JSON.stringify(await get(`?pageSize=100&projectId=${PROJECT_B}`)));
    console.log('ALL:', JSON.stringify(await get('?pageSize=100')));
    console.log('Q-OP-A:', JSON.stringify(await get(`?pageSize=100&q=${encodeURIComponent(OP_ALPHA)}`)));
    const projects = await (await fetch(`${base}/api/projects`)).json();
    console.log('REGISTRY:', JSON.stringify(projects));
  } finally {
    try { await server.cleanup(); } finally { fixture.cleanup(); }
  }
}

main().then(() => { console.log('PROBE-DONE'); process.exit(0); }, error => { console.error('PROBE-FAIL', error); process.exit(1); });
