'use strict';

// P-ENGINE-OFFLINE-AUDIT-R45 driver: ENG-007 offline compensation boundary
// audit on real bytes (real fixture Git, real bridge CLI hook as a separate OS
// process, real bridge journal, real vector-hub with deterministic test
// embeddings, real VENDORED knowledge-engine 0.2.7-rc.11).
//
// Scenario (delta vs the accepted engine-final eng007 driver, which proved the
// single-commit compensation):
//   1. C0 is analysed ONLINE (completed SHA before the outage).
//   2. The ENGINE test service alone is stopped ("仅停测试服务"; bridge+journal
//      stay up). One commit U1 happens with a hook whose real CLI runs but the
//      bridge home is an unreachable destination ("Hook不可达"): Git must not be
//      blocked and no boundary event may appear.
//   3. Three consecutive commits B1,B2,B3 happen offline with the working hook;
//      their boundary events accumulate in the durable journal while the
//      engine is down.
//   4. Engine restart: the startup drain must backfill the whole ahead
//      interval B1->B2->B3 IN ORDER (strictly serial: each analysis finishes
//      before the next starts), each SHA exactly once, pointer ends at B3,
//      C0 is NOT re-analysed, U1 is never analysed (documented boundary).
//   5. A duplicated boundary event for the completed B2 is consumed with no
//      second run; a further restart changes nothing.
//
// Analyzer = deterministic stand-in (no real model output; the stand-in's
// claims are never presented as real-model behaviour). No quota/PAYG access.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  makeLaneDir, buildFixtureRepo, startBridge, startVector, startEngine, waitUntil,
  callJson, git, gitRun, readJsonl, saveEvidence, isolatedEnv, BRIDGE_CLI,
  EVIDENCE_ROOT, TEMP_ROOT, ENV_ISOLATION_RESOLVED, installHookVariant, makeDeadHome,
  RUNTIME_IDENTITY,
} = require('./helpers/qa-r45-harness.js');
const { createStandinAnalyzer } = require('./helpers/parallel-engine-final-standin-analyzer.js');

const PROJECT_ID = 'project-r45';

function findJournalFiles(root) {
  const out = [];
  const walk = dir => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.name === 'events.jsonl') out.push(absolute);
    }
  };
  walk(root);
  return out;
}

function boundaryEvents(...roots) {
  const events = [];
  for (const file of roots.flatMap(findJournalFiles)) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
      const event = JSON.parse(line);
      if (event.schema === 'git-commit-boundary/v1') events.push(event);
    }
  }
  return events.sort((a, b) => a.sequence - b.sequence);
}

function sha256(file) {
  return require('node:crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function commitFile(repoPath, name, body) {
  fs.writeFileSync(path.join(repoPath, name), `${body}\n${name.repeat(48)}\n`);
  git(repoPath, ['add', '.']);
  const result = gitRun(repoPath, ['commit', '-qm', `feature ${name}`]);
  const sha = git(repoPath, ['rev-parse', 'HEAD']);
  return { result, sha };
}

async function main() {
  const lane = makeLaneDir('qa-r45-offline');
  const commands = [];
  const evidence = {
    caseId: 'ENG-007', lane: 'P-ENGINE-OFFLINE-AUDIT-R45', laneDir: lane, phases: {}, commands,
    isolation: { tempRoot: TEMP_ROOT, evidenceRoot: EVIDENCE_ROOT, envIsolation: ENV_ISOLATION_RESOLVED },
    identity: {
      vendoredEngineVersion: JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', '_modules', 'knowledge-engine', 'package.json'), 'utf8')).version,
      vendoredCoordinatorSha256: sha256(path.resolve(__dirname, '..', '..', '_modules', 'knowledge-engine', 'src', 'coordinator.js')),
      bridge: RUNTIME_IDENTITY.bridge, vector: RUNTIME_IDENTITY.vector,
    },
  };

  const fixture = buildFixtureRepo(lane, 'r45', []);
  const knowledgePath = path.join(lane, 'knowledge-r45');
  const storePath = path.join(knowledgePath, 'dev-conversations');
  fs.mkdirSync(storePath, { recursive: true });
  const home = path.join(lane, 'bridge-home');
  const dataDir = path.join(lane, 'engine-data');
  const vectorRoot = path.join(lane, 'vector-root');
  const eventsFile = path.join(lane, 'analyzer-events.jsonl');

  const bridge = startBridge(home);
  let engine = null;
  let vector = null;
  const analyzer = createStandinAnalyzer({ eventsFile });
  const startsFor = sha => readJsonl(eventsFile).filter(e => e.kind === 'start' && e.commitSha === sha);
  const runFor = sha => engine.runtime.store.listRuns(PROJECT_ID).filter(r => r.commitSha === sha);
  const lastAnalyzed = () => engine.runtime.store.getProject(PROJECT_ID)?.runtime?.lastAnalyzedCommit || null;
  const ledgerFile = sha => path.join(dataDir, 'runtime', 'processed-commits', PROJECT_ID, `${sha}.json`);

  try {
    const bridgeUrl = await bridge.listen();
    vector = await startVector(vectorRoot);
    const registered = await bridge.projectRegistry.addProject({ home, path: fixture.repoPath, store: storePath });
    const { repoIdentity } = await bridge.resolveRepoContext(fixture.repoPath);
    commands.push(`bridge project registered id=${registered.id.slice(0, 12)}…; console ${bridgeUrl}`);

    // lifecycle 0: project registered with the engine offline (consumer off)
    engine = await startEngine({ dataDir, bridgeUrl, vectorUrl: vector.url, analyzer, consume: false });
    await engine.listen();
    engine.runtime.store.addProject({
      projectId: PROJECT_ID, repoPath: fixture.repoPath, knowledgePath,
      trackingStartCommit: fixture.baseline, repoIdentity, journalId: registered.id, conversationBaselineCursor: 0,
    });
    await engine.close();
    engine = null;

    // ---------- phase 1: C0 analysed ONLINE (completed SHA before outage) ----------
    engine = await startEngine({ dataDir, bridgeUrl, vectorUrl: vector.url, analyzer, consume: true });
    await engine.listen();
    installHookVariant(fixture.repoPath, { home, mode: 'ok' });
    const c0 = commitFile(fixture.repoPath, 'online-c0', 'online feature C0');
    assert.equal(c0.result.code, 0, `online commit failed: ${c0.result.stderr}`);
    const runC0 = await waitUntil(async () => {
      const run = engine.runtime.store.listRuns(PROJECT_ID).find(r => r.commitSha === c0.sha);
      return run && run.state === 'succeeded' ? run : null;
    }, 60000, 'online commit C0 is analysed while the engine runs');
    assert.equal(startsFor(c0.sha).length, 1, 'C0 analysed exactly once online');
    assert.equal(lastAnalyzed(), c0.sha, 'pointer at C0 before the outage');
    commands.push(`C0=${c0.sha.slice(0, 8)} analysed online (run ${runC0.runId}, trigger=${runC0.trigger})`);

    // ---------- phase 2: stop ONLY the engine; U1 with an unreachable bridge home ----------
    await engine.close();
    engine = null;
    const deadHome = makeDeadHome(lane);
    installHookVariant(fixture.repoPath, { home: deadHome, mode: 'deadhome' });
    const u1 = commitFile(fixture.repoPath, 'offline-unreachable-u1', 'offline feature U1 (hook CLI up, bridge home unreachable)');
    assert.equal(u1.result.code, 0, `Git must not be blocked by the unreachable-bridge hook (exit ${u1.result.code}): ${u1.result.stderr}`);
    assert.notEqual(u1.result.stderr.length, 0, 'the real CLI surfaced its failure through the hook');
    assert.equal(boundaryEvents(home, storePath).filter(e => e.commitSha === u1.sha).length, 0, 'no boundary event for the unreachable-hook commit');
    evidence.phases.hookUnreachable = {
      commitSha: u1.sha, gitExit: u1.result.code, hookStderr: u1.result.stderr,
      boundaryEvents: 0,
      boundary: 'the real CLI ran as its own process and failed against an unwritable bridge home; the journal never learned about U1; Git itself succeeded',
    };
    commands.push(`U1=${u1.sha.slice(0, 8)} committed with unreachable bridge home -> git exit 0, no boundary event`);

    // ---------- phase 3: consecutive offline commits B1..B3 with the working hook ----------
    installHookVariant(fixture.repoPath, { home, mode: 'ok' });
    const offline = [];
    for (const label of ['offline-b1', 'offline-b2', 'offline-b3']) {
      const commit = commitFile(fixture.repoPath, label, `offline feature ${label}`);
      assert.equal(commit.result.code, 0, `offline commit ${label} failed: ${commit.result.stderr}`);
      offline.push({ label, sha: commit.sha });
    }
    const boundaries = boundaryEvents(home, storePath);
    for (const { label, sha } of offline) {
      const own = boundaries.filter(e => e.commitSha === sha);
      assert.equal(own.length, 1, `exactly one boundary event for ${label}`);
    }
    const sequences = offline.map(({ sha }) => boundaries.find(e => e.commitSha === sha).sequence);
    assert.ok(sequences[0] < sequences[1] && sequences[1] < sequences[2], 'journal sequences increase in commit order');
    const cursorWhileStopped = JSON.parse(fs.readFileSync(path.join(dataDir, 'engine-state.json'), 'utf8')).journalCursors[registered.id] || 0;
    assert.ok(cursorWhileStopped < sequences[2], 'the stopped engine consumed none of the offline events');
    evidence.phases.offlineInterval = {
      commits: offline.map((o, i) => ({ label: o.label, sha: o.sha, journalSequence: sequences[i] })),
      engineWasDown: true, cursorWhileStopped,
    };
    commands.push(`offline B1..B3 committed while engine DOWN (sequences ${sequences.join('<')}); engine cursor stayed ${cursorWhileStopped}`);

    // ---------- phase 4: restart -> ordered backfill of the ahead interval ----------
    engine = await startEngine({ dataDir, bridgeUrl, vectorUrl: vector.url, analyzer, consume: true });
    const engineUrl = await engine.listen();
    await waitUntil(async () => {
      for (const { sha } of offline) {
        const run = engine.runtime.store.listRuns(PROJECT_ID).find(r => r.commitSha === sha);
        if (!run || run.state !== 'succeeded') return null;
      }
      return lastAnalyzed() === offline[2].sha || null;
    }, 90000, 'startup drain backfills B1..B3 and advances the pointer to B3');

    const log = readJsonl(eventsFile);
    const idx = predicate => log.findIndex(predicate);
    const order = offline.map(({ sha }) => sha);
    const startIdx = order.map(sha => idx(e => e.kind === 'start' && e.commitSha === sha));
    const finishIdx = order.map(sha => idx(e => e.kind === 'finish' && e.commitSha === sha));
    assert.ok(startIdx.every(i => i >= 0), 'each offline SHA has an analyzer start event');
    assert.ok(startIdx[0] < startIdx[1] && startIdx[1] < startIdx[2], `analyses ran in commit order (start indices ${startIdx})`);
    assert.ok(finishIdx[0] < startIdx[1] && finishIdx[1] < startIdx[2], `analyses were strictly serial: each finished before the next started (finish ${finishIdx} vs start ${startIdx})`);
    for (const { sha, label } of offline) {
      assert.equal(startsFor(sha).length, 1, `${label} analysed exactly once during backfill`);
      assert.equal(JSON.parse(fs.readFileSync(ledgerFile(sha), 'utf8')).status, 'completed', `${label} ledger completed`);
      assert.ok(fs.existsSync(path.join(knowledgePath, 'changes', `${sha.slice(0, 12)}.md`)), `${label} promoted knowledge`);
      const run = runFor(sha)[0];
      assert.equal(run.trigger, 'git-hook', `${label} came through the journal/hook path`);
    }
    assert.equal(startsFor(c0.sha).length, 1, 'completed C0 was NOT re-analysed during the backfill');
    assert.equal(runFor(c0.sha).length, 1, 'no second run for completed C0');
    assert.equal(startsFor(u1.sha).length, 0, 'the unreachable-hook commit U1 was never analysed (documented boundary)');
    assert.equal(runFor(u1.sha).length, 0, 'no run record for U1');
    assert.ok(!fs.existsSync(ledgerFile(u1.sha)), 'no ledger record for U1');
    assert.equal(lastAnalyzed(), offline[2].sha, 'pointer ends at B3');
    const cursorAfterBackfill = engine.runtime.store.state.journalCursors[registered.id] || 0;
    assert.ok(cursorAfterBackfill >= sequences[2], 'journal cursor advanced past the last offline event');
    evidence.phases.orderedBackfill = {
      analysisStartIndices: startIdx, analysisFinishIndices: finishIdx,
      strictSerialOrder: true, invocations: Object.fromEntries([...offline.map(o => [o.label, startsFor(o.sha).length]), ['C0', startsFor(c0.sha).length], ['U1', startsFor(u1.sha).length]]),
      lastAnalyzedCommit: lastAnalyzed(), journalCursorAfter: cursorAfterBackfill,
      ledgerCompleted: [...offline.map(o => o.sha), c0.sha].map(sha => ({ sha: sha.slice(0, 8), status: JSON.parse(fs.readFileSync(ledgerFile(sha), 'utf8')).status })),
      u1LedgerExists: fs.existsSync(ledgerFile(u1.sha)),
      healthCounts: (await callJson(engineUrl, '/api/health')).body.counts,
    };
    commands.push(`restart backfilled B1->B2->B3 strictly in order; C0 kept 1 invocation; U1 untouched; pointer=${lastAnalyzed().slice(0, 8)}`);

    // ---------- phase 5: duplicated boundary for completed B2 + restart stability ----------
    const replay = spawnSync(process.execPath, [BRIDGE_CLI, '--home', home, '--cwd', fixture.repoPath, '--sha', offline[1].sha], {
      cwd: fixture.repoPath, windowsHide: true, encoding: 'utf8', env: isolatedEnv(),
    });
    assert.equal(replay.status, 0, `replaying the boundary event failed: ${replay.stderr}`);
    const cursorBeforeReplay = engine.runtime.store.state.journalCursors[registered.id] || 0;
    await waitUntil(async () => (engine.runtime.store.state.journalCursors[registered.id] || 0) > cursorBeforeReplay, 20000, 'the duplicated boundary event is consumed');
    assert.equal(runFor(offline[1].sha).length, 1, 'no second run for the completed offline SHA B2');
    assert.equal(startsFor(offline[1].sha).length, 1, 'B2 not analysed again after duplicate delivery');

    await engine.close();
    engine = await startEngine({ dataDir, bridgeUrl, vectorUrl: vector.url, analyzer, consume: true });
    await engine.listen();
    await new Promise(resolve => setTimeout(resolve, 3000));
    const runsAfterRestart = engine.runtime.store.listRuns(PROJECT_ID);
    assert.equal(runsAfterRestart.length, 4, 'after restart: exactly C0+B1+B2+B3 runs');
    assert.equal(runsAfterRestart.filter(r => r.state === 'succeeded').length, 4, 'all runs succeeded');
    for (const sha of [c0.sha, ...offline.map(o => o.sha)]) {
      assert.equal(startsFor(sha).length, 1, `no re-analysis of ${sha.slice(0, 8)} after restart`);
    }
    assert.equal(fs.readdirSync(path.join(knowledgePath, 'changes')).length, 4, 'no duplicate promoted knowledge');
    evidence.phases.completedShaNotRerun = {
      duplicatedBoundaryFor: offline[1].sha.slice(0, 8), consumedCursorAdvance: true,
      runsForB2: runFor(offline[1].sha).length, invocationsB2: startsFor(offline[1].sha).length,
      restartRunCount: runsAfterRestart.length, restartAllSucceeded: true,
      promotedKnowledgeFiles: fs.readdirSync(path.join(knowledgePath, 'changes')).length,
      lastAnalyzedCommit: lastAnalyzed(),
    };
    commands.push(`duplicate B2 boundary consumed with no rerun; second restart stable at ${runsAfterRestart.length} runs`);

    evidence.verdict = {
      'git-not-blocked (unreachable-bridge hook variant)': 'PASS - real CLI process failed against an unwritable bridge home, git exit 0, no boundary event',
      'ordered ahead-interval backfill after restart': 'PASS - B1->B2->B3 strictly serial in commit order via the real journal/hook path, exactly once each, pointer ends at B3',
      'completed-sha-not-rerun': 'PASS - C0 kept exactly one analysis across the backfill, duplicate B2 delivery, and a further restart',
      'hook-unreachable commit U1': 'DOCUMENTED BOUNDARY - never analysed, no run, no ledger (no journal event exists to compensate; the engine does not scan Git history)',
      analyzerStandin: 'deterministic stand-in - NO real model output covered',
      vectorService: 'real vector-hub server, deterministic test embeddings - paid embedding API NOT covered',
    };
    await engine.close();
    await vector.close();
    await bridge.close();
    saveEvidence(EVIDENCE_ROOT, 'offline-backfill-evidence.json', evidence);
    console.log('QA-R45 OFFLINE-BACKFILL PASS');
    process.exit(0);
  } catch (error) {
    evidence.verdict = { failed: String((error && error.stack) || error) };
    try { await engine?.close(); } catch {}
    try { await vector?.close(); } catch {}
    try { await bridge.close(); } catch {}
    saveEvidence(EVIDENCE_ROOT, 'offline-backfill-evidence.json', evidence);
    console.error(`QA-R45 OFFLINE-BACKFILL FAIL: ${error.message}`);
    process.exit(1);
  }
}

main();
