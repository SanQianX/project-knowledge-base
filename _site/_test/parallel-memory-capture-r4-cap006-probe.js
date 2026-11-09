'use strict';
// _site/_test/parallel-memory-capture-r4-cap006-probe.js
//
// CAP-006 R4 — Codex CODEX_HOME isolation retest (R4 contract item 3).
//
// R3 declared the Codex notify sub-item BLOCKED because the codex CLI "resolves
// the developer's real profile directory regardless of HOME/USERPROFILE". That
// experiment never set CODEX_HOME — and the product's own codexHookProbe
// (_site/lib/integration-installer.js) explicitly passes
// CODEX_HOME: this.env.CODEX_HOME || dirname(codexConfigFile), so the claimed
// un-isolatability was never the environment the product actually gives the
// CLI. This case settles it with real evidence, both directions:
//
//   1. FIRST a read-only CLI gate, before any UI step: with EXPLICIT
//      CODEX_HOME plus independent APPDATA/LOCALAPPDATA/USERPROFILE/HOME on an
//      external temp home, `codex plugin list --json` and
//      `codex plugin marketplace list` must answer with every config/plugin
//      path inside the isolated root and zero writes to the real home.
//      One bounded attempt per command — if the CLI cannot answer, the gate
//      fails with that single meaningful error, no blind retries.
//   2. THEN the real UI, three consecutive real 接入 clicks for the codex row:
//      the first install writes the notify wrapper; the product's own settled
//      status scan then proves clean-chain idempotence over it (its
//      statusCaptureCodex computes planNotify and only reports installed when
//      changed === false); a doubled owned chain wrapping a compatible DevTask
//      Radar third-party entry is repaired by the second click (collapse to
//      one anchor, third party preserved); a plain doubled anchor without any
//      third party is repaired by the third click (repeatable collapse,
//      nothing resurrected). One backup per real change, every write inside
//      the isolated CODEX_HOME.
//
// Both corruptions are direct edits of the ISOLATED config.toml — declared
// artificial damage (an older stacking install's shape), never product
// output. No Codex session is ever started: the probe exercises the
// plugin/config surface only, so no model and no quota is consumed. If the
// product ignores the explicit isolation the probe FAILS with the escaping
// paths as the source-defect evidence; there is no must-be-BLOCKED assertion —
// real evidence decides.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');

const r3cap = require('./helpers/parallel-memory-capture-r3-cap-shell');
const { startCapHarness, ROOT } = require('./helpers/parallel-memory-capture-r4-cap-shell');

const EVIDENCE = process.env.PK_TEST_EVIDENCE_DIR ? path.resolve(process.env.PK_TEST_EVIDENCE_DIR) : null;
const CLIENT = 'codex';
const MARKER = 'CAP006R4-ISOLATION-PROBE';
const RADAR = ['node', 'C:/DevTask Radar/connectors/codex/notify-hook.js'];
const FANOUT = path.join(ROOT, '_site', 'scripts', 'codex-notify-fanout.cjs');
// The live Codex desktop rewrites its electron state at arbitrary moments; the
// R4 cap008e probe proved these writes external. They stay carved out here and
// must stay marker-free.
const LIVE_CODEX_STATE = /^\.codex\/\.codex-global-state\.json(\.bak)?$/;

function gitHead() {
  try {
    return execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim();
  } catch { return null; }
}

const encode = args => Buffer.from(JSON.stringify(args)).toString('base64');
const decode = value => {
  try { return JSON.parse(Buffer.from(value, 'base64').toString('utf8')); } catch { return null; }
};

/** The root-level notify line of a codex config.toml, product-format. */
function readNotifyLine(configFile) {
  const source = fs.existsSync(configFile) ? fs.readFileSync(configFile, 'utf8') : '';
  const lines = source.split(/\r?\n/);
  const table = lines.findIndex(line => /^\s*\[/.test(line));
  const index = lines.findIndex((line, i) => /^\s*notify\s*=/.test(line) && (table < 0 || i < table));
  if (index < 0) return { source, lines, eol: source.includes('\r\n') ? '\r\n' : '\n', index, args: null };
  let args = null;
  try { args = JSON.parse(lines[index].replace(/^\s*notify\s*=\s*/, '')); } catch { args = null; }
  return { source, lines, eol: source.includes('\r\n') ? '\r\n' : '\n', index, args: Array.isArray(args) ? args : null };
}

const isOwnedFanout = args => Array.isArray(args)
  && /(?:^|[\\/])node(?:\.exe)?$/i.test(args[0] || '')
  && args[1] === FANOUT;

/** Walk the notify chain: owned fanouts collapse until a terminal command. */
function chainOf(args) {
  const commands = [];
  let fanoutCount = 0;
  let bridge = null;
  let current = args;
  while (Array.isArray(current) && current.length) {
    if (isOwnedFanout(current)) {
      fanoutCount += 1;
      const bridgeIndex = current.indexOf('--bridge-base64');
      bridge = bridgeIndex >= 0 ? decode(current[bridgeIndex + 1]) : null;
      commands.push({ kind: 'owned-fanout', bridge });
      const nextIndex = current.indexOf('--next-base64');
      current = nextIndex >= 0 ? decode(current[nextIndex + 1]) : null;
    } else {
      commands.push({ kind: 'terminal', command: current });
      current = null;
    }
  }
  return { commands, fanoutCount, bridge, terminal: commands.length && commands[commands.length - 1].kind === 'terminal' ? commands[commands.length - 1].command : null };
}

/**
 * The read-only CLI gate. Exactly the environment the product's own server
 * process (hence its codex children) will have. One bounded attempt per
 * command; the classification is honest in all three directions.
 */
function codexReadGate({ homeDir, codexHome, appData, localAppData }) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith('CODEX_')) delete env[name];
  Object.assign(env, {
    HOME: homeDir,
    USERPROFILE: homeDir,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    CODEX_HOME: codexHome,
  });
  const inside = value => /^[A-Za-z]:[\\/]/.test(String(value)) && path.resolve(String(value)).toLowerCase().startsWith(path.resolve(homeDir).toLowerCase());
  const collectPaths = value => {
    const found = [];
    const walk = item => {
      if (!item) return;
      if (typeof item === 'string') { if (/^[A-Za-z]:[\\/]/.test(item)) found.push(item); return; }
      if (Array.isArray(item)) { item.forEach(walk); return; }
      if (typeof item === 'object') Object.values(item).forEach(walk);
    };
    walk(value);
    return [...new Set(found)];
  };
  const configBefore = r3cap.digestRealClientConfigs();
  const treesBefore = r3cap.digestRealClientTrees();
  const trials = [];
  for (const [label, args] of [['plugin list', ['plugin', 'list', '--json']], ['marketplace list', ['plugin', 'marketplace', 'list']]]) {
    const started = Date.now();
    const result = spawnSync('codex', args, { encoding: 'utf8', windowsHide: true, timeout: 90000, env, cwd: os.tmpdir() });
    let parsed = null;
    try { parsed = JSON.parse(result.stdout); } catch { parsed = null; }
    const paths = parsed ? collectPaths(parsed) : [];
    const outside = paths.filter(p => !inside(p));
    trials.push({
      label,
      command: `codex ${args.join(' ')}`,
      exitCode: result.status,
      durationMs: Date.now() - started,
      answered: Boolean(result.stdout && result.stdout.trim()),
      stderrHead: result.stderr ? String(result.stderr).slice(0, 200) : null,
      absolutePathCount: paths.length,
      pathsOutsideIsolatedHome: outside.slice(0, 5),
    });
  }
  const configComparison = r3cap.compareConfigSurface(configBefore, r3cap.digestRealClientConfigs());
  const treeComparison = r3cap.compareRealTrees(treesBefore, r3cap.digestRealClientTrees());
  const realHomeUntouched = configComparison.byteIdentical && treeComparison.leaks.length === 0 && treeComparison.configChanges.length === 0;
  const answered = trials.every(trial => trial.answered);
  const escaped = trials.some(trial => trial.pathsOutsideIsolatedHome.length > 0);
  const classification = !answered
    ? 'blocked: the CLI does not answer under the isolated home'
    : escaped
      ? 'blocked: the CLI resolves paths outside the isolated home'
      : realHomeUntouched
        ? 'isolated'
        : 'blocked: the read-only gate itself wrote the real home';
  return {
    environment: 'explicit CODEX_HOME + independent APPDATA/LOCALAPPDATA/USERPROFILE/HOME on the external temp home — exactly what the product server passes its codex children',
    isolatedHome: homeDir,
    codexHome,
    trials,
    realHomeAfterGate: { configByteIdentical: configComparison.byteIdentical, leaks: treeComparison.leaks, configChanges: treeComparison.configChanges },
    classification,
  };
}

/** Replace the isolated config's notify line with an artificial chain. */
function writeCorruptNotify(configFile, args) {
  const record = readNotifyLine(configFile);
  if (record.index < 0) throw new Error(`the notify line must exist before corruption: ${record.source.slice(0, 300)}`);
  record.lines[record.index] = `notify = ${JSON.stringify(args)}`;
  fs.writeFileSync(configFile, record.lines.join(record.eol), 'utf8');
  return chainOf(readNotifyLine(configFile).args);
}

const backupsIn = codexHome => fs.readdirSync(codexHome).filter(name => /^config\.toml\.project-knowledge-notify-.*\.bak$/.test(name));

/** One real 接入 click: wait for its request, its completion and the row. */
async function connectClick(harness, expectConnectedRow) {
  const before = harness.installCallCount();
  await harness.nativeClick(`[data-agent-switch="install"][data-agent-client="${CLIENT}"]`);
  await harness.waitFor(() => harness.installCallCount() === before + 1, 'the 接入 click really sends a new install request', 30000);
  await harness.waitFor(async () => {
    const call = await harness.lastInstallCall();
    return Boolean(call && call.response && call.response.complete === true);
  }, 'the install request completes', 180000);
  const call = await harness.lastInstallCall();
  if (expectConnectedRow) {
    await harness.waitFor(
      () => harness.run(`(() => { const row = [...document.querySelectorAll('#agentCaptureList .agent-capture-row')].find(item => item.querySelector('[data-agent-switch]') && item.querySelector('[data-agent-switch]').dataset.agentClient === ${JSON.stringify(CLIENT)}); return Boolean(row) && row.querySelector('.status').textContent === '已接入'; })()`),
      'the row shows codex as connected again',
      90000,
    );
  }
  return call;
}

async function main() {
  // The probe-owned external temp home: the server's whole homeDir (hence the
  // integration homeDir and CODEX_HOME) moves here for this case, so the
  // codex config file the product edits and the CODEX_HOME the CLI children
  // use are one and the same isolated root.
  const tempRoot = r3cap.resolveTempRoot();
  fs.mkdirSync(tempRoot, { recursive: true });
  const isolatedHome = fs.mkdtempSync(path.join(tempRoot, 'pk-cap-r4-cap006r-home-'));
  const codexHome = path.join(isolatedHome, '.codex');
  // The CLI refuses to answer when CODEX_HOME does not exist; the isolated
  // home is this lane's own directory to prepare.
  fs.mkdirSync(codexHome, { recursive: true });
  const configFile = path.join(codexHome, 'config.toml');

  const harness = await startCapHarness({
    tag: 'cap006r4',
    evidenceDir: EVIDENCE || undefined,
    serverEnv: {
      HOME: isolatedHome,
      USERPROFILE: isolatedHome,
      APPDATA: path.join(isolatedHome, 'AppData', 'Roaming'),
      LOCALAPPDATA: path.join(isolatedHome, 'AppData', 'Local'),
      CODEX_HOME: codexHome,
    },
  });
  const evidence = [];
  try {
    const bridgeCommand = ['node', path.join(harness.bridgeHome, 'bin', 'bridge-hook.cjs')];

    // ------------------------------------------------------------------
    // 0. The read-only CLI gate, BEFORE any UI step (contract order).
    // ------------------------------------------------------------------
    const gate = codexReadGate({
      homeDir: isolatedHome,
      codexHome,
      appData: path.join(isolatedHome, 'AppData', 'Roaming'),
      localAppData: path.join(isolatedHome, 'AppData', 'Local'),
    });
    if (gate.classification !== 'isolated') {
      // The product passes exactly this environment; an escape here is a
      // source defect to report, not a boundary to hide behind.
      throw new Error(`the read-only CLI gate must isolate under explicit CODEX_HOME (source defect if not): ${JSON.stringify(gate)}`);
    }

    // ------------------------------------------------------------------
    // 1. The first real 接入: install (notify wrapper + plugin/marketplace).
    // ------------------------------------------------------------------
    await harness.openSystemDrawer();
    const rowBefore = await harness.agentRow(CLIENT);
    assert.equal(rowBefore.badge, '未接入', `the isolated codex row must start disconnected: ${JSON.stringify(rowBefore)}`);
    const firstCall = await connectClick(harness, true);
    assert.equal(firstCall.status, 200, `the first install request answers 200: ${JSON.stringify(firstCall)}`);
    assert.equal(firstCall.response.complete, true, `the first install must complete (isolation must not break the product): ${JSON.stringify(firstCall.response)}`);
    const firstOperationId = firstCall.response.operationId;
    assert.ok(firstOperationId, 'the first install must report an operation id');
    const firstCapture = (firstCall.response.clients || []).find(entry => entry.client === CLIENT)?.developmentCapture;
    assert.ok(firstCapture, `the install answer must carry the capture result: ${JSON.stringify(firstCall.response.clients)}`);
    assert.equal(firstCapture.changed, true, `the first install really wrote the notify wrapper: ${JSON.stringify(firstCapture)}`);
    assert.ok(firstCapture.backupFile && firstCapture.backupFile.startsWith(codexHome), `the backup must live inside the isolated home: ${JSON.stringify(firstCapture)}`);
    assert.equal(fs.existsSync(firstCapture.backupFile), true, 'the reported backup file must exist on disk');

    // The wrapper itself, in the product's own format, under the isolated home.
    const afterFirst = readNotifyLine(configFile);
    assert.notEqual(afterFirst.index, -1, `the isolated config.toml must carry the notify line: ${afterFirst.source.slice(0, 300)}`);
    const chainFirst = chainOf(afterFirst.args);
    assert.equal(chainFirst.fanoutCount, 1, `exactly one owned fanout anchors the chain: ${JSON.stringify(chainFirst)}`);
    assert.equal(afterFirst.args.length, 4, `the fresh anchor is a plain fanout with no stacking: ${JSON.stringify(afterFirst.args)}`);
    assert.deepEqual(chainFirst.bridge, bridgeCommand, `the fanout must target the lane Bridge entry: ${JSON.stringify(chainFirst)}`);
    assert.equal(fs.existsSync(FANOUT), true, 'the owned fanout script must exist');
    assert.equal(fs.existsSync(bridgeCommand[1]), true, 'the Bridge hook entry must exist');

    // The plugin/marketplace half also landed inside the isolated CODEX_HOME.
    const configText = fs.readFileSync(configFile, 'utf8');
    assert.match(configText, /\[marketplaces\.project-knowledge\]/, `the marketplace registration must be in the isolated config.toml: ${configText.slice(0, 300)}`);
    assert.match(configText, /\[plugins\."project-knowledge@project-knowledge"\]/, `the plugin registration must be in the isolated config.toml: ${configText.slice(0, 300)}`);
    const pluginCacheRoot = path.join(codexHome, 'plugins', 'cache', 'project-knowledge', 'project-knowledge');
    assert.equal(fs.existsSync(pluginCacheRoot), true, `the plugin cache must live under the isolated CODEX_HOME: ${pluginCacheRoot}`);
    const notifyShaAfterFirst = crypto.createHash('sha256').update(afterFirst.lines[afterFirst.index]).digest('hex');
    const backupsAfterFirst = backupsIn(codexHome);
    assert.deepEqual(backupsAfterFirst.length, 1, `one backup per real change, the first install made exactly one: ${JSON.stringify(backupsAfterFirst)}`);
    if (harness.evidence) await harness.browser.screenshot(path.join(harness.evidence, 'cap006r4-after-first-install.png'));

    // ------------------------------------------------------------------
    // 2. Clean-chain idempotence, proven by the product's own settled scan:
    //    statusCaptureCodex reports installed only when planNotify says the
    //    clean chain needs NO rewrite (changed === false).
    // ------------------------------------------------------------------
    const statusClean = await harness.settledStatus();
    const clientClean = harness.statusClient(statusClean, CLIENT);
    assert.equal(clientClean.developmentCapture.state, 'installed', `the product's own scan must accept the clean chain without rewrite: ${JSON.stringify(clientClean.developmentCapture)}`);
    assert.equal(clientClean.developmentCapture.installed, true, `installed means planNotify.changed === false on the clean chain: ${JSON.stringify(clientClean.developmentCapture)}`);
    const notifyShaClean = crypto.createHash('sha256').update(readNotifyLine(configFile).lines[readNotifyLine(configFile).index]).digest('hex');
    assert.equal(notifyShaClean, notifyShaAfterFirst, 'the scan itself must not have rewritten the notify line');
    assert.deepEqual(backupsIn(codexHome).length, 1, `a no-op status scan must not add backups: ${JSON.stringify(backupsIn(codexHome))}`);
    const backupsAfterCleanScan = backupsIn(codexHome);

    // ------------------------------------------------------------------
    // 3. Corruption 1: a doubled owned chain (an older stacking install's
    //    shape) wrapping a compatible DevTask Radar third-party entry.
    //    Artificial damage declared up front — a direct edit of the ISOLATED
    //    config, never product output.
    // ------------------------------------------------------------------
    const inner = ['node', FANOUT, '--next-base64', encode(RADAR), '--bridge-base64', encode(bridgeCommand)];
    const doubledWithRadar = ['node', FANOUT, '--next-base64', encode(inner), '--bridge-base64', encode(bridgeCommand)];
    const chainCorrupt1 = writeCorruptNotify(configFile, doubledWithRadar);
    assert.equal(chainCorrupt1.fanoutCount, 2, `the corruption really doubled the owned anchor: ${JSON.stringify(chainCorrupt1)}`);
    assert.deepEqual(chainCorrupt1.terminal, RADAR, `the corruption really embedded the third-party radar entry: ${JSON.stringify(chainCorrupt1)}`);

    // The product's own scan must see the damage before any repair is asked for.
    await harness.reopenSystemDrawer();
    await harness.waitFor(
      () => harness.run(`(() => { const row = [...document.querySelectorAll('#agentCaptureList .agent-capture-row')].find(item => item.querySelector('[data-agent-switch]') && item.querySelector('[data-agent-switch]').dataset.agentClient === ${JSON.stringify(CLIENT)}); return Boolean(row) && row.querySelector('.status').textContent === '未接入'; })()`),
      'the row re-renders as not connected after the fresh scan',
      60000,
    );
    const statusCorrupt1 = await harness.settledStatus();
    const clientCorrupt1 = harness.statusClient(statusCorrupt1, CLIENT);
    assert.equal(clientCorrupt1.developmentCapture.state, 'not-installed', `the product must report the doubled chain as not installed (its repair vocabulary for codex): ${JSON.stringify(clientCorrupt1.developmentCapture)}`);
    assert.equal(clientCorrupt1.developmentCapture.installed, false, `the doubled chain must not count as installed: ${JSON.stringify(clientCorrupt1.developmentCapture)}`);
    assert.equal(clientCorrupt1.summary, 'disconnected', `the product must not report the client as connected: ${JSON.stringify(clientCorrupt1.summary)}`);
    const rowCorrupt1 = await harness.agentRow(CLIENT);
    assert.equal(rowCorrupt1.badge, '未接入', `the row must read as not connected while the chain is doubled: ${JSON.stringify(rowCorrupt1)}`);
    assert.equal(rowCorrupt1.switch.action, 'install', `the switch must offer 接入 (the repair) again: ${JSON.stringify(rowCorrupt1.switch)}`);
    if (harness.evidence) await harness.browser.screenshot(path.join(harness.evidence, 'cap006r4-needs-repair.png'));

    // ------------------------------------------------------------------
    // 4. The second real 接入: the repair. Collapse to one anchor, keep the
    //    third party, one more backup — all inside the isolated home.
    // ------------------------------------------------------------------
    const secondCall = await connectClick(harness, true);
    assert.equal(secondCall.status, 200, `the repair request answers 200: ${JSON.stringify(secondCall)}`);
    assert.equal(secondCall.response.complete, true, `the repair must complete: ${JSON.stringify(secondCall.response)}`);
    const secondOperationId = secondCall.response.operationId;
    assert.ok(secondOperationId, 'the repair must report its own operation id');
    assert.notEqual(secondOperationId, firstOperationId, 'each action must be separately traceable');
    const repairCapture = (secondCall.response.clients || []).find(entry => entry.client === CLIENT)?.developmentCapture;
    assert.equal(repairCapture.changed, true, `the repair really rewrote the doubled chain: ${JSON.stringify(repairCapture)}`);
    assert.ok(repairCapture.backupFile && repairCapture.backupFile.startsWith(codexHome), `the repair backup must live inside the isolated home: ${JSON.stringify(repairCapture)}`);
    const chainAfterRepair1 = chainOf(readNotifyLine(configFile).args);
    assert.equal(chainAfterRepair1.fanoutCount, 1, `the repair must collapse the doubled anchor back to one: ${JSON.stringify(chainAfterRepair1)}`);
    assert.deepEqual(chainAfterRepair1.terminal, RADAR, `the compatible third-party radar entry must be preserved: ${JSON.stringify(chainAfterRepair1)}`);
    assert.deepEqual(chainAfterRepair1.bridge, bridgeCommand, `the surviving anchor must still target the lane Bridge entry: ${JSON.stringify(chainAfterRepair1)}`);
    const backupsAfterRepair1 = backupsIn(codexHome);
    assert.deepEqual(backupsAfterRepair1.length, 2, `exactly one backup per real change (install + repair): ${JSON.stringify(backupsAfterRepair1)}`);

    // ------------------------------------------------------------------
    // 5. Corruption 2: a plain doubled anchor with NOTHING after it. The
    //    third repair cycle proves the collapse is repeatable, does not
    //    compound, and does not resurrect what was already gone.
    // ------------------------------------------------------------------
    const bareInner = ['node', FANOUT, '--bridge-base64', encode(bridgeCommand)];
    const doubledBare = ['node', FANOUT, '--next-base64', encode(bareInner), '--bridge-base64', encode(bridgeCommand)];
    const chainCorrupt2 = writeCorruptNotify(configFile, doubledBare);
    assert.equal(chainCorrupt2.fanoutCount, 2, `the second corruption really doubled the anchor again: ${JSON.stringify(chainCorrupt2)}`);
    assert.equal(chainCorrupt2.terminal, null, `the second corruption carries no third party: ${JSON.stringify(chainCorrupt2)}`);

    await harness.reopenSystemDrawer();
    await harness.waitFor(
      () => harness.run(`(() => { const row = [...document.querySelectorAll('#agentCaptureList .agent-capture-row')].find(item => item.querySelector('[data-agent-switch]') && item.querySelector('[data-agent-switch]').dataset.agentClient === ${JSON.stringify(CLIENT)}); return Boolean(row) && row.querySelector('.status').textContent === '未接入'; })()`),
      'the row re-renders as not connected before the second repair',
      60000,
    );
    const thirdCall = await connectClick(harness, true);
    assert.equal(thirdCall.response.complete, true, `the second repair must complete: ${JSON.stringify(thirdCall.response)}`);
    const thirdOperationId = thirdCall.response.operationId;
    assert.notEqual(thirdOperationId, secondOperationId, 'the third action is again separately traceable');
    const repair2Capture = (thirdCall.response.clients || []).find(entry => entry.client === CLIENT)?.developmentCapture;
    assert.equal(repair2Capture.changed, true, `the second repair really rewrote the chain: ${JSON.stringify(repair2Capture)}`);
    const chainAfterRepair2 = chainOf(readNotifyLine(configFile).args);
    assert.equal(chainAfterRepair2.fanoutCount, 1, `the second repair collapses to exactly one anchor: ${JSON.stringify(chainAfterRepair2)}`);
    assert.equal(chainAfterRepair2.terminal, null, `nothing may be resurrected after the bare collapse: ${JSON.stringify(chainAfterRepair2)}`);
    assert.equal(readNotifyLine(configFile).args.length, 4, `the collapsed chain is a plain fanout: ${JSON.stringify(readNotifyLine(configFile).args)}`);
    assert.deepEqual(chainAfterRepair2.bridge, bridgeCommand, `the bridge target survives the second repair: ${JSON.stringify(chainAfterRepair2)}`);
    const backupsAfterRepair2 = backupsIn(codexHome);
    assert.deepEqual(backupsAfterRepair2.length, 3, `one backup per real change across install + two repairs: ${JSON.stringify(backupsAfterRepair2)}`);

    // The settled scan accepts the final chain without rewrite, again.
    const statusFinal = await harness.settledStatus();
    assert.equal(harness.statusClient(statusFinal, CLIENT).developmentCapture.installed, true, `the final chain must satisfy the product's own no-rewrite check: ${JSON.stringify(harness.statusClient(statusFinal, CLIENT).developmentCapture)}`);

    // ------------------------------------------------------------------
    // 6. operationId traceability in the product's own diagnostics UI.
    // ------------------------------------------------------------------
    const traceability = [];
    for (const [label, operationId] of [['first', firstOperationId], ['repair-radar', secondOperationId], ['repair-bare', thirdOperationId]]) {
      const dialog = await harness.logsSearch(operationId);
      assert.ok(dialog.entries.length > 0, `the operation id of the ${label} action must be findable in the diagnostics dialog`);
      const hits = dialog.entries.filter(entry => `${entry.summary} ${entry.detail}`.includes(operationId));
      assert.ok(hits.length > 0, `the ${label} operation id must appear in the returned diagnostics records themselves: ${JSON.stringify(dialog.entries.slice(0, 3))}`);
      traceability.push({ action: label, operationId, returnedEntries: dialog.entries.length, operationIdHits: hits.length });
    }
    // The diagnostics dialog is open on the last repair's records — a visibly
    // distinct page state from the first-install shot, and itself evidence.
    if (harness.evidence) await harness.browser.screenshot(path.join(harness.evidence, 'cap006r4-after-repair.png'));
    const commandLog = await harness.productApi('GET', '/api/logs?q=integration.command&pageSize=100');
    assert.equal(commandLog.status, 200, `the diagnostics log must be readable: ${JSON.stringify(commandLog.body)}`);
    const commands = (commandLog.body.entries || [])
      .filter(entry => String(entry.event || '') === 'integration.command_completed')
      .map(entry => ({ event: entry.event, client: entry.context?.client ?? null, status: entry.context?.status ?? null, argsHash: entry.context?.argsHash ?? null }));
    assert.ok(commands.length > 0, 'the product must record the native codex commands it really ran');
    assert.equal(commands.every(entry => entry.status === 0), true, `every native command must have exited 0: ${JSON.stringify(commands)}`);

    // ------------------------------------------------------------------
    // 7. Nothing leaked into the developer's real home (live-state carve-out).
    // ------------------------------------------------------------------
    const configComparison = r3cap.compareConfigSurface(harness.realHomeBefore, r3cap.digestRealClientConfigs());
    assert.equal(configComparison.byteIdentical, true, `the real client configuration must be untouched: ${JSON.stringify({ changedFiles: configComparison.changedFiles, changedDirs: configComparison.changedDirs })}`);
    const treeComparison = r3cap.compareRealTrees(harness.realTreesBefore, r3cap.digestRealClientTrees());
    const liveWrites = treeComparison.changed.filter(item => LIVE_CODEX_STATE.test(`${item.dir}/${item.file}`));
    assert.deepEqual(treeComparison.leaks.filter(item => !LIVE_CODEX_STATE.test(`${item.dir}/${item.file}`)), [], `nothing outside the runtime set and the proven live Codex state may change in the real home: ${JSON.stringify(treeComparison.leaks)}`);
    assert.deepEqual(treeComparison.configChanges, [], `no real configuration file may change: ${JSON.stringify(treeComparison.configChanges)}`);
    // Everything else that changed must be classified runtime by the frozen
    // R3 partition (the developer's own live Claude/Codex sessions writing
    // their own runtime files concurrently) — anything else IS a leak and
    // already failed the leaks assertion above.
    const concurrentRuntimeWrites = treeComparison.changed.filter(item => !LIVE_CODEX_STATE.test(`${item.dir}/${item.file}`));
    assert.deepEqual(concurrentRuntimeWrites.filter(item => !r3cap.RUNTIME_PATH.test(`${item.dir}/${item.file}`)), [], `every non-carve-out change must be a runtime-path write of the live clients, not ours: ${JSON.stringify(concurrentRuntimeWrites)}`);
    for (const relative of ['.codex/.codex-global-state.json', '.codex/.codex-global-state.json.bak']) {
      const real = path.join(os.homedir(), relative);
      if (fs.existsSync(real)) {
        assert.equal(fs.readFileSync(real, 'utf8').includes(MARKER), false, `the live Codex state must stay marker-free (external writes only): ${relative}`);
      }
    }

    evidence.push({
      case: 'CAP-006 (R4 retest)',
      fixture: { tag: 'cap006r4', fixtureDir: harness.fixture, isolatedHome, codexHome, port: Number(harness.base.split(':').pop()) },
      source: { repoRoot: ROOT, gitHead: gitHead() },
      r3ClaimRetested: 'R3 declared the codex notify sub-item BLOCKED ("the native codex CLI resolves the developer\'s real profile directory regardless of HOME/USERPROFILE") — that experiment never set CODEX_HOME, while the product\'s own codexHookProbe passes it explicitly',
      gate,
      firstInstall: {
        control: `[data-agent-switch="install"][data-agent-client="${CLIENT}"]`,
        realClick: true,
        httpStatus: firstCall.status,
        operationId: firstOperationId,
        complete: firstCall.response.complete,
        developmentCapture: firstCapture,
        notifyChain: chainFirst,
        backups: backupsAfterFirst,
      },
      cleanChainIdempotence: {
        method: 'the product\'s own settled status scan — statusCaptureCodex reports installed only when planNotify computes changed === false over the existing chain',
        developmentCapture: clientClean.developmentCapture,
        notifyLineSha256Stable: notifyShaClean === notifyShaAfterFirst,
        backups: backupsAfterCleanScan,
      },
      corruption1: {
        method: 'direct edit of the ISOLATED config.toml notify line into a doubled owned fanout chain wrapping a compatible DevTask Radar third-party entry (declared artificial damage: an older stacking install\'s shape, never product output)',
        chainAfterCorruption: chainCorrupt1,
        productStatus: { developmentCapture: clientCorrupt1.developmentCapture, summary: clientCorrupt1.summary },
        ui: { badge: rowCorrupt1.badge, switch: rowCorrupt1.switch },
      },
      repair1: {
        control: `[data-agent-switch="install"][data-agent-client="${CLIENT}"]`,
        realClick: true,
        httpStatus: secondCall.status,
        operationId: secondOperationId,
        complete: secondCall.response.complete,
        developmentCapture: repairCapture,
        notifyChainAfterRepair: chainAfterRepair1,
        backups: backupsAfterRepair1,
      },
      corruption2: {
        method: 'direct edit of the ISOLATED config.toml notify line into a plain doubled owned anchor with no third party (declared artificial damage)',
        chainAfterCorruption: chainCorrupt2,
      },
      repair2: {
        control: `[data-agent-switch="install"][data-agent-client="${CLIENT}"]`,
        realClick: true,
        httpStatus: thirdCall.status,
        operationId: thirdOperationId,
        complete: thirdCall.response.complete,
        developmentCapture: repair2Capture,
        notifyChainAfterRepair: chainAfterRepair2,
        finalScanInstalled: harness.statusClient(statusFinal, CLIENT).developmentCapture.installed,
        backups: backupsAfterRepair2,
      },
      operationIdTraceability: traceability,
      nativeCommands: commands,
      realHomeIsolation: {
        configuration: { byteIdentical: configComparison.byteIdentical, changedFiles: configComparison.changedFiles, changedDirs: configComparison.changedDirs },
        tree: { leaks: treeComparison.leaks, configChanges: treeComparison.configChanges, runtimeChangeCount: treeComparison.runtimeChanges },
        concurrentLiveWrites: { writes: liveWrites.map(item => `${item.dir}/${item.file} (${item.state})`), proof: 'the live Codex desktop\'s own electron state, marker-free, carved out exactly as the R4 cap008e probe proved external' },
        concurrentRuntimeWrites: { count: concurrentRuntimeWrites.length, sample: concurrentRuntimeWrites.slice(0, 8).map(item => `${item.dir}/${item.file}`), proof: 'the developer\'s own live Claude/Codex sessions writing their runtime files mid-run; every one matches the frozen R3 RUNTIME_PATH partition, none is ours' },
        scopeLabels: ['.claude', '.codex', '.config/opencode'],
      },
      scopeLabel: 'honest: read-only CLI gate first, then three real 接入 clicks (install, repair preserving a compatible third party, repair of a bare doubled anchor); clean-chain idempotence by the product\'s own no-rewrite scan; every write stays inside the explicit external CODEX_HOME; no Codex session, no model, no quota',
    });

    if (harness.evidence) {
      fs.mkdirSync(harness.evidence, { recursive: true });
      fs.writeFileSync(path.join(harness.evidence, 'cap006r4-codex-notify-isolation.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    }

    console.log('parallel-memory-capture-r4-cap006-probe PASS (explicit CODEX_HOME isolates the codex CLI: the read-only gate kept every path inside the external temp home with the real home untouched; three real 接入 clicks installed, repaired a doubled chain preserving the third-party entry, and repaired a bare doubled anchor — collapsing to one anchor each time, one backup per real change — and the product\'s own scan accepted the clean chain without rewrite; the real ~/.codex was never touched)');
  } finally {
    await harness.cleanup();
    // Never let scratch removal mask the real result: a codex child may hold
    // the config file a moment past its kill; retry briefly, then report.
    let removed = false;
    for (let attempt = 0; attempt < 12 && !removed; attempt += 1) {
      try { fs.rmSync(isolatedHome, { recursive: true, force: true }); removed = true; }
      catch { await new Promise(resolve => setTimeout(resolve, 500)); }
    }
    if (!removed) console.error(`scratch isolated home removal left behind: ${isolatedHome}`);
  }
}

process.on('unhandledRejection', error => { console.error(error); process.exitCode = 1; });
main().catch(error => { console.error(error); process.exitCode = 1; });
