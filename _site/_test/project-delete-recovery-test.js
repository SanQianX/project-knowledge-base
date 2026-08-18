const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { StorageLayout } = require('../lib/storage-layout');
const { ProjectRegistryStore } = require('../lib/project-registry-store');
const { ProjectStore } = require('../lib/project-store');
const { ProjectLifecycleService } = require('../lib/project-lifecycle-service');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-delete-recovery-'));
  const layout = new StorageLayout({ dataDir: path.join(root, 'data') });
  const registry = new ProjectRegistryStore({ layout });
  const projects = new ProjectStore({ layout });
  await registry.initialize();
  const faultPoints = [
    'delete-tombstoned',
    'delete-before-hook', 'delete-after-hook',
    'delete-before-registry', 'delete-after-registry',
    'delete-before-metadata', 'delete-after-metadata',
    'delete-before-knowledge', 'delete-after-knowledge',
    'delete-before-completed',
  ];
  const hooks = {
    uninstallHook({ projectId }) { return { ok: true, removed: true, projectId }; },
  };
  for (let index = 0; index < faultPoints.length; index += 1) {
    const projectId = `project-delete-${String(index).padStart(2, '0')}`;
    const repoPath = path.join(root, 'repos', projectId);
    const knowledgePath = path.join(root, 'knowledge', projectId);
    fs.mkdirSync(repoPath, { recursive: true });
    fs.mkdirSync(knowledgePath, { recursive: true });
    fs.writeFileSync(path.join(knowledgePath, 'README.md'), '# User knowledge\n', 'utf8');
    await projects.create(projectId, { displayName: projectId, storageName: projectId, repoPath, knowledgePath });
    await registry.add(projectId, { displayNameSnapshot: projectId });
    let injected = false;
    const failing = new ProjectLifecycleService({
      layout, registryStore: registry, projectStore: projects, hookManager: hooks,
      fault(point) {
        if (!injected && point === faultPoints[index]) { injected = true; throw new Error(`fault:${point}`); }
      },
    });
    await assert.rejects(
      failing.deleteProject(projectId, { deleteKnowledge: true, confirmationToken: projectId }),
      error => /fault:|can be retried/.test(error.message),
      `fault ${faultPoints[index]} must stop the first attempt`,
    );
    assert(fs.existsSync(failing.deleteTransactionPath(projectId)), 'a durable tombstone must exist before any externally visible mutation');

    const recovery = new ProjectLifecycleService({ layout, registryStore: registry, projectStore: projects, hookManager: hooks });
    const recovered = await recovery.deleteProject(projectId, { deleteKnowledge: true, confirmationToken: projectId });
    assert.strictEqual(recovered.ok, true, `fault ${faultPoints[index]} must recover on retry`);
    assert(!registry.listIds().includes(projectId));
    assert(!fs.existsSync(layout.getProjectMetadataDir(projectId)));
    assert(!fs.existsSync(knowledgePath));
    const journal = recovery.readDeleteJournal(projectId);
    assert.strictEqual(journal.phase, 'completed');
    assert(Object.values(journal.steps).every(step => step.completed), 'every delete step must be durably terminal');
  }
  console.log('project-delete-recovery-test PASS');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
