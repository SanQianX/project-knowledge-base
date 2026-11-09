'use strict';

// P-LIFECYCLE-NEGATIVE-R51 lane environment helper.
//
// Installs driver-process isolation BEFORE any product/helper module is
// required: every redirected variable gets an OWN, existing root (never
// unset) with a resolved-containment assertion against the lane temp root.
// Modeled on the audited R48 pattern; deliberately NOT reusing lanes that
// scrub KB_*/CODEX/CLAUDE variables — this lane needs explicit owned values
// where absence must never be mistaken for set.
//
// Portability: roots come from R51_TEMP_ROOT / R51_EVIDENCE_ROOT when set,
// otherwise os.tmpdir() and the repo-relative ignored artifacts dir. No
// hardcoded drive letters; the temp root must live outside the repository.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const TEMP_ROOT = path.resolve(process.env.R51_TEMP_ROOT || path.join(os.tmpdir(), 'r51-lifecycle-negative'));
const EVIDENCE_ROOT = path.resolve(process.env.R51_EVIDENCE_ROOT || path.join(REPO_ROOT, 'qa-autopilot', 'artifacts', 'parallel-20261023', 'lifecycle-negative-r51', 'evidence'));

// Resolve the Chrome/Edge binary BEFORE env isolation: find-chrome.cjs reads
// LOCALAPPDATA/PROGRAMFILES candidates, and the isolated driver must keep its
// writable roots owned. The absolute executable path is preserved through
// KB_CHROME_PATH (the first candidate find-chrome checks) so the browser
// launch stays deterministic while everything writable stays in lane roots.
function resolveChromeBeforeIsolation() {
  const { findChrome } = require(path.join(REPO_ROOT, '_site', '_test', 'helpers', 'find-chrome.js'));
  return findChrome();
}

function installLaneEnv({ caseId } = {}) {
  if (TEMP_ROOT === REPO_ROOT || TEMP_ROOT.startsWith(REPO_ROOT + path.sep)) {
    throw new Error(`R51 temp root must live outside the repository (got ${TEMP_ROOT})`);
  }
  fs.mkdirSync(TEMP_ROOT, { recursive: true });
  const laneTmp = fs.mkdtempSync(path.join(TEMP_ROOT, `r51-${caseId || 'lane'}-`));
  const iso = path.join(laneTmp, 'iso');
  const names = ['home', 'appdata', 'localappdata', 'tmp', 'codex', 'claude', 'workbench', 'bridge', 'kb-data', 'kb-knowledge', 'gitcfg'];
  const resolved = { R51_TEMP_ROOT: TEMP_ROOT, R51_EVIDENCE_ROOT: EVIDENCE_ROOT };
  for (const name of names) {
    const dir = path.join(iso, name);
    fs.mkdirSync(dir, { recursive: true });
    resolved[name] = dir;
  }
  const gitGlobal = path.join(resolved.gitcfg, 'gitconfig');
  if (!fs.existsSync(gitGlobal)) fs.writeFileSync(gitGlobal, '', 'utf8');
  const assign = {
    HOME: resolved.home, USERPROFILE: resolved.home,
    APPDATA: resolved.appdata, LOCALAPPDATA: resolved.localappdata,
    TEMP: resolved.tmp, TMP: resolved.tmp,
    CODEX_HOME: resolved.codex, CLAUDE_CONFIG_DIR: resolved.claude,
    CLAUDE_AI_WORKBENCH_DATA_DIR: resolved.workbench,
    AI_CODING_EVENT_BRIDGE_HOME: resolved.bridge,
    KB_DATA_DIR: resolved['kb-data'], KB_KNOWLEDGE_DATA_DIR: resolved['kb-knowledge'],
    // Deterministic git: no machine/global config can leak into fixture repos.
    GIT_CONFIG_GLOBAL: gitGlobal,
  };
  for (const [name, value] of Object.entries(assign)) process.env[name] = value;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  for (const [name, value] of Object.entries(assign)) {
    const absolute = path.resolve(value);
    if (absolute !== laneTmp && !absolute.startsWith(laneTmp + path.sep)) {
      throw new Error(`containment failure: ${name} -> ${absolute} escapes ${laneTmp}`);
    }
  }
  return {
    laneTmp,
    evidenceRoot: EVIDENCE_ROOT,
    envIsolationResolved: Object.fromEntries(Object.entries(assign).map(([k, v]) => [k, path.resolve(v)])),
    cleanup() { try { fs.rmSync(laneTmp, { recursive: true, force: true }); } catch {} },
  };
}

module.exports = { installLaneEnv, resolveChromeBeforeIsolation, TEMP_ROOT, EVIDENCE_ROOT, REPO_ROOT };
