// Run: node _site/_test/post-commit-automation-test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const automationConfig = require('../lib/automation-config');
const automation = require('../lib/post-commit-automation');
const { REQUIREMENT_UNAVAILABLE, renderCommitPrompt } = require('../lib/commit-prompt');

(() => {
  const normalized = automationConfig.normalizeAutomationConfig({
    enabled: true,
    hookPromptTemplate: 'Legacy instruction for {{commitHash}}.',
    initPromptTemplate: 'must be ignored',
    postCommitEnabled: true,
    allowReadOnlyBash: true,
  });
  assert.strictEqual(normalized.commitPromptTemplate, 'Legacy instruction for {{commitHash}}.', 'legacy Hook prompt should be a read-only compatibility override');
  assert.strictEqual(normalized.legacyPromptOverride, true);
  assert(!Object.hasOwn(normalized, 'hookPromptTemplate'));
  assert(!Object.hasOwn(normalized, 'initPromptTemplate'));
  assert(!Object.hasOwn(normalized, 'postCommitEnabled'));
  assert(!Object.hasOwn(normalized, 'allowReadOnlyBash'));
  assert(!Object.hasOwn(automationConfig, 'DEFAULT_INIT_PROMPT_TEMPLATE'), 'init prompt constant must not be exported');
  assert(!Object.hasOwn(automation, 'dispatchProjectInit'), 'project init dispatch must not be public');
  assert(!Object.hasOwn(automation, 'dispatchAutomation'), 'generic automation dispatch must not be public');

  const staging = path.resolve('runtime', 'staging', 'run-test');
  const evidenceRoot = path.resolve('runtime', 'runs', 'run-test', 'input', 'evidence');
  const policy = automationConfig.buildAutomationToolPolicy({ stagingPath: staging, evidenceRoot });
  assert.strictEqual(policy.canWriteKb, false, 'AI must never write final knowledge directly');
  assert.strictEqual(policy.canWriteStaging, true);
  assert(!policy.allowedTools.includes('Bash'), 'generic Bash must not be available to analysis');
  assert.strictEqual(automationConfig.evaluateAutomationToolUse(policy, 'Write', { file_path: path.join(staging, 'manifest.json') }).behavior, 'allow');
  assert.strictEqual(automationConfig.evaluateAutomationToolUse(policy, 'Write', { file_path: path.resolve('source.js') }).behavior, 'deny');
  assert.strictEqual(automationConfig.evaluateAutomationToolUse(policy, 'Read', { file_path: path.join(evidenceRoot, 'patch-manifest.json') }).behavior, 'allow');
  assert.strictEqual(automationConfig.evaluateAutomationToolUse(policy, 'Write', { file_path: path.join(evidenceRoot, 'patches', '000001.patch') }).behavior, 'deny');
  assert.strictEqual(automationConfig.evaluateAutomationToolUse(policy, 'Read', { file_path: path.resolve('repo', 'source.js') }).behavior, 'deny');
  assert.strictEqual(automationConfig.evaluateAutomationToolUse(policy, 'Bash', { command: 'git show' }).behavior, 'deny');

  const evidence = {
    commitSha: 'a'.repeat(40),
    parents: ['b'.repeat(40)],
    author: 'Test Author',
    date: '2026-08-17T00:00:00Z',
    subject: 'feat: exact evidence',
    branch: 'main',
    patchMode: 'parent',
    patchHash: 'sha256:patch',
    patchBytes: 42,
    patchOmitted: false,
    patch: 'diff --git a/a.js b/a.js\n+implemented\n',
    files: [{ status: 'M', path: 'a.js', oldPath: null, binary: false, added: 1, deleted: 0 }],
  };
  const config = {
    projectId: 'project-test',
    displayName: 'Prompt Test',
    repoPath: path.resolve('repo'),
    knowledgePath: path.resolve('knowledge'),
    automation: { commitPromptTemplate: automationConfig.DEFAULT_COMMIT_PROMPT_TEMPLATE },
  };
  const missing = renderCommitPrompt({ config, evidence, requirements: [], existingKnowledge: { entries: [], omitted: [] } });
  assert(missing.prompt.includes(REQUIREMENT_UNAVAILABLE), 'unavailable requirement must use the fixed non-guessing text');
  assert(missing.prompt.includes(evidence.patch), 'prompt must contain the actual patch');
  assert(missing.prompt.includes('现有相关知识'), 'prompt must contain existing knowledge section');
  assert(missing.prompt.includes('新增、更新或删除'), 'prompt must ask for add/update/delete decisions');
  assert(!missing.prompt.includes('git-hook') && !missing.prompt.includes('startup'), 'trigger must not affect prompt content');

  const requirement = { id: 'req-1', client: 'codex', sessionId: 'session-1', ts: '2026-08-17T00:00:00Z', requirement: 'Implement the exact feature.' };
  const fromHook = renderCommitPrompt({ config, evidence, requirements: [requirement], existingKnowledge: { entries: [] } });
  const fromStartup = renderCommitPrompt({ config, evidence, requirements: [requirement], existingKnowledge: { entries: [] } });
  assert.strictEqual(fromHook.promptHash, fromStartup.promptHash, 'Hook and startup must render the identical prompt hash');
  assert(fromHook.prompt.includes('Implement the exact feature.'), 'recorded user requirement must be present');

  const legacy = renderCommitPrompt({
    config: { ...config, automation: { hookPromptTemplate: 'Legacy {{commitHash}}' } },
    evidence,
    requirements: [],
    existingKnowledge: { entries: [] },
  });
  assert(legacy.prompt.includes('Legacy ' + evidence.commitSha), 'legacy Hook prompt override should still render');
  assert(legacy.prompt.includes(REQUIREMENT_UNAVAILABLE) && legacy.prompt.includes(evidence.patch), 'mandatory evidence sections must be appended to incomplete legacy templates');

  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'post-commit-automation.js'), 'utf8');
  assert(!/dispatchProjectInit|renderProjectInitPrompt|project-init|startup-recovery/.test(source), 'automation source must not retain init or a third trigger name');
  console.log('post-commit-automation-test PASS');
})();
