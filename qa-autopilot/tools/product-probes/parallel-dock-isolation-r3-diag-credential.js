#!/usr/bin/env node
'use strict';
// P-DOCK-ISOLATION-R3 / free diagnostic.
//
// It proves the R3 environment contract WITHOUT any provider call:
//   * the probe really runs inside the isolated environment;
//   * the terminal module resolves the real profile from its MEMORY overlay
//     while the isolated credential file holds no credential at all;
//   * the module's public API never exposes a partial secret;
//   * a session can be started with that profile (the model is never called);
//   * Chrome starts with the isolated profile and the isolated user profile
//     (the >= 136 --remote-debugging-port gate) and the real product page
//     loads.
//
// It spends no model turn, so it can be re-run freely.

const fs = require('fs');
const path = require('path');

const PKB_ROOT = path.resolve(__dirname, '..', '..', '..');
const UI = require(path.join(PKB_ROOT, '_site', '_test', 'helpers', 'parallel-dock-isolation-r3-ui.js'));
const { createDockIsolationEnv } = require(path.join(PKB_ROOT, '_site', '_test', 'helpers', 'parallel-dock-isolation-r3-env.js'));

const ARTIFACTS = process.env.PK_R3_ARTIFACTS
  || path.join(PKB_ROOT, 'qa-autopilot', 'artifacts', 'parallel-20261023', 'dock-isolation-r3');
const HANDOFF_FILE = process.env.PK_R3_HANDOFF || null;
const MODEL_PROFILE_ID = process.env.R3_DOCK_MODEL_PROFILE || 'minimax';

async function main() {
  const evidence = {
    schema: 'qa-autopilot/dock-isolation-r3-diag/v1',
    case: 'DIAG-ISOLATION',
    lane: 'P-DOCK-ISOLATION-R3',
    startedAt: new Date().toISOString(),
    checks: [],
    firstFailure: null,
  };
  let env = null;
  let browser = null;
  let sessionId = null;
  const check = (key, expect, observed, pass) => { evidence.checks.push({ key, expect, observed, pass }); };

  try {
    if (!HANDOFF_FILE) throw new Error('run through parallel-dock-isolation-r3-launch.js (PK_R3_HANDOFF missing)');
    const handoff = JSON.parse(fs.readFileSync(HANDOFF_FILE, 'utf8'));
    env = await createDockIsolationEnv({ tag: 'diag-r3', handoff });
    evidence.identity = { ...env.identity(), fileHashes: env.fileHashes() };

    // 1. The isolated paths really point outside the repository.
    const layout = env.layout;
    const inside = (value) => {
      const relative = path.relative(PKB_ROOT, value);
      return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    };
    const isolatedPaths = {
      HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE,
      APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA,
      TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR,
      CODEX_HOME: process.env.CODEX_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
      KB_DATA_DIR: process.env.KB_DATA_DIR, KB_KNOWLEDGE_DATA_DIR: process.env.KB_KNOWLEDGE_DATA_DIR,
      AI_CODING_EVENT_BRIDGE_HOME: process.env.AI_CODING_EVENT_BRIDGE_HOME,
      AGENT_TERMINAL_DATA_DIR: process.env.AGENT_TERMINAL_DATA_DIR,
    };
    const pathsOutside = Object.entries(isolatedPaths).every(([, value]) => value && !inside(value));
    check('isolated-paths-outside-repo', 'every isolated path points outside the repository', JSON.stringify(isolatedPaths), pathsOutside);

    // 2. No ambient provider key and no ambient module URL survived.
    const ambientProviderKeys = Object.keys(process.env).filter(key =>
      /^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL|ANTHROPIC_MODEL|CLAUDE_CODE_OAUTH_TOKEN|OPENAI_API_KEY|GEMINI_API_KEY|GOOGLE_API_KEY|MINIMAX)/.test(key));
    check('no-ambient-provider-key', 'no ambient provider credential in the probe environment', JSON.stringify(ambientProviderKeys), ambientProviderKeys.length === 0);

    // 3. The module resolves the real profile from memory, the file is empty.
    const profiles = await env.termApi('profiles');
    const rows = Array.isArray(profiles.data) ? profiles.data : ((profiles.data && profiles.data.profiles) || []);
    const resolved = rows.find(item => item && item.id === MODEL_PROFILE_ID) || null;
    const credentialFile = path.join(layout.dataDir, 'credentials.v1.json');
    const credentialRaw = fs.existsSync(credentialFile) ? fs.readFileSync(credentialFile, 'utf8') : '';
    let credentialJson = null;
    try { credentialJson = JSON.parse(credentialRaw); } catch {}
    const storedRefs = credentialJson && credentialJson.credentials ? Object.keys(credentialJson.credentials) : [];
    check('profile-resolved-in-memory', 'the module reports the real profile as configured',
      JSON.stringify({ listed: Boolean(resolved), credentialConfigured: Boolean(resolved && resolved.credentialConfigured), masked: resolved && resolved.credentialMasked }),
      Boolean(resolved && resolved.credentialConfigured));
    check('credential-not-in-file', 'the isolated credential file holds no credential',
      JSON.stringify({ storedRefs, file: path.basename(credentialFile) }),
      !storedRefs.includes(MODEL_PROFILE_ID) && storedRefs.length === 0);
    check('no-partial-secret-in-api', 'the public API masks the credential with a fixed placeholder',
      String(resolved && resolved.credentialMasked),
      String(resolved && resolved.credentialMasked) === '********');

    // 4. A session starts with that profile - the model is NOT called.
    const created = await env.termApi('sessions', {
      method: 'POST',
      body: {
        context: { contextId: env.terminalProjectId, workspaceRef: env.terminalProjectId },
        aiProfileId: MODEL_PROFILE_ID,
        permissionMode: 'bypassPermissions',
      },
    });
    const session = created.data && created.data.session;
    sessionId = session && session.sessionId;
    check('session-starts-with-profile', 'a session starts with the in-memory credential (no model call)',
      JSON.stringify({ status: created.status, sessionId, aiProfileId: session && session.aiProfileId, selectedModel: session && session.selectedModel }),
      created.status === 201 && Boolean(sessionId));

    // 5. The real Claude Code CLI must be resolvable and runnable inside the
    //    isolation - this is the precondition of the one real model turn.
    const doctor = await env.moduleApi('system/doctor');
    const claudeCode = doctor.data && doctor.data.agents && doctor.data.agents['claude-code']
      ? doctor.data.agents['claude-code']
      : null;
    check('claude-cli-usable-in-isolation', 'the module resolves the real Claude Code executable and can run it inside the isolation',
      JSON.stringify({
        resolvedExecutable: claudeCode && claudeCode.resolvedExecutable,
        resolutionReason: claudeCode && claudeCode.resolutionReason,
        versionProbe: claudeCode && claudeCode.versionProbe,
        loginState: claudeCode && claudeCode.loginState,
      }),
      Boolean(claudeCode && claudeCode.resolvedExecutable && claudeCode.versionProbe && claudeCode.versionProbe.ok));

    // 6. Chrome starts inside the isolation and the real product page loads.
    browser = await UI.launchCdpBrowser({
      chrome: env.chromePath,
      profileDir: layout.browserProfile,
      url: env.productUrl, width: 1600, height: 900,
    });
    await UI.installProductLog(browser);
    await UI.openWorkView(browser, env.productUrl);
    const snapshot = await UI.dockSnapshot(browser);
    const consoleErrors = browser.consoleErrors.map(entry => ({
      source: entry.source || null,
      text: entry.text || null,
      url: entry.url || null,
    }));
    // The isolated fixture has no engine running, so the product's own
    // /api/engine/snapshot call answers 503. That is the known R2 baseline
    // error, not a defect of this lane.
    const unexpectedErrors = consoleErrors.filter(entry =>
      !/\/api\/engine\/snapshot/.test(String(entry.url || '')) && !/503/.test(String(entry.text || '')));
    evidence.consoleErrorSamples = consoleErrors;
    evidence.exceptionSamples = browser.exceptions.slice(0, 5);
    check('chrome-and-product-load', 'Chrome starts with the isolated profile and the product workbench loads (only the known engine-snapshot 503 may appear)',
      JSON.stringify({ consoleErrors, unexpectedErrors: unexpectedErrors.length, exceptions: browser.exceptions.length }),
      unexpectedErrors.length === 0 && browser.exceptions.length === 0);
  } catch (error) {
    evidence.firstFailure = { message: error.message, stack: String(error.stack || '').split('\n').slice(0, 12) };
  } finally {
    if (sessionId && env) {
      try { await env.termApi(`sessions/${sessionId}/abort`, { method: 'POST', body: { reason: 'r3 diagnostic cleanup' } }); } catch {}
    }
    evidence.verdict = evidence.firstFailure ? 'FAIL' : (evidence.checks.every(item => item.pass) ? 'PASS' : 'FAIL');
    evidence.finishedAt = new Date().toISOString();
    try { if (browser) await browser.close(); } catch {}
    try { if (env) await env.cleanup(); } catch (error) { console.error('[r3-diag] cleanup error:', error.message); }
    const writer = UI.evidenceWriter(ARTIFACTS, 'diag-isolation-evidence.json');
    evidence.file = writer.write(evidence);
    console.log(`[r3-diag] verdict=${evidence.verdict} evidence=${evidence.file}`);
    process.exitCode = evidence.verdict === 'PASS' ? 0 : 1;
  }
}

main().catch(error => { console.error('[r3-diag] fatal:', error); process.exitCode = 1; });
