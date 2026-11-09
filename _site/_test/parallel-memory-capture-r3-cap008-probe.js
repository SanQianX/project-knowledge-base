'use strict';
// _site/_test/parallel-memory-capture-r3-cap008-probe.js
//
// CAP-008 同basename不同真实路径A/B并行 — the external-Agent integration case
// of qa-autopilot/config/test-cases.json.
//
//   steps:    相同basename不同真实路径A/B开发会话并行。
//   expected: 以canonical身份隔离，不串对话/Commit。
//   evidence: 实际命令与退出码 / UI、接口、磁盘对应证据 / 源HEAD/文件哈希/测试夹具ID
//
// WHAT IS REAL HERE
//
//   * the product server is the real one running in its OWN consumer mode
//     (analysisOwner 'legacy'), so the product's own BridgeConsumerService and
//     ConversationStore — the code that decides which project a captured event
//     belongs to — are the code under test, not a driver-side reimplementation;
//   * two REAL Git repositories with the SAME basename (`service`) live at two
//     different canonical paths and are imported through the product's real
//     import API, which installs the real managed post-commit hook into each
//     repo (each hook marker carrying its own projectId);
//   * the development sessions are fired through the REAL Bridge shim the
//     product's real 接入 click installed (bin/bridge-hook.cjs): interleaved
//     UserPromptSubmit/Stop payloads with unique marker strings, cwd pointing
//     at repo A or repo B;
//   * the commits are real `git commit` invocations; the managed hooks really
//     run and really POST hook-event/v2 back to the product;
//   * isolation is asserted at every layer with falsifiable cross-checks:
//     distinct canonical workspaceIds (computed by the product's own identity
//     resolver), journal records carrying only their own identity, per-project
//     conversation read-back through the product's own API, boundary files on
//     disk only under the owning project, and a whole-data-dir grep proving no
//     marker ever lands on the other project.
//
// WHY THIS FILE IS NOT NAMED *-test.js
//
//   The case needs the native Claude Code CLI (for the real 接入 click) and a
//   real Git + Chrome environment. The offline CI suite collects every
//   *_test.js and would report a false failure on a runner without them, so
//   the case runs through the product probe entry point instead.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');

const { startCapHarness, ROOT, resolveTempRoot } = require('./helpers/parallel-memory-capture-r3-cap-shell');
const { BridgeAdapter } = require(path.join(ROOT, '_site', 'lib', 'bridge-adapter'));
const { parseManagedMarker } = require(path.join(ROOT, '_site', 'lib', 'hook-manager'));

const EVIDENCE = process.env.PK_TEST_EVIDENCE_DIR ? path.resolve(process.env.PK_TEST_EVIDENCE_DIR) : null;
const CLIENT = 'claude';

function gitHead() {
  try {
    return execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim();
  } catch { return null; }
}

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true }).trim();
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

/** Every (file, needle) hit of the needles below a directory. */
function grepTree(dir, needles) {
  const hits = [];
  for (const file of walkFiles(dir)) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const needle of needles) if (text.includes(needle)) hits.push({ file: path.relative(dir, file).split(path.sep).join('/'), needle });
  }
  return hits;
}

async function main() {
  // The consumer mode is the point of this case: the product's own drain and
  // projection code runs, so a driver-side "correct routing" could not mask it.
  const harness = await startCapHarness({ tag: 'cap008', evidenceDir: EVIDENCE || undefined, analysisOwner: 'legacy' });
  const evidence = [];
  const reposRoot = fs.mkdtempSync(path.join(resolveTempRoot(), 'pk-cap008-repos-'));
  const dataDir = harness.server.dataDir;
  try {
    const hex = () => crypto.randomBytes(6).toString('hex');
    const markerA = { prompt: `CAP008-A-PROMPT-${hex()}`, answer: `CAP008-A-ANSWER-${hex()}`, commit: `CAP008-A-COMMIT-${hex()}`, session: `cap008-alpha-${hex()}` };
    const markerB = { prompt: `CAP008-B-PROMPT-${hex()}`, answer: `CAP008-B-ANSWER-${hex()}`, commit: `CAP008-B-COMMIT-${hex()}`, session: `cap008-beta-${hex()}` };
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
    const bridgeHome = harness.server.bridgeHome;

    // ------------------------------------------------------------------
    // 2. Two real repositories with the SAME basename at different paths.
    // ------------------------------------------------------------------
    const repoA = path.join(reposRoot, 'alpha', 'service');
    const repoB = path.join(reposRoot, 'beta', 'service');
    for (const [repo, seed] of [[repoA, 'a'], [repoB, 'b']]) {
      fs.mkdirSync(repo, { recursive: true });
      commands.push({ cwd: repo, args: ['init', '-b', 'main'], ...runGitRaw(repo, ['init', '-b', 'main']) });
      commands.push({ cwd: repo, args: ['config', 'user.name', 'CAP008 Probe'], ...runGitRaw(repo, ['config', 'user.name', 'CAP008 Probe']) });
      commands.push({ cwd: repo, args: ['config', 'user.email', 'cap008@probe.invalid'], ...runGitRaw(repo, ['config', 'user.email', 'cap008@probe.invalid']) });
      fs.writeFileSync(path.join(repo, 'README.md'), `CAP008 same-basename fixture ${seed}\n`, 'utf8');
      commands.push({ cwd: repo, args: ['add', 'README.md'], ...runGitRaw(repo, ['add', 'README.md']) });
      commands.push({ cwd: repo, args: ['commit', '-m', `seed ${seed}`], ...runGitRaw(repo, ['commit', '-m', `seed ${seed}`]) });
    }
    assert.equal(path.basename(repoA), path.basename(repoB), 'the two repos must share one basename');
    assert.notEqual(path.resolve(repoA).toLowerCase(), path.resolve(repoB).toLowerCase(), 'the two repos must live at different canonical paths');

    // ------------------------------------------------------------------
    // 3. Import both through the product's real import API. Each import
    //    resolves the canonical repo identity and installs the managed
    //    post-commit hook bound to its own projectId. Both keep the SAME
    //    default display name (the shared basename) — only the canonical
    //    identity may tell them apart.
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

    // ------------------------------------------------------------------
    // 4. One drain BETWEEN import and the sessions: the product establishes
    //    each project's baseline before the events exist, exactly as the
    //    Bridge notify wake-up does in real operation. Without this the
    //    baseline would swallow the first session events (I-14: pre-import
    //    history is never backfilled).
    // ------------------------------------------------------------------
    await harness.productApi('POST', '/api/bridge/notify', {});
    let drainStatus = null;
    await harness.waitFor(async () => {
      const status = await harness.productApi('GET', '/api/bridge/status');
      const drained = status.body && status.body.status ? status.body.status.lastDrainAt : null;
      if (drained) drainStatus = status.body.status;
      return Boolean(drained);
    }, 'the product drains the bridge journal after import', 30000);
    for (const project of imported) {
      const stateFile = path.join(dataDir, 'projects', project.projectId, 'state.json');
      await harness.waitFor(() => {
        try {
          const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
          const state = parsed && typeof parsed === 'object' && parsed.state && typeof parsed.state === 'object' ? parsed.state : parsed;
          return Number.isInteger(state.conversationBaselineCursor);
        } catch { return false; }
      }, `project ${project.projectId} must establish its conversation baseline before the sessions start`, 30000);
    }

    // ------------------------------------------------------------------
    // 5. Two interleaved development sessions through the real shim.
    //    The shim always exits 0 (fail-open), so landing is proven by the
    //    read-back in step 6, not by the exit code.
    // ------------------------------------------------------------------
    const fire = (payload) => {
      const env = { ...process.env, AI_CODING_EVENT_BRIDGE_HOME: bridgeHome };
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

    // ------------------------------------------------------------------
    // 6. The product's own conversation read-back: each project sees only
    //    its own session, and never the other side's markers.
    // ------------------------------------------------------------------
    const localDate = (() => {
      const now = new Date();
      const offset = now.getTimezoneOffset() * 60000;
      return new Date(now.getTime() - offset).toISOString().slice(0, 10);
    })();
    const dates = [...new Set([new Date().toISOString().slice(0, 10), localDate])];
    const turnsOf = async (projectId) => {
      for (const date of dates) {
        const result = await harness.productApi('GET', `/api/conversations/turns?projectId=${encodeURIComponent(projectId)}&date=${date}`);
        if (result.status === 200 && JSON.stringify(result.body).length > 2) return { date, body: result.body };
      }
      return { date: null, body: null };
    };
    await harness.waitFor(async () => {
      const read = await turnsOf(projectA.projectId);
      const text = JSON.stringify(read.body);
      return text.includes(markerA.prompt) && text.includes(markerA.answer);
    }, 'project A reads back its own session through the product API', 90000);
    await harness.waitFor(async () => {
      const read = await turnsOf(projectB.projectId);
      const text = JSON.stringify(read.body);
      return text.includes(markerB.prompt) && text.includes(markerB.answer);
    }, 'project B reads back its own session through the product API', 90000);

    const readA = await turnsOf(projectA.projectId);
    const readB = await turnsOf(projectB.projectId);
    const textA = JSON.stringify(readA.body);
    const textB = JSON.stringify(readB.body);
    assert.equal(textA.includes(markerA.prompt) && textA.includes(markerA.answer) && textA.includes(markerA.session), true, `project A must carry its own session: ${textA.slice(0, 800)}`);
    assert.equal(textA.includes(markerB.prompt) || textA.includes(markerB.answer) || textA.includes(markerB.session), false, `project A must not carry B's session: ${textA.slice(0, 800)}`);
    assert.equal(textB.includes(markerB.prompt) && textB.includes(markerB.answer) && textB.includes(markerB.session), true, `project B must carry its own session: ${textB.slice(0, 800)}`);
    assert.equal(textB.includes(markerA.prompt) || textB.includes(markerA.answer) || textB.includes(markerA.session), false, `project B must not carry A's session: ${textB.slice(0, 800)}`);

    // ------------------------------------------------------------------
    // 7. Real commits in both repos. The managed hooks append the commit
    //    boundary themselves and notify the product, which projects the
    //    boundary under the owning project only.
    // ------------------------------------------------------------------
    const commits = [];
    for (const [project, marker, seed] of [[projectA, markerA, 'a'], [projectB, markerB, 'b']]) {
      const file = path.join(project.repo, `work-${seed}.md`);
      fs.writeFileSync(file, `${marker.commit}\n`, 'utf8');
      commands.push({ cwd: project.repo, args: ['add', `work-${seed}.md`], ...runGitRaw(project.repo, ['add', `work-${seed}.md`]) });
      commands.push({ cwd: project.repo, args: ['commit', '-m', marker.commit], ...runGitRaw(project.repo, ['commit', '-m', marker.commit]) });
      const sha = git(project.repo, ['rev-parse', 'HEAD']);
      assert.match(sha, /^[0-9a-f]{40}$/, 'the commit must produce a real sha');
      commits.push({ projectId: project.projectId, repo: project.repo, marker: marker.commit, sha });
    }
    const [commitA, commitB] = commits;
    const boundaryPath = (projectId, sha) => path.join(dataDir, 'projects', projectId, 'commit-boundaries', `${sha}.json`);
    await harness.waitFor(() => fs.existsSync(boundaryPath(commitA.projectId, commitA.sha)), 'project A persists its own commit boundary', 90000);
    await harness.waitFor(() => fs.existsSync(boundaryPath(commitB.projectId, commitB.sha)), 'project B persists its own commit boundary', 90000);
    assert.equal(fs.existsSync(boundaryPath(commitB.projectId, commitA.sha)), false, "B must not own A's commit boundary");
    assert.equal(fs.existsSync(boundaryPath(commitA.projectId, commitB.sha)), false, "A must not own B's commit boundary");
    const boundaryA = JSON.parse(fs.readFileSync(boundaryPath(commitA.projectId, commitA.sha), 'utf8'));
    const boundaryB = JSON.parse(fs.readFileSync(boundaryPath(commitB.projectId, commitB.sha), 'utf8'));
    assert.equal(boundaryA.projectId, commitA.projectId, `A's boundary must name A: ${JSON.stringify(boundaryA)}`);
    assert.equal(boundaryA.repoIdentity.workspaceId, projectA.workspaceId, `A's boundary must carry A's canonical identity: ${JSON.stringify(boundaryA)}`);
    assert.equal(boundaryB.projectId, commitB.projectId, `B's boundary must name B: ${JSON.stringify(boundaryB)}`);
    assert.equal(boundaryB.repoIdentity.workspaceId, projectB.workspaceId, `B's boundary must carry B's canonical identity: ${JSON.stringify(boundaryB)}`);

    // ------------------------------------------------------------------
    // 8. Record-level isolation in the durable per-project store: every
    //    persisted event that carries a marker belongs to exactly that
    //    side — same canonical identity, same session — and the other
    //    side's markers are absent from the whole file.
    //
    //    The Bridge journal itself is a LIVE SPOOL by design: the consumer
    //    trims every drained record (the sealed stores are the archive of
    //    record), so the journal is only checked structurally — its
    //    sequence watermark must prove the traffic really passed through
    //    the Bridge.
    // ------------------------------------------------------------------
    const storeEvents = (projectId) => {
      const file = path.join(dataDir, 'projects', projectId, 'conversation-events.jsonl');
      if (!fs.existsSync(file)) return [];
      return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
    };
    const eventsA = storeEvents(projectA.projectId);
    const eventsB = storeEvents(projectB.projectId);
    const recordCheck = (events, marker, workspaceId, projectId, side) => {
      const own = events.filter(event => String(event.content || '').includes(marker.prompt) || String(event.content || '').includes(marker.answer));
      assert.ok(own.length >= 2, `${side} must persist its own prompt and answer events: ${JSON.stringify(own.map(event => ({ eventType: event.eventType, content: String(event.content).slice(0, 60) })))}`);
      assert.equal(own.every(event => event.projectId === projectId), true, `every ${side} record must be named after its project: ${JSON.stringify(own.map(event => event.projectId))}`);
      assert.equal(own.every(event => event.repoIdentity && event.repoIdentity.workspaceId === workspaceId), true, `every ${side} record must carry ${side}'s canonical identity: ${JSON.stringify(own.map(event => event.repoIdentity))}`);
      assert.equal(own.every(event => event.sessionId === marker.session), true, `every ${side} record must belong to ${side}'s session: ${JSON.stringify(own.map(event => event.sessionId))}`);
    };
    recordCheck(eventsA, markerA, projectA.workspaceId, projectA.projectId, 'A');
    recordCheck(eventsB, markerB, projectB.workspaceId, projectB.projectId, 'B');

    // The Bridge spool really carried the traffic (4 session events + 2
    // boundaries), and the consumer really drained and compacted it.
    const spoolStates = [];
    for (const file of walkFiles(bridgeHome)) {
      if (path.basename(file) !== 'state.json') continue;
      let parsed;
      try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
      if (Number.isInteger(parsed.lastSequence)) spoolStates.push({ file: path.relative(bridgeHome, file).split(path.sep).join('/'), firstSequence: parsed.firstSequence, lastSequence: parsed.lastSequence });
    }
    assert.ok(spoolStates.length > 0, `the Bridge journal state must exist under the isolated bridge home: ${bridgeHome}`);
    assert.ok(spoolStates.some(state => state.lastSequence >= 6), `the Bridge journal must have carried all six records (4 session events + 2 boundaries): ${JSON.stringify(spoolStates)}`);

    // ------------------------------------------------------------------
    // 9. Whole-store cross-contamination grep: no marker or sha of one
    //    side may appear anywhere under the other project's directory,
    //    and each marker must exist under its own project.
    // ------------------------------------------------------------------
    const hitsA = grepTree(dataDir, [markerA.prompt, markerA.answer, markerA.session, commitA.sha]);
    const hitsB = grepTree(dataDir, [markerB.prompt, markerB.answer, markerB.session, commitB.sha]);
    assert.ok(hitsA.length > 0, "A's evidence must exist in the product data dir");
    assert.ok(hitsB.length > 0, "B's evidence must exist in the product data dir");
    assert.equal(hitsA.some(hit => hit.file.split('/').includes(projectA.projectId)), true, `A's evidence must be under A's project directory: ${JSON.stringify(hitsA)}`);
    assert.equal(hitsB.some(hit => hit.file.split('/').includes(projectB.projectId)), true, `B's evidence must be under B's project directory: ${JSON.stringify(hitsB)}`);
    assert.equal(hitsA.some(hit => hit.file.split('/').includes(projectB.projectId)), false, `no A evidence may live under B's project directory: ${JSON.stringify(hitsA)}`);
    assert.equal(hitsB.some(hit => hit.file.split('/').includes(projectA.projectId)), false, `no B evidence may live under A's project directory: ${JSON.stringify(hitsB)}`);

    // ------------------------------------------------------------------
    // 10. Nothing leaked into the developer's real home (see CAP-001 for
    //     the honest scope of this comparison).
    // ------------------------------------------------------------------
    const configComparison = harness.compareConfigSurface(harness.realHomeBefore, harness.digestRealClientConfigs());
    assert.equal(configComparison.byteIdentical, true, `the real client configuration must be untouched: ${JSON.stringify({ changedFiles: configComparison.changedFiles, changedDirs: configComparison.changedDirs })}`);
    const treeComparison = harness.compareRealTrees(harness.realTreesBefore, harness.digestRealClientTrees());
    assert.deepEqual(treeComparison.leaks, [], `nothing outside the runtime set may change in the real home: ${JSON.stringify(treeComparison.leaks)}`);
    assert.deepEqual(treeComparison.configChanges, [], `no configuration file may change in the real home: ${JSON.stringify(treeComparison.configChanges)}`);

    if (harness.evidence) await harness.browser.screenshot(path.join(harness.evidence, 'cap008-after.png'));

    evidence.push({
      case: 'CAP-008',
      fixture: {
        tag: 'cap008', fixtureDir: harness.fixture, reposRoot, isolatedHome: harness.homeDir,
        bridgeHome, dataDir, port: Number(harness.base.split(':').pop()), analysisOwner: 'legacy',
      },
      source: { repoRoot: ROOT, gitHead: gitHead() },
      repos: [
        { side: 'A', path: repoA, basename: path.basename(repoA), projectId: projectA.projectId, workspaceId: projectA.workspaceId, hookMarker: hookMarkers[projectA.projectId] },
        { side: 'B', path: repoB, basename: path.basename(repoB), projectId: projectB.projectId, workspaceId: projectB.workspaceId, hookMarker: hookMarkers[projectB.projectId] },
      ],
      markers: { A: markerA, B: markerB },
      wiring: { installRequest: installCall.request, httpStatus: installCall.status, operationId: installCall.response.operationId, shimPath, ownedHookEntries: hooks },
      identityOracle: { A: oracleA.repoIdentity, B: oracleB.repoIdentity },
      baselineDrain: drainStatus,
      sessionCommands,
      commands: commands.map(entry => ({ cwd: entry.cwd, args: entry.args, exitCode: entry.exitCode })),
      journal: {
        spoolStates,
        note: 'the Bridge journal is a live spool: the consumer trims every drained record after the per-project stores are written, so the durable isolation evidence is the per-project store records below',
      },
      storeRecords: {
        A: eventsA.map(event => ({ eventType: event.eventType, role: event.role, sessionId: event.sessionId, workspaceId: event.repoIdentity && event.repoIdentity.workspaceId, contentHead: String(event.content || '').slice(0, 40) })),
        B: eventsB.map(event => ({ eventType: event.eventType, role: event.role, sessionId: event.sessionId, workspaceId: event.repoIdentity && event.repoIdentity.workspaceId, contentHead: String(event.content || '').slice(0, 40) })),
      },
      conversationReadBack: {
        A: { date: readA.date, carriesOwnSession: true, carriesOtherSession: false },
        B: { date: readB.date, carriesOwnSession: true, carriesOtherSession: false },
      },
      commits: {
        A: { sha: commitA.sha, message: markerA.commit, boundaryFile: path.relative(dataDir, boundaryPath(commitA.projectId, commitA.sha)), boundary: boundaryA },
        B: { sha: commitB.sha, message: markerB.commit, boundaryFile: path.relative(dataDir, boundaryPath(commitB.projectId, commitB.sha)), boundary: boundaryB },
        crossBoundaryAUnderB: fs.existsSync(boundaryPath(commitB.projectId, commitA.sha)),
        crossBoundaryBUnderA: fs.existsSync(boundaryPath(commitA.projectId, commitB.sha)),
      },
      storeGrep: { A: hitsA, B: hitsB },
      realHomeIsolation: {
        configuration: { byteIdentical: configComparison.byteIdentical, changedFiles: configComparison.changedFiles, changedDirs: configComparison.changedDirs },
        tree: { leaks: treeComparison.leaks, configChanges: treeComparison.configChanges, runtimeChangeCount: treeComparison.runtimeChanges },
        scopeLabel: "honest: the developer's own live client sessions keep writing runtime files while the case runs; the isolation claim is about the client configuration surface and every changed file outside the known runtime set",
      },
      scopeLabel: 'honest: both sessions went through the real installed shim and both commits through the real managed hooks; read-back used the product own conversation API plus the on-disk stores of the legacy-mode product instance',
    });

    if (harness.evidence) {
      fs.mkdirSync(harness.evidence, { recursive: true });
      fs.writeFileSync(path.join(harness.evidence, 'cap008-cross-workspace-isolation.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    }

    console.log('parallel-memory-capture-r3-cap008-probe PASS (same-basename repos at different canonical paths stayed isolated: canonical identities differ, sessions and commits never crossed sides)');
  } finally {
    await harness.cleanup();
    fs.rmSync(reposRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

function runGitRaw(repo, args) {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} in ${repo} failed (${result.status}): ${String(result.stderr || result.stdout || '').slice(0, 500)}`);
  return { exitCode: result.status };
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
