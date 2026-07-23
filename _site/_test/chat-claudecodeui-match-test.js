// Regression test for the claudecodeui-style chat panel additions:
//   1. Runner honors opts.permissionMode from sendInput (mode badge can
//      switch modes mid-session).
//   2. getSessionTokenUsage accumulates input + output + cache tokens
//      from claude/usage events and reports hasUsage=false on a fresh
//      session.
//   3. The chat panel template renders the slash palette, mode badge,
//      token donut, and command-count badge wired to refs that exist
//      in the Vue setup.
//   4. Permission-mode persistence uses per-session localStorage keys
//      so a /new conversation does not leak the old mode.

const fs = require('fs');
const path = require('path');
const runner = require('../lib/claude-cli-runner');

const ROOT = path.resolve(__dirname, '..', '..');
const SLUG = 'chat-claudecodeui-match-temp';
const TEMP_KB = path.join(ROOT, 'projects', SLUG);
const TEMP_AI = path.join(ROOT, '_site', '_ai', SLUG);

function assert(cond, msg) { if (!cond) throw new Error(msg); }

(async () => {
  fs.rmSync(TEMP_KB, { recursive: true, force: true });
  fs.rmSync(TEMP_AI, { recursive: true, force: true });
  fs.mkdirSync(TEMP_KB, { recursive: true });

  try {
    // 1. sendInput honors opts.permissionMode from the caller.
    const started = runner.startSession({
      slug: SLUG,
      projectPath: ROOT,
      kbPath: TEMP_KB,
      promptKey: 'initial-analysis',
      aiProfile: { id: 'test-profile', implementation: 'claude-code-agent', mainModel: 'test-model' },
      vars: { SLUG, PROJECT_PATH: ROOT, PRIMARY_LANGUAGE: 'JavaScript', KNOWLEDGE_LANGUAGE: 'zh-CN' },
    });
    assert(started.sessionId, 'startSession should return sessionId');

    // No real Claude binary is wired here, but sendInput returns a
    // {started, pendingPermission} shape before the spawn throws. The
    // source-level contract is what we assert: opts.permissionMode must
    // propagate through to the turn's permissionMode so the mode badge
    // actually changes the runtime mode.
    const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'claude-cli-runner.js'), 'utf-8');
    assert(/normalizePermissionMode\(opts\.permissionMode \|\| session\.permissionMode \|\| 'default'\)/.test(source),
      'sendInput should normalize and read opts.permissionMode from caller');

    // 2. getSessionTokenUsage accumulates usage from claude/result events.
    const fresh = runner.getSessionTokenUsage(started.sessionId);
    assert(fresh && typeof fresh.used === 'number', 'token usage should report a number');
    assert(fresh.used === 0, `fresh session should have used=0, got ${fresh.used}`);
    assert(fresh.hasUsage === false, 'fresh session should have hasUsage=false');
    assert(fresh.total > 0, 'token usage should report a positive total');

    // Simulate a claude/usage event by injecting it via the subscribe API.
    // We can't actually start Claude here, so we reach in via a small
    // monkey-patch: subscribe writes nothing for our fake session, so we
    // skip that path and assert the source-level wiring instead — the
    // event type 'claude/usage' must be filtered and its usage reported.
    // (Usage is emitted on each message_start and message_delta event so
    // the token percentage tracks the streaming turn in real time, rather
    // than waiting for the final claude/result.)
    assert(/type === 'claude\/usage' && ev\.usage/.test(source),
      'getSessionTokenUsage should iterate claude/usage events and read ev.usage');
    assert(/input_tokens/.test(source) && /output_tokens/.test(source) && /cache_creation_input_tokens/.test(source),
      'getSessionTokenUsage should account for input + output + cache tokens');

    // 3. The chat panel template wires the new controls.
    const html = fs.readFileSync(path.join(__dirname, '..', '..', 'ui', 'index.html'), 'utf-8');
    assert(/slashMenuOpen/.test(html), 'template should reference slashMenuOpen');
    assert(/v-if="slashMenuOpen"/.test(html), 'template should gate slash palette on slashMenuOpen');
    assert(/filteredSlashCommands/.test(html), 'template should iterate filteredSlashCommands');
    assert(/permissionMode/.test(html), 'template should reference permissionMode');
    assert(/toggleModeMenu/.test(html), 'template should wire mode dropdown');
    assert(/tokenUsagePercent/.test(html), 'template should render token usage percent');
    assert(/sessionTokenUsage/.test(html), 'template should reference sessionTokenUsage');
    assert(/@click="toggleSlashMenu"/.test(html), 'template should wire the slash-count badge button');
    assert(/@keydown="handleTerminalKeydown"/.test(html),
      'textarea should use handleTerminalKeydown for arrow/escape/enter handling');

    // 4. The Vue setup declares the supporting state + handlers.
    assert(/const slashCommands\s*=\s*\[/.test(html), 'Vue setup should declare slashCommands array');
    assert(/openSlashMenu/.test(html) && /closeSlashMenu/.test(html) && /selectSlashCommand/.test(html),
      'Vue setup should declare slash menu handlers');
    assert(/loadPermissionModeForSession/.test(html) && /savePermissionModeForSession/.test(html),
      'Vue setup should declare per-session permission-mode persistence');
    assert(/PERMISSION_MODES\s*=\s*\['default',\s*'acceptEdits',\s*'auto',\s*'bypassPermissions',\s*'plan'\]/.test(html),
      'Vue setup should declare the 5 permission modes in the same order as claudecodeui');
    assert(/kb-claude-mode-\$\{/.test(html) || /`kb-claude-mode-/.test(html),
      'Vue setup should namespace permission mode by sessionId in localStorage');
    assert(/startTokenUsagePolling/.test(html) && /refreshTokenUsage/.test(html),
      'Vue setup should declare token-usage polling');
    assert(/\/api\/claude\/sessions\/\$\{[^}]+\}\/token-usage/.test(html),
      'Vue setup should fetch the new token-usage endpoint');
    assert(/const activeSessionMetaById\s*=\s*new Map\(\)/.test(html),
      'sidebar running dots should track active Claude sessions by sessionId');
    assert(/function applyActiveSessionChange\(event\)/.test(html)
        && /activeSessionMetaById\.delete\(event\.sessionId\)/.test(html)
        && /applyActiveSessionChange\(event\);/.test(html),
      'session change events should update active counts for every project');
    assert(/function clearActiveSession\(sessionId, fallbackSlug\)/.test(html)
        && /clearActiveSession\(sessionId, slug\);/.test(html),
      'manual Stop should immediately clear the project running indicator');
    assert(/handle\('claude\/retry'/.test(html),
      'UI should display retry status when the Claude SDK runner retries a transient model error');
    assert(/if \(d\.result && !d\.isError\) setAssistantResult\(d\.result\)/.test(html),
      'UI should not render claude/result error payloads as final assistant output');
    assert(!/slug === selectedSlug\.value \|\| !\(slug in activeSessionsBySlug\)/.test(html),
      'active session recount must not be gated to the selected project');

    // 5. The server wires permissionMode + token-usage.
    const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf-8');
    assert(/body\.permissionMode/.test(server), 'server should read permissionMode from input body');
    assert(/getSessionTokenUsage/.test(server), 'server should call getSessionTokenUsage');
    assert(/token-usage/.test(server), 'server should expose the /token-usage route');

    // 6. i18n: new strings are present in both locales.
    assert(/slashHelpDesc/.test(html) && /slashClearDesc/.test(html) && /slashModelDesc/.test(html)
        && /slashCostDesc/.test(html) && /slashMemoryDesc/.test(html) && /slashConfigDesc/.test(html),
      'English i18n should declare all slash command descriptions');
    assert(/footerModeDefault/.test(html) && /footerModeBypassPermissions/.test(html)
        && /footerModeAcceptEdits/.test(html) && /footerModePlan/.test(html),
      'English i18n should declare mode labels');
    assert(/斜杠命令/.test(html) && /内置/.test(html) && /默认模式/.test(html),
      'Chinese i18n should declare new strings');

    // 7. The new functionality doesn't break the prior tests' invariants.
    assert(!/claude session not initialized yet/.test(source),
      'sendInput must still allow null claudeSessionId (fresh-turn fallback)');
    assert(!/terminalSession\.claudeSessionId\s*==\s*null/.test(html),
      'UI input :disabled must not block on null claudeSessionId');

    // 8. The legacy `claude -p` subprocess path was removed in the
    //    CC-Switch migration. The SDK path is the only supported mode and
    //    it does not own a stdio pipe, so there is no stdin warning to
    //    silence. We assert the legacy spawn is no longer reachable
    //    rather than inspecting its (now removed) stdio config.
    assert(/spawnClaude is no longer supported/.test(source),
      'spawnClaude should be removed/replaced — SDK is the only supported path');

    // 9. SDK overrides: systemPrompt from the AI profile must reach
    //    runSdkTurn. Without this the embedded terminal never gets the
    //    hardened claude_code system prompt (so upstream models can
    //    impersonate other AIs). The legacy temperature/maxTokens
    //    profile fields were removed in the CC-Switch migration —
    //    callers wire those at the call site if they need them.
    assert(/buildSdkOverridesFromProfile/.test(source),
      'runner must export buildSdkOverridesFromProfile');
    const sdkOverrides = runner.buildSdkOverridesFromProfile({
      systemPrompt: { type: 'preset', preset: 'claude_code' },
    });
    assert(sdkOverrides.systemPrompt && sdkOverrides.systemPrompt.preset === 'claude_code',
      'sdk overrides must include the claude_code preset by default');
    const sdkDefaults = runner.buildSdkOverridesFromProfile({});
    assert(sdkDefaults.systemPrompt && sdkDefaults.systemPrompt.preset === 'claude_code',
      'sdk overrides should default to claude_code preset when profile has no override');

    // 10. buildClaudeEnvFromProfile: each model alias slot maps to its
    //     own env var. Empty optional slots fall back to mainModel so
    //     partial CC-Switch configs still produce a valid runtime env.
    const env = runner.buildClaudeEnvFromProfile({
      apiKey: 'sk-plaintext',
      baseUrl: 'https://example.test/anthropic',
      mainModel: 'main',
      thinkingModel: 'think',
      haikuModel: 'hk',
      sonnetModel: 'sn',
      opusModel: 'op',
      timeoutMs: 1234,
    });
    assert(env.ANTHROPIC_AUTH_TOKEN === 'sk-plaintext', 'claude env should set auth token');
    assert(env.ANTHROPIC_BASE_URL === 'https://example.test/anthropic', 'claude env should set base URL');
    assert(env.ANTHROPIC_MODEL === 'main', 'claude env should set main model');
    assert(env.ANTHROPIC_DEFAULT_HAIKU_MODEL === 'hk', 'claude env should map haiku alias');
    assert(env.ANTHROPIC_DEFAULT_SONNET_MODEL === 'sn', 'claude env should map sonnet alias');
    assert(env.ANTHROPIC_DEFAULT_OPUS_MODEL === 'op', 'claude env should map opus alias');
    assert(env.ANTHROPIC_DEFAULT_THINKING_MODEL === 'think', 'claude env should map thinking alias');
    assert(env.API_TIMEOUT_MS === '1234', 'claude env should set timeout');
    assert(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC === '1', 'claude env should disable nonessential traffic');

    // 10b. Empty alias slots fall back to mainModel (so a CC-Switch
    //      profile that only fills mainModel still produces a complete
    //      runtime env).
    const envFallback = runner.buildClaudeEnvFromProfile({
      apiKey: 'sk', mainModel: 'only-main',
    });
    assert(envFallback.ANTHROPIC_MODEL === 'only-main', 'main model should land on ANTHROPIC_MODEL');
    assert(envFallback.ANTHROPIC_DEFAULT_HAIKU_MODEL === 'only-main',
      'unset haikuModel should fall back to mainModel');
    assert(envFallback.ANTHROPIC_DEFAULT_OPUS_MODEL === 'only-main',
      'unset opusModel should fall back to mainModel');
    assert(envFallback.ANTHROPIC_DEFAULT_SONNET_MODEL === 'only-main',
      'unset sonnetModel should fall back to mainModel');
    assert(envFallback.ANTHROPIC_DEFAULT_THINKING_MODEL === 'only-main',
      'unset thinkingModel should fall back to mainModel');

    // 10c. Transient SDK errors should be retried. This covers GLM-style
    //      temporary capacity errors such as "当前模型访问量太大" without
    //      retrying ordinary configuration errors.
    assert(runner.isTransientClaudeError(new Error('API Error: 400 [\u5f53\u524d\u6a21\u578b\u8bbf\u95ee\u91cf\u592a\u5927]')),
      'runner should treat provider capacity errors as transient');
    assert(runner.isTransientClaudeError(new Error('429 too many requests')),
      'runner should treat rate-limit errors as transient');
    assert(!runner.isTransientClaudeError(new Error('model does not exist')),
      'runner should not retry non-transient configuration errors');
    assert(/type:\s*'claude\/retry'/.test(source) && /maxSdkRetries\(\)/.test(source),
      'runSdkTurn should emit claude/retry and use the retry limit helper');

    // 11. Context window: getSessionTokenUsage must source `total` from
    //     session.contextWindow (set by applyAiProfileToSession from the
    //     profile + model lookup table), not a hardcoded 200000. Without
    //     this, models with 1M context (minimax-m3 / glm-5.2) render the
    //     usage bar pinned at 20%.
    assert(/session\.contextWindow\s*=\s*resolveContextWindow\(/.test(source),
      'applyAiProfileToSession should write session.contextWindow via resolveContextWindow');
    assert(/Number\.isFinite\(ctxWin\)\s*&&\s*ctxWin\s*>\s*0/.test(source),
      'getSessionTokenUsage should fall back only when session.contextWindow is missing/invalid');
    assert(!/return \{ used, total: fallbackTotal, hasUsage: sawUsage \};/.test(source),
      'getSessionTokenUsage return must use resolved `total`, not the hardcoded fallbackTotal');

    // 11b. Live test: inject a contextWindow directly on the session and
    //      confirm the runner surfaces it. This exercises the full
    //      getSession → read-session.contextWindow → return path.
    const liveSession = runner.getSession ? runner.getSession(started.sessionId) : null;
    if (liveSession) {
      liveSession.contextWindow = 1048576;
      const usage1M = runner.getSessionTokenUsage(started.sessionId);
      assert(usage1M.total === 1048576,
        `session with contextWindow=1M should report total=1048576, got ${usage1M.total}`);
      liveSession.contextWindow = null;
      const usageFallback = runner.getSessionTokenUsage(started.sessionId);
      assert(usageFallback.total === 200000,
        `session without contextWindow should fall back to 200000, got ${usageFallback.total}`);
    }

    // 12. Narrow-layout pane switching: 1024-1279px range previously
    //     clipped the second split-pane column. We use a Notion/Linear-
    //     style v-show toggle driven by a matchMedia isNarrow ref and a
    //     narrowPane reactive object keyed by activeView. All four
    //     split-pane instances (dashboard, import, ai, runs) are wrapped
    //     so that on narrow viewports only one column is visible.
    assert(/const isNarrow\s*=\s*ref\(/.test(html),
      'Vue setup should declare isNarrow ref from matchMedia');
    assert(/const narrowPane\s*=\s*reactive\(\{/.test(html),
      'Vue setup should declare narrowPane reactive object');
    assert(/function setNarrowPane\(/.test(html),
      'Vue setup should declare setNarrowPane helper');
    assert(/narrowMedia\.addEventListener\('change'/.test(html),
      'Vue setup should listen to matchMedia change for isNarrow');
    assert(/watch\(activeView/.test(html),
      'Vue setup should reset narrowPane to default on view change');
    assert(/\.narrow-only\s*\{\s*display:\s*none\s*;?\s*\}/.test(html),
      'CSS should define .narrow-only class hidden by default');
    assert(/@media\s*\(max-width:\s*1279px\)\s*\{\s*\.narrow-only\s*\{\s*display:\s*inline-flex/.test(html),
      'CSS should show .narrow-only at <=1279px');
    assert(/activeView === 'dashboard'" class="dashboard-view flex min-h-0 flex-1 overflow-hidden"/.test(html)
        && /dashboard-view[\s\S]{0,240}class="panel flex h-full min-h-0 w-full flex-1 flex-col/.test(html),
      'dashboard should render the Claude workbench as one full-width panel');
    assert(/v-show="!isNarrow\s*\|\|\s*narrowPane\.import\s*===\s*'form'"/.test(html)
        && /v-show="!isNarrow\s*\|\|\s*narrowPane\.import\s*===\s*'preview'"/.test(html),
      'import split-pane should v-show both columns based on narrowPane.import');
    assert(/v-show="!isNarrow\s*\|\|\s*narrowPane\.ai\s*===\s*'list'"/.test(html)
        && /v-show="!isNarrow\s*\|\|\s*narrowPane\.ai\s*===\s*'editor'"/.test(html),
      'ai split-pane should v-show both columns based on narrowPane.ai');
    assert(/narrowOpenClaude/.test(html) && /narrowShowTarget/.test(html)
        && /narrowEditProfile/.test(html),
      'i18n should declare narrow-mode toggle button labels');
    assert(/\.pane-wrap\s*\{\s*display:\s*flex;\s*flex-direction:\s*column;\s*height:\s*100%;\s*min-height:\s*0/.test(html),
      'CSS should define .pane-wrap so v-show wrappers fill their slot (otherwise inner h-full collapses and clips bottom controls)');
    assert((html.match(/class="pane-wrap"\s+v-show="!isNarrow \|\| narrowPane\.\w+ === '[^']+'"/g) || []).length === 4,
      'the two remaining split views should carry class="pane-wrap" on both slots');

    runner.deleteSession(started.sessionId);
    console.log('chat-claudecodeui-match test passed');
  } catch (e) {
    console.error('chat-claudecodeui-match test failed:', e.message);
    process.exitCode = 1;
  } finally {
    fs.rmSync(TEMP_KB, { recursive: true, force: true });
    fs.rmSync(TEMP_AI, { recursive: true, force: true });
  }
})();
