'use strict';
// _site/_test/parallel-memory-injection-origin-probe.js
//
// MEM-008 C01 — who is the author of a captured Workbench event, and can a
// real delegation ever be admitted as a human turn?
//
// The chain under test, every component real:
//
//   real Workbench module 0.13.6 (real capture, real eventKey, real
//     ConversationCapture -> real event-bridge console)
//       -> real event-bridge console journal (real normalisation)
//         -> real knowledge engine (real journal consumption, real
//            ConversationStore, real MemoryService.capture admission gate)
//
// Three real turns, each through the module's own HTTP contract:
//
//   A  the real CLIENT shape   session created with inputOrigin 'human'
//                              (packages/client: opts.inputOrigin || 'human')
//   B  the real DISPATCHER shape
//                              child session created WITHOUT an origin, then
//                              the input carries the dispatcher's own option
//                              object { inputOrigin: 'agent-delegation' }
//                              (workbench-service dispatcher -> send())
//   C  the CALLER-ASSERTED shape
//                              child session created WITHOUT an origin, then
//                              the input carries { inputOrigin: 'human' }
//                              — the public input endpoint forwards the body
//                              options straight into send()
//
// Everything the probe writes is synthetic: the fixture repository, the
// synthetic markers in the prompts, the isolated engine data directory. No
// real user identity is impersonated: leg C proves that NO identity is
// verified at all, which is exactly the open C01 question.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const shell = require('./helpers/parallel-memory-injection-shell');

const PROFILE_ID = String(process.env.PK_WB_MODEL_PROFILE || 'minimax');
const REQUESTED_MODEL = String(process.env.PK_WB_MODEL_ID || 'MiniMax-M3.1-Flash');
const EFFORT = String(process.env.PK_WB_MODEL_EFFORT || 'max');
const TURN_TIMEOUT_MS = Number(process.env.PK_WB_TURN_TIMEOUT_MS || 420000);

const BINDER_ENTRY = path.join(path.dirname(require.resolve('@sanqianx/ai-coding-knowledge-engine/package.json', { paths: [path.join(shell.REPO_ROOT)] })), 'src', 'runtime', 'commit-conversation-binder.js');

const results = [];
function record(caseId, status, detail) {
  results.push({ caseId, status, detail });
  console.log(`CASE ${caseId} ${status} ${JSON.stringify(detail)}`);
}

function markerFor(leg) {
  return `SYNTHETIC-C01-${leg}`;
}

function promptFor(leg) {
  return `【合成测试事件 ${markerFor(leg)}】这是一条用于归属审查的合成测试输入，请只回复：收到。`;
}

async function main() {
  const moduleRoot = shell.resolveWorkbenchModuleRoot();
  if (!moduleRoot) throw new Error('no claude-ai-workbench module copy was found to host');
  const identity = shell.packageIdentity(moduleRoot);

  const layout = shell.createIsolationLayout('parallel-memory-injection-origin');
  const engineToken = crypto.randomBytes(24).toString('hex');
  const bridgeToken = crypto.randomBytes(24).toString('hex');
  const brainId = `brain-${crypto.randomBytes(6).toString('hex')}`;
  const projectId = `c01-${crypto.randomBytes(4).toString('hex')}`;

  const console_ = await shell.startBridgeConsole({ home: layout.bridgeHome, runtimeToken: bridgeToken });
  const vector = await shell.startVectorHubStandIn();
  const engine = await shell.startRealEngine({
    dataDir: layout.engineDataDir,
    runtimeToken: engineToken,
    debug: true,
    consume: true,
    bridgeUrl: console_.url,
    vectorUrl: vector.url,
  });
  const proxy = await shell.startRecordingProxy({ target: engine.url, label: 'knowledge-engine' });

  const repo = shell.makeGitRepo(layout.repos, 'c01-origin');
  const repoIdentity = await shell.resolveRepoIdentity(repo.path);
  if (!repoIdentity || !repoIdentity.repoIdentity) throw new Error('the fixture repository has no bridge repo identity');

  // The console must know the project, otherwise the real capture is refused
  // with PROJECT_NOT_REGISTERED.
  const registered = await console_.api('POST', '/api/projects', { path: repo.path });
  if (registered.status !== 201) throw new Error(`the console project registration failed: HTTP ${registered.status} ${JSON.stringify(registered.body)}`);
  const consoleProject = registered.body.project;
  const journalId = consoleProject.id;

  const scopes = await engine.api('POST', '/api/scopes', {
    scopes: [{ id: `scope-${crypto.randomBytes(4).toString('hex')}`, kind: 'brain', brainId, name: 'C01 brain', knowledgePath: layout.brainKnowledgeDir }],
  });
  if (scopes.status !== 200) throw new Error(`the brain scope was not bound: HTTP ${scopes.status} ${JSON.stringify(scopes.body)}`);

  const project = await engine.api('POST', '/api/projects', {
    projectId,
    name: 'c01-origin',
    repoPath: repo.path,
    knowledgePath: layout.projectKnowledgeDir,
    brainId,
    journalId,
    repoIdentity: repoIdentity.repoIdentity,
  });
  if (project.status !== 200) throw new Error(`the engine project was not registered: HTTP ${project.status} ${JSON.stringify(project.body)}`);

  const port = await shell.freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = shell.spawnNode([path.join(__dirname, 'helpers', 'parallel-memory-injection-wb-host.js')], shell.hostEnv(layout, {
    PK_WB_MODULE_ROOT: moduleRoot,
    PK_WB_HOST_PORT: String(port),
    PK_WB_HOST_DATA_DIR: layout.dataDir,
    PK_WB_HOST_WORKSPACES: JSON.stringify({ 'wb-origin': repo.path }),
    PK_WB_ENGINE_URL: proxy.url,
    PK_WB_PROFILE_SOURCE: 'real-readonly',
    PK_WB_BRIDGE_URL: console_.url,
    PK_WB_BRIDGE_TOKEN: bridgeToken,
  }));

  const legs = {};
  try {
    await shell.waitForHttp(`${base}/api/claude-workbench/v1/health`, 30000);

    // ---- the three real turns -----------------------------------------
    legs.human = await shell.runWorkbenchTurn({
      base, profileId: PROFILE_ID, model: REQUESTED_MODEL, effort: EFFORT,
      workspaceRef: 'wb-origin', contextId: 'c01-origin',
      question: promptFor('HUMAN'),
      sessionInputOrigin: 'human',
      timeoutMs: TURN_TIMEOUT_MS,
    });
    // The dispatcher shape: the child session carries no origin of its own and
    // the input carries the dispatcher's own option object.
    legs.delegated = await shell.runWorkbenchTurn({
      base, profileId: PROFILE_ID, model: REQUESTED_MODEL, effort: EFFORT,
      workspaceRef: 'wb-origin', contextId: 'c01-origin',
      question: promptFor('DELEGATED'),
      sessionInputOrigin: undefined,
      inputOptions: { inputOrigin: 'agent-delegation', permissionMode: 'default', effort: EFFORT },
      timeoutMs: TURN_TIMEOUT_MS,
    });
    // The caller-asserted shape: the public input endpoint forwards the body
    // options straight into send(), so a caller can name the origin.
    legs.callerAsserted = await shell.runWorkbenchTurn({
      base, profileId: PROFILE_ID, model: REQUESTED_MODEL, effort: EFFORT,
      workspaceRef: 'wb-origin', contextId: 'c01-origin',
      question: promptFor('CALLERASSERTED'),
      sessionInputOrigin: undefined,
      inputOptions: { inputOrigin: 'human' },
      timeoutMs: TURN_TIMEOUT_MS,
    });

    record('MEM-008.C01.s1-three-real-turns', Object.values(legs).every(leg => leg && leg.sessionId) ? 'PASS' : 'BLOCKED', {
      module: { name: identity.name, version: identity.version, root: moduleRoot },
      profile: { id: PROFILE_ID, source: 'original-subscription-store read-only, credential in memory only', credentialWrittenAnywhere: false },
      turns: Object.fromEntries(Object.entries(legs).map(([key, leg]) => [key, {
        workbenchSessionId: leg.sessionId,
        claudeSessionId: leg.claudeSessionId,
        sdkReportedModel: leg.sdkReportedModel,
        isError: leg.isError,
        errorEvent: leg.error,
        answerPreview: String(leg.answer || '').slice(0, 200),
      }])),
      note: 'the origin label of a turn is decided before the model runs; the model answer is not part of this case',
    });

    // ---- the real console journal --------------------------------------
    const journalEvents = await shell.eventually(async () => {
      const response = await console_.api('GET', `/api/journal/events?journalId=${encodeURIComponent(journalId)}&fromSequence=1&limit=200`);
      const events = (response.body && response.body.events) || [];
      const prompts = events.filter(event => event.eventType === 'user_prompt');
      return prompts.length >= 3 ? { events, prompts } : null;
    }, 60000, 500);

    const bySession = {};
    for (const event of (journalEvents ? journalEvents.prompts : [])) bySession[event.sessionId] = event;

    const describe = event => event ? {
      eventId: event.eventId,
      sequence: event.sequence,
      sessionId: event.sessionId,
      turnId: event.turnId,
      eventKey: event.eventKey,
      originInEventKey: /:origin=(human|agent-delegation|unknown)$/.exec(String(event.eventKey || '')) ?.[1] || null,
      meta: event.meta || null,
      identityConfidence: event.identityConfidence,
      captureStatus: event.captureStatus,
      repoIdentity: event.repoIdentity ? { workspaceId: event.repoIdentity.workspaceId, workspaceRoot: event.repoIdentity.workspaceRoot } : null,
      authorFieldsPresent: Object.keys(event).filter(key => /author|owner|actor|person/i.test(key)),
      contentHead: String(event.content || '').slice(0, 120),
    } : null;

    const humanEvent = bySession[legs.human.sessionId] || null;
    const delegatedEvent = bySession[legs.delegated.sessionId] || null;
    const assertedEvent = bySession[legs.callerAsserted.sessionId] || null;

    record('MEM-008.C01.s2-console-journal-origin', humanEvent && delegatedEvent && assertedEvent ? 'PASS' : 'BLOCKED', {
      journalId,
      consoleProject: { id: consoleProject.id, path: consoleProject.path },
      humanLeg: describe(humanEvent),
      delegatedLeg: describe(delegatedEvent),
      callerAssertedLeg: describe(assertedEvent),
      detail: 'the real console normalised three real captures; the origin survives only inside the eventKey text and meta.origin is always the workbench module',
    });

    const delegatedLabelledHuman = delegatedEvent && /:origin=human$/.test(String(delegatedEvent.eventKey || ''));
    record('MEM-008.C01.s3-delegation-never-labelled-human', delegatedEvent && !delegatedLabelledHuman ? 'PASS' : 'BLOCKED', {
      delegatedEventKey: delegatedEvent && delegatedEvent.eventKey,
      delegatedOriginInEventKey: delegatedEvent ? (/:origin=(human|agent-delegation|unknown)$/.exec(String(delegatedEvent.eventKey || '')) || [])[1] : null,
      labelledAsHuman: Boolean(delegatedLabelledHuman),
      detail: 'the module stamped the dispatcher origin on the delegated turn; the console kept it',
    });

    // ---- the real engine consumption ------------------------------------
    const consumed = await shell.eventually(() => {
      const events = engine.engine.coordinator.conversations.readEvents(projectId);
      const prompts = events.filter(event => event.eventType === 'user_prompt');
      return prompts.length >= 3 ? prompts : null;
    }, 60000, 500);

    const consumedBySession = {};
    for (const event of (consumed || [])) consumedBySession[event.sessionId] = event;
    const consumedHuman = consumedBySession[legs.human.sessionId] || null;
    const consumedDelegated = consumedBySession[legs.delegated.sessionId] || null;
    const consumedAsserted = consumedBySession[legs.callerAsserted.sessionId] || null;

    record('MEM-008.C01.s4-engine-recovered-origin', consumedHuman && consumedDelegated && consumedAsserted ? 'PASS' : 'BLOCKED', {
      projectId,
      journalId,
      engineEventCount: consumed ? consumed.length : 0,
      humanLeg: consumedHuman ? { eventId: consumedHuman.eventId, inputOrigin: consumedHuman.inputOrigin, contentHash: consumedHuman.contentHash, sessionId: consumedHuman.sessionId } : null,
      delegatedLeg: consumedDelegated ? { eventId: consumedDelegated.eventId, inputOrigin: consumedDelegated.inputOrigin, contentHash: consumedDelegated.contentHash, sessionId: consumedDelegated.sessionId } : null,
      callerAssertedLeg: consumedAsserted ? { eventId: consumedAsserted.eventId, inputOrigin: consumedAsserted.inputOrigin, contentHash: consumedAsserted.contentHash, sessionId: consumedAsserted.sessionId } : null,
      detail: 'the real engine consumed the real journal and recovered inputOrigin from the eventKey of each real event',
    });

    if (!consumedHuman || !consumedDelegated || !consumedAsserted) {
      throw new Error('the engine did not consume the three real captured events');
    }

    // ---- the frozen snapshot of the engine ------------------------------
    const { CommitConversationBinder } = require(BINDER_ENTRY);
    const coordinator = engine.engine.coordinator;
    const binder = new CommitConversationBinder({
      layout: coordinator.layout,
      projectStore: coordinator.projectStore,
      conversationStore: coordinator.conversations,
    });
    const allEvents = coordinator.conversations.readEvents(projectId);
    const commitSha = repo.headCommit;
    const snapshot = coordinator.conversations.writeSnapshot(projectId, {
      commitSha,
      repoIdentity: repoIdentity.repoIdentity,
      parentSha: null,
      status: 'available',
      turns: binder.buildExplicitTurns(allEvents),
    });
    record('MEM-008.C01.s5-engine-frozen-snapshot', snapshot && snapshot.snapshotHash ? 'PASS' : 'BLOCKED', {
      commitSha,
      snapshotHash: snapshot && snapshot.snapshotHash,
      status: snapshot && snapshot.status,
      turnCount: snapshot && snapshot.turns.length,
      userEvents: snapshot ? snapshot.turns.reduce((total, turn) => total + turn.userEvents.length, 0) : 0,
      frozenBy: 'the engine\'s own ConversationStore.writeSnapshot over the engine\'s own stored events, with the frozen binder projection buildExplicitTurns',
      originsInSnapshot: snapshot ? snapshot.turns.flatMap(turn => turn.userEvents.map(event => ({ eventId: event.eventId, inputOrigin: event.inputOrigin }))) : [],
    });

    // ---- the real long-term-memory candidate gate -----------------------
    const memories = coordinator.memories;
    const knowledgeDir = layout.projectKnowledgeDir;
    const candidatesDir = path.join(knowledgeDir, 'memories', 'candidates');
    fs.mkdirSync(candidatesDir, { recursive: true });

    function buildCandidate(event, leg) {
      const marker = markerFor(leg);
      const entryId = `memories/candidates/c01-${leg.toLowerCase()}.md`;
      fs.writeFileSync(path.join(knowledgeDir, ...entryId.split('/')), `# ${marker}\n\n合成测试条目 ${marker}。\n`, 'utf8');
      return {
        entryId,
        text: marker,
        quote: marker,
        scopeType: 'global',
        scopeId: brainId,
        sourceEventId: event.eventId,
        sourceHash: event.contentHash,
        eligibility: { durable: true, crossProject: true, reason: 'synthetic C01 attribution probe', scopeReason: 'synthetic C01 attribution probe' },
      };
    }

    function runFor(candidate) {
      return {
        projectId,
        commitSha,
        promotedAt: new Date().toISOString(),
        staging: {
          operations: [{ path: candidate.entryId, operation: 'write', evidenceReferences: [`conversation:${snapshot.snapshotHash}`] }],
          memoryCandidates: [candidate],
        },
      };
    }

    const humanCandidate = buildCandidate(consumedHuman, 'HUMAN');
    const delegatedCandidate = buildCandidate(consumedDelegated, 'DELEGATED');
    const assertedCandidate = buildCandidate(consumedAsserted, 'CALLERASSERTED');

    const humanGate = memories.capture(runFor(humanCandidate));
    const delegatedGate = memories.capture(runFor(delegatedCandidate));
    const assertedGate = memories.capture(runFor(assertedCandidate));

    record('MEM-008.C01.s6-gate-admits-human-labelled-event', humanGate.accepted === 1 ? 'PASS' : 'BLOCKED', {
      gate: 'the real MemoryService.capture admission path of the frozen engine source',
      inputOrigin: consumedHuman.inputOrigin,
      accepted: humanGate.accepted,
      rejected: humanGate.rejected,
      detail: 'the gate is origin sensitive: a human-labelled real event passes every provenance check',
    });

    const delegatedRejected = (delegatedGate.rejected || []).some(entry => entry.code === 'SOURCE_NOT_HUMAN');
    record('MEM-008.C01.s7-gate-rejects-delegated-event', delegatedRejected && delegatedGate.accepted === 0 ? 'PASS' : 'BLOCKED', {
      gate: 'the real MemoryService.capture admission path of the frozen engine source',
      inputOrigin: consumedDelegated.inputOrigin,
      accepted: delegatedGate.accepted,
      rejected: delegatedGate.rejected,
      rejectionCode: (delegatedGate.rejected || [])[0] ? delegatedGate.rejected[0].code : null,
      detail: 'a real delegation is refused by the long-term-memory candidate gate; it can never be admitted as a human turn',
    });

    const assertedAccepted = assertedGate.accepted === 1;
    record('MEM-008.C01.s8-c01-identity-not-provable', assertedAccepted ? 'BLOCKED' : 'PASS', {
      gate: 'the real MemoryService.capture admission path of the frozen engine source',
      inputOrigin: consumedAsserted.inputOrigin,
      accepted: assertedGate.accepted,
      rejected: assertedGate.rejected,
      detail: 'the human label is asserted by the caller, not derived from an identity: a session that was never declared human was captured as human because the public input endpoint carried options.inputOrigin, and the gate admits it',
      c01Verdict: 'BLOCKED — the chain carries no verified human identity, so "human == the owner" cannot be proven',
    });

    const authorFields = new Set();
    for (const event of (journalEvents ? journalEvents.prompts : [])) {
      for (const key of Object.keys(event)) if (/author|actor|owner|person/i.test(key)) authorFields.add(key);
    }
    record('MEM-008.C01.s9-no-author-identity-in-event', authorFields.size === 0 ? 'PASS' : 'BLOCKED', {
      authorLikeFields: [...authorFields],
      eventKeys: (journalEvents ? journalEvents.prompts : []).map(event => event.eventKey),
      identityConfidenceMeaning: 'the console sets identityConfidence=exact for the REPOSITORY identity, not for a person',
      detail: 'the normalised event carries the repository identity and the module origin, never an author identity',
    });
  } finally {
    child.child.kill();
    await child.exited;
    await proxy.close();
    await engine.close();
    await vector.close();
    await console_.close();
  }

  const essentials = [
    'MEM-008.C01.s1-three-real-turns',
    'MEM-008.C01.s2-console-journal-origin',
    'MEM-008.C01.s3-delegation-never-labelled-human',
    'MEM-008.C01.s4-engine-recovered-origin',
    'MEM-008.C01.s5-engine-frozen-snapshot',
    'MEM-008.C01.s6-gate-admits-human-labelled-event',
    'MEM-008.C01.s7-gate-rejects-delegated-event',
  ];
  const essentialsPass = essentials.every(id => (results.find(entry => entry.caseId === id) || {}).status === 'PASS');
  const c01Verdict = 'BLOCKED';

  const cleanup = await shell.removeTreeAsync(layout.root);
  if (!cleanup.removed) console.error(`CLEANUP-LEFTOVER ${cleanup.path} (${cleanup.error && cleanup.error.code})`);

  const summary = {
    lane: 'test-memory-injection',
    file: 'parallel-memory-injection-origin-probe.js',
    case: 'MEM-008-C01',
    title: '真实 Workbench 事件归属与长期记忆 candidate 门禁',
    c01Verdict,
    c01VerdictReason: '真实委派被门禁以 SOURCE_NOT_HUMAN 拒绝；但 human 标签完全由调用方断言，链路中不存在可核验的人的身份，因此"human 就是本人"无法证明，C01 仍为 BLOCKED',
    syntheticSource: true,
    syntheticNote: '全部事件来自隔离夹具仓库与合成标记文本，不冒充任何真实用户身份',
    cases: results,
    ownership: {
      laneOwned: [
        '_site/_test/parallel-memory-injection-origin-probe.js',
        '_site/_test/helpers/parallel-memory-injection-shell.js',
        '_site/_test/helpers/parallel-memory-injection-wb-host.js',
      ],
      snapshotProvenance: shell.snapshotProvenance(),
      note: 'the three pieces copied into this lane helper are read-only snapshots of other lanes\' files; the sources are never edited or imported',
    },
    verdict: essentialsPass ? 'PASS (delegation is refused by the real gate) / C01 BLOCKED' : 'BLOCKED',
    cleanup,
    paidTurnsSent: 3,
    networkUsed: true,
  };

  const target = process.env.PARALLEL_MEMORY_INJECTION_ORIGIN_EVIDENCE;
  if (target) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(summary, null, 2), 'utf8');
  }
  console.log(`parallel-memory-injection-origin-probe verdict=${summary.verdict}`);
  process.exitCode = essentialsPass ? 0 : 3;
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
