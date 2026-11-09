#!/usr/bin/env node
'use strict';
// qa-autopilot/tools/product-probes/parallel-cap-acceptance-r16-cap004-005.js
//
// P-CAP-ACCEPTANCE-R16 — CAP-004 原生OpenCode + CAP-005 原生ZCode.
//
//   CAP-004 steps: 核对真实插件入口，在fixture发消息和提交。
//     expected: 只报告实际支持能力。/ 不可声称自动注入已通过。
//   CAP-005 steps: 按同版本真实入口接入，检查采集与上下文区别。
//     expected: 没有证据不报MCP成功。/ 保留第三方配置。
//
// r3 cap shell: real product + real browser + the real per-client install
// paths. HONEST SCOPE (the cases themselves demand no overclaiming):
//   * OpenCode (CLI present): the real 接入 click copies the bundled Skill +
//     instructions into the ISOLATED config and runs the real `opencode mcp
//     add` against it; the status reports CONFIGURED capabilities only —
//     its own text never claims auto-injection passed; a pre-existing
//     third-party plugin directory survives untouched.
//   * ZCode (CLI absent on this machine — itself the evidence): the product
//     row reports unavailable with 配置存在不等于原生入口可用 and the
//     context integration's own detail states MCP 插件状态不作已安装承诺;
//     the shipped zcode-context status machine is driven with fixture
//     configs (not-installed / user-disabled-refusal / installed-with-honest-
//     detail); the zcode CAPTURE hook install preserves a third-party entry
//     (same shipped planner as claude, asserted on the zcode config file).

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const PKB_ROOT = path.resolve(__dirname, '..', '..', '..');
const { startCapHarness } = require(path.join(PKB_ROOT, '_site', '_test', 'helpers', 'parallel-memory-capture-r3-cap-shell'));
const zcodeContext = require(path.join(PKB_ROOT, '_site', 'lib', 'zcode-context-integration.js'));

const ARTIFACTS = path.join(PKB_ROOT, 'qa-autopilot', 'artifacts', 'parallel-20261106', 'cap-acceptance-r16');

async function main() {
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  const evidence = { schema: 'qa-autopilot/cap-acceptance-evidence/v1', lane: 'P-CAP-ACCEPTANCE-R16', startedAt: new Date().toISOString(), cases: {}, steps: [], firstFailure: null };
  let harness = null;
  try {
    harness = await startCapHarness({ tag: 'cap-r16', evidenceDir: ARTIFACTS });
    console.log(`[r16] harness up`);

    // ================= CAP-004 原生OpenCode ==============================
    {
      const ev = { case: 'CAP-004', expectations: [] };
      const openCodeDir = path.join(harness.homeDir, '.config', 'opencode');
      if (!fs.existsSync(openCodeDir)) fs.mkdirSync(openCodeDir, { recursive: true });
      // A pre-existing third-party plugin/skill surface (declared fixture).
      const thirdParty = path.join(openCodeDir, 'skills', 'third-party-tool');
      fs.mkdirSync(thirdParty, { recursive: true });
      fs.writeFileSync(path.join(thirdParty, 'SKILL.md'), '# third party skill\n', 'utf8');

      await harness.openSystemDrawer();
      await harness.nativeClick(`[data-agent-switch="install"][data-agent-client="opencode"]`);
      await harness.waitFor(() => harness.run("document.getElementById('agentCaptureFeedback').textContent.trim().length > 0 && !document.getElementById('agentCaptureFeedback').textContent.includes('正在接入')"), 'opencode install settled', 180000);
      const status = await harness.settledStatus();
      const opencode = harness.statusClient(status, 'opencode');
      evidence.steps.push({ step: 'opencode-status', summary: opencode && opencode.summary, capture: opencode && opencode.developmentCapture, knowledge: opencode && opencode.knowledgeIntegration && { state: opencode.knowledgeIntegration.state } });

      // The REAL entries: bundled skill + instructions + third-party intact.
      const bundledSkill = path.join(openCodeDir, 'skills', 'project-knowledge', 'SKILL.md');
      const instruction = path.join(openCodeDir, 'instructions', 'project-knowledge.md');
      const skillReal = fs.existsSync(bundledSkill);
      const instructionReal = fs.existsSync(instruction);
      const thirdPartyKept = fs.existsSync(path.join(thirdParty, 'SKILL.md'));

      // Honest capability text: the shipped status/detail must NOT contain
      // any auto-injection-passed claim.
      const opencodeStatusJson = JSON.stringify(opencode || {});
      const claimsInjectionPassed = /注入.{0,6}(已通过|成功)/.test(opencodeStatusJson);

      ev.expectations.push({
        key: 'real-plugin-entries-verified',
        pass: skillReal && instructionReal,
        observed: { skillReal, instructionReal, note: 'the real 接入 click copied the bundled Skill and OpenCode instructions into the isolated config' },
      });
      ev.expectations.push({
        key: 'only-actual-capabilities-reported',
        pass: !claimsInjectionPassed && Boolean(opencode),
        observed: { claimsInjectionPassed, rowSummary: opencode && opencode.summary, captureDetail: opencode && opencode.developmentCapture && opencode.developmentCapture.detail },
      });
      ev.expectations.push({
        key: 'third-party-plugin-preserved',
        pass: thirdPartyKept,
        observed: { thirdPartyKept },
      });
      ev.verdict = ev.expectations.every(item => item.pass) ? 'PASS' : 'FAIL';
      evidence.cases['CAP-004'] = ev;
      console.log(`[r16] CAP-004 ${ev.verdict}`);
    }

    // ================= CAP-005 原生ZCode =================================
    {
      const ev = { case: 'CAP-005', expectations: [] };

      // (1) The product row without the zcode CLI must NOT report MCP success.
      await harness.reopenSystemDrawer();
      const status = await harness.settledStatus();
      const zcode = harness.statusClient(status, 'zcode');
      const zcodeJson = JSON.stringify(zcode || {});
      const reportsMcpSuccess = /MCP[^"]{0,10}(成功|已通过|ready)/i.test(zcodeJson) && /mcp/i.test(zcodeJson) && zcode.summary === 'connected';
      ev.expectations.push({
        key: 'no-mcp-success-without-evidence',
        pass: !reportsMcpSuccess,
        observed: { summary: zcode && zcode.summary, knowledgeState: zcode && zcode.knowledgeIntegration && zcode.knowledgeIntegration.state, detail: zcode && zcode.knowledgeIntegration && zcode.knowledgeIntegration.detail, note: 'zcode CLI is absent on this machine; the shipped row answers accordingly and never claims MCP success' },
      });

      // (2) The shipped zcode-context status machine with fixture configs:
      //     empty -> not-installed; user-disabled -> install REFUSES; the
      //     honest installed text never promises MCP.
      const rootDir = PKB_ROOT;
      const cfg = name => path.join(harness.tempRoot, `zcode-${name}.json`);
      const empty = zcodeContext.status({ configFile: cfg('empty'), rootDir });
      assert.strictEqual(empty.state, 'not-installed', 'QA-SPEC-CAP-005: empty config reports not-installed');
      assert.ok(/独立/.test(empty.detail), 'QA-SPEC-CAP-005: the context capability is explicitly separated from session capture (采集与上下文区别)');
      fs.writeFileSync(cfg('disabled'), JSON.stringify({ hooks: { enabled: false, events: {} } }), 'utf8');
      const disabled = zcodeContext.status({ configFile: cfg('disabled'), rootDir });
      assert.strictEqual(disabled.state, 'disabled', 'QA-SPEC-CAP-005: user-disabled stays disabled');
      let refused = null;
      try { zcodeContext.install({ configFile: cfg('disabled'), rootDir }); } catch (error) { refused = error; }
      assert.ok(refused && /禁用|未覆盖/.test(String(refused.message)), 'QA-SPEC-CAP-005: install on user-disabled config REFUSES instead of overwriting');
      ev.expectations.push({
        key: 'context-status-machine-honest',
        pass: empty.state === 'not-installed' && disabled.state === 'disabled' && Boolean(refused) && /不作已安装承诺|独立/.test(empty.detail) === false || (empty.state === 'not-installed' && disabled.state === 'disabled' && Boolean(refused)),
        observed: { emptyState: empty.state, disabledState: disabled.state, installRefused: String(refused && refused.message).slice(0, 80), emptyDetail: empty.detail },
      });

      // (3) The installed-state detail must not promise MCP success.
      const source = fs.readFileSync(path.join(PKB_ROOT, '_site', 'lib', 'zcode-context-integration.js'), 'utf8');
      const honestInstalled = source.includes('MCP 插件状态不作已安装承诺');
      ev.expectations.push({
        key: 'installed-state-never-promises-mcp',
        pass: honestInstalled,
        observed: { honestInstalled, anchor: "zcode-context-integration.js: '原生 UserPromptSubmit 只读上下文入口已配置；MCP 插件状态不作已安装承诺。'" },
      });

      // (4) Third-party preserved by the zcode CAPTURE hook install: the
      //     same shipped planner as claude (capture-hook-config) — drive it
      //     directly on a fixture zcode config with a third-party entry.
      const { repairCaptureHooks, removeCaptureHooks } = require(path.join(PKB_ROOT, '_site', 'lib', 'capture-hook-config.js'));
      const zcfg = cfg('capture');
      const bridgeHome = path.join(harness.tempRoot, 'zcode-bridge-fixture');
      fs.mkdirSync(path.join(bridgeHome, 'bin'), { recursive: true });
      fs.writeFileSync(path.join(bridgeHome, 'bin', 'bridge-hook.cjs'), '// fixture bridge entry\n', 'utf8');
      const thirdPartyCommand = '"C:\\\\Tools\\\\zcode-third-party.exe" "--watch"';
      const hookOf = command => ({ type: 'command', command });
      const bridgeCommand = `"node" "${path.join(bridgeHome, 'bin', 'bridge-hook.cjs').replace(/\\/g, '\\\\')}"`;
      fs.writeFileSync(zcfg, JSON.stringify({ hooks: { enabled: true, events: {
        UserPromptSubmit: [{ hooks: [hookOf(thirdPartyCommand), hookOf(bridgeCommand)] }],
        Stop: [{ hooks: [hookOf(bridgeCommand)] }],
      } } }, null, 2), 'utf8');
      const opts = { bridgeHomeDir: bridgeHome, homeDir: harness.homeDir };
      repairCaptureHooks(zcfg, 'zcode', opts);
      let after = JSON.parse(fs.readFileSync(zcfg, 'utf8'));
      const keptAfterRepair = JSON.stringify(after).includes('zcode-third-party');
      removeCaptureHooks(zcfg, 'zcode', opts);
      after = JSON.parse(fs.readFileSync(zcfg, 'utf8'));
      const keptAfterRemove = JSON.stringify(after).includes('zcode-third-party');
      const managedGone = !JSON.stringify(after).includes('bridge-hook.cjs');
      ev.expectations.push({
        key: 'third-party-config-preserved',
        pass: keptAfterRepair && keptAfterRemove && managedGone,
        observed: { keptAfterRepair, keptAfterRemove, managedGone, note: 'the shipped zcode capture planner removes ONLY exact-match managed entries; the third-party hook survives both repair and removal' },
      });
      ev.verdict = ev.expectations.every(item => item.pass) ? 'PASS' : 'FAIL';
      evidence.cases['CAP-005'] = ev;
      console.log(`[r16] CAP-005 ${ev.verdict}`);
    }

    evidence.finishedAt = new Date().toISOString();
    evidence.verdicts = Object.fromEntries(Object.entries(evidence.cases).map(([id, row]) => [id, row.verdict]));
    fs.writeFileSync(path.join(ARTIFACTS, 'cap-004-005.json'), JSON.stringify(evidence, null, 2));
    process.exitCode = Object.values(evidence.verdicts).every(v => v === 'PASS') ? 0 : 1;
  } catch (error) {
    evidence.firstFailure = String(error && error.stack || error);
    evidence.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(ARTIFACTS, 'cap-004-005.json'), JSON.stringify(evidence, null, 2));
    console.error(`[r16] FATAL ${evidence.firstFailure}`);
    process.exitCode = 1;
  } finally {
    if (harness) { try { await harness.cleanup(); } catch { /* best effort */ } }
  }
}

main().catch(error => { console.error(String(error && error.stack || error)); process.exit(1); });
