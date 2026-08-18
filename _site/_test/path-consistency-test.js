const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { StorageLayout } = require('../lib/storage-layout');
const { SettingsStore } = require('../lib/settings-store');
const { ProjectRegistryStore } = require('../lib/project-registry-store');
const { ProjectStore } = require('../lib/project-store');
const { ProjectLifecycleService } = require('../lib/project-lifecycle-service');
const { KnowledgeToolRuntime } = require('../lib/knowledge-tool-runtime');
const { CommitReconciler } = require('../lib/commit-reconciler');
const { handlePostCommitEvent } = require('../lib/post-commit-automation');
const hookManager = require('../lib/hook-manager');
const { callTool } = require('../../bin/project-knowledge-mcp');
const { spawnServer } = require('./helpers/spawn-server');

const ROOT = path.resolve(__dirname, '..', '..');
const PORT = 7834;
const BASE = `http://127.0.0.1:${PORT}`;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pkb-path-v2-'));
const dataDir = path.join(temp, 'data');
const rootA = path.join(temp, 'knowledge-a');
const rootB = path.join(temp, 'knowledge-b');
const oldRepo = path.join(temp, 'old-repo');
const movedRepo = path.join(temp, 'moved-repo');
const newRepo = path.join(temp, 'new-repo');

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.strictEqual(result.status, 0, result.stderr);
  return String(result.stdout || '').trim();
}

function initializeRepo(cwd, title) {
  fs.mkdirSync(cwd, { recursive: true });
  git(cwd, ['init', '--initial-branch=main']);
  git(cwd, ['config', 'user.email', 'path@example.test']);
  git(cwd, ['config', 'user.name', 'Path Test']);
  fs.writeFileSync(path.join(cwd, 'README.md'), `# ${title}\n`, 'utf8');
  git(cwd, ['add', 'README.md']);
  git(cwd, ['commit', '-m', 'baseline']);
}

async function waitForServer() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('server did not start');
}

(async () => {
  let spawned;
  try {
    initializeRepo(oldRepo, 'Old');
    initializeRepo(newRepo, 'New');
    fs.mkdirSync(rootA, { recursive: true });
    fs.mkdirSync(rootB, { recursive: true });
    const oldKnowledge = path.join(rootA, 'old-fixed');
    fs.mkdirSync(path.join(oldKnowledge, 'modules'), { recursive: true });
    fs.writeFileSync(path.join(oldKnowledge, 'modules', 'identity.md'), '# Fixed identity\n\nOld project knowledge remains here.\n', 'utf8');

    const layout = new StorageLayout({ dataDir });
    const settingsStore = new SettingsStore({ layout });
    const registryStore = new ProjectRegistryStore({ layout });
    const projectStore = new ProjectStore({ layout });
    await settingsStore.initialize({ knowledge: { rootPath: rootA } });
    await registryStore.initialize();
    const baseline = git(oldRepo, ['rev-parse', 'HEAD']);
    const commonDir = git(oldRepo, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    await projectStore.create('project-stable', {
      displayName: 'Before rename', storageName: 'old-fixed', repoPath: oldRepo, knowledgePath: oldKnowledge,
      repoIdentity: { commonDir }, legacyExtensions: { slug: 'legacy-old' },
    }, { trackingStartCommit: baseline, index: { dirty: true, generation: 1 } });
    await registryStore.add('project-stable', { displayNameSnapshot: 'Before rename' });

    await settingsStore.updatePatch({ knowledge: { rootPath: rootB } });
    assert.strictEqual(projectStore.readConfig('project-stable').knowledgePath, oldKnowledge, 'global root changes must not move an existing project');
    await projectStore.updateConfig('project-stable', { displayName: 'After rename' });
    assert.strictEqual(projectStore.readConfig('project-stable').projectId, 'project-stable');

    const lifecycle = new ProjectLifecycleService({ layout, settingsStore, registryStore, projectStore, hookManager, triggerScriptPath: path.join(ROOT, '_site', 'scripts', 'hook-trigger.js') });
    const imported = await lifecycle.importProject({ localPath: newRepo, displayName: 'New root project' });
    assert(layout.isPathInside(rootB, imported.config.knowledgePath, { realpath: true }));
    assert(!layout.isPathInside(rootA, imported.config.knowledgePath, { realpath: true }));
    await settingsStore.updatePatch({ ai: { schema: 'ai-profiles/v1', profiles: [{ id: 'secret', apiKey: 'never-print-this-secret' }] } });

    fs.renameSync(oldRepo, movedRepo);
    const reconciler = new CommitReconciler({ layout, registryStore, projectStore, requireAiProfile: false });
    const moved = await handlePostCommitEvent({ schema: 'hook-event/v2', projectId: 'project-stable', repoRoot: movedRepo }, { layout, registryStore, projectStore, reconciler });
    assert.strictEqual(moved.ok, true);
    assert.strictEqual(projectStore.readConfig('project-stable').repoPath, path.resolve(movedRepo));
    assert.strictEqual(projectStore.readConfig('project-stable').projectId, 'project-stable');

    const runtime = new KnowledgeToolRuntime({ layout, settingsStore, registryStore, projectStore, cwd: movedRepo });
    const resolved = runtime.resolveProject({ repoPath: movedRepo });
    assert.strictEqual(resolved.projectId, 'project-stable');
    assert.strictEqual(resolved.knowledgePath, oldKnowledge);
    assert.strictEqual(resolved.indexPath, layout.getIndexPath());
    const mcpResolved = await callTool(runtime, 'project_knowledge_resolve', { projectId: 'project-stable' });
    assert.strictEqual(mcpResolved.knowledgePath, resolved.knowledgePath);
    assert.strictEqual(mcpResolved.indexPath, resolved.indexPath);

    const protectedFiles = [layout.getSettingsPath(), layout.getProjectRegistryPath(), layout.getProjectConfigPath('project-stable'), layout.getProjectStatePath('project-stable')];
    const beforeRead = new Map(protectedFiles.map(file => [file, fs.readFileSync(file, 'utf8')]));
    const entry = await runtime.get({ projectId: 'project-stable', entry: 'modules/identity.md' });
    assert.match(entry.chunks[0].chunk_text, /Old project knowledge/);
    const search = await runtime.search({ projectId: 'project-stable', query: 'Old project knowledge' });
    assert.strictEqual(search.source, 'knowledge-retrieval-service');
    assert.strictEqual(search.backend, 'markdown-hybrid-fallback');
    const cli = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'project-knowledge-kb.js'), 'get', '--project', 'project-stable', '--entry', 'modules/identity.md', '--json'], {
      cwd: movedRepo, encoding: 'utf8', env: { ...process.env, KB_DATA_DIR: dataDir, KB_SKIP_MIGRATION: '1' },
    });
    assert.strictEqual(cli.status, 0, cli.stderr);
    assert.match(JSON.parse(cli.stdout).chunks[0].chunk_text, /Old project knowledge/);
    const cliError = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'project-knowledge-kb.js'), 'get', '--project', 'missing-project', '--entry', 'README.md', '--json'], {
      cwd: movedRepo, encoding: 'utf8', env: { ...process.env, KB_DATA_DIR: dataDir, KB_SKIP_MIGRATION: '1' },
    });
    assert.notStrictEqual(cliError.status, 0);
    assert(!cliError.stderr.includes('never-print-this-secret'));
    assert(!/\bstack\b/i.test(cliError.stderr));
    for (const file of protectedFiles) assert.strictEqual(fs.readFileSync(file, 'utf8'), beforeRead.get(file), `read query mutated ${file}`);
    await runtime.close();

    spawned = spawnServer({ root: ROOT, port: PORT, dataDir, tag: 'path-v2' });
    await waitForServer();
    const response = await fetch(`${BASE}/api/projects`);
    const body = await response.json();
    const serverProject = body.projects.find(project => project.projectId === 'project-stable');
    assert.strictEqual(serverProject.config.knowledgePath, oldKnowledge);
    assert.strictEqual(layout.getIndexPath(), path.join(dataDir, 'index', 'knowledge.lancedb'));
    console.log('path-consistency-test PASS');
  } finally {
    if (spawned) {
      try { spawned.child.kill(); } catch {}
      await Promise.race([
        new Promise(resolve => spawned.child.once('exit', resolve)),
        new Promise(resolve => setTimeout(resolve, 2000)),
      ]);
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try { fs.rmSync(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); break; }
      catch (error) {
        if (attempt === 4) throw error;
        await new Promise(resolve => setTimeout(resolve, 150));
      }
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
