'use strict';

// P-ENG-ADVANCED ENG-006 跨项目并发 (cross-project concurrency) acceptance driver.
//
// Case (qa-autopilot/config/test-cases.json ENG-006):
//   steps:    两个或更多fixture提交并观察调度。
//   expected: 1) 按当前实际并发上限排队。 2) 项目之间无文件串写。
//
// Real behavior under test: vendored knowledge-engine child process with its
// DEFAULT concurrency (coordinator clamps to 2), three projects (one with a
// non-ASCII knowledge path), four queued runs, real analyzer-interval evidence
// from the stand-in's JSONL log (no real model output), real per-project
// knowledge trees on disk, loopback vector double.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  makeLaneDir, buildFixtureRepo, waitUntil, callJson, startVectorDouble,
  startEngineChild, readEventsFile, writePlan, saveEvidence, listFilesRecursive,
} = require('./helpers/parallel-engine-advanced-harness.js');

const ARTIFACTS = process.env.PK_TEST_EVIDENCE_ROOT
  ? path.join(process.env.PK_TEST_EVIDENCE_ROOT, 'eng006')
  : path.resolve(__dirname, '../../qa-autopilot/artifacts/parallel-20261023/engine-review-r3/reruns/eng006');
const PROJECTS = [
  { projectId: 'project-eng006-a', name: 'eng006-a', dirName: 'repo-eng006-a', knowledgeName: 'knowledge-eng006-a' },
  { projectId: 'project-eng006-b', name: 'eng006-b', dirName: 'repo-eng006-b', knowledgeName: 'knowledge-eng006-b' },
  { projectId: 'project-eng006-c', name: 'eng006-c（中文路径）', dirName: 'repo-eng006-c', knowledgeName: '知识-eng006-c' },
];

function maxOverlap(intervals) {
  const points = [];
  for (const [start, end] of intervals) { points.push([start, 1], [end, -1]); }
  points.sort((x, y) => x[0] - y[0] || y[1] - x[1]);
  let live = 0; let peak = 0;
  for (const [, delta] of points) { live += delta; peak = Math.max(peak, live); }
  return peak;
}

async function main() {
  const lane = makeLaneDir('eng006');
  const commands = [];
  const evidence = { caseId: 'ENG-006', laneDir: lane, phases: {}, commands };
  const fixtures = [];
  for (const spec of PROJECTS) {
    fixtures.push({ spec, fixture: buildFixtureRepo(lane, spec.dirName, ['one', 'two']) });
  }
  const planFile = path.join(lane, 'analyzer-plan.json');
  const eventsFile = path.join(lane, 'analyzer-events.jsonl');
  writePlan(planFile, { default: { delayMs: 700 }, rules: [] });

  const vector = await startVectorDouble();
  const engine = await startEngineChild({ label: 'eng006', dataDir: path.join(lane, 'engine-data'), vectorUrl: vector.url, planFile, eventsFile });
  commands.push('POST /api/projects x3 (default concurrency, no override)', 'POST /api/runs a#one, b#one, c#one, a#two');

  try {
    for (const { spec, fixture } of fixtures) {
      const knowledgePath = path.join(lane, spec.knowledgeName);
      fs.mkdirSync(knowledgePath, { recursive: true });
      spec.knowledgePath = knowledgePath;
      const registered = await callJson(engine.base, '/api/projects', {
        projectId: spec.projectId, name: spec.name, repoPath: fixture.repoPath, knowledgePath, trackingStartCommit: fixture.baseline,
      });
      assert.equal(registered.status, 200, `registration failed for ${spec.projectId}`);
    }

    const enqueuePlan = [[0, 'one'], [1, 'one'], [2, 'one'], [0, 'two']];
    for (const [index, label] of enqueuePlan) {
      const { spec, fixture } = fixtures[index];
      const commitSha = fixture.shas[label];
      const response = await callJson(engine.base, '/api/runs', { projectId: spec.projectId, commitSha });
      assert.equal(response.status, 200, `enqueue failed: ${JSON.stringify(response.body)}`);
    }
    evidence.enqueueNote = 'runs queued in order: a#one, b#one, c#one, a#two (a#two is project a second fixture commit)';

    const health = (await callJson(engine.base, '/api/health')).body;
    assert.equal(health.concurrency, 2, `actual concurrency limit is 2, got ${health.concurrency}`);
    evidence.phases.healthConcurrency = { concurrency: health.concurrency, active: health.counts.running };

    // Mid-flight: while the 700ms analyzer intervals run, expect exactly 2 running and 2 queued.
    const midflight = await waitUntil(async () => {
      const runs = (await callJson(engine.base, '/api/runs')).body.runs;
      return runs.length === 4 && runs.filter(r => r.state === 'running').length === 2 && runs.filter(r => r.state === 'queued').length === 2 ? runs : null;
    }, 20000, 'two runs active while two queued');
    evidence.phases.midflight = midflight.map(r => ({ project: r.projectId, sha: r.commitSha.slice(0, 7), state: r.state, phase: r.phase }));

    await waitUntil(async () => {
      const runs = (await callJson(engine.base, '/api/runs')).body.runs;
      return runs.length === 4 && runs.every(r => r.state === 'succeeded');
    }, 40000, 'all four runs succeed');

    // --- Expected 1: 按当前实际并发上限排队 ---
    const events = readEventsFile(eventsFile);
    const byRun = new Map();
    for (const e of events) {
      const key = `${e.projectId}:${e.commitSha.slice(0, 7)}`;
      if (!byRun.has(key)) byRun.set(key, { projectId: e.projectId, sha: e.commitSha.slice(0, 7) });
      byRun.get(key)[e.kind === 'start' ? 'startAt' : 'finishAt'] = e.at;
    }
    const intervals = [...byRun.values()].map(r => [new Date(r.startAt).getTime(), new Date(r.finishAt).getTime()]);
    const peak = maxOverlap(intervals);
    assert.equal(intervals.length, 4, 'four analysis intervals recorded');
    assert.equal(peak, 2, `analyzer never exceeded the actual concurrency limit (peak=${peak}, limit=2)`);
    // project a serialized: a#two start after a#one finish
    const aOne = [...byRun.values()].find(r => r.projectId === PROJECTS[0].projectId && r.sha === fixtures[0].fixture.shas.one.slice(0, 7));
    const aTwo = [...byRun.values()].find(r => r.projectId === PROJECTS[0].projectId && r.sha === fixtures[0].fixture.shas.two.slice(0, 7));
    assert.ok(aOne && aTwo, 'both project-a commits analyzed');
    assert.ok(new Date(aTwo.startAt) >= new Date(aOne.finishAt), 'same-project runs serialized');
    evidence.phases.schedule = {
      concurrencyLimit: health.concurrency,
      peakConcurrentAnalyzerIntervals: peak,
      intervals: [...byRun.values()],
      sameProjectSerialized: { aOneFinish: aOne.finishAt, aTwoStart: aTwo.startAt },
    };

    // --- Expected 2: 项目之间无文件串写 ---
    const enqueuedLabelsByIndex = { 0: ['one', 'two'], 1: ['one'], 2: ['one'] };
    for (const [index, { spec, fixture }] of fixtures.entries()) {
      const files = listFilesRecursive(spec.knowledgePath);
      const own = files.filter(f => f.startsWith('changes/'));
      const expectedOwn = enqueuedLabelsByIndex[index].map(label => `changes/${fixture.shas[label].slice(0, 12)}.md`).sort();
      assert.deepEqual(own.sort(), expectedOwn, `${spec.projectId} knowledge tree contains exactly its own promoted files`);
      for (const file of own) {
        const content = fs.readFileSync(path.join(spec.knowledgePath, ...file.split('/')), 'utf8');
        assert.ok(content.includes(spec.projectId), `${file} mentions its own project`);
        for (const other of PROJECTS) {
          if (other.projectId !== spec.projectId) assert.ok(!content.includes(other.projectId), `${file} must not mention ${other.projectId} (no cross-write)`);
        }
      }
    }
    const finalRuns = (await callJson(engine.base, '/api/runs')).body.runs;
    for (const run of finalRuns) {
      const owner = PROJECTS.find(p => p.projectId === run.projectId);
      assert.ok(owner, 'every run attributed to a registered project');
      assert.ok([fixtures[PROJECTS.indexOf(owner)].fixture.shas.one, fixtures[PROJECTS.indexOf(owner)].fixture.shas.two].includes(run.commitSha), 'run commit belongs to its own project fixture');
    }
    const syncs = vector.requests.filter(r => r.url === '/api/sync');
    assert.equal(syncs.length, 4, 'four index syncs (one per promoted run)');
    for (const sync of syncs) {
      const project = PROJECTS.find(p => p.projectId === sync.body.project);
      assert.ok(project, `sync project ${sync.body.project} is one of ours`);
      assert.ok(sync.body.sourceDir && PROJECTS.some(p => p.knowledgePath && sync.body.sourceDir.replace(/\//g, '\\').endsWith(path.basename(p.knowledgePath)) || sync.body.sourceDir === p.knowledgePath || p.knowledgePath.endsWith(sync.body.sourceDir.split(/[\\/]/).pop())), 'sync sourceDir belongs to that project');
    }
    evidence.phases.crossWriteCheck = {
      knowledgeTrees: Object.fromEntries(PROJECTS.map(p => [p.projectId, listFilesRecursive(p.knowledgePath)])),
      syncRequests: syncs.map(s => ({ project: s.body.project, sourceDir: s.body.sourceDir })),
    };

    evidence.verdict = {
      'expected1 按当前实际并发上限排队(实际上限=2, 峰值=2, 同项目串行)': 'PASS',
      'expected2 项目之间无文件串写(知识树/归属/索引请求逐项核对)': 'PASS',
      analyzerStandin: 'declarative stand-in - real intervals, NO real model output covered',
      vectorDouble: 'loopback HTTP double - vector-hub itself not covered',
    };
    await engine.stop();
    await vector.close();
    saveEvidence(ARTIFACTS, 'eng006-evidence.json', evidence);
    console.log('ENG-006 PASS');
    process.exitCode = 0;
  } catch (error) {
    evidence.verdict = { failed: String(error && error.stack || error) };
    try { await engine.stop(); } catch {}
    try { await vector.close(); } catch {}
    saveEvidence(ARTIFACTS, 'eng006-evidence.json', evidence);
    console.error(`ENG-006 FAIL: ${error.message}`);
    process.exitCode = 1;
  }
}

main();
