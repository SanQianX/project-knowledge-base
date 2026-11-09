'use strict';

// P-ENGINE-OFFLINE-AUDIT-R45 lane harness (ENG-007 offline compensation
// boundary audit). Wraps the audited P-ENG-FINAL harness READ-ONLY: this file
// adds nothing but (1) driver-process environment isolation applied BEFORE the
// wrapped harness is required, and (2) a post-commit hook variant whose real
// bridge CLI is reachable but whose bridge home is an unwritable destination
// ("hook 不可达" fault: the CLI runs and fails, the journal never hears about
// the commit, Git itself is not blocked).
//
// Portability: no hardcoded drive letters. Temp/evidence roots resolve from
// R45_TEMP_ROOT / R45_EVIDENCE_ROOT when set, otherwise the OS temp dir and
// the repo-relative ignored artifacts dir. The wrapped harness additionally
// refuses temp roots inside the repository.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

// ---------- step 1: isolate the driver process environment ----------
const TEMP_ROOT = path.resolve(process.env.R45_TEMP_ROOT || path.join(os.tmpdir(), 'r45-engine-offline'));
const EVIDENCE_ROOT = path.resolve(process.env.R45_EVIDENCE_ROOT || path.join(REPO_ROOT, 'qa-autopilot', 'artifacts', 'parallel-20261023', 'engine-offline-audit-r45', 'evidence'));

if (TEMP_ROOT === REPO_ROOT || TEMP_ROOT.startsWith(REPO_ROOT + path.sep)) {
  throw new Error(`R45 temp root must live outside the repository (got ${TEMP_ROOT})`);
}
fs.mkdirSync(TEMP_ROOT, { recursive: true });
fs.mkdirSync(EVIDENCE_ROOT, { recursive: true });

const ISO = path.join(TEMP_ROOT, 'iso');
for (const dir of ['home', 'appdata', 'localappdata', 'tmp', 'codex', 'claude', 'workbench', 'bridge', 'kb-data', 'kb-knowledge']) {
  fs.mkdirSync(path.join(ISO, dir, Math.random().toString(36).slice(2)), { recursive: true });
}
function oneOf(name) {
  const dir = path.join(ISO, name);
  return fs.readdirSync(dir)[0] ? path.join(dir, fs.readdirSync(dir)[0]) : dir;
}
const envIsolation = {
  HOME: oneOf('home'), USERPROFILE: oneOf('home'),
  APPDATA: oneOf('appdata'), LOCALAPPDATA: oneOf('localappdata'),
  TEMP: oneOf('tmp'), TMP: oneOf('tmp'),
  CODEX_HOME: oneOf('codex'), CLAUDE_CONFIG_DIR: oneOf('claude'),
  CLAUDE_AI_WORKBENCH_DATA_DIR: oneOf('workbench'),
  AI_CODING_EVENT_BRIDGE_HOME: oneOf('bridge'),
  KB_DATA_DIR: oneOf('kb-data'), KB_KNOWLEDGE_DATA_DIR: oneOf('kb-knowledge'),
  PK_TEST_TEMP_ROOT: TEMP_ROOT,
};
for (const [name, value] of Object.entries(envIsolation)) process.env[name] = value;
// resolved-containment assertion for every isolated root
const resolved = Object.fromEntries(Object.entries(envIsolation).map(([k, v]) => [k, path.resolve(v)]));
for (const [k, v] of Object.entries(resolved)) {
  const root = path.resolve(TEMP_ROOT);
  if (v !== root && !v.startsWith(root + path.sep)) {
    throw new Error(`containment failure: ${k} -> ${v} escapes ${TEMP_ROOT}`);
  }
}

// ---------- step 2: require the audited harness (read-only reuse) ----------
const FINAL = require('./parallel-engine-final-harness.js');

// ---------- step 3: hook variants owned by this lane ----------
// dead-home: a regular FILE occupies the bridge home path, so the real CLI
// process starts, cannot create its journal destination, exits non-zero, and
// the hook propagates that fault. 'ok' matches the audited harness behaviour
// (real CLI, real home, output silenced) but is installed by this lane so the
// wrapped installer is never modified.
function installHookVariant(repoPath, { home, mode }) {
  const hookPath = path.join(repoPath, '.git', 'hooks', 'post-commit');
  const slash = value => value.replace(/\\/g, '/');
  const line = `"${slash(process.execPath)}" "${slash(FINAL.BRIDGE_CLI)}" --home "${slash(home)}" --cwd "${slash(repoPath)}"`;
  const script = mode === 'ok'
    ? ['#!/bin/sh', `${line} >/dev/null 2>&1`, 'exit 1', ''].join('\n')
    : ['#!/bin/sh', line, 'exit 1', ''].join('\n');
  fs.mkdirSync(path.dirname(hookPath), { recursive: true });
  fs.writeFileSync(hookPath, script, { mode: 0o755 });
  return { hookPath, mode, content: script };
}

function makeDeadHome(lane) {
  const dead = path.join(lane, 'dead-bridge-home');
  fs.writeFileSync(dead, 'not a directory: the bridge journal destination is unreachable\n');
  return dead;
}

module.exports = {
  ...FINAL,
  TEMP_ROOT,
  EVIDENCE_ROOT,
  ENV_ISOLATION_RESOLVED: resolved,
  installHookVariant,
  makeDeadHome,
};
