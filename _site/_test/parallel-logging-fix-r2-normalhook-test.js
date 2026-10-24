'use strict';
// P-LOG-SAFETY-R2 normal hook path regression (lane-exclusive prefix
// parallel-logging-fix-r2-*).
//
// Complements the crash red/green probe: with the floating-rejection fix in
// place, the NORMAL legacy hook path must keep working end to end — two
// sequential real commits in a real registered Git fixture, two hook
// events, both processed to background.operation_completed by the existing
// clearly-labelled offline analyzer stand-in (KB_AUTOMATION_FAKE_CLAUDE=1,
// RuntimeKnowledgeAnalyzer.fakeResult), knowledge promoted into the
// project's knowledge root, lastAnalyzedCommit advancing, server healthy
// throughout, and an orderly control-channel shutdown.
//
// This is not a model-quality acceptance; the stand-in is marked as such in
// every record it writes ("isolated automation test adapter").
//
// KB_EMBEDDING_FAKE=1 is the product's own mock embedder (server-app.js
// createEmbedder), the same stand-in the other background-path product tests
// use. Without it the isolated instance has a cold model cache and the real
// embedding path tries to fetch the ONNX model from the network, which stalls
// the background operation past the run-all budget.
//
// P-LINUX-CI-CLOSEOUT-R7 corrections: (1) a health-timeout failure now prints
// the server's own exit cause, its captured stdout/stderr tails, and whether
// the port ever answered — /api/health is a synchronous responder behind the
// HTTP listener, so a 30s timeout means initializeRuntime never reached
// listen, and the stderr tail is the only way the CI log can name the hanging
// await; (2) the failure path force-kills a wedged server child — a surviving
// child process handle keeps this process alive (the linux22 CI shape: FAIL
// printed at 30s, hang until the 80s hard timer); (3) the hard timer dumps
// the captured server IO before exit(2). The 30s health budget is unchanged.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Portable isolation (P-QA-LOG-INTEGRATION-5025): the temp root comes from
// PK_TEST_TEMP_ROOT or os.tmpdir() and must live outside the source tree;
// HOME/APPDATA/LOCALAPPDATA/TEMP/CODEX_HOME/CLAUDE_CONFIG_DIR and the dual
// product data roots are redirected before any other module is loaded.
const { installLoggingTestEnv, resolveEvidenceDir } = require('./helpers/parallel-logging-integration-5025-env');
const lane = installLoggingTestEnv({ caseId: 'LOGFIXR2-NORMALHOOK', prefix: 'logfixr2-normal' });
const laneTmp = lane.laneTmp;

const { spawnServer } = require('./helpers/spawn-server');
const freePort = require('./helpers/free-port');
const { SettingsStore } = require('../lib/settings-store');
const { createLoggingAcceptanceFixture } = require('./helpers/parallel-logging-acceptance-fixture');

const ROOT = path.resolve(__dirname, '../..');
const ARTIFACTS = resolveEvidenceDir(path.resolve(ROOT, 'qa-autopilot/artifacts/parallel-20261023/logging-fix-r2/evidence/normalhook'));

const PROJECT_A = 'project-logfixr2-normal';
// Below the run-all per-test budget (PK_TEST_TIMEOUT_MS, default 90s) so a
// stall still lets this entry write its own evidence before the runner kills
// the child.
const HARD_TIMEOUT_MS = 80000;

// Module scope so the hard-timeout timer can kill the spawned server and dump
// its IO before exit(2) (see the R7 note in the header).
let server = null;
let exitInfo = null;
let serverStdout = '';
let serverStderr = '';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const now = () => new Date().toISOString();

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: path.join(laneTmp, 'non-existent-git-config'),
};

function git(repoPath, args) {
  const res = spawnSync('git', ['-C', repoPath, ...args], { encoding: 'utf8', env: GIT_ENV });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout.trim();
}

function addCommit(repoPath, name, content) {
  fs.writeFileSync(path.join(repoPath, name), content);
  git(repoPath, ['add', '.']);
  git(repoPath, ['commit', '-q', '-m', `LOGFIXR2 normal ${name}`]);
  return git(repoPath, ['rev-parse', 'HEAD']);
}

function allLogRecords(dataDir) {
  const records = [];
  const rootDir = path.join(dataDir, 'logs');
  if (!fs.existsSync(rootDir)) return records;
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.jsonl')) {
        for (const line of fs.readFileSync(full, 'utf8').split('\n')) {
          if (line.trim()) { try { records.push(JSON.parse(line)); } catch {} }
        }
      }
    }
  };
  walk(rootDir);
  return records;
}

async function waitFor(predicate, label, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await sleep(300);
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function main() {
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  const evidence = { caseId: 'R2-NORMALHOOK', startedAt: now(), phases: {} };

  const fixture = await createLoggingAcceptanceFixture({
    caseId: 'logfixr2normal',
    projects: [{ projectId: PROJECT_A, displayName: 'LOGFIXR2正常路径' }],
  });
  await fixture.logger.close();
  // The reconciler resolves a usable AI profile before the (fake) claim runs;
  // give the isolated settings one clearly-labelled offline profile.
  const settingsStore = new SettingsStore({ layout: fixture.layout });
  await settingsStore.updatePatch({ ai: { profiles: [{ id: 'profile-logfixr2-offline', name: 'LOGFIXR2 离线替身', enabled: true, vendor: 'offline-standin' }] } });
  const repoA = fixture.projects[0].repo.path;

  // Two additional real commits in the real registered fixture repository.
  const sha2 = addCommit(repoA, 'notes-two.md', '# second\n\nLOGFIXR2 normal path commit 2.\n');
  const sha3 = addCommit(repoA, 'notes-three.md', '# third\n\nLOGFIXR2 normal path commit 3.\n');
  evidence.commits = { sha2, sha3 };

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  server = spawnServer({
    root: ROOT,
    port,
    dataDir: fixture.dataDir,
    tag: 'logfixr2normal',
    extraEnv: { KB_AUTOMATION_FAKE_CLAUDE: '1', KB_EMBEDDING_FAKE: '1' },
  });
  server.child.once('exit', (code, signal) => { exitInfo = { code, signal, at: now() }; });
  server.child.stdout.on('data', chunk => { serverStdout += chunk; });
  server.child.stderr.on('data', chunk => { serverStderr += chunk; });

  const postHook = async (head, operationId) => {
    const res = await fetch(`${base}/api/hooks/post-commit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schema: 'hook-event/v2', projectId: PROJECT_A, repoRoot: repoA, head, branch: 'main', operationId }),
    });
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  };

  try {
    await waitFor(async () => {
      try { return (await fetch(`${base}/api/health`)).ok; } catch { return false; }
    }, 'isolated server healthy', 30000);
    evidence.server = { pid: server.child.pid, port };

    // Queue semantics: post BOTH hook events back to back (the second while
    // the first may still be running), then require both to settle.
    const op1 = 'op-logfixr2-normal-0001';
    const op2 = 'op-logfixr2-normal-0002';
    const ack1 = await postHook(sha2, op1);
    const ack2 = await postHook(sha3, op2);
    evidence.hookAcks = { ack1, ack2 };
    if (ack1.status !== 202 || ack2.status !== 202 || !ack1.body?.accepted || !ack2.body?.accepted) {
      throw new Error(`hook acks not 202/accepted: ${JSON.stringify({ ack1, ack2 })}`);
    }

    const settled = await waitFor(() => {
      const records = allLogRecords(fixture.dataDir);
      const done = op => records.some(r => r.event === 'background.operation_completed' && r.operationId === op);
      const failed = records.filter(r => r.event === 'background.operation_failed');
      if (failed.length) return { premature: true, failed: failed.map(r => ({ operationId: r.operationId, code: r.error?.code, message: r.error?.message })) };
      return done(op1) && done(op2);
    }, 'both hook operations completed', 60000);
    if (settled && settled.premature) throw new Error(`background failure on the normal path: ${JSON.stringify(settled.failed)}`);

    const records = allLogRecords(fixture.dataDir);
    evidence.phases.background = {
      completed: records.filter(r => r.event === 'background.operation_completed').map(r => ({ operationId: r.operationId, ts: r.ts })),
      failed: records.filter(r => r.event === 'background.operation_failed').map(r => r.operationId),
      accepted: records.filter(r => r.event === 'hook.event_accepted').map(r => ({ operationId: r.operationId, ts: r.ts })),
      promotionEvents: records.filter(r => r.event.startsWith('knowledge.promotion') || r.event.startsWith('reconcile.')).map(r => ({ event: r.event, operationId: r.operationId, commitSha: r.commitSha, error: r.error ? { code: r.error.code, message: r.error.message } : undefined, context: r.context, ts: r.ts })).slice(0, 20),
    };
    // Diagnostic tree of the isolated data dir (depth 3) so file destinations
    // are auditable in evidence.
    const treeOf = (dir, depth) => {
      const out = [];
      if (depth < 0 || !fs.existsSync(dir)) return out;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        out.push(path.relative(fixture.dataDir, path.join(dir, entry.name)) + (entry.isDirectory() ? '/' : ''));
        if (entry.isDirectory() && depth > 0) out.push(...treeOf(path.join(dir, entry.name), depth - 1));
      }
      return out;
    };
    evidence.phases.dataDirTree = treeOf(fixture.dataDir, 3).slice(0, 200);
    if (evidence.phases.background.failed.length) throw new Error('no operation_failed expected on the all-valid normal path');

    // Knowledge promoted from the labelled offline stand-in: entries under the
    // project knowledge root naming the isolated automation test adapter.
    const knowledgeRoot = fixture.projects[0].knowledgePath;
    const mdFiles = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.md')) mdFiles.push({ file: path.relative(knowledgeRoot, full), content: fs.readFileSync(full, 'utf8') });
      }
    };
    walk(knowledgeRoot);
    evidence.phases.knowledge = {
      entries: mdFiles.map(f => ({ file: f.file, adapterLabelled: f.content.includes('isolated automation test adapter') })),
    };
    const promotedCount = mdFiles.filter(f => f.content.includes('isolated automation test adapter')).length;
    if (promotedCount < 2) throw new Error(`expected >=2 promoted knowledge entries from the two commits, got ${promotedCount}`);

    // Health throughout + no premature exit.
    const health = await fetch(`${base}/api/health`);
    evidence.phases.healthAfterHooks = { status: health.status, exitInfo };
    if (!health.ok || exitInfo !== null) throw new Error(`server unhealthy or exited during normal processing: ${JSON.stringify({ status: health.status, exitInfo })}`);

    // Disk truth BEFORE shutdown (spawnServer.cleanup removes the data dir):
    // lastAnalyzedCommit advanced to the last commit.
    const stateFile = path.join(fixture.dataDir, 'projects', PROJECT_A, 'state.json');
    const readState = p => JSON.parse(fs.readFileSync(p, 'utf8'));
    let state;
    try { state = readState(stateFile); } catch {
      const candidates = [];
      const projDir = path.join(fixture.dataDir, 'projects');
      for (const name of fs.readdirSync(projDir)) {
        const candidate = path.join(projDir, name, 'state.json');
        if (fs.existsSync(candidate) && readState(candidate).lastAnalyzedCommit) candidates.push(readState(candidate));
      }
      state = candidates[0];
    }
    evidence.phases.projectState = { lastAnalyzedCommit: state?.lastAnalyzedCommit, expected: sha3 };
    if (state?.lastAnalyzedCommit !== sha3) throw new Error(`lastAnalyzedCommit did not advance to ${sha3}: ${state?.lastAnalyzedCommit}`);

    // Orderly shutdown via the verified control channel (drain path).
    const stopStarted = Date.now();
    await server.cleanup();
    evidence.phases.shutdown = { stopStartedAt: new Date(stopStarted).toISOString(), exitInfo, stoppedWithinMs: Date.now() - stopStarted };

    if (exitInfo === null) throw new Error('server did not exit after control-channel stop');
    evidence.verdict = 'PASS';
    console.log('R2 normalhook PASS');
    process.exitCode = 0;
  } catch (error) {
    evidence.verdict = { failed: String((error && error.stack) || error) };
    // Failure-path visibility: the CI console is the only artifact the runner
    // keeps. A health timeout must name the server's own exit cause, its
    // captured stdout/stderr tails, and whether the port ever answered.
    let probeAfterFailure = null;
    try {
      const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1500) });
      probeAfterFailure = { answered: true, ok: response.ok, status: response.status };
    } catch (probeError) {
      probeAfterFailure = { answered: false, code: (probeError && probeError.cause && (probeError.cause.code || probeError.cause.message)) || String(probeError && probeError.message || probeError) };
    }
    evidence.debugFailureProbe = probeAfterFailure;
    console.error(`R2 normalhook FAIL: ${error.message}`);
    console.error(`R2 normalhook server state: ${JSON.stringify({ port, pid: server.child.pid, exitInfo, probeAfterFailure })}`);
    console.error(`R2 normalhook server stderr tail:\n${serverStderr.slice(-1600)}`);
    console.error(`R2 normalhook server stdout tail:\n${serverStdout.slice(-1600)}`);
    process.exitCode = 1;
  } finally {
    evidence.debugServerIo = { exitInfo, stdoutTail: serverStdout.slice(-4000), stderrTail: serverStderr.slice(-4000) };
    evidence.finishedAt = now();
    fs.mkdirSync(ARTIFACTS, { recursive: true });
    fs.writeFileSync(path.join(ARTIFACTS, 'normalhook-evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
    try {
      await server.cleanup();
      // cleanup() stops the control channel and kills, but a child wedged
      // mid-startup can survive the signal — and its process handle keeps
      // THIS process alive (the linux22 CI shape: FAIL at 30s, hang to the
      // 80s hard timer). The exit decision belongs to this test, not to the
      // child.
      if (exitInfo === null) { try { server.child.kill('SIGKILL'); } catch {} }
    } finally { fixture.cleanup(); }
    lane.cleanup();
  }
}

const hardTimer = setTimeout(() => {
  try {
    fs.mkdirSync(ARTIFACTS, { recursive: true });
    fs.writeFileSync(path.join(ARTIFACTS, 'hard-timeout.json'), JSON.stringify({ at: now(), exitInfo, stdoutTail: serverStdout.slice(-1600), stderrTail: serverStderr.slice(-1600) }, null, 2) + '\n');
  } catch {}
  try { if (server && exitInfo === null) server.child.kill('SIGKILL'); } catch {}
  console.error('normalhook HARD TIMEOUT');
  process.exit(2);
}, HARD_TIMEOUT_MS);
hardTimer.unref();

main();
