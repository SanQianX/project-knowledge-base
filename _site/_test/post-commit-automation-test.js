// Prompt and safety-policy regression tests for fully automatic KB updates.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), `kb-post-commit-${process.pid}-`));
process.env.KB_DATA_DIR = TMP_DATA;
process.env.KB_SKIP_MIGRATION = '1';
const dataDir = require('../lib/data-dir');
dataDir._resetCache();

const automationConfig = require('../lib/automation-config');
const automation = require('../lib/post-commit-automation');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return String(result.stdout || '').trim();
}

(async () => {
  const repo = path.join(TMP_DATA, 'repo');
  const kbPath = path.join(TMP_DATA, 'kb');
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(kbPath, { recursive: true });
  git(repo, ['init', '--initial-branch=main']);
  git(repo, ['config', 'user.email', 'auto@example.com']);
  git(repo, ['config', 'user.name', 'Automation Test']);
  fs.writeFileSync(path.join(repo, 'feature.txt'), 'feature\n', 'utf-8');
  git(repo, ['add', 'feature.txt']);
  git(repo, ['commit', '-m', 'feat: exact commit']);
  const head = git(repo, ['rev-parse', 'HEAD']);

  const normalized = automationConfig.normalizeAutomationConfig({
    enabled: true,
    postCommitEnabled: true,
    knowledgeMode: 'requestApproval',
    maxQueueSize: 1,
  });
  assert(!Object.prototype.hasOwnProperty.call(normalized, 'knowledgeMode'), 'legacy knowledge mode must be removed');
  assert(!Object.prototype.hasOwnProperty.call(normalized, 'maxQueueSize'), 'legacy queue cap must be removed');

  const policy = automationConfig.buildAutomationToolPolicy({
    automation: normalized,
    kbPath,
  });
  assert(policy.canWriteKb === true && policy.allowedTools.includes('Edit'), 'automatic policy must write directly to KB');
  assert(automationConfig.evaluateAutomationToolUse(policy, 'Write', {
    file_path: path.join(kbPath, 'changes', 'x.md'),
  }).behavior === 'allow', 'KB write should be allowed');
  assert(automationConfig.evaluateAutomationToolUse(policy, 'Write', {
    file_path: path.join(repo, 'feature.txt'),
  }).behavior === 'deny', 'source write should be denied');
  assert(automationConfig.evaluateAutomationToolUse(policy, 'Write', {
    file_path: path.join(kbPath, 'changes', '00-index.md'),
  }).behavior === 'deny', 'generated index write should be denied');

  const cfg = {
    displayName: 'Prompt Test',
    localPath: repo,
    gitPath: repo,
    kbPath,
    automation: {
      enabled: true,
      postCommitEnabled: true,
      hookPromptTemplate: '{{commitHash}}\n{{commitSubject}}\n{{changedFiles}}',
    },
    claudeWorkbench: { permissionMode: 'bypassPermissions' },
  };
  const rendered = await automation.renderAutomationPrompt({
    slug: 'prompt-test',
    cfg,
    event: { commitHash: head },
    defaultProjectKbPath: () => kbPath,
  });
  assert(rendered.metadata.pendingCommitCount === 1, 'one task should contain one commit');
  assert(rendered.metadata.commitHash === head, 'prompt should target the requested commit exactly');
  assert(rendered.prompt.includes('feat: exact commit'), 'prompt should include exact commit subject');
  assert(rendered.prompt.includes('feature.txt'), 'prompt should include exact commit files');
  assert(!rendered.prompt.includes('knowledgeMode'), 'prompt should not expose a review/apply mode');
  assert(rendered.workbench.permissionMode === 'bypassPermissions', 'workbench permission should be preserved');

  fs.rmSync(TMP_DATA, { recursive: true, force: true });
  console.log('post-commit automation test passed');
})().catch(error => {
  try { fs.rmSync(TMP_DATA, { recursive: true, force: true }); } catch {}
  console.error(error);
  process.exit(1);
});
