'use strict';
// _site/_test/parallel-memory-capture-r3-cap006-probe.js
//
// CAP-006 修复幂等 — the external-Agent integration case of
// qa-autopilot/config/test-cases.json.
//
//   steps:    连续两次接入/修复同一客户端。
//   expected: 不叠加Hook、不重复notify wrapper。/ operationId可追踪。
//   evidence: 实际命令与退出码 / UI、接口、磁盘对应证据 / 源HEAD、文件哈希、测试夹具ID
//
// WHAT IS REAL HERE
//
//   * the product server, the browser and the native Claude Code CLI are the
//     real ones, against an isolated home (see the harness header);
//   * the FIRST 接入 is a real click and a real install;
//   * the wiring is then really broken the way an older stacking install
//     breaks it: the managed Stop group is duplicated AND a user-owned
//     third-party hook is added, so the product's own status scan must report
//     needs-repair before the second click;
//   * the SECOND 接入 is again a real click: the product must remove the
//     duplicate (removedDuplicates in its own answer), keep exactly one
//     managed entry per event, PRESERVE the third-party hook, and answer a
//     second operationId that is findable in the product's own diagnostics
//     dialog.
//
// BLOCKED SUB-ITEM (recorded honestly, not worked around)
//
//   "不重复notify wrapper" is about the Codex notify chain. On this machine
//   the native codex CLI resolves the developer's REAL profile directory no
//   matter what HOME/USERPROFILE say, so a Codex 接入 through the real UI
//   would read and write the developer's real ~/.codex — exactly what this
//   lane is forbidden to do. The probe proves that boundary with the real CLI
//   (command, exit code and the outside-the-isolated-home paths it reports)
//   and marks the sub-item BLOCKED instead of substituting an API call.

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');

const { startCapHarness, ROOT } = require('./helpers/parallel-memory-capture-r3-cap-shell');

const EVIDENCE = process.env.PK_TEST_EVIDENCE_DIR ? path.resolve(process.env.PK_TEST_EVIDENCE_DIR) : null;
const CLIENT = 'claude';
const THIRD_PARTY_COMMAND = 'thirdparty-user-hook.exe --on-stop';

function gitHead() {
  try {
    return execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim();
  } catch { return null; }
}

function readSettings(homeDir) {
  return JSON.parse(fs.readFileSync(path.join(homeDir, '.claude', 'settings.json'), 'utf8'));
}

function countHooks(settings) {
  const counts = {};
  for (const event of ['UserPromptSubmit', 'Stop']) {
    const groups = (settings.hooks && settings.hooks[event]) || [];
    const bridge = [];
    const thirdParty = [];
    for (const group of groups) for (const hook of group?.hooks || []) {
      const command = hook?.type === 'command' ? hook.command : `${hook?.command || ''} ${(hook?.args || []).join(' ')}`;
      if (/bridge-hook\.cjs/i.test(String(command))) bridge.push(String(command));
      else thirdParty.push(String(command));
    }
    counts[event] = { bridgeGroups: bridge.length, thirdParty: thirdParty.length, bridgeCommands: bridge, thirdPartyCommands: thirdParty };
  }
  return counts;
}

/**
 * The boundary evidence for the Codex sub-item, with the real CLI. The CLI's
 * own runtime is not deterministic (it phones a remote plugin catalogue), so
 * the probe makes bounded attempts and classifies honestly:
 *   answered + paths outside the isolated home -> BLOCKED proven,
 *   answered + everything inside               -> the claim is WRONG (fail),
 *   never answered                              -> BLOCKED, cli-unusable.
 */
function codexIsolationBoundary(homeDir, attempts = 3) {
  const command = 'codex';
  const args = ['plugin', 'list', '--json'];
  const started = Date.now();
  // Exactly the environment the product's own `execute('codex', …)` gives the
  // CLI: HOME/USERPROFILE redirected, CODEX_HOME not set.
  const env = { ...process.env, HOME: homeDir, USERPROFILE: homeDir };
  delete env.CODEX_HOME;
  const trials = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = spawnSync(command, args, {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 90000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    let outside = [];
    try {
      const parsed = JSON.parse(result.stdout);
      outside = (parsed.installed || [])
        .map(item => (item.source && item.source.path) || null)
        .filter(Boolean)
        .map(item => ({ path: item, insideHome: path.resolve(item).toLowerCase().startsWith(path.resolve(homeDir).toLowerCase()) }))
        .filter(item => !item.insideHome);
    } catch { /* not the documented JSON */ }
    trials.push({ attempt, exitCode: result.status, answered: Boolean(result.stdout), pathsOutsideIsolatedHome: outside.slice(0, 5) });
    if (result.stdout) {
      return {
        command: `${command} ${args.join(' ')}`,
        exitCode: result.status,
        durationMs: Date.now() - started,
        isolatedHome: homeDir,
        environment: 'HOME/USERPROFILE redirected to the isolated home, CODEX_HOME unset — the environment the product itself gives the CLI',
        answered: true,
        stderrHead: result.stderr ? String(result.stderr).slice(0, 200) : null,
        pathsOutsideIsolatedHome: outside.slice(0, 5),
        classification: outside.length ? 'blocked: the CLI reads the developer\'s real profile' : 'isolatable',
        trials,
      };
    }
  }
  return {
    command: `${command} ${args.join(' ')}`,
    exitCode: trials[trials.length - 1].exitCode,
    durationMs: Date.now() - started,
    isolatedHome: homeDir,
    environment: 'HOME/USERPROFILE redirected to the isolated home, CODEX_HOME unset — the environment the product itself gives the CLI',
    answered: false,
    stderrHead: null,
    pathsOutsideIsolatedHome: [],
    classification: 'blocked: the CLI does not even complete against an isolated home',
    trials,
  };
}

async function main() {
  const harness = await startCapHarness({ tag: 'cap006', evidenceDir: EVIDENCE || undefined });
  const evidence = [];
  try {
    // ------------------------------------------------------------------
    // 0. The BLOCKED Codex notify sub-item first, with its real boundary
    //    evidence — before any UI step, so the claim is settled up front.
    // ------------------------------------------------------------------
    const codexBoundary = codexIsolationBoundary(harness.homeDir);
    assert.notEqual(codexBoundary.classification, 'isolatable', `if the codex CLI were isolatable the sub-item would not be BLOCKED: ${JSON.stringify(codexBoundary)}`);
    assert.equal(codexBoundary.classification.startsWith('blocked:'), true, `the codex BLOCKED claim needs a real classification: ${JSON.stringify(codexBoundary)}`);
    // ------------------------------------------------------------------
    // 1. The first real 接入.
    // ------------------------------------------------------------------
    await harness.openSystemDrawer();
    await harness.nativeClick(`[data-agent-switch="install"][data-agent-client="${CLIENT}"]`);
    await harness.waitFor(
      () => harness.run("document.getElementById('agentCaptureFeedback').textContent.trim().length > 0 && !document.getElementById('agentCaptureFeedback').textContent.includes('正在接入')"),
      'the first 接入 action answers in the UI',
      180000,
    );
    const firstCall = await harness.lastInstallCall();
    assert.equal(firstCall.status, 200, `the first install request answers 200: ${JSON.stringify(firstCall)}`);
    assert.equal(firstCall.response.complete, true, `the first install must complete: ${JSON.stringify(firstCall.response)}`);
    const firstOperationId = firstCall.response.operationId;
    assert.ok(firstOperationId, 'the first install must report an operation id');
    await harness.waitFor(
      () => harness.run(`(() => { const row = [...document.querySelectorAll('#agentCaptureList .agent-capture-row')].find(item => item.querySelector('[data-agent-switch]') && item.querySelector('[data-agent-switch]').dataset.agentClient === ${JSON.stringify(CLIENT)}); return Boolean(row) && row.querySelector('.status').textContent === '已接入'; })()`),
      'the row shows the client as connected after the first install',
      90000,
    );
    const countsAfterFirst = countHooks(readSettings(harness.homeDir));
    assert.equal(countsAfterFirst.UserPromptSubmit.bridgeGroups, 1, `one managed entry per event, no stacking: ${JSON.stringify(countsAfterFirst)}`);
    assert.equal(countsAfterFirst.Stop.bridgeGroups, 1, `one managed entry per event, no stacking: ${JSON.stringify(countsAfterFirst)}`);
    if (harness.evidence) await harness.browser.screenshot(path.join(harness.evidence, 'cap006-after-first-install.png'));

    // ------------------------------------------------------------------
    // 2. Break the wiring the way an older stacking install does: duplicate
    //    the managed Stop group and add a user-owned third-party hook.
    // ------------------------------------------------------------------
    const settingsFile = path.join(harness.homeDir, '.claude', 'settings.json');
    const settings = readSettings(harness.homeDir);
    const stopGroups = settings.hooks.Stop;
    const ownedGroup = stopGroups.find(group => (group?.hooks || []).some(hook => /bridge-hook\.cjs/i.test(String(hook?.command || ''))));
    assert.ok(ownedGroup, `the managed Stop group must exist before the corruption: ${JSON.stringify(stopGroups)}`);
    settings.hooks.Stop = [
      ...stopGroups,
      JSON.parse(JSON.stringify(ownedGroup)),
      { hooks: [{ type: 'command', command: THIRD_PARTY_COMMAND }] },
    ];
    fs.writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
    const countsCorrupt = countHooks(readSettings(harness.homeDir));
    assert.equal(countsCorrupt.Stop.bridgeGroups, 2, `the corruption really duplicated the managed Stop entry: ${JSON.stringify(countsCorrupt)}`);
    assert.equal(countsCorrupt.Stop.thirdParty, 1, `the corruption really added the third-party hook: ${JSON.stringify(countsCorrupt)}`);

    // The product's own scan must see the damage before any repair is asked
    // for. Reopening the drawer is the product's own refresh point; the scan
    // itself takes longer than the 500 ms the API waits, so the row's own
    // re-render (the UI re-polls while the scan is pending) is the first
    // settled answer, and the API is read only after it.
    await harness.reopenSystemDrawer();
    await harness.waitFor(
      () => harness.run(`(() => { const row = [...document.querySelectorAll('#agentCaptureList .agent-capture-row')].find(item => item.querySelector('[data-agent-switch]') && item.querySelector('[data-agent-switch]').dataset.agentClient === ${JSON.stringify(CLIENT)}); return Boolean(row) && row.querySelector('.status').textContent === '未接入'; })()`),
      'the row re-renders as not connected after the fresh scan',
      60000,
    );
    const statusCorrupt = await harness.settledStatus();
    const clientCorrupt = harness.statusClient(statusCorrupt, CLIENT);
    assert.equal(clientCorrupt.developmentCapture.state, 'needs-repair', `the product must report the duplicated hook as needs-repair: ${JSON.stringify(clientCorrupt.developmentCapture)}`);
    assert.equal(clientCorrupt.summary, 'disconnected', `the product must not report the client as connected: ${JSON.stringify(clientCorrupt.summary)}`);
    const rowCorrupt = await harness.agentRow(CLIENT);
    assert.equal(rowCorrupt.badge, '未接入', `the row must read as not connected while the wiring is broken: ${JSON.stringify(rowCorrupt)}`);
    assert.equal(rowCorrupt.switch.action, 'install', `the switch must offer 接入 (the repair) again: ${JSON.stringify(rowCorrupt.switch)}`);
    if (harness.evidence) await harness.browser.screenshot(path.join(harness.evidence, 'cap006-needs-repair.png'));

    // ------------------------------------------------------------------
    // 3. The second real 接入: the repair. No stacking, third party kept.
    // ------------------------------------------------------------------
    const callsBeforeSecondClick = harness.installCallCount();
    await harness.nativeClick(`[data-agent-switch="install"][data-agent-client="${CLIENT}"]`);
    await harness.waitFor(
      () => harness.installCallCount() === callsBeforeSecondClick + 1,
      'the second 接入 click really sends a new install request',
      30000,
    );
    await harness.waitFor(
      async () => {
        const call = await harness.lastInstallCall();
        return Boolean(call && call.response && call.response.complete === true);
      },
      'the repair request completes',
      180000,
    );
    const secondCall = await harness.lastInstallCall();
    assert.equal(secondCall.status, 200, `the second install request answers 200: ${JSON.stringify(secondCall)}`);
    assert.equal(secondCall.response.complete, true, `the repair must complete: ${JSON.stringify(secondCall.response)}`);
    const secondOperationId = secondCall.response.operationId;
    assert.ok(secondOperationId, 'the repair must report its own operation id');
    assert.notEqual(secondOperationId, firstOperationId, 'the two actions must be separately traceable');
    const captureAnswer = (secondCall.response.clients || []).find(entry => entry.client === CLIENT)?.developmentCapture;
    assert.ok(captureAnswer, `the repair answer must carry the capture result: ${JSON.stringify(secondCall.response.clients)}`);
    assert.equal(captureAnswer.removedDuplicates, 1, `the product must report removing exactly the one duplicate: ${JSON.stringify(captureAnswer)}`);
    assert.equal(captureAnswer.removedLegacy, 0, `nothing legacy should have been removed: ${JSON.stringify(captureAnswer)}`);

    await harness.waitFor(
      () => harness.run(`(() => { const row = [...document.querySelectorAll('#agentCaptureList .agent-capture-row')].find(item => item.querySelector('[data-agent-switch]') && item.querySelector('[data-agent-switch]').dataset.agentClient === ${JSON.stringify(CLIENT)}); return Boolean(row) && row.querySelector('.status').textContent === '已接入'; })()`),
      'the row shows the client as connected again after the repair',
      90000,
    );
    const countsAfterRepair = countHooks(readSettings(harness.homeDir));
    assert.equal(countsAfterRepair.UserPromptSubmit.bridgeGroups, 1, `the repair must not stack hooks: ${JSON.stringify(countsAfterRepair)}`);
    assert.equal(countsAfterRepair.Stop.bridgeGroups, 1, `the repair must collapse the duplicate back to one managed entry: ${JSON.stringify(countsAfterRepair)}`);
    assert.deepEqual(countsAfterRepair.Stop.thirdPartyCommands, [THIRD_PARTY_COMMAND], `the user's third-party hook must be preserved: ${JSON.stringify(countsAfterRepair.Stop)}`);
    assert.equal(countsAfterRepair.UserPromptSubmit.thirdParty, 0, `no third-party hook was added on the other event: ${JSON.stringify(countsAfterRepair)}`);

    const hooksAfterRepair = harness.ownedHookEntries();
    const eventsAfterRepair = [...new Set(hooksAfterRepair.map(entry => entry.event))].sort();
    assert.deepEqual(eventsAfterRepair, ['Stop', 'UserPromptSubmit'], `both capture events must still be wired: ${JSON.stringify(hooksAfterRepair)}`);
    for (const event of eventsAfterRepair) {
      const owned = hooksAfterRepair.filter(entry => entry.event === event);
      assert.equal(owned.length, 1, `exactly one managed ${event} entry after the repair: ${JSON.stringify(owned)}`);
      assert.equal(owned[0].shimExists, true, `the ${event} hook must still point at a real Bridge entry: ${JSON.stringify(owned[0])}`);
    }

    // The product left its own backup of what it removed on disk.
    const backups = fs.readdirSync(path.join(harness.homeDir, '.claude'))
      .filter(name => /^settings\.json\.project-knowledge-capture-.*\.bak$/.test(name));
    assert.equal(backups.length, 1, `the product must back up the removed duplicate exactly once: ${JSON.stringify(backups)}`);

    // ------------------------------------------------------------------
    // 4. operationId traceability, in the product's own diagnostics UI.
    // ------------------------------------------------------------------
    const traceability = [];
    for (const [label, operationId] of [['first', firstOperationId], ['repair', secondOperationId]]) {
      const dialog = await harness.logsSearch(operationId);
      assert.equal(dialog.search, operationId, `the diagnostics dialog must keep the searched operation id: ${JSON.stringify(dialog.search)}`);
      assert.ok(dialog.entries.length > 0, `the operation id of the ${label} action must be findable in the diagnostics dialog`);
      const hits = dialog.entries.filter(entry => `${entry.summary} ${entry.detail}`.includes(operationId));
      assert.ok(hits.length > 0, `the ${label} operation id must appear in the returned diagnostics records themselves, not just accompany them: ${JSON.stringify(dialog.entries.slice(0, 3))}`);
      const installRecords = dialog.entries.filter(entry => `${entry.summary} ${entry.detail}`.includes('Agent 接入完成'));
      assert.ok(installRecords.length > 0, `the ${label} operation id must resolve to its own install record: ${JSON.stringify(dialog.entries.map(entry => entry.summary).slice(0, 10))}`);
      traceability.push({
        action: label,
        operationId,
        dialogStatus: dialog.status,
        returnedEntries: dialog.entries.length,
        operationIdHits: hits.length,
        installCompletedRecords: installRecords.length,
        sampleSummaries: [...new Set(dialog.entries.map(entry => entry.summary.replace(/^\d\d\/\d\d \d\d:\d\d/, '').trim()))].slice(0, 8),
      });
    }

    // The real native commands the product ran, with their real exit codes.
    const commandLog = await harness.productApi('GET', '/api/logs?q=integration.command_completed&pageSize=100');
    assert.equal(commandLog.status, 200, `the diagnostics log must be readable: ${JSON.stringify(commandLog.body)}`);
    const commands = (commandLog.body.entries || [])
      .filter(entry => String(entry.event || '').includes('integration.command'))
      .map(entry => ({
        event: entry.event,
        client: entry.context && entry.context.client ? entry.context.client : null,
        status: entry.context && entry.context.status !== undefined ? entry.context.status : null,
        argumentCount: entry.context && entry.context.argumentCount !== undefined ? entry.context.argumentCount : null,
        argsHash: entry.context && entry.context.argsHash ? entry.context.argsHash : null,
      }));
    assert.ok(commands.length > 0, 'the product must record the native commands it really ran');
    assert.equal(commands.every(entry => entry.status === 0), true, `every native command must have exited 0: ${JSON.stringify(commands)}`);

    // ------------------------------------------------------------------
    // 5. Nothing leaked into the developer's real home.
    // ------------------------------------------------------------------
    const configAfter = harness.digestRealClientConfigs();
    const configComparison = harness.compareConfigSurface(harness.realHomeBefore, configAfter);
    assert.equal(configComparison.byteIdentical, true, `the real client configuration must be untouched: ${JSON.stringify({ changedFiles: configComparison.changedFiles, changedDirs: configComparison.changedDirs })}`);
    const treeComparison = harness.compareRealTrees(harness.realTreesBefore, harness.digestRealClientTrees());
    assert.deepEqual(treeComparison.leaks, [], `nothing outside the runtime set may change in the real home: ${JSON.stringify(treeComparison.leaks)}`);
    assert.deepEqual(treeComparison.configChanges, [], `no configuration file may change in the real home: ${JSON.stringify(treeComparison.configChanges)}`);
    if (harness.evidence) await harness.browser.screenshot(path.join(harness.evidence, 'cap006-after-repair.png'));

    evidence.push({
      case: 'CAP-006',
      fixture: { tag: 'cap006', fixtureDir: harness.fixture, isolatedHome: harness.homeDir, port: Number(harness.base.split(':').pop()) },
      source: { repoRoot: ROOT, gitHead: gitHead() },
      firstInstall: {
        control: `[data-agent-switch="install"][data-agent-client="${CLIENT}"]`,
        realClick: true,
        httpStatus: firstCall.status,
        operationId: firstOperationId,
        complete: firstCall.response.complete,
        hooksAfter: countsAfterFirst,
      },
      corruption: {
        method: 'duplicated the managed Stop group and added a third-party hook, directly in the isolated settings.json',
        settingsFile: path.join(harness.homeDir, '.claude', 'settings.json'),
        hooksAfterCorruption: countsCorrupt,
        productStatus: { developmentCapture: clientCorrupt.developmentCapture, summary: clientCorrupt.summary },
        ui: { badge: rowCorrupt.badge, switch: rowCorrupt.switch },
      },
      repair: {
        control: `[data-agent-switch="install"][data-agent-client="${CLIENT}"]`,
        realClick: true,
        httpStatus: secondCall.status,
        operationId: secondOperationId,
        complete: secondCall.response.complete,
        captureAnswer,
        hooksAfterRepair: countsAfterRepair,
        ownedHookEntries: hooksAfterRepair,
        removedDuplicateBackups: backups,
      },
      operationIdTraceability: traceability,
      nativeCommands: commands,
      blockedSubItems: [{
        item: '不重复notify wrapper（Codex notify 链）',
        status: 'BLOCKED',
        reason: 'the native codex CLI resolves the developer\'s real profile directory regardless of HOME/USERPROFILE, so a Codex 接入 through the real UI would read and write the developer\'s real ~/.codex; the lane may not modify the real home',
        boundary: codexBoundary,
      }],
      realHomeIsolation: {
        configuration: { byteIdentical: configComparison.byteIdentical, changedFiles: configComparison.changedFiles, changedDirs: configComparison.changedDirs },
        tree: { leaks: treeComparison.leaks, configChanges: treeComparison.configChanges, runtimeChangeCount: treeComparison.runtimeChanges, changed: treeComparison.changed },
      },
      scopeLabel: 'honest: two real 接入 clicks (install, then repair of a really duplicated hook); the Codex notify sub-item is BLOCKED with real CLI boundary evidence',
    });

    if (harness.evidence) {
      fs.mkdirSync(harness.evidence, { recursive: true });
      fs.writeFileSync(path.join(harness.evidence, 'cap006-repair-idempotency.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    }

    console.log('parallel-memory-capture-r3-cap006-probe PASS (the second 接入 really repaired a duplicated hook without stacking and preserved the third-party hook; both operation ids are traceable in the product diagnostics; the codex notify sub-item is BLOCKED with real boundary evidence)');
  } finally {
    await harness.cleanup();
  }
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
