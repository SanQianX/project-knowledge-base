'use strict';
// Parallel knowledge lane — engine cases ENG-001, ENG-003, ENG-004, ENG-008.
// The real vendored knowledge-engine runs in-process on an isolated port with
// an isolated data directory, and every Git fixture is a real repository with
// real commits. The analyzer is a declared stub (no model is called) and the
// vector endpoint is a declared stub that returns no rows, so nothing here is
// evidence of model or vector behaviour.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const fixture = require('./helpers/parallel-knowledge-fixture');
// The entry point isolates itself: ambient module addresses, live data
// directories and the real HOME are cleared here, before any product module
// is loaded, so the test never depends on the caller running `env -u`.
fixture.isolateProcess();
const { StorageLayout } = require('../lib/storage-layout');
const { ProjectStore } = require('../lib/project-store');
const { ProjectRegistryStore } = require('../lib/project-registry-store');
const { ProjectLifecycleService } = require('../lib/project-lifecycle-service');
const { createEngineServer } = require('../../_modules/knowledge-engine/src/server');
const { CommitScanner } = require('../../_modules/knowledge-engine/src/runtime/scanner');
const AtomicFile = require('../../_modules/knowledge-engine/src/runtime/atomic-file');

const results = [];
function record(caseId, status, detail) {
  results.push({ caseId, status, detail });
  console.log(`CASE ${caseId} ${status} ${JSON.stringify(detail)}`);
}

async function stubVectorServer() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      requests.push({ url: req.url, method: req.method });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, results: [], errors: [], projects: [] }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { requests, url: `http://127.0.0.1:${server.address().port}`, close: () => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); } };
}

function forbiddenBridge() {
  const guard = name => async () => { throw new Error(`event bridge must not be contacted from the test lane (${name})`); };
  return { registerConsumer: guard('registerConsumer'), listJournals: guard('listJournals'), readEvents: guard('readEvents'), ackConsumerCursor: guard('ackConsumerCursor'), close() {} };
}

// Declared stub analyzer: stages Markdown plus a manifest, exactly like the
// canonical engine suite does. It never contacts a model.
function stubAnalyzer(events = [], options = {}) {
  return {
    sourceReadMode: 'isolated-frozen-evidence',
    async runClaim(input) {
      events.push({ kind: 'start', projectId: input.projectId, sha: input.claim.commitSha });
      const relative = options.manifestPath || `changes/${input.claim.commitSha.slice(0, 12)}.md`;
      const content = `# 引擎晋升条目\n\nENGTOKEN 事实：提交 ${input.claim.commitSha} 已被分析。\n`;
      // An escaping manifest path is the attack under test, so the staged
      // bytes stay inside the staging directory in every case.
      const stagedRelative = relative.split('/').includes('..') ? 'escaped.md' : relative;
      AtomicFile.writeFileAtomic(path.join(input.stagingPath, 'files', stagedRelative), content);
      AtomicFile.writeJsonAtomic(input.manifestPath, {
        schema: 'knowledge-staging-manifest/v1',
        projectId: input.projectId,
        runId: input.claim.runId,
        commitSha: input.claim.commitSha,
        operations: [{
          path: relative,
          operation: 'create',
          sha256: `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`,
          reason: 'Frozen Git evidence',
          evidenceReferences: [`commit:${input.claim.commitSha}`, `patch:${input.claim.patchHash}`, `conversation:${input.claim.conversationSnapshotHash}`, `retrieval:${input.claim.retrievalManifestHash}`],
        }],
      });
      events.push({ kind: 'finish', projectId: input.projectId, sha: input.claim.commitSha });
      return { ok: true };
    },
  };
}

async function startEngine({ dataDir, vectorUrl, analyzer }) {
  fs.mkdirSync(dataDir, { recursive: true });
  const runtime = createEngineServer({ dataDir, vectorUrl, bridge: forbiddenBridge(), analyzer });
  await runtime.ready;
  await new Promise(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${runtime.server.address().port}`;
  return {
    ...runtime,
    base,
    async call(route, body) {
      const response = await fetch(`${base}${route}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    },
  };
}

(async () => {
  const root = fixture.makeTempDir('parallel-knowledge-engine');
  const vector = await stubVectorServer();
  const analyzerEvents = [];
  let engine = null;
  try {
    // --------------------------------------------------------------- ENG-001
    {
      const repo = fixture.makeRepo(root, 'repo-import', [
        { message: '历史提交一', files: { 'a.txt': 'a\n' } },
        { message: '历史提交二', files: { 'b.txt': 'b\n' } },
        { message: '历史提交三', files: { 'c.txt': 'c\n' } },
      ]);
      const repoBefore = fixture.hashTree(repo.repoPath);
      const knowledgeRoot = path.join(root, 'knowledge-root');
      fs.mkdirSync(knowledgeRoot, { recursive: true });
      const layout = new StorageLayout({ dataDir: path.join(root, 'shell-data') });
      const registry = new ProjectRegistryStore({ layout });
      const projects = new ProjectStore({ layout });
      await registry.initialize();
      const lifecycle = new ProjectLifecycleService({
        layout,
        registryStore: registry,
        projectStore: projects,
        settingsStore: { read: () => ({ knowledge: { rootPath: knowledgeRoot }, ai: { schema: 'ai-profiles/v1', profiles: [{ id: 'test-profile', enabled: true, vendor: 'anthropic', model: 'm' }], defaultProfileId: null } }) },
        triggerScriptPath: path.join(root, 'hook-trigger.js'),
        hookManager: { readHookStatus: () => ({ kbManaged: false }), installHook: () => ({ ok: true, managedVersion: 2 }), uninstallHook: () => ({ ok: true }) },
      });
      const imported = await lifecycle.importProject({ localPath: repo.repoPath, projectId: 'project-import', aiProfileId: 'test-profile' });
      assert.equal(imported.state.trackingStartCommit, repo.head, 'the import must record the imported HEAD as the baseline');
      assert.equal(imported.state.lastAnalyzedCommit, null, 'an import must not claim an analysed commit');
      assert.equal(imported.state.trackingMode, 'normal');
      const projectKnowledge = imported.config.knowledgePath;
      assert.deepEqual(fs.readdirSync(projectKnowledge).filter(name => name !== '.gitkeep'), [], 'an import must not create knowledge files');
      assert.deepEqual(fixture.hashTree(repo.repoPath), repoBefore, 'the import must not touch the source repository');

      // The real engine scanner must see zero pending history behind the baseline.
      const scanner = new CommitScanner();
      const scan = await scanner.scan({ repoPath: repo.repoPath }, { trackingStartCommit: repo.head, lastAnalyzedCommit: null, trackingMode: 'normal' });
      assert.equal(scan.status, 'ok');
      assert.equal(scan.baseline, repo.head);
      assert.deepEqual(scan.commits, [], 'the baseline must cover the whole imported history');
      assert.equal(scan.pendingCount, 0);

      // A real engine started on that registration must not analyse history.
      engine = await startEngine({ dataDir: path.join(root, 'engine-import'), vectorUrl: vector.url, analyzer: stubAnalyzer(analyzerEvents) });
      const registration = await engine.call('/api/projects', {
        projectId: 'project-import',
        name: 'import',
        repoPath: repo.repoPath,
        knowledgePath: projectKnowledge,
        trackingStartCommit: repo.head,
        brainId: 'brain-default',
        domainId: 'domain-tools',
      });
      assert.equal(registration.status, 200);
      await fixture.eventually(() => engine.store.state.runs.length > 0, 2000);
      assert.deepEqual(engine.store.listRuns(), [], 'starting the engine must not create an analysis run for imported history');
      assert.deepEqual(fixture.hashTree(repo.repoPath), repoBefore, 'the source repository must stay byte-identical');
      record('ENG-001', 'PASS', {
        importedHead: repo.head,
        trackingStartCommit: imported.state.trackingStartCommit,
        lastAnalyzedCommit: imported.state.lastAnalyzedCommit,
        scanStatus: scan.status,
        pendingCommits: scan.pendingCount,
        runsCreated: engine.store.listRuns().length,
        knowledgeFiles: fs.readdirSync(projectKnowledge).filter(name => name !== '.gitkeep').length,
        sourceRepoUnchanged: true,
      });
      await engine.close();
      engine = null;
    }

    // --------------------------------------------------------------- ENG-003
    {
      const repoPath = path.join(root, 'repo-empty');
      fs.mkdirSync(repoPath, { recursive: true });
      fixture.git(repoPath, ['init', '-q']);
      fixture.git(repoPath, ['config', 'user.email', 'parallel-knowledge@local.invalid']);
      fixture.git(repoPath, ['config', 'user.name', 'Parallel Knowledge Test']);
      const knowledgeRoot = path.join(root, 'knowledge-root-empty');
      fs.mkdirSync(knowledgeRoot, { recursive: true });
      const layout = new StorageLayout({ dataDir: path.join(root, 'shell-data-empty') });
      const registry = new ProjectRegistryStore({ layout });
      const projects = new ProjectStore({ layout });
      await registry.initialize();
      const lifecycle = new ProjectLifecycleService({
        layout,
        registryStore: registry,
        projectStore: projects,
        settingsStore: { read: () => ({ knowledge: { rootPath: knowledgeRoot }, ai: { schema: 'ai-profiles/v1', profiles: [{ id: 'test-profile', enabled: true, vendor: 'anthropic', model: 'm' }], defaultProfileId: null } }) },
        triggerScriptPath: path.join(root, 'hook-trigger.js'),
        hookManager: { readHookStatus: () => ({ kbManaged: false }), installHook: () => ({ ok: true, managedVersion: 2 }), uninstallHook: () => ({ ok: true }) },
      });
      const imported = await lifecycle.importProject({ localPath: repoPath, projectId: 'project-empty', aiProfileId: 'test-profile' });
      assert.equal(imported.state.trackingMode, 'empty-repo');
      assert.equal(imported.state.trackingStartCommit, null, 'a repository without HEAD must not get a baseline commit');
      assert.equal(imported.state.lastAnalyzedCommit, null);

      const scanner = new CommitScanner();
      const emptyScan = await scanner.scan({ repoPath }, { trackingStartCommit: null, lastAnalyzedCommit: null, trackingMode: 'empty-repo' });
      assert.equal(emptyScan.status, 'empty-repo', 'a repository without HEAD must be reported as empty, not as analysed');
      assert.deepEqual(emptyScan.commits, []);

      engine = await startEngine({ dataDir: path.join(root, 'engine-empty'), vectorUrl: vector.url, analyzer: stubAnalyzer(analyzerEvents) });
      const knowledgePath = imported.config.knowledgePath;
      await engine.call('/api/projects', { projectId: 'project-empty', name: 'empty', repoPath, knowledgePath, trackingStartCommit: null, brainId: 'brain-default', domainId: 'domain-tools' });
      assert.deepEqual(engine.store.listRuns(), [], 'no analysis may be invented before the first commit exists');
      assert.equal(engine.store.readRuntime('project-empty').lastAnalyzedCommit, null);

      // The first real commit after the empty import must be processable.
      fs.writeFileSync(path.join(repoPath, 'first.txt'), 'first\n', 'utf8');
      fixture.git(repoPath, ['add', '-A']);
      fixture.git(repoPath, ['commit', '-q', '-m', 'first commit']);
      const firstSha = fixture.git(repoPath, ['rev-parse', 'HEAD']);
      const run = engine.coordinator.enqueue({ projectId: 'project-empty', commitSha: firstSha });
      const settled = await fixture.eventually(() => ['succeeded', 'failed', 'index-pending'].includes(engine.store.getRun(run.runId).state));
      assert.equal(settled, true, 'the first commit must reach a terminal state');
      const finished = engine.store.getRun(run.runId);
      assert.equal(finished.state, 'succeeded', `first commit failed: ${JSON.stringify(finished.error)}`);
      assert.equal(engine.store.readRuntime('project-empty').lastAnalyzedCommit, firstSha);
      assert.ok(fs.existsSync(path.join(knowledgePath, 'changes', `${firstSha.slice(0, 12)}.md`)), 'the first commit must produce knowledge');
      record('ENG-003', 'PASS', {
        trackingMode: imported.state.trackingMode,
        trackingStartCommit: imported.state.trackingStartCommit,
        emptyScanStatus: emptyScan.status,
        runsBeforeFirstCommit: 0,
        firstCommitSha: firstSha,
        firstCommitState: finished.state,
        lastAnalyzedCommit: engine.store.readRuntime('project-empty').lastAnalyzedCommit,
      });
      await engine.close();
      engine = null;
    }

    // --------------------------------------------------------------- ENG-004
    {
      const repo = fixture.makeRepo(root, 'repo-duplicate', [
        { message: '初始', files: { 'README.md': '# dup\n' } },
        { message: '功能', files: { 'feature.txt': 'feature\n' } },
      ]);
      const knowledgePath = fixture.makeKnowledgeDir(root, 'knowledge-duplicate');
      const dataDir = path.join(root, 'engine-duplicate');
      engine = await startEngine({ dataDir, vectorUrl: vector.url, analyzer: stubAnalyzer(analyzerEvents) });
      await engine.call('/api/projects', { projectId: 'project-dup', name: 'dup', repoPath: repo.repoPath, knowledgePath, brainId: 'brain-default', domainId: 'domain-tools' });

      const first = engine.coordinator.enqueue({ projectId: 'project-dup', commitSha: repo.head });
      const second = engine.coordinator.enqueue({ projectId: 'project-dup', commitSha: repo.head });
      assert.equal(second.runId, first.runId, 'the same SHA must reuse one run');
      const settled = await fixture.eventually(() => ['succeeded', 'failed', 'index-pending'].includes(engine.store.getRun(first.runId).state));
      assert.equal(settled, true);
      assert.equal(engine.store.getRun(first.runId).state, 'succeeded', `run failed: ${JSON.stringify(engine.store.getRun(first.runId).error)}`);
      const analysesAfterFirst = analyzerEvents.filter(event => event.kind === 'start' && event.sha === repo.head).length;
      assert.equal(analysesAfterFirst, 1, 'one SHA must produce exactly one analysis');
      assert.equal(engine.store.listRuns('project-dup').length, 1, 'one SHA must produce exactly one run');

      // A repeated explicit reconciliation of the same SHA must be refused by
      // the processing ledger instead of analysing again.
      const repeated = await engine.coordinator.reconciler.processCommitEvent({ projectId: 'project-dup', commitSha: repo.head });
      assert.equal(repeated.status, 'already-completed', 'a repeated SHA must be reported as already completed');
      assert.equal(analyzerEvents.filter(event => event.kind === 'start' && event.sha === repo.head).length, 1, 'a repeated SHA must not analyse again');

      // Startup reconciliation: a fresh engine on the same data directory.
      await engine.close();
      engine = await startEngine({ dataDir, vectorUrl: vector.url, analyzer: stubAnalyzer(analyzerEvents) });
      const afterRestart = await engine.coordinator.reconciler.processCommitEvent({ projectId: 'project-dup', commitSha: repo.head });
      assert.equal(afterRestart.status, 'already-completed', 'startup reconciliation must not re-analyse a completed SHA');
      assert.equal(analyzerEvents.filter(event => event.kind === 'start' && event.sha === repo.head).length, 1, 'startup reconciliation must not run the model again');
      assert.equal(engine.store.listRuns('project-dup').length, 1);
      const promotedFiles = fs.readdirSync(path.join(knowledgePath, 'changes'));
      assert.deepEqual(promotedFiles, [`${repo.head.slice(0, 12)}.md`], 'exactly one promotion must exist');
      record('ENG-004', 'PASS', {
        runId: first.runId,
        runsCreated: engine.store.listRuns('project-dup').length,
        analysesForSha: analyzerEvents.filter(event => event.kind === 'start' && event.sha === repo.head).length,
        repeatedStatus: repeated.status,
        restartStatus: afterRestart.status,
        promotedFiles,
      });
      await engine.close();
      engine = null;
    }

    // --------------------------------------------------------------- ENG-008
    {
      const repo = fixture.makeRepo(root, 'repo-escape', [
        { message: '初始', files: { 'README.md': '# escape\n' } },
        { message: '功能', files: { 'feature.txt': 'feature\n' } },
      ]);
      const knowledgePath = fixture.makeKnowledgeDir(root, 'knowledge-escape');
      fs.writeFileSync(path.join(knowledgePath, 'README.md'), '# 已有知识\n\nENG008TOKEN 已有正文\n', 'utf8');
      const knowledgeBefore = fixture.hashTree(knowledgePath);
      const repoBefore = fixture.hashTree(repo.repoPath);
      const outsideMarker = path.join(root, 'escaped.md');
      engine = await startEngine({ dataDir: path.join(root, 'engine-escape'), vectorUrl: vector.url, analyzer: stubAnalyzer(analyzerEvents, { manifestPath: '../escaped.md' }) });
      await engine.call('/api/projects', { projectId: 'project-escape', name: 'escape', repoPath: repo.repoPath, knowledgePath, brainId: 'brain-default', domainId: 'domain-tools' });
      const run = engine.coordinator.enqueue({ projectId: 'project-escape', commitSha: repo.head });
      const settled = await fixture.eventually(() => ['succeeded', 'failed', 'index-pending'].includes(engine.store.getRun(run.runId).state));
      assert.equal(settled, true);
      const failed = engine.store.getRun(run.runId);
      assert.equal(failed.state, 'failed', 'an out-of-bounds staging path must be refused');
      assert.equal(failed.error.code, 'PATH_OUTSIDE_ROOT', `unexpected failure code: ${failed.error.code}`);
      assert.deepEqual(fixture.hashTree(knowledgePath), knowledgeBefore, 'the final knowledge must stay byte-identical');
      assert.deepEqual(fixture.hashTree(repo.repoPath), repoBefore, 'the source repository must stay byte-identical');
      assert.equal(fs.existsSync(outsideMarker), false, 'nothing may be written outside the project knowledge root');
      const state = engine.store.readRuntime('project-escape');
      assert.equal(state.lastAnalyzedCommit, null, 'a refused promotion must not advance the analysed commit');
      assert.equal(state.analysis.status, 'failed');
      assert.equal(state.analysis.activeClaim.phase, 'failed', 'the failed claim must be retained for diagnosis');
      assert.ok(state.analysis.activeClaim.error, 'the failure evidence must be retained');
      const claimFiles = fs.existsSync(path.join(root, 'engine-escape', 'runtime', 'claims', 'project-escape'))
        ? fs.readdirSync(path.join(root, 'engine-escape', 'runtime', 'claims', 'project-escape'))
        : [];
      assert.ok(claimFiles.includes(`${repo.head}.json`), 'the frozen claim snapshot must be retained');
      const runs = await engine.call('/api/runs');
      const reported = runs.body.runs.find(row => row.runId === run.runId);
      assert.ok(reported && reported.error && reported.error.code === 'PATH_OUTSIDE_ROOT', 'the failure must stay visible in the run projection');
      const logDir = path.join(root, 'engine-escape', 'logs', 'projects', 'project-escape');
      const logFiles = fs.existsSync(logDir) ? fs.readdirSync(logDir) : [];
      let failureLogged = false;
      for (const file of logFiles) {
        const records = fs.readFileSync(path.join(logDir, file), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
        if (records.some(record => record.event === 'knowledge.maintenance.failed' && record.commitSha === repo.head)) failureLogged = true;
      }
      assert.equal(failureLogged, true, 'the failure must be written to the diagnostics log');
      record('ENG-008', 'PASS', {
        runState: failed.state,
        errorCode: failed.error.code,
        knowledgeUnchanged: true,
        sourceRepoUnchanged: true,
        claimRetained: claimFiles.includes(`${repo.head}.json`),
        diagnosticsLogged: failureLogged,
        lastAnalyzedCommit: state.lastAnalyzedCommit,
      });
      await engine.close();
      engine = null;
    }

    const summary = { lane: 'test-knowledge', file: 'parallel-knowledge-engine-test.js', cases: results, model: 'declared stub analyzer (no model call)', vector: 'declared stub returning no rows' };
    const target = process.env.PARALLEL_KNOWLEDGE_EVIDENCE;
    if (target) fs.mkdirSync(path.dirname(target), { recursive: true });
    if (target) fs.writeFileSync(target, JSON.stringify(summary, null, 2), 'utf8');
    console.log('parallel-knowledge-engine-test PASS');
  } finally {
    if (engine) await engine.close();
    await vector.close();
    fixture.removeTree(root);
    fixture.cleanupIsolatedProcess();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
