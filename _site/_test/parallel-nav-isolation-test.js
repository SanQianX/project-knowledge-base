'use strict';
// P-NAV-VECTOR-ISOLATION-R7 / P-NAV-POSIX-CI-R9 — offline negatives for the
// harness premise.
//
// The R7 incident: the engine constructor's built-in vectorUrl default
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
// The R9 legs (CI 40011886791: Linux-only NAV failures, Windows green):
//
//   4. POSIX socket-byte budget: the CI-failed Chrome SingletonSocket path
//      (120 UTF-8 bytes under the descriptive R7 component names) must be
//      rejected by the budget verdict, and the short POSIX components must
//      hold with margin, byte-for-byte including the Chrome suffix. Pure
//      string-contract checks — they prove the budget math everywhere, and
//      actual Linux proof stays with the next same-SHA CI run;
//   5. placement-aware real-home scan: values inside the OWNED root must not
//      be flagged as leaks merely because the hosted runner places the temp
//      root under the real home (the CI false positive on
//      PSModuleAnalysisCachePath), while true leaks outside the owned root
//      are still flagged.
//
// No browser, no product instance, no network: this is a driver-level test.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

const {
  enterNavIsolation, navIsolationReport, ISOLATION_KEYS,
  REAL_HOME, REAL_USERPROFILE,
  realHomeReferenceKeys, posixSocketBudgetVerdict, worstCasePosixSocketPaths,
  POSIX_SOCKET_CHAR_LIMIT,
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
    assert.deepEqual(report.referencesRealHome, [], 'no env value may reference the real home (outside the owned root; placement-aware since R9)');
    assert.deepEqual(report.redirectionFailures, [],
      'every isolation key that pointed at the real home before the whitelist must be redirected into the owned root');
    assert.ok(report.chromeDefaultProfileDirExists, 'the Chrome default-profile shape exists under the isolated USERPROFILE');
    assert.ok(report.psCacheParentExists, 'the PS module-analysis cache parent directory exists');
    assert.deepEqual(report.osWhitelistHeld, [], `nothing outside the OS whitelist and the isolation map survives: ${JSON.stringify(report.osWhitelistHeld)}`);
    // SystemRoot exists only on Windows; POSIX's OS floor is PATH alone.
    const osCritical = process.platform === 'win32' ? ['SystemRoot', 'PATH'] : ['PATH'];
    for (const key of osCritical) assert.ok(key in process.env, `OS-critical variable ${key} survives the whitelist (${process.platform})`);
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

  // --- 4. POSIX socket-byte budget (offline string contract; CI stays the
  //        Linux proof of record — this leg does not pretend Windows proves
  //        Linux, it proves the byte math is right everywhere) ---------------
  {
    // The exact CI 40011886791 failure shape: descriptive R7 components under
    // RUNNER_TEMP, Chrome's suffix rand observed at 6 chars.
    const ciFailedRoot = '/home/runner/work/_temp/pk-nav-r7-9399-ChZLZ5/pk-parallel-nav-nav004-pUkYfU';
    const ciFailedSocket = `${ciFailedRoot}/temp/com.google.Chrome.90mVLb/SingletonSocket`;
    assert.equal(Buffer.byteLength(ciFailedSocket, 'utf8'), 121,
      'the CI-failed SingletonSocket path is pinned at 121 UTF-8 bytes — 14 over the 107-char sun_path ceiling');
    const failed = posixSocketBudgetVerdict(ciFailedRoot);
    assert.ok(!failed.ok, 'the CI-failed root must be rejected by the POSIX socket budget');
    assert.ok(failed.chromeSocketBytes > POSIX_SOCKET_CHAR_LIMIT,
      `rejected with the computed worst case (${failed.chromeSocketBytes} bytes incl. the 12-char Chrome rand bound)`);

    // The R9 short components under the SAME runner temp: pkn<pid36><rand6>/
    // n<rand6>, with the 't' temp layout. pid 9399 → base36 '793'.
    const shortRoot = '/home/runner/work/_temp/pkn793abcdef/ghijkl';
    const worst = worstCasePosixSocketPaths(shortRoot);
    assert.equal(worst.chromeSingletonSocket, `${shortRoot}/t/com.google.Chrome.xxxxxxxxxxxx/SingletonSocket`,
      'the worst-case Chrome socket includes the full suffix, budgeted at the 12-char rand bound');
    assert.equal(worst.productRuntimeControlSock, `${shortRoot}/data/runtime-control.sock`,
      'the product runtime-control socket rides the same root (spawnServer dataDir = <fixture>/data)');
    const held = posixSocketBudgetVerdict(shortRoot);
    assert.ok(held.ok, `the short-component root must hold the budget: ${JSON.stringify({ chrome: held.chromeSocketBytes, control: held.controlSocketBytes })}`);
    assert.ok(POSIX_SOCKET_CHAR_LIMIT - held.chromeSocketBytes >= 10,
      `the short-component root holds with margin (limit ${POSIX_SOCKET_CHAR_LIMIT}, chrome worst case ${held.chromeSocketBytes})`);

    // Boundary: exactly at the limit passes, one byte over fails. The tail is
    // 49 ASCII bytes, so a 58-byte root lands exactly at the 107 ceiling.
    assert.equal(worstCasePosixSocketPaths('/tmp').chromeSingletonSocket.length - '/tmp'.length, 49,
      'the Chrome socket tail is pinned at 49 bytes (12-char rand bound)');
    assert.ok(posixSocketBudgetVerdict('/tmp/' + 'a'.repeat(53)).ok, 'a root landing exactly at the byte ceiling is accepted');
    assert.ok(!posixSocketBudgetVerdict('/tmp/' + 'a'.repeat(54)).ok, 'one byte over the ceiling is rejected');
    proof.posixSocketBudget = {
      ciFailedSocketBytes: Buffer.byteLength(ciFailedSocket, 'utf8'),
      ciFailedRootRejected: true,
      shortRoot,
      shortRootVerdict: { chromeSocketBytes: held.chromeSocketBytes, controlSocketBytes: held.controlSocketBytes, limit: held.limit },
      boundaryAcceptedBytes: posixSocketBudgetVerdict('/tmp/' + 'a'.repeat(53)).chromeSocketBytes,
      boundaryRejectedBytes: posixSocketBudgetVerdict('/tmp/' + 'a'.repeat(54)).chromeSocketBytes,
    };

    // Byte, not char, accounting: 'π' is one char but two UTF-8 bytes, so the
    // verdict must exceed the character count by exactly that delta.
    const multibyte = posixSocketBudgetVerdict('/tmp/π');
    assert.equal(multibyte.chromeSocketBytes, multibyte.paths.chromeSingletonSocket.length + 1,
      'the budget counts UTF-8 bytes, not chars');
  }

  // --- 5. placement-aware real-home scan (the CI false positive, offline) ---
  {
    // Hosted-runner placement: the owned temp root legitimately lives UNDER
    // the real home. Owned values must NOT be flagged (the CI failure flagged
    // PSModuleAnalysisCachePath exactly this way).
    const ownedRoot = '/home/runner/work/_temp/pkn793abcdef/ghijkl';
    const runnerHome = '/home/runner';
    const ownedEnv = {
      HOME: `${ownedRoot}/home`,
      USERPROFILE: `${ownedRoot}/home`,
      TEMP: `${ownedRoot}/t`,
      PSModuleAnalysisCachePath: `${ownedRoot}/ps-module-analysis-cache.bin`,
      CLAUDE_CONFIG_DIR: `${ownedRoot}/claude-config`,
      CODEX_HOME: `${ownedRoot}/codex-home`,
    };
    assert.deepEqual(realHomeReferenceKeys(ownedEnv, { root: ownedRoot, realHome: runnerHome, realUserProfile: runnerHome }), [],
      'owned values under a real-home-prefixed temp root are placement, not leaks (the R9 CI false positive)');

    // True leaks — outside the owned root while referencing the real home —
    // must still be flagged, both as canonical paths and as bare mentions.
    const leaking = {
      ...ownedEnv,
      CODEX_HOME: '/home/runner/.codex',
      KB_DATA_DIR: '/home/runner/.project-knowledge',
      RELEASE_NOTE: 'staged from /home/runner/real-secret.txt',
    };
    assert.deepEqual(
      realHomeReferenceKeys(leaking, { root: ownedRoot, realHome: runnerHome, realUserProfile: runnerHome }).sort(),
      ['CODEX_HOME', 'KB_DATA_DIR', 'RELEASE_NOTE'],
      'leaks outside the owned root stay flagged even when the owned root sits under the real home',
    );

    // R7: numeric and other NON-PATH values must never be classified as path
    // leaks. On the Linux runners the test CWD is /home/runner/work/... —
    // under the real home — so the unguarded path.resolve('0') of the R9
    // classifier canonically landed inside /home/runner and flagged
    // KB_MODULES_AUTOSTART at nav-isolation-test line 99. Path-shape gating
    // removes the phantom; every real leak above stays flagged.
    const flagsEnv = {
      ...ownedEnv,
      KB_MODULES_AUTOSTART: '0',
      KB_MODULES_REGISTER: '0',
      KB_EMBEDDING_FAKE: '1',
      FORCE_COLOR: '0',
      CI: 'true',
      KB_TERMINAL_URL: 'http://127.0.0.1:9',
      KB_TERMINAL_COMMAND: '',
    };
    assert.deepEqual(realHomeReferenceKeys(flagsEnv, { root: ownedRoot, realHome: runnerHome, realUserProfile: runnerHome }), [],
      'non-path values (numeric flags, booleans, dead URLs, empty strings) are never path leaks even when the CWD sits under the real home');
    const flagsWithRealLeak = { ...flagsEnv, KB_DATA_DIR: '/home/runner/.project-knowledge' };
    assert.deepEqual(
      realHomeReferenceKeys(flagsWithRealLeak, { root: ownedRoot, realHome: runnerHome, realUserProfile: runnerHome }),
      ['KB_DATA_DIR'],
      'the path-shape gate pardons flags without blinding the scan to a real home leak in the same environment',
    );
    proof.placementAwareRealHomeScan = {
      ownedRootUnderRealHome: ownedRoot,
      ownedValuesFlagged: 0,
      trueLeaksFlagged: ['CODEX_HOME', 'KB_DATA_DIR', 'RELEASE_NOTE'],
      nonPathFlagKeysUnflagged: Object.keys(flagsEnv).filter(key => !Object.keys(ownedEnv).includes(key)),
      ciFalsePositiveShape: 'PSModuleAnalysisCachePath under the owned RUNNER_TEMP no longer fails isolation-test line 82',
      r7CiFalsePositiveShape: "numeric flag '0' no longer resolves against the CWD into a phantom home leak (KB_MODULES_AUTOSTART at line 99)",
    };
  }

  proof.finishedAt = new Date().toISOString();
  proof.verdict = 'PASS — all three R7 negatives hold (poisoned env whitelisted with redirection proven, explicit URLs retained, constructor default proven live-port and always overridden by the shell) and both R9 contracts hold (POSIX socket-byte budget rejects the CI-failed root and holds with margin for the short components; the real-home scan is placement-aware without losing true-leak detection)';
  if (EVIDENCE) {
    fs.mkdirSync(EVIDENCE, { recursive: true });
    fs.writeFileSync(path.join(EVIDENCE, 'isolation-negatives.json'), JSON.stringify(proof, null, 2) + '\n', 'utf8');
  }
  console.log(JSON.stringify(proof, null, 2));
})().catch(error => {
  console.error(String(error && error.stack || error));
  process.exitCode = 1;
});
