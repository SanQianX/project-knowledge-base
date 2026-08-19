// Run: node _site/_test/bridge-consumer-service-test.js
//
// T11 core gates: exact workspace matching, unimported skip + ACK,
// duplicate-notify idempotency, contiguous ACK under forced failure,
// drainThrough joining, ambiguity stop.

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
const bridgeModule = require('@sanqianx/ai-coding-event-bridge');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), `kb-bridge-consumer-${process.pid}-`));
const layout = new StorageLayout({ dataDir: path.join(temp, 'data') });
const registry = new ProjectRegistryStore({ layout });
const projects = new ProjectStore({ layout });
const bridgeHome = path.join(temp, 'bridge-home');
const adapter = new BridgeAdapter({ dataDir: layout.dataDir, bridgeModule, bridgeHomeDir: bridgeHome });
const store = new ConversationStore({ layout, projectStore: projects, logger: null });

function gitRepo(name) {
  const dir = path.join(temp, name);
  fs.mkdirSync(dir, { recursive: true });
  execSync('git init -q', { cwd: dir, stdio: 'ignore' });
  return dir;
}

async function importProject(projectId, repoPath, repoIdentity) {
  await projects.create(projectId, {
    storageName: projectId,
    displayName: projectId,
    repoPath,
    knowledgePath: path.join(temp, 'knowledge', projectId),
    repoIdentity,
  });
  await registry.add(projectId, { displayName: projectId });
}

async function bridgeEvent(eventType, role, content, repoIdentity, sessionId, turnId) {
  return adapter.bridge.appendConversationEvent({
    source: 'claude-code', eventType, role, content,
    sessionId, turnId, repoIdentity,
  });
}

(async () => {
  await registry.initialize();
  const ccsPath = gitRepo('ccs');
  const ccbPath = gitRepo('ccb');
  const ccsIdentity = (await bridgeModule.resolveRepoContext(ccsPath)).repoIdentity;
  const ccbIdentity = (await bridgeModule.resolveRepoContext(ccbPath)).repoIdentity;

  // Only CCS is imported.
  await importProject('project-ccs', ccsPath, ccsIdentity);

  const service = new BridgeConsumerService({
    bridgeAdapter: adapter,
    conversationStore: store,
    registryStore: registry,
    projectStore: projects,
    logger: null,
  });
  const started = await service.start();
  assert.strictEqual(started.started, true);

  // Phase A: develop in unimported CCB.
  const ccbUser = await bridgeEvent('user_prompt', 'user', 'Modify CCB parser', ccbIdentity, 'ccb-s1', 'turn-ccb-1');
  await bridgeEvent('assistant_response', 'assistant', 'CCB parser modified', ccbIdentity, 'ccb-s1', 'turn-ccb-1');
  const drainA = await service.drain('notify');
  assert.strictEqual(drainA.stats.skippedUnregistered, 2, 'unimported workspace events are skipped');
  assert.strictEqual(drainA.stats.persisted, 0);
  assert.deepStrictEqual(store.readEvents('project-ccs'), [], 'CCS store stays empty');
  const ccbStoreDir = layout.getProjectConversationEventsPath('project-ccb');
  assert.ok(!fs.existsSync(path.dirname(ccbStoreDir)), 'no CCB project conversation store is created');
  const consumerA = await adapter.getConsumer('project-knowledge');
  assert.strictEqual(consumerA.consumer.ack, ccbUser.sequence + 1, 'consumer ACK advances through skipped CCB events');

  // Phase B: develop in imported CCS.
  const ccsUser = await bridgeEvent('user_prompt', 'user', 'Modify CCS autofocus', ccsIdentity, 'ccs-s1', 'turn-ccs-1');
  await bridgeEvent('assistant_response', 'assistant', 'CCS autofocus modified', ccsIdentity, 'ccs-s1', 'turn-ccs-1');
  await service.drain('notify');
  const ccsEvents = store.readEvents('project-ccs');
  assert.strictEqual(ccsEvents.length, 2, 'exactly the CCS turn is projected');
  assert.ok(ccsEvents.every(event => !event.content.includes('CCB')), 'no CCB content leaked into CCS');
  assert.strictEqual(ccsEvents[0].eventId, ccsUser.eventId, 'global bridge eventId preserved');
  assert.strictEqual(ccsEvents[0].sequence, ccsUser.sequence, 'global bridge sequence preserved');
  assert.strictEqual(ccsEvents[0].turnId, 'turn-ccs-1', 'canonical bridge turnId preserved');

  // Unattributed evidence is never projected into a project.
  await bridgeEvent('user_prompt', 'user', 'no workspace at all', null, 'lost-s1', 'turn-lost-1');
  const drainLost = await service.drain('notify');
  assert.strictEqual(drainLost.stats.skippedNoWorkspace, 1);

  // Duplicate notifications are idempotent.
  const before = store.readEvents('project-ccs').length;
  await service.handleNotification();
  await service.handleNotification();
  assert.strictEqual(store.readEvents('project-ccs').length, before, 'duplicate wake-ups create no duplicates');

  // drainThrough joins in-flight drains and covers the boundary sequence.
  const boundaryUser = await bridgeEvent('user_prompt', 'user', 'boundary prompt', ccsIdentity, 'ccs-s2', 'turn-ccs-2');
  const throughResult = await service.drainThrough(boundaryUser.sequence, 'commit-boundary');
  assert.strictEqual(throughResult.ack, boundaryUser.sequence);
  const statusAfter = await service.status();
  assert.strictEqual(statusAfter.ack, boundaryUser.sequence);
  assert.strictEqual(statusAfter.consumerRegistered, true);
  assert.strictEqual(statusAfter.bridgeHealthy, true);

  // Contiguous ACK under forced persist failure (GATE ACK-001 semantics).
  const failStore = {
    appendBridgeEvent: async (projectId, record) => {
      if (record.content === 'fails once') throw new Error('forced persist failure');
      return { appended: true };
    },
  };
  const failService = new BridgeConsumerService({
    bridgeAdapter: adapter,
    conversationStore: failStore,
    registryStore: registry,
    projectStore: projects,
    logger: null,
    consumerName: 'project-knowledge',
  });
  await failService.start();
  const okSeq = (await bridgeEvent('user_prompt', 'user', 'succeeds', ccsIdentity, 'ccs-s3', 'turn-f1')).sequence;
  const failSeq = (await bridgeEvent('user_prompt', 'user', 'fails once', ccsIdentity, 'ccs-s3', 'turn-f2')).sequence;
  const afterSeq = (await bridgeEvent('user_prompt', 'user', 'would succeed', ccsIdentity, 'ccs-s3', 'turn-f3')).sequence;
  let drainError = null;
  try {
    await failService.drain('notify');
  } catch (error) {
    drainError = error;
  }
  assert.ok(drainError, 'failing sequence must surface an error');
  const failConsumer = await adapter.getConsumer('project-knowledge');
  assert.strictEqual(failConsumer.consumer.ack, okSeq, 'ACK stopped exactly at the last contiguous success');

  // After removing the failure, ACK may advance through the rest.
  const healStore = {
    appendBridgeEvent: async () => ({ appended: true }),
  };
  failService.conversationStore = healStore;
  const recovered = await failService.drain('retry');
  assert.strictEqual(recovered.ack, afterSeq, 'recovered drain advances through previously failed sequences');
  await service.stop();

  // Ambiguous workspace mapping stops ACK and records a gap.
  await importProject('project-ccs-clone', ccsPath, ccsIdentity);
  const ambSeq = (await bridgeEvent('user_prompt', 'user', 'ambiguous', ccsIdentity, 'ccs-s4', 'turn-amb')).sequence;
  let ambiguityError = null;
  try {
    await failService.drain('notify');
  } catch (error) {
    ambiguityError = error;
  }
  assert.ok(ambiguityError && ambiguityError.code === 'PROJECT_AMBIGUOUS', 'ambiguous mapping must stop the drain');
  const ambConsumer = await adapter.getConsumer('project-knowledge');
  assert.strictEqual(ambConsumer.consumer.ack, ambSeq - 1, 'ACK never crosses the ambiguous sequence');

  // GATE BASELINE-001 (isolated world: fresh stores + fresh bridge journal).
  const temp2 = fs.mkdtempSync(path.join(os.tmpdir(), `kb-bridge-consumer-base-${process.pid}-`));
  const layout2 = new StorageLayout({ dataDir: path.join(temp2, 'data') });
  const registry2 = new ProjectRegistryStore({ layout: layout2 });
  const projects2 = new ProjectStore({ layout: layout2 });
  const adapter2 = new BridgeAdapter({ dataDir: layout2.dataDir, bridgeModule, bridgeHomeDir: path.join(temp2, 'bridge-home') });
  const store2 = new ConversationStore({ layout: layout2, projectStore: projects2, logger: null });
  const emit2 = async (eventType, role, content, repoIdentity, sessionId, turnId) =>
    adapter2.bridge.appendConversationEvent({ source: 'claude-code', eventType, role, content, sessionId, turnId, repoIdentity });

  await registry2.initialize();
  const basePath = gitRepo('ccs-base');
  const baseIdentity = (await bridgeModule.resolveRepoContext(basePath)).repoIdentity;
  const oldUser = await emit2('user_prompt', 'user', 'old pre-import conversation', baseIdentity, 'base-s1', 'turn-base-old');
  await projects2.create('project-base', {
    storageName: 'project-base', displayName: 'project-base',
    repoPath: basePath, knowledgePath: path.join(temp2, 'knowledge', 'project-base'),
    repoIdentity: baseIdentity,
  }, { conversationBaselineCursor: oldUser.sequence });
  await registry2.add('project-base', { displayName: 'project-base' });

  const baseService = new BridgeConsumerService({
    bridgeAdapter: adapter2,
    conversationStore: store2,
    registryStore: registry2,
    projectStore: projects2,
    logger: null,
    consumerName: 'project-knowledge',
  });
  const baseStart = await baseService.start();
  const baseDrain = baseStart.drain && baseStart.drain.stats ? baseStart.drain : await baseService.drain('baseline-check');
  assert.strictEqual(baseDrain.stats.skippedBelowBaseline >= 1, true, 'pre-baseline events are skipped, not backfilled');
  assert.deepStrictEqual(store2.readEvents('project-base'), [], 'no pre-import history projected');
  const newUser = await emit2('user_prompt', 'user', 'fresh post-import conversation', baseIdentity, 'base-s2', 'turn-base-new');
  await baseService.drain('notify');
  const baseEvents = store2.readEvents('project-base');
  assert.strictEqual(baseEvents.length, 1);
  assert.strictEqual(baseEvents[0].eventId, newUser.eventId, 'post-import events are projected');

  // Offline recovery: project imported without a baseline gets one at the
  // current watermark on first attachment — still no backfill.
  const offlinePath = gitRepo('ccs-offline');
  const offlineIdentity = (await bridgeModule.resolveRepoContext(offlinePath)).repoIdentity;
  await emit2('user_prompt', 'user', 'history before offline project attached', offlineIdentity, 'off-s0', 'turn-off-old');
  await projects2.create('project-offline', {
    storageName: 'project-offline', displayName: 'project-offline',
    repoPath: offlinePath, knowledgePath: path.join(temp2, 'knowledge', 'project-offline'),
    repoIdentity: offlineIdentity,
  }, { conversationBaselineCursor: null });
  await registry2.add('project-offline', { displayName: 'project-offline' });
  const attachDrain = await baseService.drain('first-attachment');
  assert.deepStrictEqual(store2.readEvents('project-offline'), [], 'first attachment establishes baseline without backfilling');
  const offlineState = projects2.readState('project-offline');
  assert.ok(Number.isInteger(offlineState.conversationBaselineCursor), 'baseline persisted at attachment-time watermark');
  await emit2('user_prompt', 'user', 'after offline project attached', offlineIdentity, 'off-s1', 'turn-off-new');
  await baseService.drain('notify');
  const offlineEvents = store2.readEvents('project-offline');
  assert.strictEqual(offlineEvents.length, 1, 'only post-attachment events project');
  assert.ok(offlineEvents[0].content.includes('after offline project attached'));

  console.log('bridge-consumer-service-test PASS');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
