const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { StorageLayout } = require('../lib/storage-layout');
const { SettingsStore } = require('../lib/settings-store');
const { ProjectRegistryStore } = require('../lib/project-registry-store');
const { ProjectStore } = require('../lib/project-store');
const { KnowledgeToolRuntime } = require('../lib/knowledge-tool-runtime');
const { validateKb, buildPrContextPack } = require('../lib/kb-validator');
const { regenerateIndexes } = require('../lib/index-builder');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pkb-pr-v2-'));
const knowledgePath = path.join(temp, 'knowledge');

function writeKnowledge() {
  fs.mkdirSync(path.join(knowledgePath, 'modules'), { recursive: true });
  fs.mkdirSync(path.join(knowledgePath, 'changes'), { recursive: true });
  fs.writeFileSync(path.join(knowledgePath, 'README.md'), '# Test KB\n');
  fs.writeFileSync(path.join(knowledgePath, 'GOAL.md'), '# Goal\n');
  fs.writeFileSync(path.join(knowledgePath, 'ARCHITECTURE.md'), '# Architecture\n');
  fs.writeFileSync(path.join(knowledgePath, 'modules', 'api.md'), '---\ntags: [api]\nsourcePaths: [src/api.js]\n---\n# API\n');
  fs.writeFileSync(path.join(knowledgePath, 'changes', 'api-change.md'), '---\ntags: [api]\naffectedModules: [api]\ndevelopmentIntent: Add API memory.\n---\n# API change\n\n## Development Intent\nAdd API memory.\n\n## Implementation Result\nDone.\n\n## Evidence\n- src/api.js\n');
  regenerateIndexes(knowledgePath);
}

(async () => {
  try {
    writeKnowledge();
    const validation = validateKb(knowledgePath);
    assert(validation.ok, JSON.stringify(validation.errors));
    const pack = buildPrContextPack(knowledgePath);
    assert(pack.ok);
    assert.strictEqual(pack.pack.schema, 'pr-context-pack/v1');
    assert(pack.pack.trustedKnowledge.some(item => item.path === 'modules/api.md'));
    assert(!JSON.stringify(pack.pack).includes('_ai/'));

    const layout = new StorageLayout({ dataDir: path.join(temp, 'data') });
    const settingsStore = new SettingsStore({ layout });
    const registryStore = new ProjectRegistryStore({ layout });
    const projectStore = new ProjectStore({ layout });
    await settingsStore.initialize({ knowledge: { rootPath: path.join(temp, 'future') } });
    await registryStore.initialize();
    await projectStore.create('project-consumer', { displayName: 'Consumer', storageName: 'consumer', repoPath: temp, knowledgePath }, { index: { dirty: true, generation: 1 } });
    await registryStore.add('project-consumer', { displayNameSnapshot: 'Consumer' });
    const runtime = new KnowledgeToolRuntime({ layout, settingsStore, registryStore, projectStore, cwd: temp });
    const entry = await runtime.get({ projectId: 'project-consumer', entry: 'modules/api.md' });
    assert.match(entry.chunks[0].chunk_text, /# API/);
    await assert.rejects(runtime.get({ projectId: 'project-consumer', entry: '../settings.json' }), error => error.code === 'PATH_OUTSIDE_ROOT');
    await runtime.close();
    console.log('pr-consumer-contract-test PASS');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
