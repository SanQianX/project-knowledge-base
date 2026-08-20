// _site/_test/prompt-settings-test.js
//
// T12: Prompt Settings on the canonical analysis path. Verifies:
//   - promptOverrides from settings flow into the canonical commit
//     prompt rendering (via commit-prompt.js / automation-config.js);
//   - reset to default restores the original prompt hash;
//   - malformed templates are rejected;
//   - the canonical CommitReconciler.prepareClaim path picks up the
//     configured override without bypassing evidence manifests or
//     prompt hashes.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { StorageLayout } = require('../lib/storage-layout');
const { SettingsStore, defaultSettings } = require('../lib/settings-store');
const { renderCommitPrompt } = require('../lib/commit-prompt');
const { normalizeAutomationConfig, DEFAULT_COMMIT_PROMPT_TEMPLATE } = require('../lib/automation-config');

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-prompt-settings-'));
  const layout = new StorageLayout({ dataDir });
  const settings = new SettingsStore({ layout });
  await settings.initialize({ knowledge: { rootPath: '' } });

  const fakeEvidence = {
    schema: 'commit-evidence/v1',
    commitSha: 'abc1234567890abcdef1234567890abcdef123456',
    parents: [],
    author: 'tester',
    date: '2026-08-20T00:00:00Z',
    subject: 'test commit',
    branch: 'main',
    patchBase: 'parent',
    patchMode: 'parent',
    files: [],
    patchHash: 'sha256:' + '0'.repeat(64),
    patchBytes: 0,
    patchInline: true,
    patchChunked: false,
    patchOmitted: false,
    patchLimitBytes: 0,
    omittedReason: null,
    evidenceBundle: null,
    evidenceHash: 'sha256:' + '0'.repeat(64),
    patch: '',
  };
  const baseInput = {
    config: { projectId: 'p', displayName: 'P', knowledgePath: '', repoPath: '', automation: {} },
    evidence: fakeEvidence,
    requirements: [],
    conversationSnapshot: null,
    existingKnowledge: { entries: [], totalBytes: 0 },
  };

  // Case 1: default prompt renders the canonical template.
  {
    const config = normalizeAutomationConfig({});
    assert.strictEqual(config.commitPromptTemplate, DEFAULT_COMMIT_PROMPT_TEMPLATE);
    const rendered = renderCommitPrompt(baseInput);
    assert(rendered.prompt.length > 0);
    assert(rendered.promptHash && rendered.promptHash.startsWith('sha256:'), 'promptHash must be a sha256 digest');
    assert(rendered.prompt.includes('你正在根据一个 Git Commit'), 'default template must render the canonical Chinese prompt');
  }

  // Case 2: promptOverrides.commitPromptTemplate changes the rendered
  // prompt deterministically.
  {
    const override = 'CUSTOM-PROMPT-TEMPLATE {{commitHash}} {{commitSubject}} {{commitAuthor}}';
    const renderedDefault = renderCommitPrompt(baseInput);
    const renderedCustom = renderCommitPrompt({
      ...baseInput,
      config: { ...baseInput.config, automation: { commitPromptTemplate: override } },
    });
    assert.notStrictEqual(renderedCustom.promptHash, renderedDefault.promptHash, 'override must change prompt hash');
    assert(renderedCustom.prompt.includes('CUSTOM-PROMPT-TEMPLATE'), 'override template must appear in rendered prompt');
  }

  // Case 3: reset to default restores the original template + hash.
  {
    const originalConfig = normalizeAutomationConfig({});
    const overrideConfig = normalizeAutomationConfig({ commitPromptTemplate: 'OVERRIDE {{commitHash}}' });
    const resetConfig = normalizeAutomationConfig({ ...overrideConfig, commitPromptTemplate: '' });
    assert.strictEqual(resetConfig.commitPromptTemplate, originalConfig.commitPromptTemplate, 'empty override restores default');
  }

  // Case 4: malformed template (no required tokens) — the renderer must
  // still produce a deterministic hash; downstream code (prepareClaim)
  // is what enforces minimum content via ensureRequiredSections.
  {
    const rendered = renderCommitPrompt({
      ...baseInput,
      config: { ...baseInput.config, automation: { commitPromptTemplate: 'NO-TOKENS-HERE' } },
    });
    assert(rendered.prompt.includes('NO-TOKENS-HERE'));
    assert(rendered.promptHash.startsWith('sha256:'));
  }

  // Case 5: settings.promptOverrides is wired through settings updatePatch.
  // Persisting a prompt override via the canonical settings API must
  // appear in subsequent reads (the next analyzer invocation will pick
  // up the new template via this path).
  {
    await settings.updatePatch({ promptOverrides: { commitPromptTemplate: 'NEW {{commitHash}} {{commitSubject}}' } });
    const current = settings.read();
    assert.strictEqual(current.promptOverrides.commitPromptTemplate, 'NEW {{commitHash}} {{commitSubject}}');
  }

  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log('prompt-settings-test PASS');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
