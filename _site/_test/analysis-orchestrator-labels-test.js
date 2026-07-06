// Run: node _site/_test/analysis-orchestrator-labels-test.js
//
// Regression test for the labels() helper inside analysis-orchestrator.js.
//
// Until 2026-07-07 renderChangeDraft() called labels(project) but no labels
// function existed in the module, so any analyze-commits run with real
// changes thrown "labels is not defined" on the first commit. The fix
// reintroduces labels() and the analyze-commits path is now reachable
// again. This test makes sure the helper stays correct across the two
// supported knowledge languages and exposes the expected keys for every
// call site in renderChangeDraft.

const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const { labels } = require(path.join(ROOT, '_site', 'lib', 'analysis-orchestrator'));

function assert(cond, msg) { if (!cond) throw new Error('ASSERT: ' + msg); }

const PROJECT_ZH = { slug: 'demo', knowledgeLanguage: 'zh-CN' };
const PROJECT_EN = { slug: 'demo', knowledgeLanguage: 'en-US' };
const PROJECT_DEFAULT = { slug: 'demo' };

const REQUIRED_KEYS = [
  'aiProposal',
  'developmentIntent',
  'goalImpact',
  'evidence',
  'proposedOperations',
  'noEvidence',
];

(() => {
  // (1) zh-CN project: every key resolves, no key is missing.
  const zh = labels(PROJECT_ZH);
  for (const key of REQUIRED_KEYS) {
    assert(typeof zh[key] === 'string' && zh[key].length > 0,
      `zh: key "${key}" must be a non-empty string, got ${JSON.stringify(zh[key])}`);
  }
  // Spot-check the actual user-facing values. These strings are emitted in
  // the proposal section of every change draft, so they are observable to
  // anyone reviewing KB updates and must not drift silently.
  assert(zh.aiProposal === 'AI 分析提案', `zh: aiProposal drift: ${zh.aiProposal}`);
  assert(zh.developmentIntent === '开发意图', `zh: developmentIntent drift: ${zh.developmentIntent}`);
  assert(zh.goalImpact === '目标影响', `zh: goalImpact drift: ${zh.goalImpact}`);
  assert(zh.evidence === '证据', `zh: evidence drift: ${zh.evidence}`);
  assert(zh.proposedOperations === '建议操作', `zh: proposedOperations drift: ${zh.proposedOperations}`);
  assert(zh.noEvidence === '（无）', `zh: noEvidence drift: ${zh.noEvidence}`);

  // (2) en-US project: full English dictionary.
  const en = labels(PROJECT_EN);
  for (const key of REQUIRED_KEYS) {
    assert(typeof en[key] === 'string' && en[key].length > 0,
      `en: key "${key}" must be a non-empty string, got ${JSON.stringify(en[key])}`);
  }
  assert(en.aiProposal === 'AI Analysis Proposal', `en: aiProposal drift: ${en.aiProposal}`);
  assert(en.developmentIntent === 'Development Intent', `en: developmentIntent drift: ${en.developmentIntent}`);
  assert(en.goalImpact === 'Goal Impact', `en: goalImpact drift: ${en.goalImpact}`);
  assert(en.evidence === 'Evidence', `en: evidence drift: ${en.evidence}`);
  assert(en.proposedOperations === 'Proposed Operations', `en: proposedOperations drift: ${en.proposedOperations}`);
  assert(en.noEvidence === '(none)', `en: noEvidence drift: ${en.noEvidence}`);

  // (3) Project with no knowledgeLanguage set defaults to zh-CN. The
  // dashboard uses zh-CN as the fallback when the field is missing.
  const fallback = labels(PROJECT_DEFAULT);
  assert(fallback.aiProposal === zh.aiProposal,
    `default: should fall back to zh-CN dictionary. got ${fallback.aiProposal}`);

  // (4) Generic zh/en must not be interchangeable — every Chinese character
  // site must stay Chinese, every English site must stay English.
  for (const key of REQUIRED_KEYS) {
    if (key === 'noEvidence') {
      assert(zh[key] !== en[key],
        `zh/en noEvidence must differ, both are ${zh[key]}`);
      continue;
    }
    assert(/[一-鿿]/.test(zh[key]) || /[぀-ヿ]/.test(zh[key]),
      `zh[${key}] should contain CJK characters, got ${zh[key]}`);
    assert(!/[一-鿿]/.test(en[key]) && !/[぀-ヿ]/.test(en[key]),
      `en[${key}] should not contain CJK characters, got ${en[key]}`);
  }

  console.log('analysis-orchestrator-labels-test PASS');
})();
