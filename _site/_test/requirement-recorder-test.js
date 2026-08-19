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
const { ConversationStore } = require('../lib/conversation-store');
const { createRequirementMetadataAdapter } = require('../lib/requirement-adapters');
const { KnowledgeToolRuntime } = require('../lib/knowledge-tool-runtime');
const claudeRunner = require('../lib/claude-cli-runner');

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
  const conversations = new ConversationStore({ layout, projectStore: projects });
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
  const serialized = fs.readFileSync(layout.getProjectConversationEventsPath('project-a'), 'utf8');
  assert(!serialized.includes('must-not-be-copied-from-metadata'), 'credential-like adapter metadata must not be persisted');
  assert.strictEqual(fs.existsSync(layout.getProjectRequirementsPath('project-a')), false, 'new explicit adapters must not create a second requirement store');
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
  assert.strictEqual(conversations.readEvents('project-a').length, 36, 'every concurrent append should remain parseable in ConversationStore');

  await assert.rejects(
    recorder.recordRequirement({ projectId: 'project-a', client: 'codex', sessionId: 'oversized', text: 'x'.repeat(FIELD_LIMITS.requirement + 1) }),
    error => error.code === 'INVALID_ARGUMENT' && /exceeds/.test(error.message),
  );

  // T14 / I-02: the Workbench itself never appends Development Conversation
  // events; explicit record_requirement keeps working for Workbench sessions.
  const chat = claudeRunner.startChatSession({
    slug: 'project-a', projectPath: repoA, kbPath: path.join(temp, 'knowledge', 'project-a'),
    aiProfile: { id: 'test-profile', implementation: 'claude-code-agent', mainModel: 'test-model' },
  });
  // T15: every internal SDK session carries the Bridge capture-disable markers.
  const chatEnv = claudeRunner.getSession(chat.sessionId).claudeEnv || {};
  assert.strictEqual(chatEnv.AI_CODING_EVENT_BRIDGE_CAPTURE, '0', 'internal SDK sessions disable Bridge capture');
  assert.strictEqual(chatEnv.AI_CODING_EVENT_ORIGIN, 'project-knowledge-internal', 'internal SDK sessions are marked as Project-Knowledge internal');
  const beforeWorkbench = conversations.readEvents('project-a').length;
  const explicitRecord = await recorder.recordRequirement({
    projectId: 'project-a', repoPath: repoA, client: 'claude', sessionId: chat.sessionId, text: 'Explicit MCP requirement for a Workbench session.',
  });
  const explicitUser = conversations.readEvents('project-a').find(event => event.legacyRequirementId === explicitRecord.id);
  assert(explicitUser, 'explicit record_requirement still persists for Workbench sessions');
  for (const listener of claudeRunner.getSession(chat.sessionId).listeners) listener({ type: 'claude/result', result: 'Workbench reply must NOT be captured.', isError: false });
  await new Promise(resolve => setTimeout(resolve, 100));
  const afterWorkbench = conversations.readEvents('project-a');
  assert.strictEqual(afterWorkbench.length, beforeWorkbench + 1, 'only the explicit requirement was appended');
  assert(!afterWorkbench.some(event => String(event.content || '').includes('Workbench reply must NOT be captured.')), 'no embedded assistant capture exists');
  assert(!afterWorkbench.some(event => event.rawEventType === 'embedded-claude-result'), 'the embedded capture path is gone');
  claudeRunner.deleteSession(chat.sessionId);

  const failingRecorder = new RequirementRecorder({
    layout,
    projectStore: projects,
    conversationStore: { appendEvent: async () => { throw new Error('disk full'); } },
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
  assert.strictEqual(conversations.readEvents('project-b').length, 1, 'MCP runtime should append to the shared ConversationStore');
  assert.strictEqual(fs.existsSync(layout.getProjectRequirementsPath('project-b')), false, 'MCP must not create legacy requirements.jsonl');
  await runtime.close();

  console.log('requirement-recorder-test PASS');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}).finally(() => {
  fs.rmSync(temp, { recursive: true, force: true });
});
