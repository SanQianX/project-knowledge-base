// AI analyzer adapter interface (TASK-005 + TASK-008).
// Each adapter implements the same shape so the orchestrator can swap implementations.
//
//   analyzeCommitBatch({ project, commits, contextPack }) -> { changes: [...] }
//   validateOutput(output) -> { valid: boolean, errors: string[] }
//
// All adapters MUST return objects that pass validateOutput. The orchestrator never
// writes drafts to disk unless the output validates.

const fs = require('fs');
const path = require('path');

function isString(v) { return typeof v === 'string'; }
function isNonEmptyString(v) { return isString(v) && v.length > 0; }
function isStringArray(v) { return Array.isArray(v) && v.every(isString); }
function isObject(v) { return v && typeof v === 'object' && !Array.isArray(v); }

function normalizeKnowledgeLanguage(value) {
  return value === 'en-US' ? 'en-US' : 'zh-CN';
}

function languageName(value) {
  return normalizeKnowledgeLanguage(value) === 'en-US' ? 'English' : 'Simplified Chinese';
}

const changeEntrySchema = {
  commit: isNonEmptyString,
  classification: (v) => ['new-feature', 'existing-feature-update', 'bug-fix', 'refactor', 'infrastructure', 'test-only', 'docs-only'].includes(v),
  developmentIntent: isNonEmptyString,
  goalImpact: isNonEmptyString,
  evidence: isStringArray,
  proposedOps: (v) => Array.isArray(v) && v.every(op => isObject(op) && isNonEmptyString(op.op) && isNonEmptyString(op.path)),
};

function validateCommitBatchOutput(output) {
  const errors = [];
  if (!isObject(output)) { errors.push('output is not an object'); return { valid: false, errors }; }
  if (!Array.isArray(output.changes)) { errors.push('missing or invalid: changes'); return { valid: false, errors }; }
  for (let i = 0; i < output.changes.length; i++) {
    const c = output.changes[i];
    if (!isObject(c)) { errors.push(`change[${i}] is not an object`); continue; }
    for (const [key, check] of Object.entries(changeEntrySchema)) {
      if (!(key in c)) { errors.push(`change[${i}] missing: ${key}`); continue; }
      if (!check(c[key])) errors.push(`change[${i}].${key} is invalid`);
    }
  }
  return { valid: errors.length === 0, errors };
}

// ---- claude-code-agent: real LLM via Anthropic-compatible API ----
//
// This adapter calls an Anthropic Messages API (real Anthropic or any
// compatible proxy such as api.minimaxi.com/anthropic). The model returns
// JSON that the KB orchestrator validates against the existing schemas.
//
// The adapter is intentionally minimal: it does ONE call per commit batch
// and asks the model to return a strict JSON object matching the schema.
// Validation happens in `validateOutput`; if the model misbehaves, the run
// is marked failed and the user can re-trigger.

const { completeJson } = require('./llm-client');

const COMMIT_SYSTEM = `You are a senior software architect reviewing a batch of git commits. For each commit, decide what useful knowledge should be recorded in the project's knowledge base. Respond with a single JSON object matching the schema in the user message. Do not invent file paths. Cite the provided evidence (context pack entries) whenever possible. Summarize the user's development intent; do not preserve raw prompts. Do not propose operations that would write outside changes/, modules/, README.md, GOAL.md, or ARCHITECTURE.md.`;

function buildCommitUser({ project, commits, contextPack }) {
  const outputLanguage = languageName(project && project.knowledgeLanguage);
  const ctx = (contextPack && contextPack.entries || []).slice(0, 30).map(e => `- ${e.path}: ${(e.summary || '').slice(0, 200)}`).join('\n');
  const list = (commits || []).map(c => `- full=${c.hash} | short=${c.short || c.hash.slice(0,7)} | ${c.date || ''} | ${c.author || ''} | ${c.subject || ''}`).join('\n');
  return `Project slug: ${project.slug}
Knowledge output language: ${normalizeKnowledgeLanguage(project.knowledgeLanguage)} (${outputLanguage})

Pending commits (chronological order, oldest first). For each line, the "full=" value is the COMPLETE 40-character commit hash; you MUST copy that exact value into the JSON "commit" field:
${list || '(no commits)'}

Context pack excerpts:
${ctx || '(no context pack available)'}

Return a JSON object of the form:
{
  "changes": [
    {
      "commit": string,                // FULL 40-char commit hash copied from the input
      "classification": "new-feature" | "existing-feature-update" | "bug-fix" | "refactor" | "infrastructure" | "test-only" | "docs-only",
      "developmentIntent": string,     // concise summary of the user's request or prompt intent; never raw prompt logs
      "goalImpact": string,            // one short sentence
      "evidence": [string],            // paths cited from the context pack
      "proposedOps": [{ "op": "create-file" | "append-section" | "update-section", "path": string, "fromTemplate"?: string }]
    }
  ]
}

Constraints:
- All human-readable natural language string values MUST be written in ${outputLanguage}. Keep JSON keys, enum values, file paths, and commit hashes exactly as specified.
- One entry per commit in the input list, in the same order.
- "commit" MUST be the full 40-character hash from the input (the value after "full="), NOT the short hash.
- proposedOps[].path MUST be a relative path under changes/ or modules/, or exactly README.md, GOAL.md, or ARCHITECTURE.md. Goal and architecture edits require human review.
- Do not include any text outside the JSON object.`;
}

const claudeCodeAgent = {
  id: 'claude-code-agent',
  name: 'Claude Code Agent (Anthropic-compatible)',
  description: 'Real LLM through an Anthropic-compatible Messages API. AI profiles can reuse this implementation with different model providers.',
  async analyzeCommitBatch({ project, commits, contextPack }) {
    const user = buildCommitUser({ project, commits, contextPack });
    const r = await completeJson({ system: COMMIT_SYSTEM, user, maxTokens: 4096, profileId: project && project.aiProfileId });
    if (!r.parsed) {
      console.error(`[claude-code-agent] LLM did not return valid JSON. text head: ${r.text.slice(0, 500)} ... text tail: ${r.text.slice(-500)}`);
      const e = new Error(`LLM returned no parseable JSON (${r.parseError && r.parseError.message || 'no output'})`);
      e.llmText = r.text;
      throw e;
    }
    // Sanity log: how many changes did the LLM return, and what do the commits look like?
    const changes = (r.parsed && r.parsed.changes) || [];
    console.log(`[claude-code-agent] parsed ${changes.length} changes; first change: ${JSON.stringify(changes[0]).slice(0, 300)}`);
    return r.parsed;
  },
  validateOutput(output) {
    return validateCommitBatchOutput(output);
  },
};

const ADAPTERS = {
  'claude-code-agent': claudeCodeAgent,
};

function getAdapter(id) {
  return ADAPTERS[id] || null;
}

function listAdapters() {
  return Object.values(ADAPTERS).map(a => ({
    id: a.id,
    name: a.name,
    description: a.description || null,
  }));
}

module.exports = {
  ADAPTERS,
  getAdapter,
  listAdapters,
  validateCommitBatchOutput,
};
