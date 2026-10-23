'use strict';
// P-NAV-VECTOR-ISOLATION-R7 — offline negatives for the harness premise.
//
// The incident: the engine constructor's built-in vectorUrl default
// (http://127.0.0.1:8787) is the developer's LIVE desktop vector-hub, and a
// NAV-007 core-source-regression run wrote a real collection through it. The
// R7 fix has three legs; this test breaks each one off-line:
//
//   1. poisoned-env whitelist: ambient module URLs / provider credentials /
//      proxies / CLI injection / real-home directory variables set on the
//      driver are all gone after enterNavIsolation(), every isolation key
//      lands inside the short repo-external run root, and the required
//      directories (Chrome default-profile shape, PS cache parent) exist;
//   2. explicit-URL retention: values the harness sets AFTER the whitelist
//      (its explicit lane endpoints) are retained verbatim — the whitelist
//      deletes ambient values, not explicit ones;
//   3. constructor vectorUrl must be set: the real engine created WITHOUT a
//      vectorUrl really keeps the live-port default (the hazard, proven
//      against the real constructor), the explicit value wins when given,
//      and the nav shell source wires the stand-in before the engine.
//
// No browser, no product instance, no network: this is a driver-level test.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

const {
  enterNavIsolation, navIsolationReport, ISOLATION_KEYS,
  REAL_HOME, REAL_USERPROFILE,
} = require('./helpers/parallel-nav-isolation-env');

const ROOT = path.resolve(__dirname, '..', '..');
const ENGINE_ENTRY = path.join(ROOT, '_modules', 'knowledge-engine', 'src', 'server.js');
const SHELL_FILE = path.join(ROOT, '_site', '_test', 'helpers', 'parallel-nav-shell.js');
const EVIDENCE = process.env.PK_R7_EVIDENCE_DIR ? path.resolve(process.env.PK_R7_EVIDENCE_DIR) : null;

(async () => {
  const proof = { startedAt: new Date().toISOString() };

  // --- 1. a poisoned driver environment is fully whitelisted ---------------
  const POISON = {
    KB_VECTOR_HUB_URL: 'http://127.0.0.1:8787',
    KB_VECTORHUB_URL: 'http://127.0.0.1:8787',
    KB_KNOWLEDGE_ENGINE_URL: 'http://127.0.0.1:8787',
    KB_TERMINAL_URL: 'http://127.0.0.1:8787',
    KB_EVENT_BRIDGE_URL: 'http://127.0.0.1:8787',
    MINIMAX_API_KEY: 'pk-r7-poison',
    ANTHROPIC_API_KEY: 'pk-r7-poison',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:8787',
    NODE_OPTIONS: '--require pk-r7-poison.js',
    NODE_PATH: 'C:\\pk-r7-poison',
    HTTP_PROXY: 'http://127.0.0.1:8787',
    CLAUDE_CODE_OAUTH_TOKEN: 'pk-r7-poison',
    HOME: REAL_HOME,
    USERPROFILE: REAL_USERPROFILE,
    CODEX_HOME: path.join(REAL_HOME, '.codex'),
    CLAUDE_CONFIG_DIR: path.join(REAL_HOME, '.claude'),
    TEMP: path.join(REAL_HOME, 'AppData', 'Local', 'Temp'),
    KB_DATA_DIR: path.join(REAL_HOME, '.project-knowledge'),
    KB_KNOWLEDGE_DATA_DIR: path.join(REAL_HOME, '.project-knowledge-knowledge'),
  };
  const before = { ...process.env };
  Object.assign(process.env, POISON);
  try {
    const isolation = enterNavIsolation({ tag: 'isolation-negative' });
    const report = navIsolationReport(process.env, isolation);

    // Directory keys are OVERWRITTEN to isolated values, ambient keys are
    // DELETED outright — the poison must be gone either way.
    for (const [key, poisonValue] of Object.entries(POISON)) {
      if (ISOLATION_KEYS.includes(key)) {
        assert.ok(key in process.env, `isolation key ${key} must be set`);
        assert.notEqual(process.env[key], poisonValue, `poison value of ${key} must not survive the whitelist`);
      } else {
        assert.ok(!(key in process.env), `poison ${key} must not survive the whitelist`);
      }
    }
    assert.ok(report.noAmbientSurvives, `ambient deletes all hold: ${JSON.stringify(report.ambientDeleted)}`);
    assert.ok(report.allIsolationKeysInsideRoot, `every isolation key points inside the run root: ${JSON.stringify(report.isolationKeys)}`);
    assert.deepEqual(report.referencesRealHome, [], 'no env value may reference the real home');
    assert.ok(report.chromeDefaultProfileDirExists, 'the Chrome default-profile shape exists under the isolated USERPROFILE');
    assert.ok(report.psCacheParentExists, 'the PS module-analysis cache parent directory exists');
    assert.deepEqual(report.osWhitelistHeld, [], `nothing outside the OS whitelist and the isolation map survives: ${JSON.stringify(report.osWhitelistHeld)}`);
    assert.ok('SystemRoot' in process.env && 'PATH' in process.env, 'OS-critical variables survive the whitelist');
    assert.notEqual(process.env.HOME, REAL_HOME, 'HOME must not be the real home');
    proof.poisonedEnvWhitelisted = {
      poisonKeys: Object.keys(POISON).length,
      isolationKeysInsideRoot: report.isolationKeys,
      chromeDefaultProfileDir: isolation.layout.chromeDefaultProfileDir,
      psCachePath: isolation.layout.psCachePath,
      runRoot: isolation.root,
    };

    // --- 2. explicit lane endpoints set AFTER the whitelist are retained ---
    const LANE_URL = 'http://127.0.0.1:9';
    process.env.KB_VECTORHUB_URL = LANE_URL;
    process.env.KB_KNOWLEDGE_ENGINE_URL = LANE_URL;
    process.env.PK_R7_EXPLICIT_CANARY = 'explicit';
    assert.equal(process.env.KB_VECTORHUB_URL, LANE_URL, 'an explicit lane endpoint must be retained, not the poisoned 8787');
    assert.equal(process.env.KB_KNOWLEDGE_ENGINE_URL, LANE_URL, 'an explicit engine endpoint must be retained');
    proof.explicitUrlRetention = { KB_VECTORHUB_URL: process.env.KB_VECTORHUB_URL, KB_KNOWLEDGE_ENGINE_URL: process.env.KB_KNOWLEDGE_ENGINE_URL };

    isolation.restore();
    // restore() must faithfully put back exactly what enterNavIsolation saw —
    // which was the POISONED environment, not the pristine one. Compare by key
    // names only: printing values would echo live secrets from the real env.
    {
      const expected = { ...before, ...POISON };
      const actualKeys = new Set(Object.keys(process.env));
      const onlyActual = [...actualKeys].filter(key => !(key in expected));
      const onlyExpected = Object.keys(expected).filter(key => !actualKeys.has(key));
      const changed = [...actualKeys].filter(key => key in expected && process.env[key] !== expected[key]);
      assert.deepEqual({ onlyActual, onlyExpected, changedKeys: changed }, { onlyActual: [], onlyExpected: [], changedKeys: [] },
        'restore() must put the entered (poisoned-input) environment back exactly');
    }
    assert.equal(process.env.KB_VECTORHUB_URL, POISON.KB_VECTORHUB_URL, 'restore puts the pre-enter value back');
    assert.ok(!('PK_R7_EXPLICIT_CANARY' in process.env), 'keys added during isolation must not survive restore');
    assert.ok(fs.existsSync(path.dirname(isolation.root)), 'the stable parent temp survives a serial run (no dangling os.tmpdir)');
    proof.restoreFaithful = { canaryGone: true, stableParentSurvives: true };
  } finally {
    for (const key of Object.keys(POISON)) {
      if (!(key in before)) delete process.env[key];
      else process.env[key] = before[key];
    }
  }

  // --- 3. constructor vectorUrl must be set (the default IS the live port) --
  const iso2 = enterNavIsolation({ tag: 'isolation-negative-engine' });
  let engines = [];
  try {
    const { createEngineServer } = require(ENGINE_ENTRY);
    const dirMissing = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-nav-r7-engine-default-'));
    const missing = createEngineServer({ dataDir: dirMissing, runtimeToken: 'pk-r7', debug: false, consume: false });
    engines.push(missing);
    assert.equal(missing.coordinator.vectorUrl, 'http://127.0.0.1:8787',
      'an engine created without vectorUrl keeps the LIVE-port default — the exact incident premise');

    const dirExplicit = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-nav-r7-engine-explicit-'));
    const explicit = createEngineServer({ dataDir: dirExplicit, runtimeToken: 'pk-r7', debug: false, consume: false, vectorUrl: 'http://127.0.0.1:9' });
    engines.push(explicit);
    assert.equal(explicit.coordinator.vectorUrl, 'http://127.0.0.1:9', 'an explicit vectorUrl wins over the default');

    const shellSource = fs.readFileSync(SHELL_FILE, 'utf8');
    assert.match(shellSource, /vectorUrl:\s*moduleUi\.url/, 'the nav shell must pass the stand-in URL to the engine constructor');
    assert.match(shellSource, /bridgeUrl:\s*moduleUi\.url/, 'the nav shell must also override the live BridgeClient default');
    assert.ok(shellSource.indexOf('await moduleUi.start()') < shellSource.indexOf('createEngineServer('),
      'the vector stand-in must start before the engine is created');
    assert.match(shellSource, /engine\.coordinator\.vectorUrl,\s*moduleUi\.url/, 'the harness asserts the live vectorUrl at every start');
    proof.constructorVectorUrl = {
      defaultWithoutOption: missing.coordinator.vectorUrl,
      withExplicitOption: explicit.coordinator.vectorUrl,
      shellWiresStandInBeforeEngine: true,
    };
  } finally {
    for (const engine of engines) await engine.close().catch(() => {});
    iso2.restore();
  }

  proof.finishedAt = new Date().toISOString();
  proof.verdict = 'PASS — all three R7 negatives hold (poisoned env whitelisted, explicit URLs retained, constructor default proven live-port and always overridden by the shell)';
  if (EVIDENCE) {
    fs.mkdirSync(EVIDENCE, { recursive: true });
    fs.writeFileSync(path.join(EVIDENCE, 'isolation-negatives.json'), JSON.stringify(proof, null, 2) + '\n', 'utf8');
  }
  console.log(JSON.stringify(proof, null, 2));
})().catch(error => {
  console.error(String(error && error.stack || error));
  process.exitCode = 1;
});
