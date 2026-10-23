'use strict';
// P-LOG-SAFETY-R2 hook floating-rejection probe (lane-exclusive prefix
// parallel-logging-fix-r2-*).
//
// Scenario: a route-acceptable but semantically incomplete hook event
// (schema ok, projectId registered, repoRoot non-empty, head NOT a full
// SHA) is POSTed to an isolated legacy instance with real registered Git
// fixtures. The route answers 202 and the background task fails for a
// legitimate reason (scanner.validateSha). This probe observes what the
// server PROCESS does next:
//
//   --expect red    old candidate: unhandledRejection terminates the whole
//                   server (R1 finding findings/log004-hook-unhandled-rejection).
//   --expect green  fixed candidate: same PID stays healthy, failure
//                   diagnostics remain traceable (background.operation_failed
//                   with the operationId), the OTHER project keeps serving,
//                   and no fake succeeded record appears.
//   --scenario engine-ack
//                   observation-only: engine-ownership instance (dead bridge
//                   URL) ack behaviour for the same payload; recorded pre-fix
//                   and post-fix to prove the engine branch is untouched.
//
// Isolation: independent KB_DATA_DIR/KB_KNOWLEDGE_DATA_DIR (fixture +
// spawnServer), ephemeral port, TEMP/TMP/TMPDIR under the lane temp root.
// No payload is ever sent to the real desktop instance on 5757/5760.

const fs = require('node:fs');
const path = require('node:path');

// Portable isolation (P-QA-LOG-INTEGRATION-5025): the temp root comes from
// PK_TEST_TEMP_ROOT or os.tmpdir() and must live outside the source tree;
// HOME/APPDATA/LOCALAPPDATA/TEMP/CODEX_HOME/CLAUDE_CONFIG_DIR and the dual
// product data roots are redirected before any other module is loaded.
const { installLoggingTestEnv, resolveEvidenceDir } = require('./helpers/parallel-logging-integration-5025-env');
const lane = installLoggingTestEnv({ caseId: 'LOGFIXR2-CRASH', prefix: 'logfixr2-crash' });
const laneTmp = lane.laneTmp;

const { spawnServer } = require('./helpers/spawn-server');
const freePort = require('./helpers/free-port');
const { createLoggingAcceptanceFixture } = require('./helpers/parallel-logging-acceptance-fixture');

const ROOT = path.resolve(__dirname, '../..');
const ARTIFACTS = resolveEvidenceDir(path.resolve(ROOT, 'qa-autopilot/artifacts/parallel-20261023/logging-fix-r2/evidence/crash'));

const PROJECT_A = 'project-logfixr2-alpha';
const PROJECT_B = 'project-logfixr2-beta';
const INVALID_OPERATION = 'op-logfixr2-invalid-0001';
const SCENARIO = process.argv.includes('--scenario')
  ? process.argv[process.argv.indexOf('--scenario') + 1]
  : 'legacy-invalid';
const EXPECT = process.argv.includes('--expect')
  ? process.argv[process.argv.indexOf('--expect') + 1]
  : null;
const HARD_TIMEOUT_MS = 120000;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const now = () => new Date().toISOString();

function projectLogRecords(dataDir, projectId) {
  const dir = path.join(dataDir, 'logs', 'projects', projectId);
  if (!fs.existsSync(dir)) return [];
  const records = [];
  for (const file of fs.readdirSync(dir).filter(name => name.endsWith('.jsonl')).sort()) {
    for (const line of fs.readFileSync(path.join(dir, file), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { records.push(JSON.parse(line)); } catch {}
    }
  }
  return records;
}

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  let body = null;
  try { body = await res.json(); } catch {}
  return { status: res.status, ok: res.ok, body };
}

async function main() {
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  const evidence = {
    probe: 'parallel-logging-fix-r2-crash-probe.js',
    scenario: SCENARIO,
    expect: EXPECT,
    startedAt: now(),
    serverAppSha256: (() => {
      const crypto = require('node:crypto');
      return crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, '_site', 'lib', 'server-app.js'))).digest('hex');
    })(),
  };

  const fixture = await createLoggingAcceptanceFixture({
    caseId: 'logfixr2',
    projects: [
      { projectId: PROJECT_A, displayName: 'LOGFIXR2甲项目' },
      { projectId: PROJECT_B, displayName: 'LOGFIXR2乙项目' },
    ],
  });
  await fixture.logger.close();

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const analysisOwner = SCENARIO === 'engine-ack' ? 'engine' : 'legacy';
  const server = spawnServer({
    root: ROOT,
    port,
    dataDir: fixture.dataDir,
    tag: 'logfixr2',
    analysisOwner,
    extraEnv: { KB_AUTOMATION_FAKE_CLAUDE: '1' },
  });
  let stdout = '';
  let stderr = '';
  server.child.stdout.on('data', chunk => { stdout += chunk; });
  server.child.stderr.on('data', chunk => { stderr += chunk; });
  let exitInfo = null;
  server.child.once('exit', (code, signal) => { exitInfo = { code, signal, at: now() }; });
  evidence.server = { pid: server.child.pid, port, analysisOwner, dataDir: fixture.dataDir };

  try {
    // Boot wait (real health endpoint, not a sleep guess).
    const bootDeadline = Date.now() + 30000;
    let health = null;
    while (Date.now() < bootDeadline) {
      try {
        const res = await fetch(`${base}/api/health`);
        if (res.ok) { health = await res.json(); break; }
      } catch {}
      await sleep(200);
    }
    if (!health) throw new Error('isolated server did not become healthy within 30s');
    evidence.boot = { healthyAt: now(), pid: server.child.pid };

    // Route-acceptable but semantically incomplete hook payload (head is not
    // a full 40-char SHA). The route layer accepts it; the background task
    // fails in scanner.validateSha for a legitimate reason.
    const repoA = fixture.projects.find(p => p.projectId === PROJECT_A).repo.path;
    const hookPayload = {
      schema: 'hook-event/v2',
      projectId: PROJECT_A,
      repoRoot: repoA,
      head: 'deadbeef-not-a-full-sha',
      branch: 'main',
      operationId: INVALID_OPERATION,
    };
    const post = await fetchJson(`${base}/api/hooks/post-commit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(hookPayload),
    });
    evidence.hookPost = { at: now(), status: post.status, body: post.body };

    if (SCENARIO === 'engine-ack') {
      // Observation only: the engine branch is untouched by the fix; capture
      // its synchronous ack for pre/post parity.
      await sleep(1000);
      const healthAfter = await fetchJson(`${base}/api/health`);
      evidence.engineAck = { healthAfter: { status: healthAfter.status, ok: healthAfter.ok }, exited: exitInfo ? exitInfo : null };
      evidence.observation = 'engine-branch ack recorded';
      fs.writeFileSync(path.join(ARTIFACTS, 'engine-ack-result.json'), JSON.stringify(evidence, null, 2) + '\n');
      console.log(`engine-ack: hook status=${post.status} health=${healthAfter.status} exit=${exitInfo ? exitInfo.code : 'alive'}`);
      process.exitCode = 0;
      return;
    }

    // Observe the process for up to 15s after the accepted failure.
    const watchDeadline = Date.now() + 15000;
    const healthTrace = [];
    let diedAt = null;
    while (Date.now() < watchDeadline) {
      let alive = false;
      try { const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1500) }); alive = res.ok; } catch {}
      healthTrace.push({ at: now(), alive });
      if (!alive) { diedAt = now(); break; }
      if (exitInfo) break;
      await sleep(250);
    }
    // Give a possibly-terminating process a moment to fully exit so exitInfo
    // is captured deterministically.
    await sleep(1500);
    evidence.healthTrace = healthTrace;
    evidence.diedAt = diedAt;
    evidence.exitInfo = exitInfo;

    const records = projectLogRecords(fixture.dataDir, PROJECT_A);
    const failed = records.filter(r => r.event === 'background.operation_failed');
    const completed = records.filter(r => r.event === 'background.operation_completed');
    evidence.diagnostics = {
      operationFailedRecords: failed.map(r => ({
        operationId: r.operationId,
        errorCode: r.error && r.error.code,
        errorMessage: r.error && r.error.message,
        stackHead: (r.error && r.error.stack || []).slice(0, 4),
        ts: r.ts,
      })),
      invalidOperationCompleted: completed.filter(r => r.operationId === INVALID_OPERATION).map(r => r.operationId),
    };

    let controlProjectOk = null;
    let controlEvidence = null;
    if (exitInfo === null) {
      // Server survived: prove the OTHER project still serves real requests.
      const goalRes = await fetchJson(`${base}/api/projects/${PROJECT_B}/goal`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: `LOGFIXR2 control goal ${Date.now()} pad-${'x'.repeat(64)}` }),
      });
      const logsRes = await fetchJson(`${base}/api/logs?pageSize=50&projectId=${PROJECT_B}`);
      const goalUpdated = ((logsRes.body || {}).entries || []).some(e => e.event === 'goal.updated');
      controlEvidence = { goalPutStatus: goalRes.status, logsStatus: logsRes.status, goalUpdatedSeen: goalUpdated };
      controlProjectOk = goalRes.ok && logsRes.ok && goalUpdated;
      evidence.controlProject = controlEvidence;
    }

    // Verdict against the declared expectation.
    const serverDied = exitInfo !== null || diedAt !== null;
    const failedForInvalid = evidence.diagnostics.operationFailedRecords.some(r => r.operationId === INVALID_OPERATION);
    const noFakeSuccess = evidence.diagnostics.invalidOperationCompleted.length === 0;
    let verdict;
    if (EXPECT === 'red') {
      verdict = { serverDied, failedDiagnosticPresent: failedForInvalid || serverDied };
      evidence.verdict = verdict;
      if (!serverDied) throw new Error('RED expected: server was expected to die from unhandledRejection but stayed healthy');
    } else if (EXPECT === 'green') {
      verdict = {
        samePidAlive: exitInfo === null && diedAt === null,
        failureDiagnosticTraceable: failedForInvalid,
        noFakeSucceeded: noFakeSuccess,
        controlProjectOk,
      };
      evidence.verdict = verdict;
      if (!(verdict.samePidAlive && verdict.failureDiagnosticTraceable && verdict.noFakeSucceeded && verdict.controlProjectOk)) {
        throw new Error(`GREEN expectation not met: ${JSON.stringify(verdict)}`);
      }
    } else {
      evidence.verdict = { observedOnly: true, serverDied };
    }

    const file = EXPECT === 'red' ? 'red-result.json' : EXPECT === 'green' ? 'green-result.json' : 'observation.json';
    fs.writeFileSync(path.join(ARTIFACTS, file), JSON.stringify(evidence, null, 2) + '\n');
    console.log(`${EXPECT || 'observe'}: serverDied=${serverDied} exit=${exitInfo ? exitInfo.code : 'alive'} failedDiagnostic=${failedForInvalid} fakeSuccess=${!noFakeSuccess} controlOk=${controlProjectOk}`);
    process.exitCode = 0;
  } catch (error) {
    evidence.error = String((error && error.stack) || error);
    fs.writeFileSync(path.join(ARTIFACTS, `${EXPECT || 'observe'}-failure.json`), JSON.stringify(evidence, null, 2) + '\n');
    console.error(`crash-probe FAIL: ${error.message}`);
    process.exitCode = 1;
  } finally {
    evidence.finishedAt = now();
    evidence.serverStdout = stdout.slice(-4000);
    evidence.serverStderr = stderr.slice(-4000);
    try {
      fs.writeFileSync(path.join(ARTIFACTS, `${EXPECT || 'observe'}-server-io.json`), JSON.stringify({ stdout: stdout.slice(-8000), stderr: stderr.slice(-8000), exitInfo }, null, 2) + '\n');
    } catch {}
    try { await server.cleanup(); } finally { fixture.cleanup(); }
    lane.cleanup();
  }
}

const hardTimer = setTimeout(() => {
  // Total-timeout scene preservation: dump what we know and stop.
  try {
    fs.mkdirSync(ARTIFACTS, { recursive: true });
    fs.writeFileSync(path.join(ARTIFACTS, 'hard-timeout.json'), JSON.stringify({ at: now(), scenario: SCENARIO, expect: EXPECT }, null, 2) + '\n');
  } catch {}
  console.error('crash-probe HARD TIMEOUT');
  process.exit(2);
}, HARD_TIMEOUT_MS);
hardTimer.unref();

main();
