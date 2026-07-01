// Regression test for the "working directory follows current project kbPath"
// behavior and the "claude --resume not found" fallback.
//
// Reproduces the bug where a persisted Claude workbench session kept using
// the old KB path after the user moved the project's kbPath via the
// knowledge-store config, and verifies the runner now:
//   1. Reads the current kbPath from projects.json when restoring.
//   2. Emits claude/kbpath-updated so the UI can show the path change.
//   3. Detects "No conversation found with session ID" on resume failure,
//      clears session.claudeSessionId, and emits claude/resume-not-found.

const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..', '..');
const SLUG = 'kbpath-follow-test-temp';
// Use a temp data dir so the runner reads our fixture projects.json instead
// of the user's real ~/.project-knowledge/projects.json. We must set
// KB_DATA_DIR BEFORE requiring the runner so its KB_ROOT captures the temp.
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), `kb-data-kbpath-follow-${process.pid}-`));
process.env.KB_DATA_DIR = DATA_DIR;
require('../lib/data-dir')._resetCache();
// Seed the prompt registry with the source package's prompts so the runner
// can resolve 'initial-analysis' when startSession is called.
try {
  fs.copyFileSync(path.join(ROOT, 'claude-prompts.json'), path.join(DATA_DIR, 'claude-prompts.json'));
} catch {}
const runner = require('../lib/claude-cli-runner');

const OLD_KB = path.join(DATA_DIR, 'projects', SLUG);
const NEW_KB = path.join(DATA_DIR, '.tmp-kbpath-follow', SLUG);
const PROJECTS_JSON = path.join(DATA_DIR, 'projects.json');
const TEMP_AI = path.join(DATA_DIR, '_ai', SLUG);

function assert(cond, msg) { if (!cond) throw new Error(msg); }

function backup(file) { return fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : null; }
function restore(file, content) {
  if (content == null) fs.rmSync(file, { force: true });
  else fs.writeFileSync(file, content, 'utf-8');
}

function upsertProject(kbPath) {
  let data = {};
  try { data = JSON.parse(fs.readFileSync(PROJECTS_JSON, 'utf-8')); } catch {}
  data[SLUG] = {
    ...(data[SLUG] || {}),
    displayName: 'KBPath follow test',
    localPath: ROOT,
    gitPath: ROOT,
    kbPath,
  };
  fs.writeFileSync(PROJECTS_JSON, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

function cleanup() {
  try { fs.rmSync(OLD_KB, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(NEW_KB, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(TEMP_AI, { recursive: true, force: true }); } catch {}
  // NOTE: don't remove DATA_DIR — it holds the seeded claude-prompts.json
  // and projects.json that the runner needs. The test's caller removes
  // the whole DATA_DIR after this script returns.
}

(async () => {
  const projectsBackup = backup(PROJECTS_JSON);
  cleanup();
  fs.mkdirSync(OLD_KB, { recursive: true });
  fs.mkdirSync(NEW_KB, { recursive: true });
  upsertProject(OLD_KB);

  try {
    // 1. Create a session at the OLD path; this persists the record with
    //    the old kbPath baked in.
    const started = runner.startSession({
      slug: SLUG,
      projectPath: ROOT,
      kbPath: OLD_KB,
      promptKey: 'initial-analysis',
      aiProfile: { id: 'test-profile', implementation: 'claude-code-agent', model: 'test-model' },
      vars: { SLUG, PROJECT_PATH: ROOT, PRIMARY_LANGUAGE: 'JavaScript', KNOWLEDGE_LANGUAGE: 'zh-CN' },
    });
    assert(started.sessionId, 'startSession should return sessionId');

    // Drop the in-memory cache without touching the persisted record on disk
    // so restoreSessionFromDisk is exercised. deleteSession would rm the
    // persisted file too; we only want to clear the live Map.
    delete require.cache[require.resolve('../lib/claude-cli-runner')];
    const runner2 = require('../lib/claude-cli-runner');

    // 2. Simulate the user moving the project to the new KB root.
    upsertProject(NEW_KB);

    // 3. Restoring the persisted session should now use NEW_KB, not OLD_KB.
    const events = [];
    runner2.subscribe(started.sessionId, (e) => events.push(e));

    const liveSession = runner2.getSession(started.sessionId);
    assert(liveSession, 'restored session should be returned');
    assert(liveSession.kbPath === NEW_KB,
      `restored session kbPath should follow the project's CURRENT kbPath (${NEW_KB}), got ${liveSession.kbPath}`);

    const kbPathEvent = events.find(e => e.type === 'claude/kbpath-updated');
    assert(kbPathEvent, 'restoring from a different kbPath should emit claude/kbpath-updated');
    assert(kbPathEvent.fromKbPath === OLD_KB, 'claude/kbpath-updated should include the previous path');
    assert(kbPathEvent.toKbPath === NEW_KB, 'claude/kbpath-updated should include the new path');

    // The previous conversation is stored in the OLD cwd's Claude session
    // store and is unreachable from the new cwd. restoreSessionFromDisk
    // must therefore drop the stale claudeSessionId and the chat history
    // so the user can start a fresh turn. The outputBuffer may still hold
    // bookkeeping events (claude/restored, claude/kbpath-updated) — those
    // are intentional, they tell the UI what just happened.
    const CONVERSATION_EVENTS = new Set([
      'claude/system-prompt', 'claude/user-prompt', 'claude/init',
      'claude/message-start', 'claude/message-stop',
      'claude/text-delta', 'claude/thinking-start', 'claude/thinking-delta',
      'claude/tool-use', 'claude/tool-use-start', 'claude/tool-input-delta',
      'claude/result', 'claude/permission-request', 'claude/permission-resolved',
      'claude/turn-end', 'claude/stderr',
    ]);
    const staleConversation = liveSession.outputBuffer.filter(e => CONVERSATION_EVENTS.has(e.type));
    assert(staleConversation.length === 0,
      `restored session should drop all conversation events on kbPath change, still has: ${staleConversation.map(e => e.type).join(', ')}`);
    assert(liveSession.claudeSessionId === null,
      `restored session should drop the stale claudeSessionId, got ${liveSession.claudeSessionId}`);
    assert(liveSession.historyCleared === true,
      'restored session should set historyCleared=true so the UI can clear its local chat');
    assert(liveSession.turns === 0,
      `restored session should reset turns on kbPath change, got ${liveSession.turns}`);

    // sendInput must accept a session whose claudeSessionId was just
    // cleared and start a fresh turn (no --resume) instead of throwing.
    // We assert the source-level contract: the precondition check that
    // rejected null claudeSessionId is gone, and the bogus 'sonnet'
    // default that would override the AI profile's ANTHROPIC_MODEL env
    // is also gone.
    const source2 = fs.readFileSync(path.join(__dirname, '..', 'lib', 'claude-cli-runner.js'), 'utf-8');
    assert(!/claude session not initialized yet/.test(source2),
      'sendInput should no longer reject null claudeSessionId');
    assert(!/model:\s*session\.model\s*\|\|\s*'sonnet'/.test(source2),
      "sendInput should not default model to 'sonnet' (let the env var win)");

    // The persisted record on disk should also reflect the cleared state
    // so a server restart does not try to resume the stale id.
    const recordFile = path.join(TEMP_AI, 'claude-workbench', `${started.sessionId}.json`);
    assert(fs.existsSync(recordFile), 'session record should still be on disk');
    const persistedAfter = JSON.parse(fs.readFileSync(recordFile, 'utf-8'));
    assert(persistedAfter.claudeSessionId === null,
      'persisted record should have claudeSessionId=null after kbPath change');
    const persistedConversation = (persistedAfter.events || []).filter(e => CONVERSATION_EVENTS.has(e.type));
    assert(persistedConversation.length === 0,
      `persisted record should have no conversation events after kbPath change, still has: ${persistedConversation.map(e => e.type).join(', ')}`);

    // 4. Resume-failure handling. The CC-Switch migration removed the
    //    `claude -p` subprocess path: the SDK is now the only entry
    //    point, so resume failures surface as SDK exceptions rather
    //    than stderr "No conversation found" messages. The
    //    claude/resume-not-found event machinery is gone with the
    //    CLI subprocess handler — instead, a stale claudeSessionId is
    //    cleared by restoreSessionFromDisk when the kbPath moves, so
    //    the next sendInput starts a fresh session without trying to
    //    resume an unreachable conversation. We assert the source-level
    //    contract that makes this work:
    //    - currentProjectKbPath is consulted on restore (so the cwd
    //      moves with the project).
    //    - claude/kbpath-updated is emitted when the cwd changes.
    //    - sendInput tolerates a null claudeSessionId (the previous
    //      "claude session not initialized yet" precondition is gone).
    //    - The runner no longer ships a claude -p subprocess spawn, so
    //      there is no stderr-driven resume-not-found detector.
    const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'claude-cli-runner.js'), 'utf-8');
    assert(/currentProjectKbPath/.test(source), 'runner should consult currentProjectKbPath during restore');
    assert(/claude\/kbpath-updated/.test(source), 'runner should emit claude/kbpath-updated when kbPath changes');
    assert(!/No conversation found with session ID/i.test(source),
      'stderr-based resume-not-found detection should be removed with the CLI subprocess path');
    assert(/spawnClaude is no longer supported/.test(source),
      'legacy spawnClaude should be removed — SDK is the only path');

    // The UI input's :disabled must no longer block on null claudeSessionId,
    // otherwise the user is stuck after a kbPath-driven history clear.
    const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf-8');
    assert(!/terminalSession\.claudeSessionId\s*==\s*null/.test(indexHtml),
      'UI input :disabled should no longer check claudeSessionId == null');
    assert(/claude\/kbpath-updated/.test(indexHtml),
      'UI should subscribe to claude/kbpath-updated to clear local chat');

    console.log('kbPath follow + resume-not-found test passed');
  } catch (e) {
    console.error('kbPath follow test failed:', e.message);
    process.exitCode = 1;
  } finally {
    cleanup();
    restore(PROJECTS_JSON, projectsBackup);
  }
})();
