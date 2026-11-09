#!/usr/bin/env node
'use strict';
// qa-autopilot/tools/product-probes/parallel-cap-acceptance-r14-cap002.js
//
// P-CAP-ACCEPTANCE-R14 — CAP-002 原生Claude采集.
//
//   steps:   隔离客户端HOME安装托管Hook，重开会话后外部开发。
//   expected: 仅新会话事件按真实Git目录归属。/ 不补捏历史。
//
// r3 cap shell: real product + real browser + REAL claude CLI integration
// (接入 click -> real plugin install + managed hooks in the isolated home).
// The development events are artificial protocol fixtures fired THROUGH the
// REAL installed shim (bridge-hook.cjs), exactly the cap008e honest scope:
// not real model chat, but the real capture chain.
//
//   * session s1 in real git repo A -> its events land in the journal
//     attributed to A's canonical workspace identity;
//   * session s2 in real git repo B -> attributed to B (distinct);
//   * a second turn on s1 (重开会话后继续开发) appends, never duplicates;
//   * a PRE-INSTALL session id that was never fired appears NOWHERE in the
//     journal — no history is fabricated or backfilled.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

const PKB_ROOT = path.resolve(__dirname, '..', '..', '..');
const { startCapHarness } = require(path.join(PKB_ROOT, '_site', '_test', 'helpers', 'parallel-memory-capture-r3-cap-shell'));

const ARTIFACTS = path.join(PKB_ROOT, 'qa-autopilot', 'artifacts', 'parallel-20261106', 'cap-acceptance-r14');
const CLIENT = 'claude';

function gitRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), `# ${path.basename(dir)}\n`, 'utf8');
  const git = args => { const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout; };
  git(['init', '-q', '-b', 'main']); git(['config', 'user.email', 'r14@example.invalid']); git(['config', 'user.name', 'r14']);
  git(['add', 'README.md']); git(['commit', '-q', '-m', 'baseline']);
  return dir;
}

function readJournalLines(bridgeHomeDir) {
  const lines = [];
  const walk = dir => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (/\.jsonl$/i.test(entry.name)) {
        for (const line of fs.readFileSync(p, 'utf8').split('\n')) if (line.trim()) { try { lines.push(JSON.parse(line)); } catch { /* skip */ } }
      }
    }
  };
  walk(bridgeHomeDir);
  return lines;
}

async function main() {
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  const evidence = { schema: 'qa-autopilot/cap-acceptance-evidence/v1', lane: 'P-CAP-ACCEPTANCE-R14', case: 'CAP-002', startedAt: new Date().toISOString(), steps: [], expectations: [], firstFailure: null };
  let harness = null;
  try {
    harness = await startCapHarness({ tag: 'cap-r14', evidenceDir: ARTIFACTS });
    console.log(`[r14] harness up home=${harness.homeDir}`);

    // ---- real 接入 through the real UI -------------------------------
    await harness.openSystemDrawer();
    await harness.nativeClick(`[data-agent-switch="install"][data-agent-client="${CLIENT}"]`);
    await harness.waitFor(() => harness.run("document.getElementById('agentCaptureFeedback').textContent.trim().length > 0 && !document.getElementById('agentCaptureFeedback').textContent.includes('正在接入')"), 'install settled', 120000);
    const status = await harness.settledStatus();
    const claude = harness.statusClient(status, CLIENT);
    assert.ok(claude && claude.developmentCapture && claude.developmentCapture.installed === true, `claude capture installed: ${JSON.stringify(claude && claude.developmentCapture)}`);

    // The managed hook command (real installed shim path).
    const settings = JSON.parse(fs.readFileSync(path.join(harness.homeDir, '.claude', 'settings.json'), 'utf8'));
    const command = (settings.hooks.UserPromptSubmit || []).flatMap(g => g.hooks || []).map(h => h.command).find(c => /bridge-hook\.cjs/i.test(c));
    assert.ok(command, 'the managed bridge hook is installed');
    const shimPath = command.match(/"([^"]*bridge-hook\.cjs)"/i)[1];
    const bridgeHomeDir = path.dirname(path.dirname(shimPath));
    evidence.steps.push({ step: 'installed', shimPath });

    // ---- two REAL git workspaces ------------------------------------
    const repoA = gitRepo(path.join(harness.fixture || harness.tempRoot, 'repo-a'));
    const repoB = gitRepo(path.join(harness.fixture || harness.tempRoot, 'repo-b'));
    const workspaceIdOf = repo => {
      const top = spawnSync('git', ['-C', repo, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', windowsHide: true }).stdout.trim();
      return top.replace(/\\/g, '/').toLowerCase();
    };
    const idA = workspaceIdOf(repoA), idB = workspaceIdOf(repoB);
    assert.notEqual(idA, idB, 'two distinct real git directories');

    const fire = (sessionId, cwd, prompt, event = 'UserPromptSubmit') => {
      const fixture = { session_id: sessionId, transcript_path: '', cwd, hook_event_name: event, prompt };
      const r = spawnSync(process.execPath, [shimPath, '--source', 'claude'], { input: JSON.stringify(fixture), encoding: 'utf8', windowsHide: true, timeout: 30000 });
      if (r.status !== 0) throw new Error(`shim fire failed (${event}/${sessionId}): ${String(r.stderr || '').slice(0, 200)}`);
    };
    const sleep = ms => new Promise(r => setTimeout(r, ms));

    // s1 in A: two turns (重开会话后外部开发 — the session reopens and continues).
    fire('r14-s1', repoA, 'R14-S1-TURN-1 marker one');
    fire('r14-s1', repoA, 'R14-S1-TURN-2 marker two', 'Stop');
    fire('r14-s1', repoA, 'R14-S1-TURN-3 marker three');
    // s2 in B: one turn.
    fire('r14-s2', repoB, 'R14-S2-TURN-1 marker beta');
    await sleep(2500);

    const events = readJournalLines(bridgeHomeDir);
    const norm = value => String(value || '').replace(/\\/g, '/').toLowerCase();
    const s1 = events.filter(e => String(e.sessionId || '') === 'r14-s1');
    const s2 = events.filter(e => String(e.sessionId || '') === 'r14-s2');
    const s0 = events.filter(e => JSON.stringify(e).toLowerCase().includes('r14-s0-preinstall'));
    // Attribution: every event carries repoIdentity with the real workspace
    // root — match it against the fired directory (exact identity).
    const rootOf = e => norm(e.repoIdentity && e.repoIdentity.workspaceRoot || e.projectPath);
    const s1Attr = s1.length >= 2 && s1.every(e => rootOf(e) === idA && e.repoIdentity && e.repoIdentity.workspaceId && e.identityConfidence === 'exact');
    const s2Attr = s2.length >= 1 && s2.every(e => rootOf(e) === idB && e.repoIdentity && e.repoIdentity.workspaceId);
    const promptTurns = s1.filter(e => e.eventType === 'user_prompt' && /R14-S1-TURN-[13]/.test(String(e.content || '')));
    const workspaceIds = new Set([...s1, ...s2].map(e => e.repoIdentity && e.repoIdentity.workspaceId));

    evidence.steps.push({ step: 'journal-summary', total: events.length, s1: s1.length, s2: s2.length, sample: s1.slice(0, 2) });
    evidence.expectations.push({
      key: 'new-session-events-attributed-to-real-git-dirs',
      pass: s1.length >= 2 && s2.length >= 1 && s1Attr && s2Attr && workspaceIds.size === 2,
      observed: { s1Events: s1.length, s2Events: s2.length, s1Attr, s2Attr, distinctWorkspaceIds: workspaceIds.size, idA, idB },
    });
    evidence.expectations.push({
      key: 'no-fabricated-history',
      pass: s0.length === 0 && promptTurns.length === 2 && new Set(promptTurns.map(e => e.content)).size === 2,
      observed: { preInstallSessionEvents: s0.length, s1PromptTurns: promptTurns.length, note: 'only the fired turns exist (2 distinct prompts + the stop); the pre-install session appears nowhere; no duplicate/backfilled turns' },
    });
    evidence.finishedAt = new Date().toISOString();
    evidence.verdict = evidence.expectations.every(item => item.pass) ? 'PASS' : 'FAIL';
    fs.writeFileSync(path.join(ARTIFACTS, 'cap-002.json'), JSON.stringify(evidence, null, 2));
    console.log(`[r14] CAP-002 ${evidence.verdict}`);
    process.exitCode = evidence.verdict === 'PASS' ? 0 : 1;
  } catch (error) {
    evidence.firstFailure = String(error && error.stack || error);
    evidence.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(ARTIFACTS, 'cap-002.json'), JSON.stringify(evidence, null, 2));
    console.error(`[r14] FATAL ${evidence.firstFailure}`);
    process.exitCode = 1;
  } finally {
    if (harness) { try { await harness.cleanup(); } catch { /* best effort */ } }
  }
}

main().catch(error => { console.error(String(error && error.stack || error)); process.exit(1); });
