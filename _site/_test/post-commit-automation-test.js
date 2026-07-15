// Post-commit automation unit/integration tests.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const automationConfig = require('../lib/automation-config');
const automation = require('../lib/post-commit-automation');

const ROOT = path.resolve(__dirname, '..', '..');
const TEMP_REPO = path.join(os.tmpdir(), `kb-post-commit-auto-${process.pid}`);
const TEMP_KB = path.join(os.tmpdir(), `kb-post-commit-auto-kb-${process.pid}`);
const SLUG = 'post-commit-auto-test';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch {}
}

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return (r.stdout || '').trim();
}

function initRepo() {
  rmrf(TEMP_REPO);
  rmrf(TEMP_KB);
  fs.mkdirSync(TEMP_REPO, { recursive: true });
  fs.mkdirSync(TEMP_KB, { recursive: true });
  git(TEMP_REPO, ['init', '--initial-branch=main']);
  git(TEMP_REPO, ['config', 'user.email', 'auto@example.com']);
  git(TEMP_REPO, ['config', 'user.name', 'Automation Test']);
  git(TEMP_REPO, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(TEMP_REPO, 'README.md'), '# auto\n', 'utf-8');
  git(TEMP_REPO, ['add', 'README.md']);
  git(TEMP_REPO, ['commit', '-m', 'feat: initial auto repo']);
  fs.writeFileSync(path.join(TEMP_REPO, 'feature.txt'), 'feature\n', 'utf-8');
  git(TEMP_REPO, ['add', 'feature.txt']);
  git(TEMP_REPO, ['commit', '-m', 'feat: add automation feature']);
  fs.writeFileSync(path.join(TEMP_KB, 'README.md'), '# kb\n', 'utf-8');
}

function project(overrides = {}) {
  return {
    displayName: 'Post Commit Auto Test',
    localPath: TEMP_REPO,
    gitPath: TEMP_REPO,
    kbPath: TEMP_KB,
    aiProfileId: 'test-profile',
    trackingStartCommit: git(TEMP_REPO, ['rev-list', '--max-parents=0', 'HEAD']),
    automation: {
      enabled: true,
      postCommitEnabled: true,
      knowledgeMode: 'requestApproval',
      allowReadOnlyBash: true,
      hookPromptTemplate: 'Project {{projectSlug}} commit {{shortHash}} files {{changedFiles}} mode {{knowledgeMode}} permission {{permissionMode}}',
    },
    claudeWorkbench: { permissionMode: 'bypassPermissions' },
    ...overrides,
  };
}

(async () => {
  initRepo();

  const normalized = automationConfig.normalizeAutomationConfig({});
  assert(normalized.enabled === false, 'automation default should be disabled');
  assert(normalized.knowledgeMode === 'requestApproval', 'default knowledge mode');
  assert(automationConfig.normalizeClaudeWorkbenchConfig({ permissionMode: 'bypassPermissions' }).permissionMode === 'bypassPermissions',
    'bypassPermissions should normalize without downgrade');

  const policyReadOnly = automationConfig.buildAutomationToolPolicy({
    automation: { knowledgeMode: 'requestApproval', allowReadOnlyBash: true },
    kbPath: TEMP_KB,
  });
  assert(policyReadOnly.allowedTools.includes('Read'), 'read policy should allow Read');
  assert(!policyReadOnly.allowedTools.includes('Edit'), 'requestApproval should not allow Edit');
  assert(automationConfig.evaluateAutomationToolUse(policyReadOnly, 'Bash', { command: 'git log --oneline -n 1' }).behavior === 'allow',
    'read-only git log should be allowed');
  assert(automationConfig.evaluateAutomationToolUse(policyReadOnly, 'Bash', { command: 'Remove-Item x' }).behavior === 'deny',
    'dangerous PowerShell write should be denied');

  const policyWrite = automationConfig.buildAutomationToolPolicy({
    automation: { knowledgeMode: 'directWriteKb', allowReadOnlyBash: true },
    kbPath: TEMP_KB,
  });
  assert(policyWrite.allowedTools.includes('Edit'), 'directWriteKb should allow Edit');
  assert(automationConfig.evaluateAutomationToolUse(policyWrite, 'Write', { file_path: path.join(TEMP_KB, 'changes', 'x.md') }).behavior === 'allow',
    'write inside KB should be allowed');
  assert(automationConfig.evaluateAutomationToolUse(policyWrite, 'Write', { file_path: path.join(TEMP_KB, 'changes', '00-index.md') }).behavior === 'deny',
    'AI should never write a generated Markdown index');
  assert(automationConfig.evaluateAutomationToolUse(policyWrite, 'Write', { file_path: path.join(TEMP_REPO, 'README.md') }).behavior === 'deny',
    'write inside source repo should be denied');

  const projects = { [SLUG]: project() };
  const hit = automation.findProjectForRepo(projects, TEMP_REPO);
  assert(hit && hit.slug === SLUG, 'repo path should resolve to slug');

  const rendered = await automation.renderAutomationPrompt({
    slug: SLUG,
    cfg: projects[SLUG],
    event: { commitHash: 'HEAD' },
    defaultProjectKbPath: () => TEMP_KB,
  });
  assert(rendered.prompt.includes(SLUG), 'prompt should include slug');
  assert(rendered.prompt.includes('feature.txt'), 'prompt should include changed file');
  assert(rendered.prompt.includes('不要创建、修改或追加任何 00-index.md'), 'all custom prompts should receive mandatory knowledge-hygiene rules');
  assert(rendered.metadata.pendingCommitCount === 1, 'render should include only commits after trackingStartCommit');
  assert(rendered.metadata.commitRange.includes('..'), 'render should include a commit range');
  assert(rendered.workbench.permissionMode === 'bypassPermissions', 'render should keep project permission mode');

  const disabled = await automation.handlePostCommitEvent({ repoPath: TEMP_REPO, commitHash: 'HEAD' }, {
    projects: { [SLUG]: project({ automation: { enabled: false, postCommitEnabled: true } }) },
    defaultProjectKbPath: () => TEMP_KB,
    validateUsableAiProfile: () => ({ ok: true, profile: { id: 'test-profile' } }),
    startAutomationSession: () => { throw new Error('should not start'); },
  });
  assert(disabled.ok && disabled.skipped, 'disabled automation should skip');

  const currentHead = git(TEMP_REPO, ['rev-parse', 'HEAD']);
  const noPending = await automation.handlePostCommitEvent({ repoPath: TEMP_REPO, commitHash: 'HEAD' }, {
    projects: { [SLUG]: project({ trackingStartCommit: currentHead }) },
    defaultProjectKbPath: () => TEMP_KB,
    validateUsableAiProfile: () => ({ ok: true, profile: { id: 'test-profile' } }),
    startAutomationSession: () => { throw new Error('should not start when there are no pending commits'); },
    writeProjects: () => {},
  });
  assert(noPending.ok && noPending.skipped && /no pending/.test(noPending.reason), 'no pending commits should skip automation');

  const startedCalls = [];
  const dispatched = await automation.handlePostCommitEvent({ repoPath: TEMP_REPO, commitHash: 'HEAD' }, {
    projects,
    defaultProjectKbPath: () => TEMP_KB,
    validateUsableAiProfile: () => ({ ok: true, profile: { id: 'test-profile' } }),
    startAutomationSession: (opts) => {
      startedCalls.push(opts);
      return { sessionId: 'sess-test' };
    },
  });
  assert(dispatched.ok && dispatched.sessionId === 'sess-test', 'enabled automation should dispatch a session');
  assert(startedCalls.length === 1, 'startAutomationSession should be called once');
  assert(startedCalls[0].permissionMode === 'bypassPermissions', 'session should receive bypassPermissions');
  assert(startedCalls[0].safetyPolicy.allowedTools.includes('Read'), 'session should receive safety policy');

  const runs = automation.listAutomationRuns(SLUG, 5);
  assert(runs.some(r => r.runId === dispatched.runId), 'automation run should be persisted');

  rmrf(TEMP_REPO);
  rmrf(TEMP_KB);
  rmrf(path.join(ROOT, '_site', '_ai', SLUG));
  console.log('post-commit automation test passed');
})().catch(err => {
  rmrf(TEMP_REPO);
  rmrf(TEMP_KB);
  rmrf(path.join(ROOT, '_site', '_ai', SLUG));
  console.error(err);
  process.exit(1);
});
