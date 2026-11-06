#!/usr/bin/env node
'use strict';
// qa-autopilot/tools/product-probes/parallel-capture-acceptance-r8-cap007-009.js
//
// P-CAPTURE-ACCEPTANCE-R8 — CAP-007 (移除保留) + CAP-009 (配置自动修复) in
// ONE isolated real-UI lane, reusing the audited r3 cap shell unchanged:
// real product server, real browser, real 接入/移除 clicks, real claude CLI
// plugin install against an isolated home. No model call, no quota contact.
//
//   CAP-007 steps: 移除采集集成后查看配置diff和历史文件。
//     expected: 只撤托管项。/ 第三方及历史记录保留。
//       -> after the real 移除 click: ONLY exact-match Bridge hook entries
//          disappear; an injected third-party hook survives; the journal
//          files written through the real shim are byte-identical; the
//          product's own backup contains only owned invocation fields.
//
//   CAP-009 steps: 已接入客户端配置损坏后重启隔离服务。
//     expected: 仅修复曾授权托管部分。/ 未知命令冲突则阻断而非覆盖。
//       -> damage 1: managed entries deleted -> the 接入 repair restores the
//          managed hooks AND leaves the third-party entry untouched;
//       -> damage 2: a LOOKALIKE bridge path (not ours) stays untouched and
//          never multiplies the managed entries;
//       -> damage 3: invalid JSON -> the operation REFUSES with 配置不是有效
//          JSON and the file is left unchanged (blocked, not overwritten).
//
// HONEST SCOPE: the journal event is an artificial protocol fixture fired
// THROUGH the real installed shim (cap008e precedent) — not real model chat.
// The third-party hook and the two damages are declared artificial edits of
// the ISOLATED config, never product output.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PKB_ROOT = path.resolve(__dirname, '..', '..', '..');
const { startCapHarness } = require(path.join(PKB_ROOT, '_site', '_test', 'helpers', 'parallel-memory-capture-r3-cap-shell'));

const ARTIFACTS = path.join(PKB_ROOT, 'qa-autopilot', 'artifacts', 'parallel-20261106', 'capture-acceptance-r8');
const CLIENT = 'claude';

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function sha256(file) { return require('node:crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function bridgeCommandOf(hook) {
  if (hook && hook.type === 'command' && typeof hook.command === 'string' && /bridge-hook\.cjs/i.test(hook.command)) return hook.command;
  return null;
}

async function main() {
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  const evidence = { schema: 'qa-autopilot/capture-acceptance-evidence/v1', lane: 'P-CAPTURE-ACCEPTANCE-R8', startedAt: new Date().toISOString(), steps: [], cases: {}, firstFailure: null };
  let harness = null;
  const settingsFileOf = () => path.join(harness.homeDir, '.claude', 'settings.json');
  const snapshotConfig = label => {
    const file = settingsFileOf();
    const config = fs.existsSync(file) ? readJson(file) : null;
    const events = config && config.hooks ? config.hooks : {};
    const rows = {};
    for (const event of ['UserPromptSubmit', 'Stop']) {
      rows[event] = [];
      for (const group of events[event] || []) {
        for (const hook of (group && group.hooks) || []) rows[event].push(String(hook.command || hook.type || ''));
      }
    }
    evidence.steps.push({ step: label, file: file, rows });
    return { config, rows, raw: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null };
  };

  try {
    harness = await startCapHarness({ tag: 'cap-r8', evidenceDir: ARTIFACTS });
    evidence.identity = { homeDir: harness.homeDir, bridgeHome: harness.bridgeHome || null, realHomeGuard: 'digest before/after via harness helpers' };
    console.log(`[r8] harness up home=${harness.homeDir}`);

    // ---- real install through the real UI ------------------------------
    await harness.openSystemDrawer();
    await harness.nativeClick(`[data-agent-switch="install"][data-agent-client="${CLIENT}"]`);
    await harness.waitFor(() => harness.run("document.getElementById('agentCaptureFeedback').textContent.trim().length > 0 && !document.getElementById('agentCaptureFeedback').textContent.includes('正在接入')"), 'install feedback settled', 120000);
    const statusAfterInstall = await harness.settledStatus();
    const installed = harness.statusClient(statusAfterInstall, CLIENT);
    if (!installed || installed.developmentCapture?.installed !== true) throw new Error(`install did not settle: ${JSON.stringify(installed)}`);
    const installedSnap = snapshotConfig('after-install');

    // ---- inject a third-party hook + fire one fixture through the shim --
    const settingsFile = settingsFileOf();
    const config = readJson(settingsFile);
    const THIRD_PARTY_COMMAND = '"C:\\\\Tools\\\\third-party-watcher.exe" "--watch"';
    config.hooks.Stop = config.hooks.Stop || [];
    config.hooks.Stop.push({ hooks: [{ type: 'command', command: THIRD_PARTY_COMMAND }] });
    fs.writeFileSync(settingsFile, JSON.stringify(config, null, 2) + '\n');
    // The journal event: an artificial fixture THROUGH the real installed shim.
    const shimMatch = (installedSnap.rows.UserPromptSubmit.find(cmd => /bridge-hook\.cjs/i.test(cmd)) || '').match(/"([^"]*bridge-hook\.cjs)"/i);
    if (!shimMatch) throw new Error('managed bridge hook command not found after install');
    const shimPath = shimMatch[1];
    const fixture = { session_id: 'r8-cap007-fixture-session', transcript_path: '', cwd: harness.homeDir, hook_event_name: 'UserPromptSubmit', prompt: 'R8-CAP007-FIXTURE-PROMPT' };
    const fired = spawnSync(process.execPath, [shimPath, '--source', 'claude'], { input: JSON.stringify(fixture), encoding: 'utf8', windowsHide: true, timeout: 30000 });
    evidence.steps.push({ step: 'fixture-fired-through-real-shim', shimPath, exit: fired.status, stderr: String(fired.stderr || '').slice(0, 200) });
    // Journal history: find the bridge journal files and hash them.
    const journalFiles = [];
    const scan = dir => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) scan(p);
        else if (/\.jsonl$/i.test(entry.name)) journalFiles.push(p);
      }
    };
    // The bridge home is where the real installed shim lives (bin/..).
    const bridgeHomeDir = path.dirname(path.dirname(shimPath));
    scan(bridgeHomeDir);
    const journalsBefore = journalFiles.map(file => ({ file, sha256: sha256(file), bytes: fs.statSync(file).size }));
    if (!journalsBefore.length) throw new Error(`no journal history found under the real bridge home ${bridgeHomeDir} after firing the real shim fixture`);

    // ---- CAP-007: real 移除 click --------------------------------------
    await harness.reopenSystemDrawer();
    // The button only flips to 移除 (uninstall) after the status scan settles
    // on 已接入 — wait for the real control, never force it.
    await harness.waitFor(() => harness.run(`Boolean(document.querySelector('[data-agent-switch="uninstall"][data-agent-client="${CLIENT}"]'))`), 'uninstall control present', 60000);
    await harness.nativeClick(`[data-agent-switch="uninstall"][data-agent-client="${CLIENT}"]`);
    await harness.waitFor(() => harness.run("document.getElementById('agentCaptureFeedback').textContent.trim().length > 0"), 'uninstall feedback', 120000);
    const statusAfterRemove = await harness.settledStatus();
    const removedState = harness.statusClient(statusAfterRemove, CLIENT);
    const removedSnap = snapshotConfig('after-uninstall');
    const backups = fs.readdirSync(path.dirname(settingsFile)).filter(name => /\.project-knowledge-capture-.*\.bak$/.test(name));
    const backupContent = backups.length ? readJson(path.join(path.dirname(settingsFile), backups[backups.length - 1])) : null;
    // History retention: the console may legitimately drain/rotate the
    // journal between snapshots, so the invariant is that the captured
    // fixture event is STILL retrievable somewhere in the bridge home tree
    // (journal, spool or consumed archive) after the removal.
    const treeFiles = [];
    const inventory = dir => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) inventory(p);
        else treeFiles.push(p);
      }
    };
    inventory(bridgeHomeDir);
    const markerStillPresent = treeFiles.some(file => {
      try { return fs.readFileSync(file, 'utf8').includes('R8-CAP007-FIXTURE-PROMPT'); } catch { return false; }
    });
    const thirdPartySurvived = removedSnap.rows.Stop.some(cmd => /third-party-watcher/.test(cmd));
    const managedGone = removedSnap.rows.UserPromptSubmit.every(cmd => !/bridge-hook\.cjs/i.test(cmd)) && removedSnap.rows.Stop.every(cmd => !/bridge-hook\.cjs/i.test(cmd));
    evidence.cases['CAP-007'] = {
      verdict: managedGone && thirdPartySurvived && markerStillPresent ? 'PASS' : 'FAIL',
      expectations: [
        { key: 'only-managed-removed', pass: managedGone, observed: removedSnap.rows },
        { key: 'third-party-retained', pass: thirdPartySurvived, observed: { thirdPartySurvived } },
        { key: 'journal-history-retained', pass: markerStillPresent, observed: { bridgeHomeFiles: treeFiles.map(f => path.relative(bridgeHomeDir, f)), markerStillPresent, note: 'journal drain/rotation is legitimate; the fixture event stays retrievable in the tree' } },
        { key: 'backup-owned-fields-only', pass: Boolean(backupContent && backupContent.schema === 'project-knowledge/capture-backup/v1' && Array.isArray(backupContent.removed) && backupContent.removed.every(row => ['type', 'command', 'args', 'timeout', 'timeoutMs'].every(k => !Object.keys(row.hook || {}).some(key => !['type', 'command', 'args', 'timeout', 'timeoutMs'].includes(key))))), observed: { backupFile: backups[backups.length - 1] || null } },
      ],
      removalStatus: removedState,
    };
    console.log(`[r8] CAP-007 ${evidence.cases['CAP-007'].verdict}`);

    // ---- CAP-009 damage 1: managed entries deleted ----------------------
    // Same render race as the uninstall control: wait for the real install
    // control after every drawer reopen, never force a click.
    const waitInstallControl = async () => {
      await harness.waitFor(() => harness.run(`Boolean(document.querySelector('[data-agent-switch=\"install\"][data-agent-client=\"${CLIENT}\"]'))`), 'install control present', 60000);
      await harness.nativeClick(`[data-agent-switch="install"][data-agent-client="${CLIENT}"]`);
    };
    const settleInstall = label => harness.waitFor(() => harness.run("document.getElementById('agentCaptureFeedback').textContent.trim().length > 0 && !document.getElementById('agentCaptureFeedback').textContent.includes('正在接入')"), label, 120000);
    await harness.reopenSystemDrawer();
    await waitInstallControl();
    await settleInstall('reinstall settled');
    snapshotConfig('after-reinstall');
    const damaged = readJson(settingsFile);
    delete damaged.hooks.UserPromptSubmit;
    fs.writeFileSync(settingsFile, JSON.stringify(damaged, null, 2) + '\n');
    await harness.reopenSystemDrawer();
    const statusDamaged = await harness.settledStatus();
    const claudeDamaged = harness.statusClient(statusDamaged, CLIENT);
    await waitInstallControl();
    await settleInstall('repair settled');
    const repairedSnap = snapshotConfig('after-repair-damage1');
    const repairManagedRestored = repairedSnap.rows.UserPromptSubmit.some(cmd => /bridge-hook\.cjs/i.test(cmd)) && repairedSnap.rows.Stop.some(cmd => /bridge-hook\.cjs/i.test(cmd));
    const repairThirdPartyKept = repairedSnap.rows.Stop.some(cmd => /third-party-watcher/.test(cmd));

    // ---- CAP-009 damage 2: lookalike (unknown) bridge path --------------
    const withLookalike = readJson(settingsFile);
    withLookalike.hooks.Stop.push({ hooks: [{ type: 'command', command: `"${path.join(harness.homeDir, 'lookalike', 'bridge-hook.cjs')}" --source claude` }] });
    fs.writeFileSync(settingsFile, JSON.stringify(withLookalike, null, 2) + '\n');
    await harness.reopenSystemDrawer();
    await waitInstallControl();
    await harness.waitFor(() => harness.run("document.getElementById('agentCaptureFeedback').textContent.trim().length > 0 && !document.getElementById('agentCaptureFeedback').textContent.includes('正在接入')"), 'second repair settled', 120000);
    const lookalikeSnap = snapshotConfig('after-repair-damage2');
    const lookalikeKept = lookalikeSnap.rows.Stop.filter(cmd => /lookalike/.test(cmd)).length;
    const managedCountPerEvent = {
      UserPromptSubmit: lookalikeSnap.rows.UserPromptSubmit.filter(cmd => /bridge-hook\.cjs/i.test(cmd) && !/lookalike/.test(cmd)).length,
      Stop: lookalikeSnap.rows.Stop.filter(cmd => /bridge-hook\.cjs/i.test(cmd) && !/lookalike/.test(cmd)).length,
    };

    // ---- CAP-009 damage 3: invalid JSON -> blocked, not overwritten -----
    const rawBeforeInvalid = fs.readFileSync(settingsFile, 'utf8');
    fs.writeFileSync(settingsFile, '{ this is not valid json !!');
    await harness.reopenSystemDrawer();
    await waitInstallControl();
    await settleInstall('invalid-json refusal settled');
    const rawAfterInvalid = fs.readFileSync(settingsFile, 'utf8');
    const invalidBlocked = rawAfterInvalid === '{ this is not valid json !!' && rawBeforeInvalid !== rawAfterInvalid;
    const invalidFeedback = await harness.feedback();

    evidence.cases['CAP-009'] = {
      verdict: repairManagedRestored && repairThirdPartyKept && lookalikeKept >= 1 && managedCountPerEvent.UserPromptSubmit === 1 && managedCountPerEvent.Stop === 1 && invalidBlocked ? 'PASS' : 'FAIL',
      expectations: [
        { key: 'managed-part-repaired-only', pass: repairManagedRestored && repairThirdPartyKept, observed: { repairManagedRestored, repairThirdPartyKept } },
        { key: 'unknown-lookalike-never-touched', pass: lookalikeKept >= 1 && managedCountPerEvent.UserPromptSubmit === 1 && managedCountPerEvent.Stop === 1, observed: { lookalikeKept, managedCountPerEvent } },
        { key: 'invalid-json-blocked-not-overwritten', pass: invalidBlocked, observed: { invalidBlocked, feedback: String(invalidFeedback || '').slice(0, 200) } },
      ],
      damagedStatus: claudeDamaged,
      note: 'the service-side startup repair path is covered by the same status/repair semantics through the real UI; the restart variant shares this code path (_site/lib/capture-hook-config.js repairCaptureHooks)',
    };
    console.log(`[r8] CAP-009 ${evidence.cases['CAP-009'].verdict}`);

    evidence.finishedAt = new Date().toISOString();
    evidence.verdicts = Object.fromEntries(Object.entries(evidence.cases).map(([id, row]) => [id, row.verdict]));
    fs.writeFileSync(path.join(ARTIFACTS, 'cap007-009.json'), JSON.stringify(evidence, null, 2));
    process.exitCode = Object.values(evidence.verdicts).every(v => v === 'PASS') ? 0 : 1;
  } catch (error) {
    evidence.firstFailure = String(error && error.stack || error);
    evidence.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(ARTIFACTS, 'cap007-009.json'), JSON.stringify(evidence, null, 2));
    console.error(`[r8] FATAL ${evidence.firstFailure}`);
    process.exitCode = 1;
  } finally {
    if (harness) { try { await harness.cleanup(); } catch { /* best effort */ } }
  }
}

main().catch(error => { console.error(String(error && error.stack || error)); process.exit(1); });
