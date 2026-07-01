// Claude workbench regression test.
//
// Verifies session metadata and the SDK-only session lifecycle. The legacy
// `claude -p` subprocess path was removed in the CC-Switch migration, so
// the pre-turn `requirePermission` flow no longer exists — the SDK path
// shows permission prompts via canUseTool only when an individual tool
// is actually invoked. Tool-level prompts are exercised by the chat
// panel integration tests.

const fs = require('fs');
const path = require('path');
const runner = require('../lib/claude-cli-runner');

const ROOT = path.resolve(__dirname, '..', '..');
const TEMP_KB = path.join(ROOT, 'projects', 'claude-workbench-test-temp');
const TEMP_AI = path.join(ROOT, '_site', '_ai', 'claude-workbench-test-temp');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

(async () => {
  fs.rmSync(TEMP_KB, { recursive: true, force: true });
  fs.rmSync(TEMP_AI, { recursive: true, force: true });
  fs.mkdirSync(TEMP_KB, { recursive: true });

  // 1. Default initial-analysis turn: SDK is the only mode. The session
  //    should be created without any pre-turn permission prompt (the
  //    SDK surfaces tool approvals lazily through canUseTool).
  const started = runner.startSession({
    slug: 'claude-workbench-test-temp',
    projectPath: ROOT,
    kbPath: TEMP_KB,
    promptKey: 'initial-analysis',
    aiProfile: {
      id: 'test-profile',
      implementation: 'claude-code-agent',
      mainModel: 'test-model',
    },
    vars: {
      SLUG: 'claude-workbench-test-temp',
      PROJECT_PATH: ROOT,
      PRIMARY_LANGUAGE: 'JavaScript',
      KNOWLEDGE_LANGUAGE: 'zh-CN',
    },
  });

  assert(started.sessionId, 'startSession should return sessionId');
  assert(!started.pendingPermission,
    'SDK mode should not show a pre-turn UI permission prompt');
  assert(started.runner === 'sdk',
    `startSession should default to runner: 'sdk', got ${started.runner}`);

  const state = runner.getState(started.sessionId);
  assert(state.runner === 'sdk',
    `session state should record runner: 'sdk', got ${state.runner}`);

  runner.deleteSession(started.sessionId);

  // 1b. The embedded terminal should be able to create an idle chat
  //     session without reading claude-prompts.json or running an
  //     initial-analysis prompt. The user's first typed message starts
  //     the actual SDK turn via sendInput.
  const chat = runner.startChatSession({
    slug: 'claude-workbench-test-temp',
    projectPath: ROOT,
    kbPath: TEMP_KB,
    aiProfile: {
      id: 'test-profile',
      implementation: 'claude-code-agent',
      mainModel: 'test-model',
    },
    permissionMode: 'default',
  });
  assert(chat.sessionId, 'startChatSession should return sessionId');
  const chatState = runner.getState(chat.sessionId);
  assert(chatState.promptKey === 'terminal-chat',
    `chat session should use terminal-chat promptKey, got ${chatState.promptKey}`);
  assert(chatState.state === 'idle',
    `chat session should stay idle until user input, got ${chatState.state}`);
  assert(chatState.turns === 0, `chat session should not start a turn, got turns=${chatState.turns}`);

  // 1c. Switching AI profiles mid-session must not resume the old upstream
  //     Claude conversation with the new provider. That used to send the
  //     previous model (for example MiniMax-M3) to the new base URL (for
  //     example GLM), producing "model not found" API errors.
  const chatSession = runner.getSession(chat.sessionId);
  chatSession.aiProfileId = 'minimax-m3';
  chatSession.model = 'MiniMax-M3';
  chatSession.claudeSessionId = 'old-claude-session-id';
  const switched = runner.applyAiProfileToSession(chatSession, {
    id: 'glm',
    implementation: 'claude-code-agent',
    mainModel: 'glm-5.2',
  });
  const switchedState = runner.getState(chat.sessionId);
  assert(switched.resetConversation === true, 'profile switch should reset the upstream conversation');
  assert(switchedState.claudeSessionId === null, 'profile switch should clear stale claudeSessionId');
  assert(switchedState.aiProfileId === 'glm', `profile switch should update aiProfileId, got ${switchedState.aiProfileId}`);
  assert(switchedState.model === 'glm-5.2', `profile switch should update model, got ${switchedState.model}`);
  runner.deleteSession(chat.sessionId);

  const executable = runner.findClaudeExecutableForSdk();
  if (process.platform === 'win32' && executable.cmd) {
    assert(!/\.(cmd|bat|ps1)$/i.test(executable.cmd),
      `SDK executable must not be a Windows shell shim: ${executable.cmd}`);
  }

  // 2. Automation raw prompt sessions must preserve the selected permission
  //    mode. This guards against regressing back to bypassPermissions -> default.
  process.env.KB_AUTOMATION_FAKE_CLAUDE = '1';
  const auto = runner.startAutomationSession({
    slug: 'claude-workbench-test-temp',
    projectPath: ROOT,
    kbPath: TEMP_KB,
    userPrompt: 'automation test prompt',
    systemPrompt: 'automation system prompt',
    aiProfile: {
      id: 'test-profile',
      implementation: 'claude-code-agent',
      mainModel: 'test-model',
    },
    permissionMode: 'bypassPermissions',
    allowedTools: ['Read'],
    safetyPolicy: {
      kind: 'kb-automation',
      kbPath: TEMP_KB,
      knowledgeMode: 'requestApproval',
      allowReadOnlyBash: false,
      allowedTools: ['Read'],
      canWriteKb: false,
    },
    metadata: { automation: true, automationRunId: 'auto-test', source: 'test' },
  });
  const autoState = runner.getState(auto.sessionId);
  assert(autoState.permissionMode === 'bypassPermissions',
    `automation session should preserve bypassPermissions, got ${autoState.permissionMode}`);
  assert(autoState.automation === true, 'automation session should be marked automation=true');
  runner.deleteSession(auto.sessionId);
  delete process.env.KB_AUTOMATION_FAKE_CLAUDE;

  fs.rmSync(TEMP_KB, { recursive: true, force: true });
  fs.rmSync(TEMP_AI, { recursive: true, force: true });
  console.log('Claude workbench test passed');
})().catch(err => {
  try { fs.rmSync(TEMP_KB, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(TEMP_AI, { recursive: true, force: true }); } catch {}
  console.error(err);
  process.exit(1);
});
