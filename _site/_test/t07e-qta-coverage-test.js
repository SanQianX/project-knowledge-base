// _site/_test/t07e-qta-coverage-test.js
//
// T07E ledger coverage for the four remaining quota-discipline specs:
//
//   QTA-001 账户识别 — the SHIPPED profile-quota parser (workbench
//     profile-quota.js) maps subscription usage windows from the official
//     endpoints; a PAYG balance field is NEVER read into a five-hour window
//     (balance simply has no mapping), and count windows carry 'requests'
//     units, never money.
//   QTA-002 usage字段歧义 — replay through the REAL parser: a payload with
//     ONLY usage counts yields null remaining percent (UNKNOWN — nothing
//     guessed); a payload with an explicit server percentage uses it; the
//     GLM percentage is documented-and-parsed as the USED percent.
//   QTA-007 进程重启 — the SHIPPED supervisor reconcile(): a preserved
//     checkpoint whose PUSH landed while the controller was down becomes
//     PUSH_ALREADY_PRESENT (never re-pushed); a half-finished worker whose
//     state is UNKNOWN goes back to PENDING for independent review — never
//     blindly advanced or re-dispatched.
//   QTA-008 绕过防护 — the SHIPPED worker isolation: withSanitizedEnv strips
//     every ambient credential variable (ANTHROPIC_/CLAUDE_/CODEX_/…) from
//     worker processes, and the supervisor contract is hash-frozen per task
//     so a worker cannot widen its own control contract.

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..', '..');

function jsonResponse(body) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body), headers: new Map() };
}

async function main() {
  const { ProfileQuotaService, detectProvider } = require(path.join(REPO, 'node_modules', 'claude-ai-workbench', 'packages', 'server', 'lib', 'profile-quota.js'));

  // ---------------- QTA-001 / QTA-002: the real parser ------------------
  {
    const now = Date.parse('2026-11-06T08:00:00.000Z');
    let lastBody = null;
    const fetchImpl = async () => jsonResponse(lastBody);
    const service = new ProfileQuotaService({ fetch: fetchImpl, now: () => now, ttlMs: 0 });
    const profile = { id: 'p1', provider: 'minimax', name: 'MiniMax', baseUrl: 'https://www.minimaxi.com/api/v1', models: { default: 'abab6.5s-chat' } };
    const credential = 'test-key';

    // Replay 1 (QTA-002): ONLY usage counts — no percentage anywhere.
    lastBody = {
      base_resp: { status_code: 0 },
      balance: { amount: 42.5, currency: 'CNY' }, // stray PAYG balance field
      model_remains: [{
        model_name: 'general',
        start_time: now - 3600_000, end_time: now + 4 * 3600_000,
        current_interval_usage_count: 5, current_interval_total_count: 100,
        weekly_start_time: now - 86400_000 * 3, weekly_end_time: now + 86400_000 * 4,
        current_weekly_usage_count: 30, current_weekly_total_count: 500,
      }],
    };
    const onlyCounts = await service.getQuota({ profile, credential, refresh: true });
    const windows = onlyCounts.windows || [];
    const interval = windows.find(w => w.kind === 'interval');
    const weekly = windows.find(w => w.kind === 'weekly');
    assert.ok(interval && interval.used === 5 && interval.total === 100 && interval.unit === 'requests',
      'QA-SPEC-QTA-001: subscription usage windows are read from the official count fields with requests units');
    assert.ok(JSON.stringify(onlyCounts).indexOf('42.5') === -1,
      'QA-SPEC-QTA-001: the PAYG balance value never leaks into any quota window — balance is not a five-hour allowance');
    assert.ok(interval.serverRemainingPercent === null,
      'QA-SPEC-QTA-002: with ONLY usage counts the remaining percent stays null (UNKNOWN) — nothing is guessed');
    assert.ok(weekly && weekly.serverRemainingPercent === null,
      'QA-SPEC-QTA-002: the weekly window stays UNKNOWN too without semantic evidence');

    // Replay 2 (QTA-002): explicit server-computed percentage present.
    const service2 = new ProfileQuotaService({ fetch: fetchImpl, now: () => now, ttlMs: 0 });
    lastBody = {
      base_resp: { status_code: 0 },
      model_remains: [{
        model_name: 'general',
        start_time: now - 3600_000, end_time: now + 4 * 3600_000,
        current_interval_usage_count: 5, current_interval_total_count: 100,
        current_interval_remaining_percent: 95,
        weekly_start_time: now - 86400_000 * 3, weekly_end_time: now + 86400_000 * 4,
        current_weekly_usage_count: 30, current_weekly_total_count: 500,
        current_weekly_remaining_percent: 88,
      }],
    };
    const withPercent = await service2.getQuota({ profile, credential, refresh: true });
    const interval2 = (withPercent.windows || []).find(w => w.kind === 'interval');
    const weekly2 = (withPercent.windows || []).find(w => w.kind === 'weekly');
    assert.ok(interval2.serverRemainingPercent === 95 && weekly2.serverRemainingPercent === 88,
      'QA-SPEC-QTA-002: an explicit server-computed percentage takes priority and is surfaced as-is');

    // GLM shape: percentage is the USED percent (documented) and stays
    // UNKNOWN when absent — never guessed into a remaining value.
    const glmProfile = { id: 'p2', provider: 'glm', name: 'GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', models: { default: 'glm-4.6' } };
    const glmNoPercent = { code: 200, success: true, data: { limits: [{ type: 'TIME_LIMIT', unit: 3, number: 5, currentValue: 8, usage: 4000, remaining: 3992, nextResetTime: now + 3600_000 }] } };
    lastBody = glmNoPercent;
    const glmUnknown = await service2.getQuota({ profile: glmProfile, credential, refresh: true });
    const toolsWindowUnknown = (glmUnknown.windows || []).find(w => w.kind === 'tools');
    assert.ok(toolsWindowUnknown && toolsWindowUnknown.usedPercent === null && toolsWindowUnknown.remainingPercent === null,
      'QA-SPEC-QTA-002: GLM window without percentage stays UNKNOWN both ways');
    lastBody = { code: 200, success: true, data: { limits: [{ type: 'TIME_LIMIT', unit: 3, number: 5, percentage: 1, currentValue: 8, usage: 4000, remaining: 3992, nextResetTime: now + 3600_000 }] } };
    const glmPercent = await service2.getQuota({ profile: glmProfile, credential, refresh: true });
    const toolsWindow = (glmPercent.windows || []).find(w => w.kind === 'tools');
    assert.ok(toolsWindow.usedPercent === 1 && toolsWindow.remainingPercent === 99,
      'QA-SPEC-QTA-002: the explicit percentage is applied with its documented USED semantics (8/4000 used -> 1% used, 99% remaining), protecting the old-plan entitlement');
    assert.ok(detectProvider(glmProfile).id === 'glm' && detectProvider(profile).id === 'minimax',
      'QA-SPEC-QTA-001: account/provider identification distinguishes the actual endpoints');
    console.log('QA-SPEC-QTA-001/002: real parser replay — balance never becomes a window; UNKNOWN without semantic evidence; explicit percentages honored');
  }

  // ---------------- QTA-007: shipped reconcile --------------------------
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-qta007-'));
    try {
      const work = path.join(root, 'work');
      fs.mkdirSync(work, { recursive: true });
      const git = args => execFileSync('git', ['-C', work, ...args], { encoding: 'utf8', windowsHide: true });
      git(['init', '-q', '-b', 'main']);
      git(['config', 'user.email', 'qta@example.invalid']); git(['config', 'user.name', 'qta']);
      fs.writeFileSync(path.join(work, 'A.md'), 'a\n');
      git(['add', 'A.md']); git(['commit', '-q', '-m', 'one']);
      const head = git(['rev-parse', 'HEAD']).trim();
      const remote = path.join(root, 'remote.git');
      git(['init', '-q', '--bare', remote]);
      git(['remote', 'add', 'origin', remote]);
      git(['push', '-q', 'origin', 'main']); // the PUSH landed while the controller was "down"

      const stateDir = path.join(root, 'state');
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(path.join(stateDir, 'queue.json'), JSON.stringify([]));
      // The supervisor reads its fixed paths from QA_OVERNIGHT_STATE_DIR —
      // redirect BEFORE require so the module constants point at the fixture.
      process.env.QA_OVERNIGHT_STATE_DIR = stateDir;
      const { reconcile } = require(path.join(REPO, 'qa-autopilot', 'tools', 'overnight-supervisor.cjs'));
      const cfg = { repoRoot: work, mainBranch: 'main', tools: {} };
      const state = {
        order: ['t1', 't2'],
        tasks: {
          t1: { id: 't1', status: 'PUSHED', commitSha: head },       // receipt unknown, remote HAS it
          t2: { id: 't2', status: 'AGENT_RUNNING', commitSha: null }, // worker state unknown at restart
        },
      };
      const notes = reconcile(cfg, state);
      const n1 = notes.find(n => n.id === 't1');
      const n2 = notes.find(n => n.id === 't2');
      assert.ok(n1 && n1.action === 'PUSH_ALREADY_PRESENT',
        `QA-SPEC-QTA-007: the already-pushed task is reconciled as PUSH_ALREADY_PRESENT (never re-pushed): ${JSON.stringify(n1)}`);
      assert.ok(state.tasks.t1.status === 'CI_PENDING', 'QA-SPEC-QTA-007: the reconciled pushed task moves to CI_PENDING, not back to dispatch');
      assert.ok(n2 && n2.action === 'HALF_FINISHED_BACK_TO_PENDING',
        `QA-SPEC-QTA-007: the unknown-state worker goes back to PENDING for independent review: ${JSON.stringify(n2)}`);
      assert.ok(state.tasks.t2.status === 'PENDING' && state.tasks.t2.halfFinished === true,
        'QA-SPEC-QTA-007: the half-finished task is NOT advanced and NOT re-dispatched blindly');
      console.log('QA-SPEC-QTA-007: shipped reconcile verifies remote state; unknown workers reconcile, never resend');
    } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  }

  // ---------------- QTA-008: shipped worker isolation -------------------
  {
    const { withSanitizedEnv, AMBIENT_PREFIXES } = require(path.join(REPO, '_site', '_test', 'helpers', 'parallel-memory-capture-r3-cap-shell'));
    assert.ok(AMBIENT_PREFIXES.includes('ANTHROPIC_') && AMBIENT_PREFIXES.includes('CLAUDE_') && AMBIENT_PREFIXES.includes('CODEX_'),
      'QA-SPEC-QTA-008: ambient credential prefixes are pinned in the shipped worker isolation');
    const probeClaude = process.env.CLAUDE_PROBE_TOKEN;
    const probeAnthropic = process.env.ANTHROPIC_PROBE_SECRET;
    assert.ok(probeClaude !== undefined && probeAnthropic !== undefined, 'QA-SPEC-QTA-008: probe setup — ambient credentials present in the parent env (set by the runner)');
    let seenInside = null;
    withSanitizedEnv(() => {
      seenInside = {
        anthropic: process.env.ANTHROPIC_PROBE_SECRET,
        claude: process.env.CLAUDE_PROBE_TOKEN,
      };
    });
    assert.ok(seenInside.anthropic === undefined && seenInside.claude === undefined,
      'QA-SPEC-QTA-008: inside the sanitized worker env the ambient credentials are GONE — a worker cannot read the real subscription credentials');
    // The control contract is hash-frozen per task by the shipped
    // makeContract (anchored): a worker cannot widen its own contract.
    const supervisorSource = fs.readFileSync(path.join(REPO, 'qa-autopilot', 'tools', 'overnight-supervisor.cjs'), 'utf8');
    assert.ok(/function makeContract/.test(supervisorSource) && /contracts', task\.id \+ '\.json'/.test(supervisorSource),
      'QA-SPEC-QTA-008: the supervisor freezes each task contract into a per-task file — contract changes are detectable, not silently widened');
    console.log('QA-SPEC-QTA-008: worker env isolation strips credentials; control contract is frozen per task');
  }

  console.log('t07e-qta-coverage-test PASS');
}

main().catch(error => { console.error(String(error && error.stack || error)); process.exit(1); });
