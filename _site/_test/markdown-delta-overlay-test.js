const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AtomicFile = require('../lib/atomic-file');
const { StorageLayout } = require('../lib/storage-layout');
const { ProjectRegistryStore } = require('../lib/project-registry-store');
const { ProjectStore } = require('../lib/project-store');
const { KnowledgeRetrievalService } = require('../lib/knowledge-retrieval-service');
const { CHUNKER_VERSION } = require('../lib/markdown-knowledge-indexer');
const { sha256 } = require('../lib/knowledge-schema');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-delta-overlay-'));
  const layout = new StorageLayout({ dataDir: path.join(root, 'data') });
  const registry = new ProjectRegistryStore({ layout });
  const projects = new ProjectStore({ layout });
  await registry.initialize();
  const projectId = 'project-delta';
  const knowledgePath = path.join(root, 'knowledge');
  fs.mkdirSync(path.join(knowledgePath, 'modules'), { recursive: true });
  const changedPath = path.join(knowledgePath, 'modules', 'changed.md');
  const deletedPath = path.join(knowledgePath, 'modules', 'deleted.md');
  const oldChanged = '# Changed\n\nStale token policy from C0.\n';
  const oldDeleted = '# Deleted\n\nStale deleted knowledge.\n';
  fs.writeFileSync(changedPath, oldChanged, 'utf8');
  fs.writeFileSync(deletedPath, oldDeleted, 'utf8');
  await projects.create(projectId, {
    displayName: 'Delta', storageName: 'delta', repoPath: root, knowledgePath,
  }, { index: { dirty: true, generation: 2, sinceCommit: '1'.repeat(40) } });
  await registry.add(projectId, { displayNameSnapshot: 'Delta' });
  AtomicFile.writeJsonAtomic(layout.getRuntimePath('index-sources', `${projectId}.json`), {
    schema: 'knowledge-index-source-manifest/v1',
    projectId,
    generation: 1,
    entries: {
      'modules/changed.md': { entryId: 'modules/changed.md', documentHash: sha256(`chunker:${CHUNKER_VERSION}\n${oldChanged}`), sourceCommit: '0'.repeat(40) },
      'modules/deleted.md': { entryId: 'modules/deleted.md', documentHash: sha256(`chunker:${CHUNKER_VERSION}\n${oldDeleted}`), sourceCommit: '0'.repeat(40) },
    },
  });

  const currentChanged = `---\nsourcePaths: [src/token-policy.js]\n---\n# Changed\n\nC1 current rotating token policy truth.\n`;
  fs.writeFileSync(changedPath, currentChanged, 'utf8');
  fs.unlinkSync(deletedPath);
  fs.writeFileSync(path.join(knowledgePath, 'modules', 'new.md'), `---\ntags: [token-policy]\n---\n# New\n\nC1 newly documented policy.\n`, 'utf8');
  fs.mkdirSync(layout.getIndexPath(), { recursive: true });

  const staleRows = [{
    record_id: 'project:project-delta:modules/changed.md:0',
    space_id: 'project:project-delta', entry_id: 'modules/changed.md', chunk_id: 'modules/changed.md:0', chunk_order: 0,
    title: 'Changed', chunk_text: oldChanged, document_hash: sha256(`chunker:${CHUNKER_VERSION}\n${oldChanged}`),
    relevance_score: 1, match_channels: ['semantic'],
  }, {
    record_id: 'project:project-delta:modules/deleted.md:0',
    space_id: 'project:project-delta', entry_id: 'modules/deleted.md', chunk_id: 'modules/deleted.md:0', chunk_order: 0,
    title: 'Deleted', chunk_text: oldDeleted, document_hash: sha256(`chunker:${CHUNKER_VERSION}\n${oldDeleted}`),
    relevance_score: 2, match_channels: ['semantic'],
  }];
  const service = new KnowledgeRetrievalService({
    layout, registryStore: registry, projectStore: projects,
    databaseProvider: () => ({ hybridSearch: async () => staleRows }),
    embedderProvider: () => ({ embedQuery: async () => [1] }),
  });
  const result = await service.retrieveForCommit({
    projectId,
    conversationSnapshot: { turns: [{ userEvents: [{ content: 'Update rotating token policy.' }], assistantEvents: [] }] },
    commitEvidence: { commitSha: '1'.repeat(40), subject: 'token policy', files: [{ status: 'M', path: 'src/token-policy.js' }] },
  });
  const changed = result.entries.find(entry => entry.path === 'modules/changed.md');
  const added = result.entries.find(entry => entry.path === 'modules/new.md');
  assert(changed && /C1 current/.test(changed.content), 'stale index content must be replaced by current Markdown truth');
  assert(!result.entries.some(entry => /Stale token policy/.test(entry.content)), 'stale chunk text must never reach the prompt context');
  assert(!result.entries.some(entry => entry.path === 'modules/deleted.md'), 'deleted Markdown must be removed from stale candidates');
  assert(changed.selectionSignals.includes('markdown-delta-overlay'));
  assert(added && added.selectionSignals.includes('markdown-delta-overlay'), 'new Markdown must enter the in-memory delta overlay immediately');
  assert.strictEqual(result.manifest.health.scopes[0].overlayEntries, 2);
  assert.strictEqual(result.manifest.health.scopes[0].deletedEntries, 1);
  assert.strictEqual(result.manifest.backend, 'ok', 'a stale index may contribute recall while current Markdown remains truth');
  assert.strictEqual(changed.documentHash, sha256(`chunker:${CHUNKER_VERSION}\n${currentChanged}`), 'retrieval manifest must freeze the current document hash');
  assert.strictEqual(projects.readState(projectId).index.dirty, true, 'retrieval must not wait for or mutate index completion state');
  console.log('markdown-delta-overlay-test PASS');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
