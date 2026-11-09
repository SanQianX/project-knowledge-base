'use strict';
// _site/_test/parallel-memory-capture-r4-cap008e-probe.js
//
// CAP-008 (engine mode) 同basename不同真实路径A/B并行 — the default-owner
// half that the R3 legacy run never proved.
//
//   steps:    相同basename不同真实路径A/B开发会话并行。
//   expected: 以canonical身份隔离，不串对话/Commit。
//
// WHAT IS DIFFERENT FROM THE ACCEPTED R3 LEGACY RUN
//
//   The R3 probe ran the product with analysisOwner 'legacy': the shell's own
//   BridgeConsumerService drained the journal into the SHELL's per-project
//   stores. The production default is analysisOwner 'engine' — the ENGINE
//   consumes. This probe runs the DEFAULT topology end to end:
//
//   * the REAL event-bridge console (the pinned installed package) as its own
//     child process, serving the journal home the installed shim writes to;
//   * the REAL vendored engine in-process with its BridgeClient pointed at
//     that console. Consumption starts DISABLED and is switched on by the
//     SHELL's own connectEngine -> /api/control activation — the driver never
//     calls control, never routes a projectId and never sets a health flag;
//   * the real product server in its DEFAULT mode (analysisOwner 'engine');
//   * the real 接入 click installs the Bridge shim; the sessions are fired
//     through that real installed shim; the commits run the real managed
//     post-commit hooks; the shell forwards the boundary to the Bridge and
//     the engine consumes it.
//
//   Isolation is asserted at every layer with falsifiable cross-checks:
//   distinct canonical workspaceIds (the product's own resolver), distinct
//   console journals (the real console's own API), per-project conversation
//   stores inside the ENGINE (its own validated read-back, whose
//   appendBridgeEvent gate rejects a mismatched workspaceId), engine-side
//   commit boundary files under the owning project only, git-hook-triggered
//   engine runs, and a whole-engine-datadir grep. The SHELL's legacy stores
//   must stay marker-free — the default consumer is the engine, and a legacy
//   write would mean the wrong path ran.
//
// HONEST SCOPE: the shim payloads (UserPromptSubmit / Stop) are artificial
// protocol fixtures fired by the driver through the real installed shim —
// they are NOT real model chat. The engine's analysis step is the frozen
// P-MEMORY-01 stand-in analyzer with an empty plan; the terminal side uses
// the shared module fixture and the vector side a lane-local endpoint
// implementing the real hub's /api/sync contract (the engine is created with
// an explicit vectorUrl — its built-in default 127.0.0.1:8787 is a LIVE
// module on this machine and must never be reached). Everything on the
// capture/consumption identity chain (console, journal, shim, hooks, shell,
// engine) is real.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');

const { startCapHarness, consoleIdentity, sha256File } = require('./helpers/parallel-memory-capture-r4-cap-shell');
const r3cap = require('./helpers/parallel-memory-capture-r3-cap-shell');
const { BridgeAdapter } = require(path.join(r3cap.ROOT, '_site', 'lib', 'bridge-adapter'));
const { parseManagedMarker } = require(path.join(r3cap.ROOT, '_site', 'lib', 'hook-manager'));

const EVIDENCE = process.env.PK_TEST_EVIDENCE_DIR ? path.resolve(process.env.PK_TEST_EVIDENCE_DIR) : null;
const CLIENT = 'claude';

function gitHead() {
  try {
    return execFileSync('git', ['-C', r3cap.ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim();
  } catch { return null; }
}

function walkFiles(dir) {
  const out = [];
  const walk = current => {
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(full);
    }
  };
  walk(dir);
  return out;
}

function grepTree(dir, needles) {
  const hits = [];
  for (const file of walkFiles(dir)) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const needle of needles) if (text.includes(needle)) hits.push({ file: path.relative(dir, file).split(path.sep).join('/'), needle });
  }
  return hits;
}

function runGitRaw(repo, args) {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} in ${repo} failed (${result.status}): ${String(result.stderr || result.stdout || '').slice(0, 500)}`);
  return { exitCode: result.status };
}

/** The identity chain of the default path: core, engine, console, shim. */
function identityChain(shimPath) {
  const coreFiles = ['_site/lib/server-app.js', '_site/lib/engine-connection.js', '_site/lib/module-bridge.js', '_site/lib/bridge-adapter.js', '_site/lib/hook-manager.js'];
  const engineFiles = ['src/server.js', 'src/coordinator.js', 'src/bridge-client.js', 'src/store.js', 'src/runtime/conversation-store.js', 'src/runtime/layout.js'];
  const consoleHookSource = path.join(r3cap.ROOT, 'node_modules', '@sanqianx', 'ai-coding-event-bridge-console', 'src', 'bridge', 'connectors', 'claude-code', 'hook-entry.js');
  return {
    gitHead: gitHead(),
    core: coreFiles.map(file => ({ file, sha256: sha256File(path.join(r3cap.ROOT, file)) })),
    engine: engineFiles.map(file => ({ file, sha256: sha256File(path.join(path.dirname(require.resolve('@sanqianx/ai-coding-knowledge-engine/package.json', { paths: [path.join(r3cap.ROOT)] })), file)) })),
    console: consoleIdentity(),
    shim: {
      installedPath: shimPath,
      installedSha256: sha256File(shimPath),
      consoleHookSource: 'src/bridge/connectors/claude-code/hook-entry.js',
      consoleHookSourceSha256: sha256File(consoleHookSource),
    },
  };
}

async function main() {
  const step = label => console.error(`[cap008e] ${label} @ ${new Date().toISOString()}`);
  step('harness starting');
  const harness = await startCapHarness({ tag: 'cap008e', evidenceDir: EVIDENCE || undefined });
  step('harness ready');
  const evidence = [];
  const reposRoot = fs.mkdtempSync(path.join(harness.tempRoot, 'pk-cap008e-repos-'));
  const engineDataDir = path.join(harness.fixture, 'engine');
  const shellDataDir = harness.server.dataDir;
  try {
    const hex = () => crypto.randomBytes(6).toString('hex');
    const markerA = { prompt: `CAP008E-A-PROMPT-${hex()}`, answer: `CAP008E-A-ANSWER-${hex()}`, commit: `CAP008E-A-COMMIT-${hex()}`, session: `cap008e-alpha-${hex()}` };
    const markerB = { prompt: `CAP008E-B-PROMPT-${hex()}`, answer: `CAP008E-B-ANSWER-${hex()}`, commit: `CAP008E-B-COMMIT-${hex()}`, session: `cap008e-beta-${hex()}` };
    const commands = [];

    // ------------------------------------------------------------------
    // 1. The real 接入 click: the Bridge shim that will receive both
    //    sessions is the one the product itself installed.
    // ------------------------------------------------------------------
    await harness.openSystemDrawer();
    await harness.nativeClick(`[data-agent-switch="install"][data-agent-client="${CLIENT}"]`);
    await harness.waitFor(
      () => harness.run("document.getElementById('agentCaptureFeedback').textContent.trim().length > 0 && !document.getElementById('agentCaptureFeedback').textContent.includes('正在接入')"),
      'the 接入 action answers in the UI',
      180000,
    );
    const installCall = await harness.lastInstallCall();
    assert.ok(installCall, 'the UI really sent an install request');
    assert.equal(installCall.status, 200, `the install request answers 200: ${JSON.stringify(installCall)}`);
    assert.equal(installCall.response.complete, true, `the install must complete: ${JSON.stringify(installCall.response)}`);
    await harness.waitFor(
      () => harness.run(`(() => { const row = [...document.querySelectorAll('#agentCaptureList .agent-capture-row')].find(item => item.querySelector('[data-agent-switch]') && item.querySelector('[data-agent-switch]').dataset.agentClient === ${JSON.stringify(CLIENT)}); return Boolean(row) && row.querySelector('.status').textContent === '已接入'; })()`),
      'the row shows the client as connected',
      90000,
    );
    const hooks = harness.ownedHookEntries();
    const shimPaths = [...new Set(hooks.map(entry => entry.shimPath))];
    assert.equal(shimPaths.length, 1, `both capture events must point at one shim: ${JSON.stringify(hooks)}`);
    assert.equal(fs.existsSync(shimPaths[0]), true, 'the shim must exist on disk');
    const shimPath = shimPaths[0];
    step('access installed');

    // ------------------------------------------------------------------
    // 2. Two real repositories with the SAME basename at different paths.
    // ------------------------------------------------------------------
    const repoA = path.join(reposRoot, 'alpha', 'service');
    const repoB = path.join(reposRoot, 'beta', 'service');
    for (const [repo, seed] of [[repoA, 'a'], [repoB, 'b']]) {
      fs.mkdirSync(repo, { recursive: true });
      commands.push({ cwd: repo, args: ['init', '-b', 'main'], ...runGitRaw(repo, ['init', '-b', 'main']) });
      commands.push({ cwd: repo, args: ['config', 'user.name', 'CAP008E Probe'], ...runGitRaw(repo, ['config', 'user.name', 'CAP008E Probe']) });
      commands.push({ cwd: repo, args: ['config', 'user.email', 'cap008e@probe.invalid'], ...runGitRaw(repo, ['config', 'user.email', 'cap008e@probe.invalid']) });
      fs.writeFileSync(path.join(repo, 'README.md'), `CAP008E same-basename fixture ${seed}\n`, 'utf8');
      commands.push({ cwd: repo, args: ['add', 'README.md'], ...runGitRaw(repo, ['add', 'README.md']) });
      commands.push({ cwd: repo, args: ['commit', '-m', `seed ${seed}`], ...runGitRaw(repo, ['commit', '-m', `seed ${seed}`]) });
    }
    assert.equal(path.basename(repoA), path.basename(repoB), 'the two repos must share one basename');
    assert.notEqual(path.resolve(repoA).toLowerCase(), path.resolve(repoB).toLowerCase(), 'the two repos must live at different canonical paths');

    // ------------------------------------------------------------------
    // 3. Import both through the real API in the DEFAULT mode. The import
    //    itself wires each project into the REAL console and the REAL
    //    engine (registerProjectLinks) and installs the managed hook bound
    //    to its own projectId.
    // ------------------------------------------------------------------
    const knowledgeRoot = path.join(harness.fixture, 'knowledge');
    fs.mkdirSync(knowledgeRoot, { recursive: true });
    const settingsResult = await harness.productApi('PATCH', '/api/settings', { knowledge: { rootPath: knowledgeRoot } });
    assert.equal(settingsResult.status, 200, `the isolated instance must accept its knowledge root: ${JSON.stringify(settingsResult.body)}`);
    const imported = [];
    for (const [repo, side] of [[repoA, 'a'], [repoB, 'b']]) {
      const knowledgePath = path.join(knowledgeRoot, `service-${side}`);
      fs.mkdirSync(knowledgePath, { recursive: true });
      const result = await harness.productApi('POST', '/api/projects/import', { localPath: repo, knowledgePath });
      assert.equal(result.status, 201, `importing ${repo} must answer 201: ${JSON.stringify(result.body)}`);
      const project = result.body && result.body.project;
      assert.ok(project && project.projectId, `the import must return the project: ${JSON.stringify(result.body)}`);
      const modules = result.body.modules || {};
      assert.equal(modules.eventBridge && modules.eventBridge.ok, true, `the real console must register the project (${side}): ${JSON.stringify(modules)}`);
      assert.equal(modules.engine && modules.engine.ok, true, `the real engine must register the project (${side}): ${JSON.stringify(modules)}`);
      imported.push({ repo, projectId: project.projectId, workspaceId: project.config && project.config.repoIdentity ? project.config.repoIdentity.workspaceId : null });
    }
    const [projectA, projectB] = imported;
    assert.notEqual(projectA.projectId, projectB.projectId, 'the two repos must be two projects');
    assert.ok(projectA.workspaceId && projectB.workspaceId, `both projects must carry a canonical workspace identity: ${JSON.stringify(imported)}`);
    assert.notEqual(projectA.workspaceId, projectB.workspaceId, 'same basename at different paths must yield different canonical identities');

    // The product's own identity resolver is the oracle for the same claim.
    const adapter = new BridgeAdapter({});
    const oracleA = await adapter.resolveRepoIdentity(repoA);
    const oracleB = await adapter.resolveRepoIdentity(repoB);
    assert.equal(oracleA.status, 'ok', `the product's own resolver must answer for A: ${JSON.stringify(oracleA)}`);
    assert.equal(oracleB.status, 'ok', `the product's own resolver must answer for B: ${JSON.stringify(oracleB)}`);
    assert.equal(oracleA.repoIdentity.workspaceId, projectA.workspaceId, 'project A identity must equal the canonical one');
    assert.equal(oracleB.repoIdentity.workspaceId, projectB.workspaceId, 'project B identity must equal the canonical one');
    assert.notEqual(oracleA.repoIdentity.workspaceId, oracleB.repoIdentity.workspaceId, 'the canonical identities of A and B must differ');

    // The managed hook of each repo is bound to its own project only.
    const hookMarkers = {};
    for (const project of imported) {
      const hookFile = path.join(project.repo, '.git', 'hooks', 'post-commit');
      assert.equal(fs.existsSync(hookFile), true, `the managed post-commit hook must exist in ${project.repo}`);
      const marker = parseManagedMarker(fs.readFileSync(hookFile, 'utf8'));
      assert.ok(marker, `the hook must be managed: ${hookFile}`);
      assert.equal(marker.projectId, project.projectId, `the hook of ${project.repo} must be bound to its own project: ${JSON.stringify(marker)}`);
      hookMarkers[project.projectId] = marker;
    }
    assert.notEqual(hookMarkers[projectA.projectId].projectId, hookMarkers[projectB.projectId].projectId, 'the two hooks must carry different projectIds');
    step('both projects imported and wired');

    // ------------------------------------------------------------------
    // 4. The DEFAULT owner is really connected and really consuming: the
    //    product reports engine ownership ready, and the engine's own
    //    health reports its journal consumer enabled — switched on by the
    //    shell's activation, never by this driver.
    // ------------------------------------------------------------------
    let ownership = null;
    await harness.waitFor(async () => {
      const result = await harness.productApi('GET', '/api/modules/health');
      if (result.status !== 200) return false;
      ownership = result.body && result.body.ownership;
      return Boolean(ownership && ownership.owner === 'engine' && ownership.ready === true);
    }, 'the product reports the engine owner ready (the shell really activated the engine)', 60000);
    let engineHealth = null;
    await harness.waitFor(async () => {
      const result = await harness.engineApi('GET', '/api/health');
      engineHealth = result.body;
      return Boolean(engineHealth && engineHealth.journal && engineHealth.journal.enabled === true);
    }, 'the engine own health reports journal consumption enabled', 60000);
    assert.equal(engineHealth.journal.consumer, 'knowledge-engine', `the engine consuming is the knowledge-engine itself: ${JSON.stringify(engineHealth.journal)}`);
    assert.deepEqual(engineHealth.journal.failures, [], `no journal consumption failures: ${JSON.stringify(engineHealth.journal.failures)}`);

    // The engine's project records carry the console-derived journal
    // identity — the canonical chain the consumer matches on.
    const engineProject = id => harness.engine.coordinator.store.getProject(id);
    const engineA0 = engineProject(projectA.projectId);
    const engineB0 = engineProject(projectB.projectId);
    assert.ok(engineA0 && engineB0, 'the engine really registered both projects');
    assert.ok(/^sha256:[a-f0-9]{64}$/.test(engineA0.journalId || ''), `A's engine journalId must be the canonical sha256 form: ${JSON.stringify(engineA0.journalId)}`);
    assert.ok(/^sha256:[a-f0-9]{64}$/.test(engineB0.journalId || ''), `B's engine journalId must be the canonical sha256 form: ${JSON.stringify(engineB0.journalId)}`);
    assert.equal(engineA0.journalId, projectA.workspaceId, "A's engine journalId is A's canonical workspace identity");
    assert.equal(engineB0.journalId, projectB.workspaceId, "B's engine journalId is B's canonical workspace identity");
    assert.notEqual(engineA0.journalId, engineB0.journalId, 'the two engine journal identities must differ');
    const consoleProjects = await harness.consoleApi('GET', '/api/projects');
    assert.equal(consoleProjects.status, 200, `the real console must list its projects: ${JSON.stringify(consoleProjects.body)}`);
    const consoleIds = (consoleProjects.body.projects || []).map(project => project.id);
    assert.equal(consoleIds.includes(projectA.workspaceId), true, 'the real console holds a project keyed by A canonical identity');
    assert.equal(consoleIds.includes(projectB.workspaceId), true, 'the real console holds a project keyed by B canonical identity');
    step('default owner connected and consuming');

    // ------------------------------------------------------------------
    // 5. Two interleaved development sessions through the REAL installed
    //    shim (artificial protocol fixtures — see the honest scope above).
    // ------------------------------------------------------------------
    const fire = (payload) => {
      const env = { ...process.env, AI_CODING_EVENT_BRIDGE_HOME: harness.bridgeHome };
      delete env.AI_CODING_EVENT_BRIDGE_CAPTURE; // an ambient kill-switch must not silence the real capture
      const result = spawnSync(process.execPath, [shimPath], {
        input: JSON.stringify(payload), env, encoding: 'utf8', timeout: 90000, windowsHide: true,
      });
      return { payload: payload.hook_event_name, cwd: payload.cwd, exitCode: result.status, error: result.error ? result.error.message : null };
    };
    const sessionCommands = [
      fire({ hook_event_name: 'UserPromptSubmit', session_id: markerA.session, prompt: markerA.prompt, cwd: repoA }),
      fire({ hook_event_name: 'UserPromptSubmit', session_id: markerB.session, prompt: markerB.prompt, cwd: repoB }),
      fire({ hook_event_name: 'Stop', session_id: markerA.session, last_assistant_message: markerA.answer, cwd: repoA }),
      fire({ hook_event_name: 'Stop', session_id: markerB.session, last_assistant_message: markerB.answer, cwd: repoB }),
    ];
    for (const call of sessionCommands) {
      assert.equal(call.exitCode, 0, `the shim must exit 0 (fail-open contract): ${JSON.stringify(call)}`);
      commands.push({ cwd: call.cwd, args: ['shim', call.payload], exitCode: call.exitCode });
    }
    step('sessions fired through the installed shim');

    // ------------------------------------------------------------------
    // 6. The ENGINE's own conversation stores: each project carries only
    //    its own session. appendBridgeEvent rejects a mismatched
    //    workspaceId, so a crossed event would surface as a journal
    //    failure, not as silent contamination.
    // ------------------------------------------------------------------
    const readEngineEvents = projectId => {
      try { return harness.engine.coordinator.conversations.readEvents(projectId); } catch { return []; }
    };
    await harness.waitFor(() => {
      const text = JSON.stringify(readEngineEvents(projectA.projectId));
      return text.includes(markerA.prompt) && text.includes(markerA.answer);
    }, 'the engine consumed A session into A conversation store', 90000);
    await harness.waitFor(() => {
      const text = JSON.stringify(readEngineEvents(projectB.projectId));
      return text.includes(markerB.prompt) && text.includes(markerB.answer);
    }, 'the engine consumed B session into B conversation store', 90000);

    const eventsA = readEngineEvents(projectA.projectId);
    const eventsB = readEngineEvents(projectB.projectId);
    const recordCheck = (events, marker, workspaceId, projectId, journalId, side) => {
      const own = events.filter(event => String(event.content || '').includes(marker.prompt) || String(event.content || '').includes(marker.answer));
      assert.ok(own.length >= 2, `${side} must persist its own prompt and answer events: ${JSON.stringify(own.map(event => ({ eventType: event.eventType, content: String(event.content || '').slice(0, 60) })))}`);
      assert.equal(own.every(event => event.projectId === projectId), true, `every ${side} record must be named after its project: ${JSON.stringify(own.map(event => event.projectId))}`);
      assert.equal(own.every(event => event.repoIdentity && event.repoIdentity.workspaceId === workspaceId), true, `every ${side} record must carry ${side}'s canonical identity: ${JSON.stringify(own.map(event => event.repoIdentity))}`);
      assert.equal(own.every(event => event.journalId === journalId), true, `every ${side} record must come from ${side}'s journal: ${JSON.stringify(own.map(event => event.journalId))}`);
      assert.equal(own.every(event => event.sessionId === marker.session), true, `every ${side} record must belong to ${side}'s session: ${JSON.stringify(own.map(event => event.sessionId))}`);
    };
    recordCheck(eventsA, markerA, projectA.workspaceId, projectA.projectId, engineA0.journalId, 'A');
    recordCheck(eventsB, markerB, projectB.workspaceId, projectB.projectId, engineB0.journalId, 'B');
    const textA = JSON.stringify(eventsA);
    const textB = JSON.stringify(eventsB);
    assert.equal(textA.includes(markerB.prompt) || textA.includes(markerB.answer) || textA.includes(markerB.session), false, "A's engine store must not carry B's session");
    assert.equal(textB.includes(markerA.prompt) || textB.includes(markerA.answer) || textB.includes(markerA.session), false, "B's engine store must not carry A's session");
    const consumptionHealth = await harness.engineApi('GET', '/api/health');
    assert.deepEqual(consumptionHealth.body.journal.failures, [], `no journal consumption failures after both sessions: ${JSON.stringify(consumptionHealth.body.journal.failures)}`);

    // ------------------------------------------------------------------
    // 7. The real console's own journals: the traffic really passed through
    //    the Bridge, and the two sides live in two distinct journals.
    // ------------------------------------------------------------------
    const journalsAnswer = await harness.consoleApi('GET', '/api/journals');
    assert.equal(journalsAnswer.status, 200, `the real console must list its journals: ${JSON.stringify(journalsAnswer.body)}`);
    const journalEvidence = [];
    for (const journal of journalsAnswer.body.journals || []) {
      const eventsAnswer = await harness.consoleApi('GET', `/api/journal/events?journalId=${encodeURIComponent(journal.journalId)}&fromSequence=1&limit=200`);
      assert.equal(eventsAnswer.status, 200, `the real console must serve journal events: ${JSON.stringify(eventsAnswer.body)}`);
      const text = JSON.stringify(eventsAnswer.body.events || []);
      journalEvidence.push({
        journalId: journal.journalId,
        eventCount: (eventsAnswer.body.events || []).length,
        carriesA: text.includes(markerA.prompt) || text.includes(markerA.answer),
        carriesB: text.includes(markerB.prompt) || text.includes(markerB.answer),
      });
    }
    const journalA = journalEvidence.find(entry => entry.carriesA);
    const journalB = journalEvidence.find(entry => entry.carriesB);
    assert.ok(journalA, `A's session must really live in a real console journal: ${JSON.stringify(journalEvidence)}`);
    assert.ok(journalB, `B's session must really live in a real console journal: ${JSON.stringify(journalEvidence)}`);
    assert.notEqual(journalA.journalId, journalB.journalId, 'the two sessions must live in two distinct console journals');
    assert.equal(journalA.carriesB || journalB.carriesA, false, `no console journal may carry both sides' sessions: ${JSON.stringify(journalEvidence)}`);
    assert.equal(journalA.journalId, engineA0.journalId, "A's console journal is A's engine journal identity");
    assert.equal(journalB.journalId, engineB0.journalId, "B's console journal is B's engine journal identity");
    step('engine stores and console journals isolated');

    // ------------------------------------------------------------------
    // 8. Real commits in both repos. The managed hooks notify the shell,
    //    the shell forwards the boundary to the Bridge, and the ENGINE
    //    consumes it: the boundary file lands under the owning project's
    //    runtime directory in the ENGINE data dir, and a git-hook run is
    //    enqueued.
    // ------------------------------------------------------------------
    const commits = [];
    for (const [project, marker, seed] of [[projectA, markerA, 'a'], [projectB, markerB, 'b']]) {
      const file = path.join(project.repo, `work-${seed}.md`);
      fs.writeFileSync(file, `${marker.commit}\n`, 'utf8');
      commands.push({ cwd: project.repo, args: ['add', `work-${seed}.md`], ...runGitRaw(project.repo, ['add', `work-${seed}.md`]) });
      commands.push({ cwd: project.repo, args: ['commit', '-m', marker.commit], ...runGitRaw(project.repo, ['commit', '-m', marker.commit]) });
      const sha = execFileSync('git', ['-C', project.repo, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim();
      assert.match(sha, /^[0-9a-f]{40}$/, 'the commit must produce a real sha');
      commits.push({ projectId: project.projectId, repo: project.repo, marker: marker.commit, sha });
    }
    const [commitA, commitB] = commits;
    const layout = harness.engine.coordinator.layout;
    const boundaryPath = (projectId, sha) => layout.getProjectCommitBoundaryPath(projectId, sha);
    await harness.waitFor(() => fs.existsSync(boundaryPath(commitA.projectId, commitA.sha)), 'the engine persists A commit boundary under A project runtime', 90000);
    await harness.waitFor(() => fs.existsSync(boundaryPath(commitB.projectId, commitB.sha)), 'the engine persists B commit boundary under B project runtime', 90000);
    assert.equal(fs.existsSync(boundaryPath(commitB.projectId, commitA.sha)), false, "the engine must not write A's boundary under B");
    assert.equal(fs.existsSync(boundaryPath(commitA.projectId, commitB.sha)), false, "the engine must not write B's boundary under A");
    const boundaryA = JSON.parse(fs.readFileSync(boundaryPath(commitA.projectId, commitA.sha), 'utf8'));
    const boundaryB = JSON.parse(fs.readFileSync(boundaryPath(commitB.projectId, commitB.sha), 'utf8'));
    assert.equal(boundaryA.projectId, commitA.projectId, `A's boundary must name A: ${JSON.stringify(boundaryA)}`);
    assert.equal(boundaryA.repoIdentity.workspaceId, projectA.workspaceId, `A's boundary must carry A's canonical identity: ${JSON.stringify(boundaryA)}`);
    assert.equal(boundaryA.journalId, engineA0.journalId, `A's boundary must come from A's journal: ${JSON.stringify(boundaryA)}`);
    assert.equal(boundaryB.projectId, commitB.projectId, `B's boundary must name B: ${JSON.stringify(boundaryB)}`);
    assert.equal(boundaryB.repoIdentity.workspaceId, projectB.workspaceId, `B's boundary must carry B's canonical identity: ${JSON.stringify(boundaryB)}`);
    assert.equal(boundaryB.journalId, engineB0.journalId, `B's boundary must come from B's journal: ${JSON.stringify(boundaryB)}`);

    // The git-hook runs settled for both projects. The lane-local vector
    // endpoint answers the engine's index step, so the only honest settled
    // state is 'succeeded' — a run parked in 'index-pending' or 'failed'
    // would mean the index plane was not the lane's (that is exactly how
    // attempt 4 exposed the default-vectorUrl leak).
    const runsOf = projectId => harness.engine.coordinator.store.listRuns(projectId)
      .filter(run => run.trigger === 'git-hook');
    await harness.waitFor(() => runsOf(commitA.projectId).some(run => run.state === 'succeeded'), "A git-hook run reaches 'succeeded' (knowledge promoted AND indexed)", 90000);
    await harness.waitFor(() => runsOf(commitB.projectId).some(run => run.state === 'succeeded'), "B git-hook run reaches 'succeeded' (knowledge promoted AND indexed)", 90000);
    const runsA = runsOf(commitA.projectId).map(run => ({ runId: run.runId, state: run.state, commitSha: run.commitSha }));
    const runsB = runsOf(commitB.projectId).map(run => ({ runId: run.runId, state: run.state, commitSha: run.commitSha }));
    assert.equal(runsA.length > 0 && runsA.every(run => run.state === 'succeeded'), true, `every A git-hook run must be 'succeeded': ${JSON.stringify(runsA)}`);
    assert.equal(runsB.length > 0 && runsB.every(run => run.state === 'succeeded'), true, `every B git-hook run must be 'succeeded': ${JSON.stringify(runsB)}`);
    assert.equal(runsA.every(run => run.commitSha === commitA.sha), true, `every A git-hook run targets A's commit: ${JSON.stringify(runsA)}`);
    assert.equal(runsB.every(run => run.commitSha === commitB.sha), true, `every B git-hook run targets B's commit: ${JSON.stringify(runsB)}`);

    // The engine's index plane stayed inside the lane AND inside each
    // project's own identity: /api/sync arrived at the lane-local endpoint
    // under the OWNING project id and knowledge path only.
    const vectorSyncs = harness.laneVector.requests
      .filter(entry => entry.method === 'POST' && entry.path === '/api/sync')
      .map(entry => entry.body);
    const syncsA = vectorSyncs.filter(body => body && body.project === commitA.projectId);
    const syncsB = vectorSyncs.filter(body => body && body.project === commitB.projectId);
    assert.ok(syncsA.length > 0, "the engine really indexed A's knowledge through the lane vector plane");
    assert.ok(syncsB.length > 0, "the engine really indexed B's knowledge through the lane vector plane");
    assert.equal(syncsA.every(body => body.sourceDir === engineA0.knowledgePath), true, `every A index sync must point at A's knowledge path: ${JSON.stringify(syncsA)}`);
    assert.equal(syncsB.every(body => body.sourceDir === engineB0.knowledgePath), true, `every B index sync must point at B's knowledge path: ${JSON.stringify(syncsB)}`);
    assert.equal(vectorSyncs.length, syncsA.length + syncsB.length, `no vector sync may target any identity besides A and B: ${JSON.stringify(vectorSyncs)}`);
    const finalHealth = await harness.engineApi('GET', '/api/health');
    assert.deepEqual(finalHealth.body.journal.failures, [], `no journal consumption failures after the commits: ${JSON.stringify(finalHealth.body.journal.failures)}`);
    step('commits consumed, boundaries and runs settled');

    // ------------------------------------------------------------------
    // 9. The SHELL's legacy stores stay marker-free: the default consumer
    //    is the engine, and a legacy-side write would be the wrong path.
    // ------------------------------------------------------------------
    const shellProjectDir = projectId => path.join(shellDataDir, 'projects', projectId);
    for (const project of imported) {
      assert.equal(fs.existsSync(path.join(shellProjectDir(project.projectId), 'conversation-events.jsonl')), false, `the shell legacy conversation store must not exist for ${project.projectId} in engine mode`);
    }
    const shellGrep = grepTree(shellDataDir, [markerA.prompt, markerA.answer, markerA.commit, markerB.prompt, markerB.answer, markerB.commit]);
    assert.deepEqual(shellGrep, [], `no session or commit marker may be written into the shell legacy stores: ${JSON.stringify(shellGrep)}`);

    // ------------------------------------------------------------------
    // 10. Whole-engine-datadir grep: each side's evidence exists under its
    //     own project directory and nowhere under the other's.
    // ------------------------------------------------------------------
    const hitsA = grepTree(engineDataDir, [markerA.prompt, markerA.answer, markerA.session, commitA.sha]);
    const hitsB = grepTree(engineDataDir, [markerB.prompt, markerB.answer, markerB.session, commitB.sha]);
    assert.ok(hitsA.length > 0, "A's evidence must exist in the engine data dir");
    assert.ok(hitsB.length > 0, "B's evidence must exist in the engine data dir");
    assert.equal(hitsA.some(hit => hit.file.split('/').includes(projectA.projectId)), true, `A's evidence must be under A's engine project directory: ${JSON.stringify(hitsA)}`);
    assert.equal(hitsB.some(hit => hit.file.split('/').includes(projectB.projectId)), true, `B's evidence must be under B's engine project directory: ${JSON.stringify(hitsB)}`);
    assert.equal(hitsA.some(hit => hit.file.split('/').includes(projectB.projectId)), false, `no A evidence may live under B's engine project directory: ${JSON.stringify(hitsA)}`);
    assert.equal(hitsB.some(hit => hit.file.split('/').includes(projectA.projectId)), false, `no B evidence may live under A's engine project directory: ${JSON.stringify(hitsB)}`);

    // ------------------------------------------------------------------
    // 11. The real UI on its default projection: reload, home view lists
    //     both same-basename projects from the real registry.
    // ------------------------------------------------------------------
    await harness.browser.send('Page.reload', {});
    await harness.waitFor(() => harness.run("document.readyState === 'complete'"), 'the reloaded page is complete', 20000);
    await harness.waitFor(
      () => harness.run(`document.getElementById('homeContent').textContent.split('service').length - 1 >= 2`),
      'the home view lists both same-basename projects after the reload',
      20000,
    );
    if (harness.evidence) await harness.browser.screenshot(path.join(harness.evidence, 'cap008e-after.png'));

    // ------------------------------------------------------------------
    // 12. Nothing leaked into the developer's real home.
    // ------------------------------------------------------------------
    const configComparison = r3cap.compareConfigSurface(harness.realHomeBefore, r3cap.digestRealClientConfigs());
    assert.equal(configComparison.byteIdentical, true, `the real client configuration must be untouched: ${JSON.stringify({ changedFiles: configComparison.changedFiles, changedDirs: configComparison.changedDirs })}`);
    const treeComparison = r3cap.compareRealTrees(harness.realTreesBefore, r3cap.digestRealClientTrees());
    // The developer's LIVE Codex rewrites its own global session state
    // (.codex-global-state.json + .bak, an atomic replace) at any moment —
    // other fleet agents work in this repo while the case executes. Such a
    // rewrite is a concurrent live write, never this lane's doing, and the
    // falsifiable proof is that the rewritten bytes carry NONE of this
    // case's markers. Everything else outside the known runtime set must
    // still be untouched.
    const LIVE_CODEX_STATE = /^\.codex\/\.codex-global-state\.json(\.bak)?$/;
    const codexTreeAfter = r3cap.digestRealClientTrees().find(entry => entry.dir === '.codex');
    const codexTreeBefore = harness.realTreesBefore.find(entry => entry.dir === '.codex');
    const concurrentLiveWrites = treeComparison.leaks
      .filter(item => LIVE_CODEX_STATE.test(`${item.dir}/${item.file}`))
      .map(item => ({
        dir: item.dir, file: item.file, state: item.state,
        beforeSha256: (codexTreeBefore && codexTreeBefore.files.get(item.file)) || null,
        afterSha256: (codexTreeAfter && codexTreeAfter.files.get(item.file)) || null,
      }));
    for (const write of concurrentLiveWrites) {
      assert.equal(write.state, 'modified', `a live codex state file may only be rewritten, never created or deleted, by the outside world: ${JSON.stringify(write)}`);
      assert.ok(write.beforeSha256, `the codex state file must already exist in the before-digest: ${JSON.stringify(write)}`);
    }
    const realCodexDir = path.join(os.homedir(), '.codex');
    for (const name of ['.codex-global-state.json', '.codex-global-state.json.bak']) {
      let text = '';
      try { text = fs.readFileSync(path.join(realCodexDir, name), 'utf8'); } catch { continue; }
      const markersAll = [markerA.prompt, markerA.answer, markerA.commit, markerB.prompt, markerB.answer, markerB.commit];
      assert.equal(markersAll.some(marker => text.includes(marker)), false, `the concurrent live codex state ${name} must not carry this case's markers`);
    }
    const realLeaks = treeComparison.leaks.filter(item => !LIVE_CODEX_STATE.test(`${item.dir}/${item.file}`));
    assert.deepEqual(realLeaks, [], `nothing outside the runtime set and the live codex state may change in the real home: ${JSON.stringify(realLeaks)}`);
    assert.deepEqual(treeComparison.configChanges, [], `no configuration file may change in the real home: ${JSON.stringify(treeComparison.configChanges)}`);
    step('all assertions passed, writing evidence');

    evidence.push({
      case: 'CAP-008-engine-mode',
      fixture: {
        tag: 'cap008e', fixtureDir: harness.fixture, reposRoot, isolatedHome: harness.homeDir,
        bridgeHome: harness.bridgeHome, consoleUrl: harness.consoleChild.url, engineDataDir, shellDataDir,
        port: Number(harness.base.split(':').pop()), analysisOwner: 'engine',
      },
      identityChain: identityChain(shimPath),
      repos: [
        { side: 'A', path: repoA, basename: path.basename(repoA), projectId: projectA.projectId, workspaceId: projectA.workspaceId, journalId: engineA0.journalId, hookMarker: hookMarkers[projectA.projectId] },
        { side: 'B', path: repoB, basename: path.basename(repoB), projectId: projectB.projectId, workspaceId: projectB.workspaceId, journalId: engineB0.journalId, hookMarker: hookMarkers[projectB.projectId] },
      ],
      markers: { A: markerA, B: markerB },
      wiring: { installRequest: installCall.request, httpStatus: installCall.status, operationId: installCall.response.operationId, shimPath, ownedHookEntries: hooks },
      identityOracle: { A: oracleA.repoIdentity, B: oracleB.repoIdentity },
      defaultOwnerActivation: {
        productOwnership: ownership,
        engineHealthBeforeSessions: { journal: engineHealth.journal, counts: engineHealth.counts },
        engineHealthAfterCommits: { journal: finalHealth.body.journal, counts: finalHealth.body.counts },
        note: 'consumption was switched on by the shell connectEngine -> /api/control activation; the driver never called control and never routed a projectId',
      },
      consoleJournals: journalEvidence,
      sessionCommands,
      commands: commands.map(entry => ({ cwd: entry.cwd, args: entry.args, exitCode: entry.exitCode })),
      engineStoreRecords: {
        A: eventsA.map(event => ({ eventType: event.eventType, role: event.role, sessionId: event.sessionId, journalId: event.journalId, workspaceId: event.repoIdentity && event.repoIdentity.workspaceId, contentHead: String(event.content || '').slice(0, 40) })),
        B: eventsB.map(event => ({ eventType: event.eventType, role: event.role, sessionId: event.sessionId, journalId: event.journalId, workspaceId: event.repoIdentity && event.repoIdentity.workspaceId, contentHead: String(event.content || '').slice(0, 40) })),
      },
      commits: {
        A: { sha: commitA.sha, message: markerA.commit, boundaryFile: path.relative(engineDataDir, boundaryPath(commitA.projectId, commitA.sha)), boundary: boundaryA, runs: runsA },
        B: { sha: commitB.sha, message: markerB.commit, boundaryFile: path.relative(engineDataDir, boundaryPath(commitB.projectId, commitB.sha)), boundary: boundaryB, runs: runsB },
        crossBoundaryAUnderB: fs.existsSync(boundaryPath(commitB.projectId, commitA.sha)),
        crossBoundaryBUnderA: fs.existsSync(boundaryPath(commitA.projectId, commitB.sha)),
      },
      shellLegacyStores: { markerFree: shellGrep.length === 0, hits: shellGrep, note: 'the default consumer is the engine; the shell legacy conversation stores must stay unwritten' },
      engineStoreGrep: { A: hitsA, B: hitsB },
      engineVectorPlane: {
        laneVectorUrl: harness.laneVector.url,
        engineVectorUrl: harness.laneVector.url,
        syncCalls: vectorSyncs,
        indexedProjects: harness.laneVector.state.projects.map(project => project.name),
        note: 'the engine was created with an explicit vectorUrl (the lane-local endpoint implementing the real hub /api/sync contract); its built-in default 127.0.0.1:8787 is a LIVE module on this machine and must never be reached',
      },
      realHomeIsolation: {
        configuration: { byteIdentical: configComparison.byteIdentical, changedFiles: configComparison.changedFiles, changedDirs: configComparison.changedDirs },
        tree: { leaks: treeComparison.leaks, realLeaksBeyondLiveCodexState: realLeaks, configChanges: treeComparison.configChanges, runtimeChangeCount: treeComparison.runtimeChanges },
        concurrentLiveWrites: {
          writes: concurrentLiveWrites,
          proof: 'the live Codex own global-state files were byte-rewritten by an outside process during the window; the new bytes carry none of this case markers, and no command of this lane ever targeted ~/.codex',
        },
        scopeLabel: "honest: the developer's own live client sessions keep writing runtime files while the case runs; the isolation claim is about the client configuration surface and every changed file outside the known runtime set — except the live Codex global-state pair, which is a concurrent outside write proven marker-free",
      },
      scopeLabel: 'honest: the sessions are artificial protocol fixtures fired through the real installed shim (not real model chat); the analysis step is the frozen P-MEMORY-01 stand-in analyzer with an empty plan; the terminal fixture is shared and the vector endpoint is lane-local (a fixture implementing the real hub /api/sync contract — not the vector-hub module); the console, its journals, the shell, the managed hooks and the engine consumption chain are real, and the product ran in its DEFAULT engine-owner mode (never switched to legacy)',
    });

    if (harness.evidence) {
      fs.mkdirSync(harness.evidence, { recursive: true });
      fs.writeFileSync(path.join(harness.evidence, 'cap008e-engine-mode-cross-workspace-isolation.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    }

    console.log('parallel-memory-capture-r4-cap008e-probe PASS (same-basename repos at different canonical paths stayed isolated through the DEFAULT engine/Bridge consumption: distinct canonical identities and console journals, engine conversation stores and commit boundaries never crossed sides, and the shell legacy stores stayed unwritten)');
  } finally {
    await harness.cleanup();
    fs.rmSync(reposRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
