'use strict';
// Parallel knowledge lane — canonical vector-side contracts (RET-006 sub-items).
//
// Scope: only the deterministic, environment-independent contracts are proven
// here, because the file is collected by the offline regression runner:
//   RET-006.a-root-switch            the hub accepts and reports a new index root
//   RET-006.b-writer-drain            an in-flight writer is drained before the switch resolves
//   RET-006.c-old-root-retained      the old index root keeps its data byte-for-byte
//   RET-006.d-project-knowledge-kept  a project knowledge directory is never moved by the switch
//
// RET-006 as a whole is NOT claimed to pass here: this file proves the
// deterministic sub-items a-d only. The remaining sub-item ("新根重建":
// writing an actual index into the new root) needs a real embedding model,
// because the hub refuses any index write without one. That
// environment-dependent acceptance lives in the explicitly invoked probe
// qa-autopilot/tools/product-probes/parallel-knowledge-vector.js, which now
// drives a real hub upsert/search, a real root switch, a real rebuild in the
// new root and a real old-root retention check, and reports RET-002/RET-006
// as BLOCKED instead of faking a green result.
//
// This file performs no model load, no download and no paid API call, and it
// never touches the live 5757/5790/8787/8790 endpoints.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fixture = require('./helpers/parallel-knowledge-fixture');
// The entry point isolates itself: ambient module addresses, live data
// directories and the real HOME are cleared here, before anything else loads.
fixture.isolateProcess();

const results = [];
function record(caseId, status, detail) {
  results.push({ caseId, status, detail });
  console.log(`CASE ${caseId} ${status} ${JSON.stringify(detail)}`);
}

const HUB_DIST = path.resolve(__dirname, '..', '..', 'node_modules', '@sanqianx', 'vector-hub', 'dist', 'cjs');

(async () => {
  const root = fixture.makeTempDir('parallel-knowledge-vector');
  try {
    const oldRoot = path.join(root, 'indexes-old');
    const newRoot = path.join(root, 'indexes-new');
    const configPath = path.join(root, 'vector-hub', 'config.json');
    fs.mkdirSync(path.join(oldRoot, 'demo'), { recursive: true });
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(path.join(oldRoot, 'demo', 'note.md'), '旧索引根下的真实数据\n', 'utf8');
    const oldRootBefore = fixture.hashTree(oldRoot);
    const knowledgePath = fixture.makeKnowledgeDir(root, 'knowledge-index');
    fs.writeFileSync(path.join(knowledgePath, 'README.md'), '# 索引根切换\n\nRET006TOKEN 项目知识\n', 'utf8');
    const knowledgeBefore = fixture.hashTree(knowledgePath);

    const port = await fixture.freePort();
    const token = 'parallel-knowledge-runtime-token';
    const process_ = fixture.spawnNode([
      path.join(HUB_DIST, 'bin.js'), 'serve', '--port', String(port), '--root', oldRoot, '--config', configPath,
    ], {
      KB_VECTOR_MANAGED: '1',
      KB_VECTOR_RUNTIME_TOKEN: token,
      VECTOR_HUB_DISABLE_PICKER: '1',
      VECTOR_HUB_ROOT: oldRoot,
      VECTOR_HUB_CONFIG: configPath,
      MINIMAX_API_KEY: '',
    });
    try {
      const base = `http://127.0.0.1:${port}`;
      fixture.assertAllowedEndpoint(base, 'vector hub');
      await fixture.waitForHttp(`${base}/api/projects`, 20000);
      const before = await (await fetch(`${base}/api/projects`)).json();
      assert.ok(before.projects.length >= 0);

      // The real switch: the shell posts the new absolute index root.
      const switched = await fetch(`${base}/api/internal/runtime-config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ settings: null, storageRoot: newRoot }),
      });
      const switchedText = await switched.text();
      assert.equal(switched.status, 200, `runtime-config switch failed: ${switched.status} ${switchedText}`);
      const switchedBody = JSON.parse(switchedText);

      // ---- RET-006.a-root-switch
      assert.equal(switchedBody.rootPath, path.resolve(newRoot), 'the hub must report the new index root');
      assert.ok(fs.existsSync(newRoot), 'the new index root must be created');
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      assert.equal(path.resolve(config.settings.rootPath), path.resolve(newRoot), 'the persisted configuration must point at the new root');
      const after = await (await fetch(`${base}/api/projects`)).json();
      assert.ok(Array.isArray(after.projects));
      record('RET-006.a-root-switch', 'PASS', {
        port,
        reportedRootPath: switchedBody.rootPath,
        persistedRoot: config.settings.rootPath,
        newRootCreated: fs.existsSync(newRoot),
      });

      // ---- RET-006.c-old-root-retained
      assert.deepEqual(fixture.hashTree(oldRoot), oldRootBefore, 'the old index root data must be retained byte-for-byte');
      record('RET-006.c-old-root-retained', 'PASS', {
        oldRoot: path.resolve(oldRoot),
        oldRootRetained: JSON.stringify(fixture.hashTree(oldRoot)) === JSON.stringify(oldRootBefore),
        oldRootStillExists: fs.existsSync(oldRoot),
      });

      // ---- RET-006.d-project-knowledge-kept
      assert.deepEqual(fixture.hashTree(knowledgePath), knowledgeBefore, 'the project knowledge must not be moved by an index root switch');
      record('RET-006.d-project-knowledge-kept', 'PASS', {
        knowledgePath: path.resolve(knowledgePath),
        projectKnowledgeUnchanged: JSON.stringify(fixture.hashTree(knowledgePath)) === JSON.stringify(knowledgeBefore),
      });

      // ---- RET-006.b-writer-drain
      // The drain barrier, measured on the real HubManager: a real project
      // write that is still running must finish before the root switch
      // resolves.
      const { HubManager } = require(path.join(HUB_DIST, 'server', 'manager.js'));
      const drainOldRoot = path.join(root, 'drain-old');
      const drainNewRoot = path.join(root, 'drain-new');
      const drainConfig = path.join(root, 'drain', 'config.json');
      fs.mkdirSync(drainOldRoot, { recursive: true });
      fs.mkdirSync(path.dirname(drainConfig), { recursive: true });
      const manager = await HubManager.load({ rootPath: drainOldRoot, configPath: drainConfig, managed: true });
      const order = {};
      const write = manager.withProjectWrite('demo', async () => {
        await new Promise(resolve => setTimeout(resolve, 600));
        order.writeFinished = Date.now();
        return 'written';
      });
      await new Promise(resolve => setTimeout(resolve, 50));
      const switchStart = Date.now();
      await manager.applyRuntimeSettings(null, drainNewRoot);
      order.switchFinished = Date.now();
      order.switchStart = switchStart;
      await write;
      assert.ok(order.writeFinished, 'the in-flight write must have finished');
      assert.ok(order.writeFinished <= order.switchFinished, 'the root switch must wait for the old writer to drain');
      assert.ok(order.switchFinished - switchStart >= 400, 'the root switch must not resolve before the pending write completes');
      assert.equal(path.resolve(manager.hub.rootPath), path.resolve(drainNewRoot), 'the manager must point at the new root after the switch');
      assert.ok(fs.existsSync(drainOldRoot), 'the drained root must still exist');
      record('RET-006.b-writer-drain', 'PASS', {
        switchWaitedForWriter: order.switchFinished - order.switchStart,
        writerFinishedBeforeSwitch: order.writeFinished <= order.switchFinished,
        managerRootAfterSwitch: path.resolve(manager.hub.rootPath),
        drainedRootStillExists: fs.existsSync(drainOldRoot),
      });
    } finally {
      process_.child.kill();
      await process_.exited;
    }

    const summary = {
      lane: 'test-knowledge',
      file: 'parallel-knowledge-vector-test.js',
      cases: results,
      ret006Overall: 'PARTIAL',
      ret006ScopeHere: 'a-d only: this file proves the deterministic, environment-independent sub-items of RET-006 and nothing more.',
      ret006NotExercisedHere: '新根重建（向新根写入真实索引）需要真实 embedding 模型，hub 在未配置模型时拒绝任何索引写入；该环境依赖验收在显式调用的 probe qa-autopilot/tools/product-probes/parallel-knowledge-vector.js 中判定——该 probe 已实现真实 hub upsert/search、根切换、新根重建检索与旧根保留，未取得模型时记 BLOCKED。',
      vectorChannel: 'no index content was written: the environment has no authorised embedding model, so only the deterministic storage-root contracts are proven here',
      probe: 'qa-autopilot/tools/product-probes/parallel-knowledge-vector.js',
    };
    const target = process.env.PARALLEL_KNOWLEDGE_EVIDENCE;
    if (target) fs.mkdirSync(path.dirname(target), { recursive: true });
    if (target) fs.writeFileSync(target, JSON.stringify(summary, null, 2), 'utf8');
    console.log('parallel-knowledge-vector-test PASS (RET-006 sub-items a-d only; the new-root rebuild is covered by the tracked probe, not here)');
  } finally {
    fixture.removeTree(root);
    fixture.cleanupIsolatedProcess();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
