// Run: node _site/_test/requirement-recorder-test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { FIELD_LIMITS, SCHEMAS, DomainError } = require('../lib/contracts');
const { StorageLayout } = require('../lib/storage-layout');
const { ProjectRegistryStore } = require('../lib/project-registry-store');
const { ProjectStore } = require('../lib/project-store');
const { RequirementRecorder } = require('../lib/requirement-recorder');
const { recordEmbeddedClaudeInput, createRequirementMetadataAdapter } = require('../lib/requirement-adapters');
const { KnowledgeToolRuntime } = require('../lib/knowledge-tool-runtime');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), `kb-requirement-recorder-${process.pid}-`));
const dataDir = path.join(temp, 'data');

function git(repo, args) {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  return String(result.stdout || '').trim();
}

function createRepo(name) {
  const repo = path.join(temp, name);
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ['init']);
  git(repo, ['config', 'user.email', 'requirements@example.test']);
  git(repo, ['config', 'user.name', 'Requirement Test']);
  fs.writeFileSync(path.join(repo, 'README.md'), `# ${name}\n`, 'utf8');
  git(repo, ['add', 'README.md']);
  git(repo, ['commit', '-m', 'initial']);
  return repo;
}

async function addProject(registry, projects, projectId, repoPath) {
  await projects.create(projectId, {
    displayName: projectId,
    storageName: projectId,
    repoPath,
    knowledgePath: path.join(temp, 'knowledge', projectId),
  }, { trackingStartCommit: git(repoPath, ['rev-parse', 'HEAD']) });
  await registry.add(projectId, { displayName: projectId });
}

(async () => {
  const layout = new StorageLayout({ dataDir });
  const registry = new ProjectRegistryStore({ layout });
  const projects = new ProjectStore({ layout });
  await registry.initialize();
  const repoA = createRepo('repo-a');
  const repoB = createRepo('repo-b');
  await addProject(registry, projects, 'project-a', repoA);
  await addProject(registry, projects, 'project-b', repoB);

  const recorder = new RequirementRecorder({ layout, registryStore: registry, projectStore: projects });
  assert.strictEqual(fs.existsSync(layout.getProjectRequirementsPath('project-a')), false, 'requirements should be lazy-created');
  assert.strictEqual(fs.existsSync(layout.getProjectRequirementsPath('project-b')), false, 'unused project should not have an empty requirements file');

  const clients = ['claude', 'codex', 'opencode'];
  const records = [];
  for (const client of clients) {
    const adapter = createRequirementMetadataAdapter(recorder, client);
    records.push(await adapter({
      projectId: 'project-a',
      repoPath: repoA,
      sessionId: `session-${client}`,
      conversationId: `conversation-${client}`,
      text: `Implement API key validation for ${client}.`,
      apiKey: 'must-not-be-copied-from-metadata',
    }));
  }
  const schemaKeys = Object.keys(records[0]).sort();
  for (const record of records) {
    assert.strictEqual(record.schema, SCHEMAS.requirement);
    assert.deepStrictEqual(Object.keys(record).sort(), schemaKeys, 'all clients should produce the same requirement schema');
    assert.strictEqual(record.projectId, 'project-a');
    assert(record.requirementHash.startsWith('sha256:'), 'record should include a body hash');
    assert(record.headAtRecord && record.branch, 'trusted Git metadata should be captured when available');
  }
  const serialized = fs.readFileSync(layout.getProjectRequirementsPath('project-a'), 'utf8');
  assert(!serialized.includes('must-not-be-copied-from-metadata'), 'credential-like adapter metadata must not be persisted');
  assert.strictEqual(fs.existsSync(layout.getProjectRequirementsPath('project-b')), false, 'recording project A must not touch project B');
  assert.strictEqual(projects.readState('project-a').lastAnalyzedCommit, null, 'recording must not dispatch or advance analysis');
  assert.strictEqual(fs.existsSync(path.join(temp, 'knowledge', 'project-a')), false, 'recording must not create knowledge content');

  const resolvedByRoot = await recorder.recordRequirement({
    repoPath: path.join(repoA, 'README.md'),
    client: 'codex',
    sessionId: 'root-resolved',
    text: 'Resolve only from the current Git root.',
  });
  assert.strictEqual(resolvedByRoot.projectId, 'project-a');
  await assert.rejects(
    recorder.recordRequirement({ projectId: 'project-a', repoPath: repoB, client: 'codex', sessionId: 'wrong-root', text: 'Wrong repository.' }),
    error => error.code === 'PROJECT_NOT_FOUND',
  );

  const concurrent = await Promise.all(Array.from({ length: 32 }, (_, index) => recorder.recordRequirement({
    projectId: 'project-a',
    client: 'codex',
    sessionId: 'concurrent-session',
    text: `Concurrent requirement ${index}`,
  })));
  assert.strictEqual(new Set(concurrent.map(item => item.id)).size, 32, 'concurrent records should have unique ids');
  assert.strictEqual(projects.readRequirements('project-a').length, 36, 'every concurrent append should remain parseable');

  await assert.rejects(
    recorder.recordRequirement({ projectId: 'project-a', client: 'codex', sessionId: 'oversized', text: 'x'.repeat(FIELD_LIMITS.requirement + 1) }),
    error => error.code === 'INVALID_ARGUMENT' && /exceeds/.test(error.message),
  );

  const ordering = [];
  const embedded = await recordEmbeddedClaudeInput({
    recorder: {
      recordRequirement: async input => {
        ordering.push(`record:${input.client}`);
        return { id: 'req-embedded', requirementHash: 'sha256:test' };
      },
    },
    session: { projectId: 'project-a', projectPath: repoA, sessionId: 'embedded-session' },
    text: 'Embedded Claude request.',
    sendInput: async (_text, metadata) => { ordering.push(`send:${metadata.requirementId}`); return { ok: true }; },
  });
  assert.deepStrictEqual(ordering, ['record:claude', 'send:req-embedded'], 'embedded input must be durable before it is sent');
  assert.strictEqual(embedded.requirementId, 'req-embedded');
  let sentAfterFailure = false;
  await assert.rejects(recordEmbeddedClaudeInput({
    recorder: { recordRequirement: async () => { throw new DomainError('PROJECT_BUSY', 'append failed'); } },
    session: { projectId: 'project-a', projectPath: repoA, sessionId: 'embedded-session' },
    text: 'Must not silently continue.',
    sendInput: async () => { sentAfterFailure = true; },
  }), error => error.code === 'PROJECT_BUSY');
  assert.strictEqual(sentAfterFailure, false, 'embedded input must not be sent after requirement persistence fails');

  const failingRecorder = new RequirementRecorder({
    layout,
    projectStore: { appendRequirement: async () => { throw new Error('disk full'); } },
    resolver: { resolve: () => ({ projectId: 'project-a', config: { repoPath: repoA } }) },
    gitReader: { currentContext: () => ({ branch: null, headAtRecord: null }) },
  });
  await assert.rejects(
    failingRecorder.recordRequirement({ projectId: 'project-a', client: 'codex', sessionId: 'failure', text: 'Durability failure.', operationId: 'op-test-failure' }),
    error => error.operationId === 'op-test-failure' && error.retryable === true,
  );

  const runtime = new KnowledgeToolRuntime({ dataDir, cwd: repoA });
  const toolResult = await runtime.recordRequirement({
    projectId: 'project-b',
    repoPath: repoB,
    client: 'opencode',
    sessionId: 'mcp-session',
    text: 'MCP metadata write only.',
  });
  assert(toolResult.requirementId && !Object.hasOwn(toolResult, 'requirement'), 'MCP result should return an id without echoing private text');
  assert.strictEqual(projects.readRequirements('project-b').length, 1, 'MCP runtime should append to the v2 project store');
  await runtime.close();

  console.log('requirement-recorder-test PASS');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}).finally(() => {
  fs.rmSync(temp, { recursive: true, force: true });
});
