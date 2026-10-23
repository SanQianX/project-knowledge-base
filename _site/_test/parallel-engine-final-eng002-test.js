'use strict';

// P-ENG-FINAL ENG-002 真实Hook闭环 (real hook closed loop) acceptance driver.
//
// Case (qa-autopilot/config/test-cases.json ENG-002, P1):
//   steps:    导入fixture→新增真实git commit→等待journal→claim→晋升→查询。
//   expected: 1) 按完整SHA绑定证据。
//             2) Markdown与检索引用一致。
//             3) 不能直接API造任务替代Hook验收。
//
// What is real here:
//   * a real fixture Git repository and a real `git commit`;
//   * a REAL post-commit hook (a separate OS process running the real
//     ai-coding-event-bridge commit-boundary CLI) that appends the boundary
//     event to an isolated bridge journal;
//   * the real bridge console server (isolated --home) that the engine polls;
//   * the real VENDORED knowledge-engine (consume mode) that drains the
//     journal, binds the claim, promotes knowledge and syncs the index;
//   * the real vector-hub server (isolated root) with deterministic test
//     embeddings - the paid embedding API is NOT exercised.
//
// The driver NEVER calls POST /api/runs: the run must arrive through the
// journal (trigger 'git-hook'), while the API path would stamp
// trigger 'manual-debug' (server.js:137 vs coordinator.js:193).
//
// Analyzer = deterministic stand-in (NO real model output). No quota access, no
// PAYG, no user HOME/credentials/memory/trust, no production ports.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  makeLaneDir, buildFixtureRepo, installPostCommitHook, startBridge, startVector,
  startEngine, waitUntil, callJson, git, gitRun, listFilesRecursive, saveEvidence, hashText,
} = require('./helpers/parallel-engine-final-harness.js');
const { createStandinAnalyzer } = require('./helpers/parallel-engine-final-standin-analyzer.js');

const ARTIFACTS = process.env.PK_TEST_EVIDENCE_ROOT
  ? path.join(process.env.PK_TEST_EVIDENCE_ROOT, 'eng002')
  : path.resolve(__dirname, '../../qa-autopilot/artifacts/parallel-20261023/engine-review-r3/reruns/eng002');
const PROJECT_ID = 'project-eng002';

function findJournalFiles(root) {
  const out = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.name === 'events.jsonl') out.push(absolute);
    }
  };
  if (fs.existsSync(root)) walk(root);
  return out;
}

async function main() {
  const lane = makeLaneDir('eng002');
  const commands = [];
  const evidence = { caseId: 'ENG-002', laneDir: lane, phases: {}, commands };

  const fixture = buildFixtureRepo(lane, 'eng002', []);
  const knowledgePath = path.join(lane, 'knowledge-eng002');
  const storePath = path.join(knowledgePath, 'dev-conversations');
  fs.mkdirSync(storePath, { recursive: true });
  const home = path.join(lane, 'bridge-home');
  const dataDir = path.join(lane, 'engine-data');
  const vectorRoot = path.join(lane, 'vector-root');
  const eventsFile = path.join(lane, 'analyzer-events.jsonl');

  const bridge = startBridge(home);
  let engine = null;
  const analyzer = createStandinAnalyzer({
    eventsFile,
    readSnapshot: (projectId, commitSha) => engine?.runtime.coordinator.conversations.readSnapshot(projectId, commitSha),
  });

  try {
    const bridgeUrl = await bridge.listen();
    const vector = await startVector(vectorRoot);
    engine = await startEngine({ dataDir, bridgeUrl, vectorUrl: vector.url, analyzer });
    const engineUrl = await engine.listen();
    commands.push('start real bridge console (isolated home) + real vector-hub (isolated root) + vendored engine (consume mode)');

    // 导入fixture: register the fixture repo as a bridge project and register
    // the project in the engine (same shape as the engine's own integration
    // fixture: journal id = bridge project id, repo identity from the repo).
    const registered = await bridge.projectRegistry.addProject({ home, path: fixture.repoPath, store: storePath });
    const { repoIdentity } = await bridge.resolveRepoContext(fixture.repoPath);
    engine.runtime.store.addProject({
      projectId: PROJECT_ID,
      repoPath: fixture.repoPath,
      knowledgePath,
      trackingStartCommit: fixture.baseline,
      repoIdentity,
      journalId: registered.id,
      conversationBaselineCursor: 0,
    });
    commands.push(`bridge project registered id=${registered.id.slice(0, 12)}…; engine project registered`);

    // A real human conversation event so the frozen claim carries evidence.
    const humanText = '请把所有项目的长期偏好设为：统一使用中文注释。';
    await bridge.bridge.captureWorkbenchEvent({
      eventType: 'user_prompt',
      source: 'claude-code',
      projectPath: fixture.repoPath,
      sessionId: 'session-eng002',
      turnId: 'turn-eng002',
      eventKey: 'workbench:eng002:origin=human',
      content: humanText,
    });
    commands.push('bridge captureWorkbenchEvent (eventKey origin=human)');

    // REAL git hook: separate OS process, real bridge CLI, isolated home.
    const hook = installPostCommitHook(fixture.repoPath, { home, mode: 'ok' });
    commands.push(`installed real post-commit hook: ${hook.hookPath}`);

    // 新增真实git commit -> the hook fires as its own process.
    fs.writeFileSync(path.join(fixture.repoPath, 'feature.txt'), `feature X\n${'y'.repeat(64)}\n`);
    git(fixture.repoPath, ['add', '.']);
    const commit = gitRun(fixture.repoPath, ['commit', '-qm', 'feature X']);
    assert.equal(commit.code, 0, `real commit failed: ${commit.stderr}`);
    const gitSha = git(fixture.repoPath, ['rev-parse', 'HEAD']);
    assert.match(gitSha, /^[a-f0-9]{40}$/, 'full 40-hex commit SHA');
    commands.push(`real git commit -> ${gitSha} (exit 0)`);

    // 等待journal -> claim -> 晋升
    await callJson(engineUrl, '/api/bridge/notify', {});
    const run = await waitUntil(async () => {
      const runs = engine.runtime.store.listRuns(PROJECT_ID);
      return runs.length === 1 && runs[0].state === 'succeeded' ? runs[0] : null;
    }, 60000, 'journal-driven run reaches succeeded');
    const trigger = run.trigger;

    // --- Evidence 1: 按完整SHA绑定证据 ---
    const journalFiles = findJournalFiles(path.join(home)).concat(findJournalFiles(storePath));
    const boundaryEvents = [];
    for (const file of journalFiles) {
      for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
        const event = JSON.parse(line);
        if (event.schema === 'git-commit-boundary/v1') boundaryEvents.push({ file, event });
      }
    }
    const boundary = boundaryEvents.find(entry => entry.event.commitSha === gitSha);
    assert.ok(boundary, `boundary event for ${gitSha} not found in ${journalFiles.length} journal file(s)`);
    assert.match(boundary.event.commitSha, /^[a-f0-9]{40}$/, 'journal binds the FULL SHA');
    assert.equal(boundary.event.repoIdentity?.workspaceRoot ? path.resolve(boundary.event.repoIdentity.workspaceRoot).toLowerCase() : null, path.resolve(fixture.repoPath).toLowerCase(), 'boundary carries the real repo identity');

    assert.equal(run.commitSha, gitSha, 'engine run binds the full SHA');
    assert.equal(run.commitSha.length, 40);
    const stateOnDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'engine-state.json'), 'utf8'));
    const runtimeState = stateOnDisk.projects.find(p => p.projectId === PROJECT_ID).runtime;
    assert.equal(runtimeState.lastAnalyzedCommit, gitSha, 'pointer advanced to the full SHA');
    const ledgerFile = path.join(dataDir, 'runtime', 'processed-commits', PROJECT_ID, `${gitSha}.json`);
    assert.ok(fs.existsSync(ledgerFile), 'processing ledger is keyed by the FULL SHA');
    const ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
    assert.equal(ledger.commitSha, gitSha);
    const promotionsDir = path.join(dataDir, 'runtime', 'promotions', PROJECT_ID);
    const promotionFiles = fs.readdirSync(promotionsDir);
    const promotion = JSON.parse(fs.readFileSync(path.join(promotionsDir, promotionFiles[0]), 'utf8'));
    assert.ok(JSON.stringify(promotion).includes(gitSha), 'promotion journal binds the full SHA');
    // The staging manifest lives under the RECONCILER's own run id (a content
    // hash), not the store run id, so it is located by scanning the run roots.
    const runRoots = fs.existsSync(path.join(dataDir, 'runtime', 'runs', PROJECT_ID))
      ? fs.readdirSync(path.join(dataDir, 'runtime', 'runs', PROJECT_ID))
      : [];
    const manifestFiles = runRoots
      .map(root => path.join(dataDir, 'runtime', 'runs', PROJECT_ID, root, 'output', 'manifest.json'))
      .filter(file => fs.existsSync(file));
    assert.equal(manifestFiles.length, 1, `exactly one staging manifest persisted (found ${manifestFiles.length} under ${runRoots.length} run root(s))`);
    const manifestFile = manifestFiles[0];
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    const commitRefs = manifest.operations.flatMap(op => op.evidenceReferences || []).filter(ref => ref.startsWith('commit:'));
    assert.ok(commitRefs.includes(`commit:${gitSha}`), 'manifest evidence reference uses the full SHA');

    evidence.phases.fullShaBinding = {
      gitSha,
      journalBoundary: { file: path.basename(boundary.file), sequence: boundary.event.sequence, commitSha: boundary.event.commitSha, workspaceRoot: boundary.event.repoIdentity?.workspaceRoot, parents: boundary.event.parents || null },
      run: { runId: run.runId, trigger, state: run.state, phase: run.phase, commitSha: run.commitSha, promotedAt: run.promotedAt },
      ledger: { path: path.relative(dataDir, ledgerFile), commitSha: ledger.commitSha, status: ledger.status },
      manifestCommitReferences: commitRefs,
      manifestFile: path.relative(dataDir, manifestFile).replace(/\\/g, '/'),
      manifestRunId: manifest.runId,
      reconcilerRunRoots: runRoots,
      promotionJournalPhase: promotion.phase,
      lastAnalyzedCommit: runtimeState.lastAnalyzedCommit,
    };

    // --- Evidence 2: Markdown与检索引用一致 ---
    const promotedPath = path.join(knowledgePath, 'changes', `${gitSha.slice(0, 12)}.md`);
    assert.ok(fs.existsSync(promotedPath), 'promoted markdown exists');
    const markdown = fs.readFileSync(promotedPath, 'utf8');
    assert.ok(markdown.includes(gitSha), 'promoted markdown cites the full SHA');
    const search = await callJson(engineUrl, '/api/search', { projectId: PROJECT_ID, query: gitSha });
    assert.equal(search.status, 200, `search failed: ${JSON.stringify(search.body).slice(0, 400)}`);
    const hits = (search.body.results || []).filter(row => (row.chunk_text || row.snippet || '').includes(gitSha));
    assert.ok(hits.length, `retrieval returned no hit for the full SHA (results=${(search.body.results || []).length})`);
    const hit = hits[0];
    const hubSearch = await vector.manager.hub.search(gitSha, { projects: [PROJECT_ID] });
    assert.ok(hubSearch.results.length, 'real vector index holds the promoted document');
    evidence.phases.markdownAndRetrieval = {
      promotedFile: path.relative(knowledgePath, promotedPath).replace(/\\/g, '/'),
      knowledgeTree: listFilesRecursive(knowledgePath),
      markdownSha256: hashText(markdown),
      markdownCitesFullSha: markdown.includes(gitSha),
      retrieval: { hitCount: hits.length, entryId: hit.entry_id, spaceId: hit.space_id, score: hit.relevance_score, indexHealth: search.body.health?.index || null },
      vectorIndex: { resultCount: hubSearch.results.length, firstUri: hubSearch.results[0]?.uri || null, snippetHasSha: (hubSearch.results[0]?.snippet || '').includes(gitSha) },
      runIndexState: run.indexState,
    };
    assert.equal(hit.entry_id, `changes/${gitSha.slice(0, 12)}.md`, 'retrieval entry id matches the promoted file');
    assert.equal(run.indexState, 'succeeded', 'index sync to the real vector service succeeded');

    // --- Evidence 3: 不能直接API造任务替代Hook验收 ---
    const cursors = engine.runtime.store.state.journalCursors || {};
    const consumer = await bridge.bridge.getConsumer('knowledge-engine');
    evidence.phases.hookProvenance = {
      apiRunCallsMadeByDriver: 0,
      runTrigger: trigger,
      apiPathTriggerWouldBe: 'manual-debug',
      journalCursor: cursors[registered.id],
      bridgeConsumerCursor: consumer?.cursors?.[registered.id] ?? null,
      totalRunsForProject: engine.runtime.store.listRuns(PROJECT_ID).length,
      analyzerInvocations: fs.existsSync(eventsFile) ? fs.readFileSync(eventsFile, 'utf8').split('\n').filter(Boolean).length : 0,
    };
    assert.equal(trigger, 'git-hook', 'run came from the journal/hook path, not from POST /api/runs');
    assert.ok(cursors[registered.id] >= 1, 'engine consumed the journal (cursor advanced)');
    assert.ok((consumer?.cursors?.[registered.id] ?? 0) >= 1, 'engine acked the bridge journal cursor');
    assert.equal(engine.runtime.store.listRuns(PROJECT_ID).length, 1, 'exactly one run - no API-created duplicate');

    evidence.verdict = {
      'expected1 按完整SHA绑定证据': 'PASS',
      'expected2 Markdown与检索引用一致': 'PASS',
      'expected3 不能直接API造任务替代Hook验收': 'PASS',
      realHook: 'real post-commit hook as a separate OS process running the real bridge commit-boundary CLI; journal boundary event verified on disk',
      analyzerStandin: 'deterministic stand-in - NO real model output covered',
      vectorService: 'real vector-hub server, deterministic test embeddings - paid embedding API NOT covered',
      bridge: 'real ai-coding-event-bridge console + journal (isolated home) - real bridge, not a stub',
    };
    await engine.close();
    await vector.close();
    await bridge.close();
    saveEvidence(ARTIFACTS, 'eng002-evidence.json', evidence);
    console.log('ENG-002 PASS');
    process.exit(0);
  } catch (error) {
    evidence.verdict = { failed: String((error && error.stack) || error) };
    try { await engine?.close(); } catch {}
    try { await vector?.close(); } catch {}
    try { await bridge.close(); } catch {}
    saveEvidence(ARTIFACTS, 'eng002-evidence.json', evidence);
    console.error(`ENG-002 FAIL: ${error.message}`);
    process.exit(1);
  }
}

main();
