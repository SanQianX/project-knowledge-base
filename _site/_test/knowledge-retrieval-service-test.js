const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { StorageLayout } = require('../lib/storage-layout');
const { ProjectRegistryStore } = require('../lib/project-registry-store');
const { ProjectStore } = require('../lib/project-store');
const { KnowledgeRetrievalService } = require('../lib/knowledge-retrieval-service');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-retrieval-'));
  const layout = new StorageLayout({ dataDir: path.join(root, 'data') });
  const registry = new ProjectRegistryStore({ layout });
  const projects = new ProjectStore({ layout });
  await registry.initialize();

  async function addProject(projectId, relatedProjectIds = []) {
    const knowledgePath = path.join(root, 'knowledge', projectId);
    fs.mkdirSync(path.join(knowledgePath, 'modules'), { recursive: true });
    await projects.create(projectId, {
      displayName: projectId,
      storageName: projectId,
      repoPath: path.join(root, 'repos', projectId),
      knowledgePath,
      relatedProjectIds,
    }, { index: { dirty: true, generation: 9 } });
    await registry.add(projectId, { displayNameSnapshot: projectId });
    return knowledgePath;
  }

  const primary = await addProject('project-primary', ['project-related']);
  const related = await addProject('project-related');
  const secret = await addProject('project-secret');
  for (let index = 0; index < 146; index += 1) {
    fs.writeFileSync(path.join(primary, 'modules', `distractor-${String(index).padStart(3, '0')}.md`), `# Distractor ${index}\n\nRefresh credential lifecycle notes repeated for semantic distraction.\n`, 'utf8');
  }
  fs.writeFileSync(path.join(primary, 'modules', 'zzzz-token-rotation.md'), `---\ntags: [auth]\nsourcePaths: [src/security/token-rotation.js]\nroutes: [/api/tokens]\nsymbols: [TokenRotator]\n---\n# Rotation invariants\n\nThe rotation invariant is authoritative.\n`, 'utf8');
  fs.writeFileSync(path.join(primary, 'modules', 'symbol-only.md'), `---\nsymbols: [SessionEpoch]\n---\n# Epoch contract\n\nEpoch invalidation behavior.\n`, 'utf8');
  fs.writeFileSync(path.join(primary, 'modules', 'route-only.md'), `---\nroutes: [/v2/device-sessions]\n---\n# Device route\n\nDevice session route behavior.\n`, 'utf8');
  fs.writeFileSync(path.join(primary, 'modules', 'tag-only.md'), `---\ntags: [credential-audit]\n---\n# Audit tag\n\nAudit behavior.\n`, 'utf8');
  fs.writeFileSync(path.join(related, 'modules', 'related-rotation.md'), `---\nsourcePaths: [src/security/token-rotation.js]\n---\n# Related rotation\n\nRelated project evidence.\n`, 'utf8');
  fs.writeFileSync(path.join(secret, 'modules', 'secret-rotation.md'), `---\nsourcePaths: [src/security/token-rotation.js]\n---\n# Secret rotation\n\nThis project is outside the explicit scope.\n`, 'utf8');

  const service = new KnowledgeRetrievalService({ layout, registryStore: registry, projectStore: projects });
  const snapshot = {
    turns: [{
      userEvents: [{ content: 'Implement the refresh credential lifecycle and preserve credential-audit behavior.' }],
      assistantEvents: [{ content: 'A secondary hint mentions device sessions.' }],
    }],
  };
  const evidence = {
    commitSha: 'a'.repeat(40),
    subject: 'update TokenRotator SessionEpoch /v2/device-sessions',
    files: [{ status: 'M', path: 'src/security/token-rotation.js' }],
  };
  const first = await service.retrieveForCommit({ projectId: 'project-primary', conversationSnapshot: snapshot, commitEvidence: evidence, contextBudget: 64 * 1024 });
  const second = await service.retrieveForCommit({ projectId: 'project-primary', conversationSnapshot: snapshot, commitEvidence: evidence, contextBudget: 64 * 1024 });
  assert.strictEqual(first.manifestHash, second.manifestHash, 'deterministic inputs must produce a stable retrieval manifest hash');
  assert.strictEqual(first.manifest.backend, 'missing', 'missing index must use the safe current-Markdown fallback');
  assert(first.manifest.currentChunkCount >= 150, 'fixture must exercise a 100-200 document knowledge base');
  assert.strictEqual(first.entries[0].path, 'modules/zzzz-token-rotation.md', 'exact changed-path metadata must outrank high-semantic distractors and filename order');
  assert(first.entries[0].selectionSignals.some(signal => signal.startsWith('exact-source-path:')));
  assert(first.entries.some(entry => entry.path === 'modules/symbol-only.md' && entry.selectionSignals.some(signal => signal.startsWith('structured:'))), 'symbol metadata must participate in recall/rerank');
  assert(first.entries.some(entry => entry.path === 'modules/route-only.md' && entry.selectionSignals.some(signal => signal.startsWith('structured:'))), 'route metadata must participate in recall/rerank');
  assert(first.entries.some(entry => entry.path === 'modules/tag-only.md' && entry.selectionSignals.some(signal => signal.startsWith('structured:'))), 'tag metadata must participate in recall/rerank');
  assert(first.entries.some(entry => entry.projectId === 'project-related'), 'explicit related project scope should be eligible at lower weight');
  assert(first.entries.every(entry => entry.projectId !== 'project-secret'), 'unrelated projects must never enter the candidate set');
  assert(first.manifest.selected.every(item => item.documentHash && item.contentHash && item.selectionSignals.length));

  const searched = await service.search({ projectId: 'project-primary', query: 'TokenRotator', limit: 5 });
  assert.strictEqual(searched.results[0].entry_id, 'modules/zzzz-token-rotation.md');
  assert(searched.results.every(result => result.scope_project_id !== 'project-secret'));
  console.log('knowledge-retrieval-service-test PASS');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
