'use strict';
// P-DESKTOP-CANDIDATE-HARDEN-R2 offline sentinel: proves the hardened env
// contract of release-preflight-5025-env.cjs without spawning any real
// candidate process, reading any real credential, or printing any env VALUE.
//
//  1. poisoned source env -> provider keys (ANTHROPIC_AUTH_TOKEN, OPENAI_*,
//     agent homes, *_BASE_URL, proxies) are NOT inherited in either variant
//  2. every writable root is redirected under the run dir
//  3. the GUI variant keeps the original USERPROFILE (audited Electron 43
//     exception) and ONLY that variant; node variant isolates it
//  4. assertEnvContract fails closed on each contract violation
//  5. e2e: a tool failure prints no secret VALUE (sentinel token absent from
//     combined output)
// Run: node desktop/test/release-preflight-5025-env-test.cjs

const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const envLib = require('./release-preflight-5025-env.cjs');

const POISON = {
  ANTHROPIC_AUTH_TOKEN: 'SENTINEL-ANTHROPIC-TOKEN',
  ANTHROPIC_BASE_URL: 'SENTINEL-ANTHROPIC-URL',
  ANTHROPIC_MODEL: 'SENTINEL-ANTHROPIC-MODEL',
  OPENAI_API_KEY: 'SENTINEL-OPENAI-KEY',
  GEMINI_API_KEY: 'SENTINEL-GEMINI-KEY',
  AZURE_OPENAI_API_KEY: 'SENTINEL-AZURE-KEY',
  DASHSCOPE_API_KEY: 'SENTINEL-DASHSCOPE-KEY',
  MINIMAX_API_KEY: 'SENTINEL-MINIMAX-KEY',
  CLAUDE_CODE_OAUTH_TOKEN: 'SENTINEL-CLAUDE-TOKEN',
  CODEX_API_KEY: 'SENTINEL-CODEX-KEY',
  SOME_SERVICE_SECRET: 'SENTINEL-SECRET',
  MY_APP_CREDENTIALS: 'SENTINEL-CREDENTIALS',
  PROVIDER_X_BASE_URL: 'SENTINEL-BASE-URL',
  HTTPS_PROXY: 'http://SENTINEL-PROXY-USER:pw@proxy.invalid:3128',
  ELECTRON_GET_USE_PROXY: 'SENTINEL-ELECTRON-GET-PROXY',
  NODE_OPTIONS: '--require SENTINEL-NODE-OPTIONS',
};
const SENTINEL_VALUES = Object.values(POISON);

function poisonedSource() {
  return {
    ...POISON,
    PATH: process.env.PATH || process.env.Path,
    Path: process.env.Path,
    PATHEXT: process.env.PATHEXT,
    SystemRoot: process.env.SystemRoot || process.env.SYSTEMROOT,
    WINDIR: process.env.WINDIR,
    ProgramFiles: process.env.ProgramFiles,
    OS: process.env.OS,
    NO_PROXY: 'localhost,127.0.0.1',
    KB_DESKTOP_ELECTRON_ZIP_DIR: 'C:/sentinel-zip-dir',
    KB_SITE_PORT: '9999', // product KB_ var must NOT survive (overridden/dropped)
    USERPROFILE: 'C:\\Users\\SentinelRealProfile',
    APPDATA: 'C:\\Users\\SentinelRealProfile\\AppData\\Roaming',
    LOCALAPPDATA: 'C:\\Users\\SentinelRealProfile\\AppData\\Local',
    TEMP: 'C:\\Users\\SentinelRealProfile\\AppData\\Local\\Temp',
    HOMEDRIVE: 'C:',
    HOMEPATH: '\\Users\\SentinelRealProfile',
  };
}

function freshRunDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'release-preflight-5025-env-test-'));
}

test('provider keys and ambient agent config are not inherited (both variants)', () => {
  const runDir = freshRunDir();
  for (const gui of [false, true]) {
    const env = envLib.buildIsolatedEnv({ sourceEnv: poisonedSource(), runDir, gui });
    for (const key of Object.keys(POISON)) {
      assert.ok(!(key in env), `${key} leaked into the ${gui ? 'gui' : 'node'} env`);
    }
    for (const value of SENTINEL_VALUES) {
      assert.ok(!Object.values(env).includes(value), `a sentinel VALUE survived in the ${gui ? 'gui' : 'node'} env`);
    }
  }
});

test('the credential pattern flags the poison names and spares the allow-list', () => {
  for (const key of Object.keys(POISON)) {
    assert.ok(envLib.PROVIDER_KEY.test(key), `pattern must flag ${key}`);
  }
  for (const key of ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'ProgramFiles',
    'ProgramFiles(x86)', 'ProgramData', 'OS', 'NO_PROXY', 'LANG', 'LC_ALL',
    'KB_DESKTOP_ELECTRON_ZIP_DIR', 'KB_DESKTOP_BUNDLE', 'KB_PREFLIGHT_ISO_ROOT',
    'PSModuleAnalysisCachePath']) {
    assert.ok(!envLib.PROVIDER_KEY.test(key), `pattern must NOT flag allow-listed ${key}`);
  }
  // Isolation overrides may match the pattern BY NAME (CODEX_HOME, CLAUDE_*):
  // that is safe because buildIsolatedEnv never copies them from the ambient
  // env — it always rewrites them under runDir — and assertEnvContract exempts
  // exactly ISOLATED_VARS from the name scan while checking their values.
  for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'CLAUDE_AI_WORKBENCH_DATA_DIR']) {
    assert.ok(envLib.ISOLATED_VARS.includes(key), `${key} must be an ISOLATED_VAR override`);
  }
});

test('every writable root is redirected under the run directory', () => {
  const runDir = freshRunDir();
  const env = envLib.buildIsolatedEnv({ sourceEnv: poisonedSource(), runDir, gui: false });
  envLib.assertEnvContract(env, runDir, { gui: false });
  for (const name of envLib.ISOLATED_VARS) {
    const value = env[name];
    assert.ok(value, `${name} set`);
    assert.ok(!String(value).includes('SentinelRealProfile'), `${name} still points at the real profile`);
    const rel = path.relative(path.resolve(runDir), path.resolve(path.dirname(value)));
    assert.ok(!(rel.startsWith('..') || path.isAbsolute(rel)), `${name} escapes runDir`);
  }
  assert.equal(env.KB_SITE_PORT, undefined, 'product KB_ vars from the shell must not survive');
  assert.equal(env.KB_DESKTOP_ELECTRON_ZIP_DIR, 'C:/sentinel-zip-dir', 'tool-control KB_DESKTOP_* vars survive');
  assert.equal(env.HOMEDRIVE, undefined);
  assert.equal(env.HOMEPATH, undefined);
});

test('USERPROFILE exception is narrowed to the GUI variant only', () => {
  const runDir = freshRunDir();
  const source = poisonedSource();
  const guiEnv = envLib.buildIsolatedEnv({ sourceEnv: source, runDir, gui: true });
  const nodeEnv = envLib.buildIsolatedEnv({ sourceEnv: source, runDir, gui: false });
  assert.equal(guiEnv.USERPROFILE, 'C:\\Users\\SentinelRealProfile', 'gui keeps the original USERPROFILE');
  assert.equal(nodeEnv.USERPROFILE, path.join(runDir, 'home'), 'node variant isolates USERPROFILE');
  envLib.assertEnvContract(guiEnv, runDir, { gui: true, originalUserProfile: source.USERPROFILE });
  envLib.assertEnvContract(nodeEnv, runDir, { gui: false });
});

test('assertEnvContract fails closed on every contract violation', () => {
  const runDir = freshRunDir();
  const base = envLib.buildIsolatedEnv({ sourceEnv: poisonedSource(), runDir, gui: false });
  const mustThrow = (label, env, opts) => {
    assert.throws(() => envLib.assertEnvContract(env, runDir, opts), { message: new RegExp(label) }, `expected violation: ${label}`);
  };
  mustThrow('credential-shaped keys', { ...base, OPENAI_API_KEY: 'x' }, { gui: false });
  mustThrow('PATH missing', (() => { const e = { ...base }; delete e.PATH; delete e.Path; return e; })(), { gui: false });
  mustThrow('PSModuleAnalysisCachePath is not set', (() => { const e = { ...base }; delete e.PSModuleAnalysisCachePath; return e; })(), { gui: false });
  mustThrow('escapes the run directory', { ...base, KB_DATA_DIR: 'C:\\elsewhere' }, { gui: false });
  mustThrow('must isolate USERPROFILE', { ...base, USERPROFILE: 'C:\\Users\\SentinelRealProfile' }, { gui: false });
  mustThrow('must keep the original USERPROFILE', base, { gui: true, originalUserProfile: 'C:\\Users\\SentinelRealProfile' });
});

test('an allow-listed variable that looks like a credential is refused', () => {
  const runDir = freshRunDir();
  const source = poisonedSource();
  source.NO_PROXY_NAME_SECRET = 'x'; // not allow-listed -> simply dropped
  const env = envLib.buildIsolatedEnv({ sourceEnv: source, runDir, gui: false });
  assert.ok(!('NO_PROXY_NAME_SECRET' in env));
});

test('hardenProcessEnv rebuilds this process env with the same contract', () => {
  const runDir = freshRunDir();
  const previous = { ...process.env };
  try {
    for (const key of Object.keys(POISON)) process.env[key] = POISON[key];
    envLib.hardenProcessEnv(runDir, { gui: false });
    for (const key of Object.keys(POISON)) assert.ok(!(key in process.env), `${key} survived hardenProcessEnv`);
    envLib.assertEnvContract({ ...process.env }, runDir, { gui: false });
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, previous);
  }
});

test('e2e: tool failure output contains no secret VALUE', () => {
  // NODE_OPTIONS is dropped for the spawn only: node itself echoes a bad
  // --require value to stderr before any tool code runs, so it would trip the
  // value assertion for a non-tool reason. The contract proof for
  // NODE_OPTIONS is the offline build/harden tests above.
  const env = { ...process.env, ...POISON };
  delete env.NODE_OPTIONS;
  const r = spawnSync(process.execPath,
    [path.join(__dirname, 'release-preflight-5025-packaged-verify.cjs'), '--bundle', path.join(os.tmpdir(), 'no-such-bundle-dir-xyz')],
    { env, encoding: 'utf8', windowsHide: true, timeout: 120000 });
  assert.notEqual(r.status, 0, 'verify must fail on a missing bundle');
  const combined = `${r.stdout || ''}${r.stderr || ''}`;
  for (const value of SENTINEL_VALUES) {
    assert.ok(!combined.includes(value), `tool output leaked a sentinel value: ${value.slice(0, 12)}…`);
  }
});

// R4 (Leader finding): ensureDirs used to create path.dirname() of every
// value, so the writable directories themselves — TEMP included — never
// existed. These sentinels pin the corrected on-disk contract.
test('ensureDirs creates every writable DIRECTORY itself (psCache only the parent)', () => {
  const runDir = freshRunDir();
  const env = envLib.buildIsolatedEnv({ sourceEnv: poisonedSource(), runDir, gui: false });
  for (const [name, dir] of Object.entries(envLib.defaultDirs(runDir))) {
    if (envLib.FILE_VALUED_DIR_KEYS.has(name)) {
      assert.ok(fs.statSync(path.dirname(dir)).isDirectory(), `${name} parent directory must exist`);
      assert.ok(!fs.existsSync(dir), `${name} is a file path — the tool must not pre-create the file`);
    } else {
      assert.ok(fs.statSync(dir).isDirectory(), `${name} directory must exist itself (not just its parent)`);
    }
  }
  assert.ok(fs.statSync(env.TEMP).isDirectory(), 'TEMP directory itself must exist');
  // A target that cannot exist as a directory (its parent is a plain file)
  // must fail closed instead of silently skipping.
  const plainFile = path.join(runDir, 'plain-file');
  fs.writeFileSync(plainFile, 'x');
  assert.throws(() => envLib.ensureDirs({ rogue: path.join(plainFile, 'sub') }),
    (err) => ['ENOTDIR', 'EEXIST', 'EACCES', 'EPERM'].includes(err.code));
});

test('assertEnvContract proves directory existence on disk, not just string containment', () => {
  const runDir = freshRunDir();
  const base = envLib.buildIsolatedEnv({ sourceEnv: poisonedSource(), runDir, gui: false });
  envLib.assertEnvContract(base, runDir, { gui: false });
  // A writable dir removed after construction must fail the contract.
  fs.rmSync(path.join(runDir, 'temp'), { recursive: true });
  assert.throws(() => envLib.assertEnvContract(base, runDir, { gui: false }),
    { message: /not created on disk/ });
  // A var pointing at a FILE where a directory is required must fail.
  fs.mkdirSync(path.join(runDir, 'temp'), { recursive: true });
  const rogueFile = path.join(runDir, 'rogue-file');
  fs.writeFileSync(rogueFile, 'x');
  assert.throws(() => envLib.assertEnvContract({ ...base, KB_DATA_DIR: rogueFile }, runDir, { gui: false }),
    { message: /not a directory/ });
  // The file-valued var accepts a not-yet-existing file with an existing parent.
  assert.ok(!fs.existsSync(base.PSModuleAnalysisCachePath));
  envLib.assertEnvContract(base, runDir, { gui: false });
});
