// Run: node _site/_test/cross-repo-isolation-e2e-test.js
//
// GATE CROSS-REPO-001 end to end with real Git workspaces and the real
// Bridge journal: CCS imported / CCB unimported, commit boundary ordering
// (append -> drainThrough -> writeBoundary -> bind), no CCB substitution.
// Also covers CROSS-REPO-002 (same remote, different clones), WORKTREE-001
// and NESTED-CWD-001 at the consumer level.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const { StorageLayout } = require('../lib/storage-layout');
const { ProjectRegistryStore } = require('../lib/project-registry-store');
const { ProjectStore } = require('../lib/project-store');
const { ConversationStore } = require('../lib/conversation-store');
const { BridgeAdapter } = require('../lib/bridge-adapter');
const { BridgeConsumerService } = require('../lib/bridge-consumer-service');
const { CommitConversationBinder } = require('../lib/commit-conversation-binder');
const claudeConnector = require('@sanqianx/ai-coding-event-bridge').claudeHookEntry;
const bridgeModule = require('@sanqianx/ai-coding-event-bridge');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), `kb-cross-repo-e2e-${process.pid}-`));
const layout = new StorageLayout({ dataDir: path.join(temp, 'data') });
const registry = new ProjectRegistryStore({ layout });
const projects = new ProjectStore({ layout });
const bridgeHome = path.join(temp, 'bridge-home');
const adapter = new BridgeAdapter({ dataDir: layout.dataDir, bridgeModule, bridgeHomeDir: bridgeHome });
const store = new ConversationStore({ layout, projectStore: projects, logger: null });
const service = new BridgeConsumerService({
  bridgeAdapter: adapter, conversationStore: store, registryStore: registry, projectStore: projects, logger: null,
});

function git(dir, args) {
  execSync(`git ${args.map(value => `"${value.replace(/"/g, '\\"')}"`).join(' ')}`, { cwd: dir, stdio: 'ignore' });
}

function makeRepo(name, origin) {
  const dir = path.join(temp, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'e2e@example.test']);
  git(dir, ['config', 'user.name', 'E2E Test']);
  if (origin) git(dir, ['remote', 'add', 'origin', origin]);
  fs.writeFileSync(path.join(dir, 'README.md'), `# ${name}\n`);
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'init']);
  return dir;
}

function commitFile(repo, name, content) {
  fs.writeFileSync(path.join(repo, `${name}.txt`), `${content}\n`);
  git(repo, ['add', '.']);
  git(repo, ['commit', '-q', '-m', name]);
  return execSync('git rev-parse HEAD', { cwd: repo, encoding: 'utf8' }).trim();
}

// External Claude session in a workspace: UserPromptSubmit + Stop payloads.
async function externalClaudeTurn(repoDir, sessionId, prompt, reply) {
  const user = await claudeConnector.main({
    home: bridgeHome,
    payload: { hookName: 'UserPromptSubmit', session_id: sessionId, cwd: repoDir, prompt },
  });
  const assistant = await claudeConnector.main({
    home: bridgeHome,
    payload: { hookName: 'Stop', session_id: sessionId, cwd: repoDir, last_assistant_message: reply },
  });
  return { user, assistant };
}

async function importProject(projectId, repoDir) {
  const identity = (await bridgeModule.resolveRepoContext(repoDir)).repoIdentity;
  const watermark = await adapter.getHighWatermark({});
  await projects.create(projectId, {
    storageName: projectId, displayName: projectId,
    repoPath: repoDir, knowledgePath: path.join(temp, 'knowledge', projectId),
    repoIdentity: identity,
  }, { conversationBaselineCursor: watermark.status === 'captured' ? watermark.cursor : null });
  await registry.add(projectId, { displayName: projectId });
  return identity;
}

// T13 ordering for one commit: boundary append -> drainThrough -> project
// boundary freeze -> binder bind (the reconcile/analyzer tail is owned by the
// hook path and covered by full-integration-e2e-test).
async function boundaryAndBind(projectId, repoDir, commitSha, identity) {
  const boundaryResult = await adapter.appendCommitBoundary({
    projectId,
    repoIdentity: identity,
    commitSha,
    parentShas: [],
    branch: 'main',
    committedAt: new Date().toISOString(),
    operationId: `op-e2e-${commitSha.slice(0, 8)}`,
  });
  assert.strictEqual(boundaryResult.status, 'captured');
  const boundary = boundaryResult.boundary;
  await service.drainThrough(boundary.journalSequence, 'commit-boundary');
  store.writeBoundary(projectId, boundary);
  const binder = new CommitConversationBinder({ layout, projectStore: projects, conversationStore: store });
  return binder.bind({ projectId, commitSha });
}

(async () => {
  await registry.initialize();
  const ccs = makeRepo('CCS', 'git@github.com:acme/ccs.git');
  const ccb = makeRepo('CCB', 'git@github.com:acme/ccb.git');

  const ccsIdentity = await importProject('project-ccs', ccs);
  const ccbIdentity = (await bridgeModule.resolveRepoContext(ccb)).repoIdentity;
  assert.notStrictEqual(ccsIdentity.workspaceId, ccbIdentity.workspaceId);
  await service.start();

  // Phase A — develop in unimported CCB.
  await externalClaudeTurn(ccb, 'ccb-session-1', 'Modify CCB parser', 'CCB parser modified');
  await service.drain('notify');
  assert.deepStrictEqual(store.readEvents('project-ccs'), [], 'CCS ConversationStore stays empty');
  assert.ok(!fs.existsSync(path.dirname(layout.getProjectConversationEventsPath('project-ccb'))),
    'no Project-Knowledge CCB conversation store is created merely because Bridge observed CCB');
  const consumerAfterCcb = await adapter.getConsumer('project-knowledge');
  assert.ok(consumerAfterCcb.consumer.ack > 0, 'consumer ACK advanced through the deterministically skipped CCB events');

  // Phase B — develop in imported CCS (from a nested directory: NESTED-CWD-001).
  fs.mkdirSync(path.join(ccs, 'modules', 'foo'), { recursive: true });
  const nestedTurn = await externalClaudeTurn(path.join(ccs, 'modules', 'foo'), 'ccs-session-1', 'Modify CCS autofocus', 'CCS autofocus modified');
  await service.drain('notify');
  const ccsEvents = store.readEvents('project-ccs');
  assert.strictEqual(ccsEvents.length, 2, 'exactly the CCS turn is projected');
  assert.ok(ccsEvents.every(event => event.repoIdentity.workspaceId === ccsIdentity.workspaceId),
    'nested-cwd conversation resolves to the CCS workspace');
  assert.strictEqual(ccsEvents[0].turnId, nestedTurn.user.turnId, 'user + assistant share one durable turnId');
  assert.ok(!ccsEvents.some(event => event.content.includes('CCB')), 'no CCB content leaked into CCS');

  // Phase C — commit CCS and freeze the snapshot.
  const commitC = commitFile(ccs, 'ccs-change', 'autofocus fix');
  const snapshotC = await boundaryAndBind('project-ccs', ccs, commitC, ccsIdentity);
  assert.strictEqual(snapshotC.projectId, 'project-ccs');
  assert.strictEqual(snapshotC.repoIdentity.workspaceId, ccsIdentity.workspaceId);
  assert.ok(JSON.stringify(snapshotC).includes('Modify CCS autofocus'), 'snapshot contains the CCS turn');
  assert.ok(!JSON.stringify(snapshotC).includes('Modify CCB parser'), 'snapshot never contains the CCB conversation');
  assert.ok(snapshotC.turns.some(turn => turn.userEvents.length === 1 && turn.assistantEvents.length === 1),
    'full turn (user + assistant) bound inside the boundary');

  // Phase D — second CCS commit right after fresh CCB conversation.
  await externalClaudeTurn(ccb, 'ccb-session-2', 'Another CCB task', 'CCB task done');
  const commitD = commitFile(ccs, 'ccs-second', 'unrelated change');
  const snapshotD = await boundaryAndBind('project-ccs', ccs, commitD, ccsIdentity);
  assert.strictEqual(snapshotD.status, 'no-new-user-prompt', 'deterministic no-evidence status');
  assert.ok(!JSON.stringify(snapshotD).includes('Another CCB task'), 'recent CCB conversation is never substituted');

  // CROSS-REPO-002 — same remote, different clones.
  const cloneA = makeRepo('clone-a', 'git@github.com:acme/ccs.git');
  const cloneB = makeRepo('clone-b', 'git@github.com:acme/ccs.git');
  const identityA = (await bridgeModule.resolveRepoContext(cloneA)).repoIdentity;
  const identityB = (await bridgeModule.resolveRepoContext(cloneB)).repoIdentity;
  assert.strictEqual(identityA.remote, ccsIdentity.remote, 'remotes are equal');
  assert.notStrictEqual(identityA.workspaceId, identityB.workspaceId, 'workspace identity differs');
  await importProject('project-clone-a', cloneA);
  await externalClaudeTurn(cloneB, 'clone-b-session', 'work in clone B', 'clone B reply');
  await service.drain('notify');
  assert.deepStrictEqual(store.readEvents('project-clone-a'), [], 'clone B conversation never enters the clone A project');
  assert.ok(!fs.existsSync(layout.getProjectConversationEventsPath('project-clone-b')) || store.readEvents('project-clone-b').length === 0,
    'unimported clone B has no projected conversation');

  // WORKTREE-001 — shared commonDir, distinct workspaceIds, no cross-binding.
  const wtMain = makeRepo('wt-main', 'git@github.com:acme/wt.git');
  fs.mkdirSync(path.join(temp, 'wt-holder'), { recursive: true });
  const wtA = path.join(temp, 'wt-holder', 'wt-a');
  const wtB = path.join(temp, 'wt-holder', 'wt-b');
  git(wtMain, ['worktree', 'add', '-q', wtA, 'HEAD']);
  git(wtMain, ['worktree', 'add', '-q', wtB, 'HEAD']);
  const wtMainIdentity = (await bridgeModule.resolveRepoContext(wtMain)).repoIdentity;
  const wtAIdentity = (await bridgeModule.resolveRepoContext(wtA)).repoIdentity;
  const wtBIdentity = (await bridgeModule.resolveRepoContext(wtB)).repoIdentity;
  assert.strictEqual(wtAIdentity.commonDir, wtMainIdentity.commonDir, 'worktrees share commonDir');
  assert.notStrictEqual(wtAIdentity.workspaceId, wtBIdentity.workspaceId);
  await importProject('project-wt-a', wtA);
  await externalClaudeTurn(wtB, 'wt-b-session', 'work in worktree B', 'worktree B reply');
  await service.drain('notify');
  assert.deepStrictEqual(store.readEvents('project-wt-a'), [], 'worktree B conversation is not auto-bound to worktree A');

  console.log('cross-repo-isolation-e2e-test PASS');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
