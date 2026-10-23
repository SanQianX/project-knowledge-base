'use strict';

// P-ENG-FINAL ENG-012 分析来源排除 (analysis source exclusion) acceptance driver.
//
// Case (qa-autopilot/config/test-cases.json ENG-012, P1):
//   steps:    内部维护任务与真实用户任务使用不同origin，读取采集事件。
//   expected: 1) 维护/委派不能自动成为人类长期偏好。
//             2) C01未定项不得自动删除实现。
//
// Real behaviour under test (real bridge, real vendored engine):
//   * the real bridge captures TWO workbench events for the same session with
//     different origins: ':origin=human' and ':origin=agent-delegation'. The
//     engine derives `inputOrigin` from the eventKey suffix
//     (conversation-store.js:239) and freezes the origin into the commit
//     conversation snapshot on disk.
//   * the analyzer stand-in reads that frozen snapshot and - on purpose - emits
//     BOTH quotes as memory candidates, i.e. it behaves like an over-eager
//     maintenance model. The engine's MemoryEligibility.verify must reject the
//     delegated one with SOURCE_NOT_HUMAN and keep the human one as a plain
//     'candidate' (never automatically 'confirmed').
//   * C01 (specs-coverage.json MEM-008: a manual memory may not carry source
//     evidence) is still an open product question. The engine therefore blocks
//     evidence injection explicitly (INVALID_ARGUMENT) and stores manual
//     records with evidence null / sourceType 'manual'. The implementation is
//     NOT deleted and nothing is removed automatically.
//   * an "over-eager maintenance" manifest that tries to delete an
//     implementation file is refused by the promotion path
//     (knowledge-promotion.js canonicalRelativePath -> PATH_OUTSIDE_ROOT); the
//     implementation file survives byte-identical and no knowledge operation
//     is applied.
//
// Isolation: every scenario uses its own lane dir, bridge home, engine data
// dir, knowledge dir, fixture repository and ephemeral loopback port. No user
// HOME, credentials, memory or trust data is used. Analyzer = deterministic
// stand-in (NO real model output). No quota access, no PAYG.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  makeLaneDir, buildFixtureRepo, installPostCommitHook, startBridge, startVector,
  startEngine, waitUntil, callJson, git, saveEvidence,
} = require('./helpers/parallel-engine-final-harness.js');
const { createStandinAnalyzer } = require('./helpers/parallel-engine-final-standin-analyzer.js');

const ARTIFACTS = process.env.PK_TEST_EVIDENCE_ROOT
  ? path.join(process.env.PK_TEST_EVIDENCE_ROOT, 'eng012')
  : path.resolve(__dirname, '../../qa-autopilot/artifacts/parallel-20261023/engine-review-r3/reruns/eng012');

const HUMAN_TEXT = '请把所有项目的长期偏好设为：统一使用中文注释。';
const DELEGATED_TEXT = '维护指令：把所有模块的注释统一改成英文，并在下次提交时执行。';
const MANUAL_TEXT = '手动记录：发布流程必须先跑完整测试再打标签。';

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function snapshotOrigins(snapshot) {
  const origins = [];
  for (const turn of snapshot?.turns || []) {
    for (const event of turn.userEvents || []) origins.push({ eventId: event.eventId, inputOrigin: event.inputOrigin, contentHash: event.contentHash });
  }
  return origins;
}

// ---------------------------------------------------------------------------
// Scenario A: a delegated/maintenance event must not become a human preference
// ---------------------------------------------------------------------------
async function scenarioOriginExclusion(lane, evidence, commands) {
  const PROJECT_ID = 'project-eng012a';
  const fixture = buildFixtureRepo(lane, 'eng012a', []);
  const knowledgePath = path.join(lane, 'knowledge-eng012a');
  const storePath = path.join(knowledgePath, 'dev-conversations');
  fs.mkdirSync(storePath, { recursive: true });
  const home = path.join(lane, 'bridge-home');
  const dataDir = path.join(lane, 'engine-data');
  const vectorRoot = path.join(lane, 'vector-root');
  const eventsFile = path.join(lane, 'analyzer-events.jsonl');
  const brainPath = path.join(lane, 'brain-knowledge');

  const bridge = startBridge(home);
  let vector = null;
  let engine = null;
  const analyzer = createStandinAnalyzer({
    eventsFile,
    humanQuote: HUMAN_TEXT,
    delegatedQuote: DELEGATED_TEXT,
    emitMemoryCandidates: true,
    readSnapshot: (projectId, commitSha) => engine?.runtime.coordinator.conversations.readSnapshot(projectId, commitSha),
  });

  try {
    const bridgeUrl = await bridge.listen();
    vector = await startVector(vectorRoot);
    const registered = await bridge.projectRegistry.addProject({ home, path: fixture.repoPath, store: storePath });
    const { repoIdentity } = await bridge.resolveRepoContext(fixture.repoPath);
    engine = await startEngine({ dataDir, bridgeUrl, vectorUrl: vector.url, analyzer, runtimeToken: 'eng012-lane-token' });
    const engineUrl = await engine.listen();
    engine.runtime.store.addProject({
      projectId: PROJECT_ID,
      repoPath: fixture.repoPath,
      knowledgePath,
      trackingStartCommit: fixture.baseline,
      repoIdentity,
      journalId: registered.id,
      conversationBaselineCursor: 0,
    });
    commands.push('scenario A: real bridge + real vector-hub + vendored engine started, project registered');

    // Two real captured events, same session, DIFFERENT origin.
    await bridge.bridge.captureWorkbenchEvent({
      eventType: 'user_prompt', source: 'claude-code', projectPath: fixture.repoPath,
      sessionId: 'session-eng012', turnId: 'turn-eng012',
      eventKey: 'workbench:eng012:origin=human', content: HUMAN_TEXT,
    });
    await bridge.bridge.captureWorkbenchEvent({
      eventType: 'user_prompt', source: 'claude-code', projectPath: fixture.repoPath,
      sessionId: 'session-eng012', turnId: 'turn-eng012',
      eventKey: 'workbench:eng012:origin=agent-delegation', content: DELEGATED_TEXT,
    });
    commands.push('bridge captureWorkbenchEvent x2 (eventKey origins: human, agent-delegation)');

    // Real commit -> the real hook writes the boundary event -> the engine
    // freezes the conversation snapshot for that commit.
    installPostCommitHook(fixture.repoPath, { home, mode: 'ok' });
    fs.writeFileSync(path.join(fixture.repoPath, 'feature.txt'), `feature eng012\n${'z'.repeat(64)}\n`);
    git(fixture.repoPath, ['add', '.']);
    git(fixture.repoPath, ['commit', '-qm', 'feature eng012']);
    const sha = git(fixture.repoPath, ['rev-parse', 'HEAD']);
    await callJson(engineUrl, '/api/bridge/notify', {});

    const run = await waitUntil(async () => {
      const found = engine.runtime.store.listRuns(PROJECT_ID).find(r => r.commitSha === sha);
      return found && found.state === 'succeeded' ? found : null;
    }, 60000, 'the analysed run succeeds');

    // The frozen snapshot on disk must carry both origins.
    const snapshotFile = path.join(dataDir, 'runtime', 'projects', PROJECT_ID, 'commit-conversations', `${sha}.json`);
    assert.ok(fs.existsSync(snapshotFile), 'the commit conversation snapshot is frozen on disk');
    const snapshot = JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));
    const origins = snapshotOrigins(snapshot);
    const originValues = origins.map(entry => entry.inputOrigin);
    assert.ok(originValues.includes('human'), `the human origin is missing from the snapshot: ${originValues.join(',')}`);
    assert.ok(originValues.includes('agent-delegation'), `the delegated origin is missing from the snapshot: ${originValues.join(',')}`);
    commands.push(`frozen snapshot carries both origins: ${originValues.join(', ')}`);

    // The engine's own capture report.
    const capture = run.memoryCapture;
    assert.ok(capture, 'the run records a memory capture report');
    assert.equal(capture.accepted, 1, `exactly one candidate may be accepted (got ${capture.accepted})`);
    assert.equal(capture.rejected.length, 1, `exactly one candidate must be rejected (got ${JSON.stringify(capture.rejected)})`);
    assert.equal(capture.rejected[0].code, 'SOURCE_NOT_HUMAN', `the delegated candidate must be rejected as SOURCE_NOT_HUMAN (got ${capture.rejected[0].code})`);

    const memories = (await callJson(engineUrl, '/api/memories')).body.memories;
    const texts = memories.map(m => m.text);
    assert.equal(memories.length, 1, `only the human candidate may exist (got ${memories.length})`);
    assert.equal(memories[0].text, HUMAN_TEXT, 'the stored candidate is the human quote');
    assert.equal(memories[0].status, 'candidate', 'an automatically captured memory stays a candidate');
    assert.ok(!texts.some(text => text.includes('维护指令')), 'the delegated/maintenance text never became a memory');
    assert.ok(!memories.some(m => m.status === 'confirmed'), 'nothing was confirmed automatically');
    assert.equal(memories[0].evidence?.origin || memories[0].evidence?.inputOrigin || null, null, 'the candidate carries the frozen event id, not an invented origin');
    commands.push(`memory capture: accepted=${capture.accepted}, rejected=${JSON.stringify(capture.rejected)}, memories=${memories.length} (status=${memories[0].status})`);

    // ---- C01: the open item is blocked explicitly, the implementation is intact ----
    const injected = await callJson(engineUrl, '/api/memories', {
      text: '注入来源证据的记忆', scopeType: 'global', evidence: { projectId: PROJECT_ID, commitSha: sha },
    });
    assert.equal(injected.status, 400, `evidence injection must be refused (status ${injected.status})`);
    assert.equal(injected.body?.error, 'INVALID_ARGUMENT', `unexpected error code ${injected.body?.error}`);
    assert.match(String(injected.body?.message || ''), /不能指定来源证据/, 'the refusal states the C01 rule explicitly');

    // A manual memory (explicit user confirmation) still stores no evidence.
    const brainScope = await callJson(engineUrl, '/api/scopes', {
      scopes: [{ id: 'brain-default', kind: 'brain', brainId: 'brain-default', name: '默认智脑', knowledgePath: brainPath }],
    }, { headers: { authorization: 'Bearer eng012-lane-token' } });
    assert.equal(brainScope.status, 200, `brain scope binding failed: ${JSON.stringify(brainScope.body)}`);
    const manual = await callJson(engineUrl, '/api/memories', { text: MANUAL_TEXT, scopeType: 'global' });
    assert.equal(manual.status, 200, `manual memory creation failed: ${JSON.stringify(manual.body)}`);
    assert.equal(manual.body?.memory?.sourceType, 'manual');
    assert.equal(manual.body?.memory?.evidence, null, 'a manual record stores no evidence');
    assert.equal(manual.body?.memory?.status, 'confirmed');
    const afterManual = (await callJson(engineUrl, '/api/memories')).body.memories;
    assert.ok(!afterManual.some(m => m.text.includes('维护指令')), 'the delegated text is still not a memory after a manual create');
    assert.equal(afterManual.filter(m => m.status === 'confirmed').length, 1, 'only the explicit manual memory is confirmed');
    commands.push('C01: evidence injection refused with INVALID_ARGUMENT; manual memory stored with evidence=null / sourceType=manual');

    evidence.phases.originExclusion = {
      commitSha: sha,
      snapshotFile: path.relative(dataDir, snapshotFile).replace(/\\/g, '/'),
      snapshotOrigins: origins,
      memoryCapture: capture,
      memories: memories.map(m => ({ id: m.id, text: m.text, status: m.status, scopeType: m.scopeType, sourceEventId: m.sourceEventId, evidence: m.evidence })),
      delegatedTextPresent: texts.some(text => text.includes('维护指令')),
      c01EvidenceInjection: { status: injected.status, error: injected.body?.error || null, message: injected.body?.message || null },
      manualMemory: { status: manual.status, sourceType: manual.body?.memory?.sourceType, evidence: manual.body?.memory?.evidence, memoryStatus: manual.body?.memory?.status },
      memoriesAfterManualCreate: afterManual.map(m => ({ text: m.text, status: m.status })),
    };
    return { engine, vector, bridge, dataDir, knowledgePath, PROJECT_ID, sha };
  } catch (error) {
    try { await engine?.close(); } catch {}
    try { await vector?.close(); } catch {}
    try { await bridge.close(); } catch {}
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Scenario B: an implementation file must never be deleted automatically
// ---------------------------------------------------------------------------
async function scenarioNoImplementationDeletion(lane, evidence, commands) {
  const PROJECT_ID = 'project-eng012b';
  const fixture = buildFixtureRepo(lane, 'eng012b', []);
  const knowledgePath = path.join(lane, 'knowledge-eng012b');
  const storePath = path.join(knowledgePath, 'dev-conversations');
  fs.mkdirSync(storePath, { recursive: true });
  const home = path.join(lane, 'bridge-home');
  const dataDir = path.join(lane, 'engine-data');
  const vectorRoot = path.join(lane, 'vector-root');
  const eventsFile = path.join(lane, 'analyzer-events.jsonl');

  // A REAL implementation file, both in the repository and inside the
  // knowledge root (outside the owned knowledge structure).
  const repoImplementation = path.join(fixture.repoPath, 'src', 'core-engine.ts');
  fs.mkdirSync(path.dirname(repoImplementation), { recursive: true });
  fs.writeFileSync(repoImplementation, 'export const core = () => "implementation";\n');
  git(fixture.repoPath, ['add', '.']);
  git(fixture.repoPath, ['commit', '-qm', 'add implementation']);
  const knowledgeImplementation = path.join(knowledgePath, 'implementation', 'core-engine.md');
  fs.mkdirSync(path.dirname(knowledgeImplementation), { recursive: true });
  fs.writeFileSync(knowledgeImplementation, '# 核心实现说明\n\n真实实现文件，不得被自动删除。\n');

  const before = {
    repoImplementation: sha256File(repoImplementation),
    knowledgeImplementation: sha256File(knowledgeImplementation),
  };

  const bridge = startBridge(home);
  let vector = null;
  let engine = null;
  // An over-eager maintenance analyzer that tries to delete an implementation.
  const analyzer = createStandinAnalyzer({
    eventsFile,
    extraOperations: [
      { operation: 'delete', path: 'implementation/core-engine.md', reason: '尝试删除实现文件' },
      { operation: 'delete', path: '../knowledge-eng012b/implementation/core-engine.md', reason: '尝试越界删除' },
    ],
  });

  try {
    const bridgeUrl = await bridge.listen();
    vector = await startVector(vectorRoot);
    const registered = await bridge.projectRegistry.addProject({ home, path: fixture.repoPath, store: storePath });
    const { repoIdentity } = await bridge.resolveRepoContext(fixture.repoPath);
    engine = await startEngine({ dataDir, bridgeUrl, vectorUrl: vector.url, analyzer });
    const engineUrl = await engine.listen();
    engine.runtime.store.addProject({
      projectId: PROJECT_ID,
      repoPath: fixture.repoPath,
      knowledgePath,
      trackingStartCommit: fixture.baseline,
      repoIdentity,
      journalId: registered.id,
      conversationBaselineCursor: 0,
    });

    installPostCommitHook(fixture.repoPath, { home, mode: 'ok' });
    fs.writeFileSync(path.join(fixture.repoPath, 'feature.txt'), `feature eng012b\n${'y'.repeat(64)}\n`);
    git(fixture.repoPath, ['add', '.']);
    git(fixture.repoPath, ['commit', '-qm', 'feature eng012b']);
    const sha = git(fixture.repoPath, ['rev-parse', 'HEAD']);
    await callJson(engineUrl, '/api/bridge/notify', {});

    const run = await waitUntil(async () => {
      const found = engine.runtime.store.listRuns(PROJECT_ID).find(r => r.commitSha === sha);
      return found && ['failed', 'succeeded'].includes(found.state) ? found : null;
    }, 60000, 'the run with the deletion attempt settles');

    assert.equal(run.state, 'failed', `the deletion attempt must not succeed (state ${run.state})`);
    assert.equal(run.error?.code, 'PATH_OUTSIDE_ROOT', `unexpected rejection code ${run.error?.code}`);
    assert.ok(fs.existsSync(repoImplementation), 'the repository implementation file still exists');
    assert.ok(fs.existsSync(knowledgeImplementation), 'the implementation file inside the knowledge root still exists');
    assert.equal(sha256File(repoImplementation), before.repoImplementation, 'the repository implementation is byte-identical');
    assert.equal(sha256File(knowledgeImplementation), before.knowledgeImplementation, 'the knowledge-root implementation is byte-identical');
    const changesDir = path.join(knowledgePath, 'changes');
    const promoted = fs.existsSync(changesDir) ? fs.readdirSync(changesDir) : [];
    assert.equal(promoted.length, 0, `no knowledge operation may be applied when one is illegal (promoted: ${promoted.join(',')})`);
    const memories = (await callJson(engineUrl, '/api/memories')).body.memories;
    assert.equal(memories.length, 0, 'a refused maintenance run creates no memory');
    commands.push(`deletion attempt refused (${run.error?.code}); implementation files byte-identical; nothing promoted`);

    evidence.phases.noImplementationDeletion = {
      commitSha: sha,
      run: { runId: run.runId, trigger: run.trigger, state: run.state, phase: run.phase, error: run.error },
      attemptedDeleteOperations: [
        { path: 'implementation/core-engine.md', kind: 'outside the owned knowledge structure' },
        { path: '../knowledge-eng012b/implementation/core-engine.md', kind: 'escape attempt' },
      ],
      implementationFiles: {
        repository: { path: path.relative(fixture.repoPath, repoImplementation).replace(/\\/g, '/'), sha256Before: before.repoImplementation, sha256After: sha256File(repoImplementation), exists: fs.existsSync(repoImplementation) },
        knowledgeRoot: { path: path.relative(knowledgePath, knowledgeImplementation).replace(/\\/g, '/'), sha256Before: before.knowledgeImplementation, sha256After: sha256File(knowledgeImplementation), exists: fs.existsSync(knowledgeImplementation) },
      },
      promotedKnowledgeFiles: promoted,
      memoriesCreated: memories.length,
    };
    return { engine, vector, bridge };
  } catch (error) {
    try { await engine?.close(); } catch {}
    try { await vector?.close(); } catch {}
    try { await bridge.close(); } catch {}
    throw error;
  }
}

async function main() {
  const evidence = { caseId: 'ENG-012', phases: {}, commands: [] };
  const commands = evidence.commands;
  try {
    const laneA = makeLaneDir('eng012a');
    evidence.laneA = laneA;
    const a = await scenarioOriginExclusion(laneA, evidence, commands);
    await a.engine.close();
    await a.vector.close();
    await a.bridge.close();

    const laneB = makeLaneDir('eng012b');
    evidence.laneB = laneB;
    const b = await scenarioNoImplementationDeletion(laneB, evidence, commands);
    await b.engine.close();
    await b.vector.close();
    await b.bridge.close();

    evidence.verdict = {
      'expected1 维护/委派不能自动成为人类长期偏好': 'PASS',
      'expected2 C01未定项不得自动删除实现': 'PASS',
      originExclusion: 'the frozen commit conversation snapshot carries both origins; the engine rejected the delegated candidate with SOURCE_NOT_HUMAN and kept the human one as a plain candidate - nothing was confirmed automatically',
      c01Block: 'POST /api/memories with an injected source-evidence field is refused with INVALID_ARGUMENT ("不能指定来源证据"); a manual memory is stored with evidence null and sourceType manual, so the MEM-008 implementation was not deleted',
      noImplementationDeletion: 'a manifest that tries to delete an implementation file is refused by the promotion path (PATH_OUTSIDE_ROOT); the run fails, no knowledge operation is applied and the implementation files stay byte-identical',
      analyzerStandin: 'deterministic stand-in that deliberately emits both the human and the delegated candidate - NO real model output covered',
      vectorService: 'real vector-hub server, deterministic test embeddings - paid embedding API NOT covered',
      boundary: 'PARTIAL on the product side: the product memory panel UI (addMemory/memoryContent/memoryTabs/memoryScopeFilter/candidateCount/memoryFeedback) and the shared memory ledger are owned by other lanes and were not exercised; specs-coverage.json MEM-008 records that those UI paths have zero assertions in the 156 product tests. Everything asserted here is engine-level behaviour.',
    };
    saveEvidence(ARTIFACTS, 'eng012-evidence.json', evidence);
    console.log('ENG-012 PASS');
    process.exit(0);
  } catch (error) {
    evidence.verdict = { failed: String((error && error.stack) || error) };
    saveEvidence(ARTIFACTS, 'eng012-evidence.json', evidence);
    console.error(`ENG-012 FAIL: ${error.message}`);
    process.exit(1);
  }
}

main();
