'use strict';

// P-LIFECYCLE-EVIDENCE-R48 lane environment helper.
//
// Installs the driver-process isolation BEFORE any product/helper module is
// required: every redirected variable gets an OWN, existing root (never
// unset) with a resolved-containment assertion against the lane temp root.
// This deliberately does NOT reuse parallel-engine-final-harness isolatedEnv:
// that scrubber deletes KB_*/CODEX/CLAUDE* variables, and this lane's driver
// needs an explicit, valid KB_TERMINAL_URL-style setup where absence of a
// variable is never mistaken for a set one.
//
// Portability: roots come from R48_TEMP_ROOT / R48_EVIDENCE_ROOT when set,
// otherwise os.tmpdir() and the repo-relative ignored artifacts dir. No
// hardcoded drive letters; the temp root must live outside the repository.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const TEMP_ROOT = path.resolve(process.env.R48_TEMP_ROOT || process.env.PK_TEST_TEMP_ROOT || path.join(os.tmpdir(), 'r48-lifecycle-evidence'));
const EVIDENCE_ROOT = path.resolve(process.env.R48_EVIDENCE_ROOT || path.join(REPO_ROOT, 'qa-autopilot', 'artifacts', 'parallel-20261023', 'lifecycle-evidence-r48', 'evidence'));

function installLaneEnv({ caseId } = {}) {
  if (TEMP_ROOT === REPO_ROOT || TEMP_ROOT.startsWith(REPO_ROOT + path.sep)) {
    throw new Error(`R48 temp root must live outside the repository (got ${TEMP_ROOT})`);
  }
  fs.mkdirSync(TEMP_ROOT, { recursive: true });
  const laneTmp = fs.mkdtempSync(path.join(TEMP_ROOT, `r48-${caseId || 'lane'}-`));
  const iso = path.join(laneTmp, 'iso');
  const names = ['home', 'appdata', 'localappdata', 'tmp', 'codex', 'claude', 'workbench', 'bridge', 'kb-data', 'kb-knowledge'];
  const resolved = { R48_TEMP_ROOT: TEMP_ROOT, R48_EVIDENCE_ROOT: EVIDENCE_ROOT };
  for (const name of names) {
    const dir = path.join(iso, name);
    fs.mkdirSync(dir, { recursive: true });
    resolved[name] = dir;
  }
  const assign = {
    HOME: resolved.home, USERPROFILE: resolved.home,
    APPDATA: resolved.appdata, LOCALAPPDATA: resolved.localappdata,
    TEMP: resolved.tmp, TMP: resolved.tmp,
    CODEX_HOME: resolved.codex, CLAUDE_CONFIG_DIR: resolved.claude,
    CLAUDE_AI_WORKBENCH_DATA_DIR: resolved.workbench,
    AI_CODING_EVENT_BRIDGE_HOME: resolved.bridge,
    KB_DATA_DIR: resolved['kb-data'], KB_KNOWLEDGE_DATA_DIR: resolved['kb-knowledge'],
  };
  for (const [name, value] of Object.entries(assign)) process.env[name] = value;
  // Every redirected root must still resolve inside the lane temp root.
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

module.exports = { installLaneEnv, TEMP_ROOT, EVIDENCE_ROOT, REPO_ROOT };
