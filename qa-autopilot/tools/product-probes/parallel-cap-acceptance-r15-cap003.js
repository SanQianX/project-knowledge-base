#!/usr/bin/env node
'use strict';
// qa-autopilot/tools/product-probes/parallel-cap-acceptance-r15-cap003.js
//
// P-CAP-ACCEPTANCE-R15 — CAP-003 原生Codex采集.
//
//   steps:   隔离Codex配置与notify链，执行开发并检查记录。
//   expected: 保留第三方notify和用户信任。/ 拒绝自动写trust。
//
// r3 cap shell: real product + real browser + the real codex integration
// path. The pre-existing third-party notify is a DevTask-Radar-shaped entry
// (the compatible shape the shipped planner wraps, never removes); the
// development event is an artificial protocol fixture fired THROUGH the REAL
// installed fanout (cap008e honest scope).
//
//   * after the real 接入 click: the managed fanout wraps the chain WITH the
//     third-party entry preserved verbatim inside --next-base64;
//   * the user's auth.json is byte-identical and trust.toml is NEVER created
//     by the product (the shipped states are waiting-trust / conflict — the
//     product refuses to write trust itself);
//   * firing the real fanout with a codex turn-ended fixture lands a journal
//     event attributed to the real git directory.

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

const PKB_ROOT = path.resolve(__dirname, '..', '..', '..');
const { startCapHarness } = require(path.join(PKB_ROOT, '_site', '_test', 'helpers', 'parallel-memory-capture-r3-cap-shell'));

const ARTIFACTS = path.join(PKB_ROOT, 'qa-autopilot', 'artifacts', 'parallel-20261106', 'cap-acceptance-r15');
const CLIENT = 'codex';
const RADAR_JS = 'C:/Tools/DevTask Radar/connectors/codex/notify-hook.js';

function readJournalLines(bridgeHomeDir) {
  const lines = [];
  const walk = dir => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (/\.jsonl$/i.test(entry.name)) for (const line of fs.readFileSync(p, 'utf8').split('\n')) if (line.trim()) { try { lines.push(JSON.parse(line)); } catch { /* skip */ } }
    }
  };
  walk(bridgeHomeDir);
  return lines;
}

async function main() {
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  const evidence = { schema: 'qa-autopilot/cap-acceptance-evidence/v1', lane: 'P-CAP-ACCEPTANCE-R15', case: 'CAP-003', startedAt: new Date().toISOString(), steps: [], expectations: [], firstFailure: null };
  let harness = null;
  try {
    harness = await startCapHarness({ tag: 'cap-r15', evidenceDir: ARTIFACTS });
    const codexDir = path.join(harness.homeDir, '.codex');
    fs.mkdirSync(codexDir, { recursive: true });
    // Pre-existing USER state: a compatible third-party notify + the user's
    // own auth file. Both declared artificial fixture content.
    fs.writeFileSync(path.join(codexDir, 'config.toml'), `notify = ["node", "${RADAR_JS.replace(/"/g, '\\"')}"]\n`, 'utf8');
    const authContent = JSON.stringify({ token: 'user-own-fixture-token' }, null, 2) + '\n';
    fs.writeFileSync(path.join(codexDir, 'auth.json'), authContent, 'utf8');
    const trustFile = path.join(codexDir, 'trust.toml');
    console.log(`[r15] harness up`);

    // ---- real 接入 on the codex row -----------------------------------
    await harness.openSystemDrawer();
    await harness.nativeClick(`[data-agent-switch="install"][data-agent-client="${CLIENT}"]`);
    await harness.waitFor(() => harness.run("document.getElementById('agentCaptureFeedback').textContent.trim().length > 0 && !document.getElementById('agentCaptureFeedback').textContent.includes('正在接入')"), 'install settled', 180000);
    const status = await harness.settledStatus();
    const codex = harness.statusClient(status, CLIENT);
    evidence.steps.push({ step: 'install-status', developmentCapture: codex && codex.developmentCapture, knowledgeIntegration: codex && codex.knowledgeIntegration && { state: codex.knowledgeIntegration.state } });

    const configAfter = fs.readFileSync(path.join(codexDir, 'config.toml'), 'utf8');
    const authAfter = fs.readFileSync(path.join(codexDir, 'auth.json'), 'utf8');
    // The chain must now carry the managed fanout WITH the third-party
    // preserved verbatim inside --next-base64.
    const notifyLine = configAfter.split('\n').find(l => l.startsWith('notify')) || '';
    const b64 = (notifyLine.match(/--next-base64",\s*"([A-Za-z0-9+/=]+)"/) || notifyLine.match(/--next-base64", "([A-Za-z0-9+/=]+)"/) || [])[1];
    let decodedNext = null;
    try { decodedNext = b64 ? JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) : null; } catch { decodedNext = null; }
    const thirdPartyPreserved = Boolean(decodedNext) && Array.isArray(decodedNext) && decodedNext[1] && decodedNext[1].toLowerCase().replace(/\\/g, '/').includes('devtask radar/connectors/codex/notify-hook.js');
    const fanoutInstalled = /codex-notify-fanout\.cjs/i.test(notifyLine);
    const authUntouched = authAfter === authContent;
    const trustNeverWritten = !fs.existsSync(trustFile);

    // ---- fire the REAL installed fanout with a codex fixture ----------
    const repo = path.join(harness.fixture || harness.tempRoot, 'repo');
    fs.mkdirSync(repo, { recursive: true });
    {
      const git = args => { const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout; };
      git(['init', '-q', '-b', 'main']); git(['config', 'user.email', 'r15@example.invalid']); git(['config', 'user.name', 'r15']);
      fs.writeFileSync(path.join(repo, 'README.md'), 'r15\n', 'utf8'); git(['add', 'README.md']); git(['commit', '-q', '-m', 'baseline']);
    }
    const fanoutMatch = notifyLine.match(/"([^"]*codex-notify-fanout\.cjs)"/i);
    let captured = false;
    let sample = null;
    let bridgeHomeDir = null;
    if (fanoutMatch) {
      // The authoritative source: a real-shaped Codex rollout file under the
      // ISOLATED CODEX_HOME (the notify payload only wakes the reader).
      const sessionsRoot = path.join(codexDir, 'sessions', '2026', '11', '09');
      fs.mkdirSync(sessionsRoot, { recursive: true });
      const rolloutFile = path.join(sessionsRoot, 'rollout-2026-11-09T02-00-00-r15-thread-1.jsonl');
      fs.writeFileSync(rolloutFile, [
        JSON.stringify({ type: 'session_meta', payload: { cwd: repo } }),
        JSON.stringify({ type: 'response_item', payload: { role: 'user', turn_id: 'r15-turn-1', content: [{ type: 'input_text', text: 'R15-CAP003-FIXTURE marker from the rollout' }] } }),
      ].join('\n') + '\n', 'utf8');
      evidence.steps.push({ step: 'rollout-fixture-written', rolloutFile });
      // Locate the lane bridge home (contains bin/bridge-hook.cjs).
      const findBridgeHome = root => {
        let found = null;
        const walk = dir => {
          if (found || !fs.existsSync(dir)) return;
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, entry.name);
            if (entry.isDirectory() && entry.name !== 'repo') walk(p);
            else if (entry.name === 'bridge-hook.cjs') { found = path.dirname(path.dirname(p)); return; }
          }
        };
        walk(root);
        return found;
      };
      bridgeHomeDir = findBridgeHome(harness.tempRoot);
      // Rebuild the exact argv from the notify array.
      const argv = JSON.parse(configAfter.split('\n').filter(l => l.startsWith('notify')).map(l => l.slice(l.indexOf('['), l.lastIndexOf(']') + 1)).join(''));
      const payload = JSON.stringify({ type: 'turn-ended', 'turn-abort': false, 'thread-id': 'r15-thread-1', 'turn-id': 'r15-turn-1', cwd: repo, id: 'r15-fixture-turn' });
      const fired = spawnSync(argv[0], argv.slice(1), {
        input: payload, encoding: 'utf8', windowsHide: true, timeout: 30000,
        env: { ...process.env, CODEX_HOME: codexDir, AI_CODING_EVENT_BRIDGE_HOME: bridgeHomeDir || undefined },
      });
      evidence.steps.push({ step: 'fanout-fired', exit: fired.status, stderr: String(fired.stderr || '').slice(0, 160) });
      await new Promise(r => setTimeout(r, 3500));
      // Robust journal discovery: scan every lane bridge-shaped root under
      // the temp root (TOML escaping makes argv decoding fragile).
      const tempRoot = harness.tempRoot;
      const markerHit = [];
      const walk = dir => {
        if (!fs.existsSync(dir)) return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const p2 = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(p2);
          else if (/\.jsonl$/i.test(entry.name)) {
            try {
              for (const line of fs.readFileSync(p2, 'utf8').split('\n')) {
                if (line.includes('R15-CAP003-FIXTURE')) { try { markerHit.push(JSON.parse(line)); } catch { markerHit.push({ raw: line.slice(0, 200) }); } }
              }
            } catch { /* binary */ }
          }
        }
      };
      walk(tempRoot);
      const hit = markerHit[0] || null;
      captured = Boolean(hit);
      sample = hit ? { sessionId: hit.sessionId, projectPath: hit.projectPath, repoIdentity: Boolean(hit.repoIdentity) } : null;
    }

    evidence.expectations.push({
      key: 'third-party-notify-and-user-trust-preserved',
      pass: fanoutInstalled && thirdPartyPreserved && authUntouched,
      observed: { fanoutInstalled, thirdPartyPreserved, decodedNext, authUntouched },
    });
    evidence.expectations.push({
      key: 'refuses-to-auto-write-trust',
      pass: trustNeverWritten,
      observed: { trustNeverWritten, note: 'the shipped states are waiting-trust/conflict — the product itself never writes trust; verified on the filesystem after the real install' },
    });
    evidence.expectations.push({
      key: 'fired-development-recorded',
      pass: captured && sample && String(sample.projectPath || '').toLowerCase().replace(/\\/g, '/').includes('repo'),
      observed: { captured, sample },
    });
    evidence.finishedAt = new Date().toISOString();
    evidence.verdict = evidence.expectations.every(item => item.pass) ? 'PASS' : 'FAIL';
    fs.writeFileSync(path.join(ARTIFACTS, 'cap-003.json'), JSON.stringify(evidence, null, 2));
    console.log(`[r15] CAP-003 ${evidence.verdict}`);
    process.exitCode = evidence.verdict === 'PASS' ? 0 : 1;
  } catch (error) {
    evidence.firstFailure = String(error && error.stack || error);
    evidence.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(ARTIFACTS, 'cap-003.json'), JSON.stringify(evidence, null, 2));
    console.error(`[r15] FATAL ${evidence.firstFailure}`);
    process.exitCode = 1;
  } finally {
    if (harness) { try { await harness.cleanup(); } catch { /* best effort */ } }
  }
}

main().catch(error => { console.error(String(error && error.stack || error)); process.exit(1); });
