const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { StorageLayout } = require('../lib/storage-layout');
const { SettingsStore } = require('../lib/settings-store');
const { ProjectRegistryStore } = require('../lib/project-registry-store');
const { ProjectStore } = require('../lib/project-store');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkb-kbpath-v2-'));
const projectId = 'project-kbpath-follow';
const oldKnowledgePath = path.join(dataDir, 'knowledge-old');
const newKnowledgePath = path.join(dataDir, 'knowledge-new');
process.env.KB_DATA_DIR = dataDir;
require('../lib/data-dir')._resetCache();

(async () => {
  try {
    fs.mkdirSync(oldKnowledgePath, { recursive: true });
    fs.mkdirSync(newKnowledgePath, { recursive: true });
    const layout = new StorageLayout({ dataDir });
    const settingsStore = new SettingsStore({ layout });
    const registryStore = new ProjectRegistryStore({ layout });
    const projectStore = new ProjectStore({ layout });
    await settingsStore.initialize({ knowledge: { rootPath: path.join(dataDir, 'future') } });
    await registryStore.initialize();
    await projectStore.create(projectId, { displayName: 'KB path follow', storageName: 'kbpath', repoPath: dataDir, knowledgePath: oldKnowledgePath });
    await registryStore.add(projectId, { displayNameSnapshot: 'KB path follow' });

    const runner = require('../lib/claude-cli-runner');
    const started = runner.startChatSession({
      slug: projectId,
      projectPath: dataDir,
      kbPath: oldKnowledgePath,
      aiProfile: { id: 'test', implementation: 'claude-code-agent', model: 'test-model' },
    });
    const recordPath = layout.getRuntimePath('claude-sessions', projectId, `${started.sessionId}.json`);
    const persisted = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    persisted.claudeSessionId = 'stale-conversation-id';
    persisted.events.push({ type: 'claude/user-prompt', text: 'old conversation' });
    fs.writeFileSync(recordPath, `${JSON.stringify(persisted, null, 2)}\n`, 'utf8');

    await projectStore.updateConfig(projectId, { knowledgePath: newKnowledgePath }, { allowKnowledgePath: true });
    delete require.cache[require.resolve('../lib/claude-cli-runner')];
    const restoredRunner = require('../lib/claude-cli-runner');
    const events = [];
    restoredRunner.subscribe(started.sessionId, event => events.push(event));
    const restored = restoredRunner.getSession(started.sessionId);
    assert.strictEqual(restored.kbPath, newKnowledgePath);
    assert.strictEqual(restored.claudeSessionId, null);
    assert.strictEqual(restored.historyCleared, true);
    assert.strictEqual(restored.turns, 0);
    assert(events.some(event => event.type === 'claude/kbpath-updated' && event.fromKbPath === oldKnowledgePath && event.toKbPath === newKnowledgePath));
    assert(!restored.outputBuffer.some(event => event.type === 'claude/user-prompt'), 'stale conversation events must be cleared');

    const persistedAfter = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    assert.strictEqual(persistedAfter.kbPath, newKnowledgePath);
    assert.strictEqual(persistedAfter.claudeSessionId, null);
    console.log('kbpath-follow-test PASS');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
