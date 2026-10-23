'use strict';
// P-WB-CANONICAL-R2 offline env self-check — the free, offline validation that
// the canonical suite's NEW wiring actually holds. No browser, no model, no
// real profile read, no network: it only exercises the launcher's gates and
// isolation in real child processes and re-validates the pure machine
// definitions. Run via the integration-5025 runner (--run env) or --check.
//
//   1. GATES: a paid entry without PK_WB_ALLOW_PAID_TURNS=1 refuses, and an
//      entry that reads the original profile without an EXPLICIT
//      PK_WB_REAL_PROFILE_DIR refuses — both BEFORE any environment mutation.
//   2. FULL BOOT in a real child: after boot, every whitelist path key points
//      inside the per-run layout root, ambient module/credential vars are
//      gone, and the carried-through captures (module root, installed product
//      package) equal the parent's pre-isolation discovery.
//   3. IDENTITY CARRY-THROUGH: the installed-product label computed by the
//      canonical harness AFTER isolation matches the parent's real-environment
//      expectation — the AppData install can no longer be mislabelled as a
//      repository pin (the exact regression the R2 dispatch ordered fixed).
//   4. RUNNER ENV: buildRunnerChildEnv drops everything except the documented
//      whitelist — ambient Anthropic credentials and arbitrary developer vars
//      never reach a probe child — and never invents a real profile path.
//   5. PURE FRAGMENT: the machine-definition fragment carries no run
//      conclusions (networkUsed/gitHistoryUsed/status/outcome/verdict/
//      resolved as KEYS) and all 50 line anchors resolve against the current
//      canonical sources.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const launcher = require('./helpers/parallel-workbench-integration-5025-launcher');
const fixture = require('./helpers/parallel-workbench-integration-5025-fixture');
const sourceMap = require('./helpers/parallel-workbench-source-map');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FRAGMENT = path.join(REPO_ROOT, 'qa-autopilot', 'artifacts', 'parallel-20261023', 'workbench-integration-5025', 'bindings.fragment.json');

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: Boolean(pass), detail: String(detail) });
  console.log(`${pass ? 'ok' : 'FAIL'} ${name} — ${detail}`);
}

// R3 offline poison sentinels — every value is newly invented; none is a real
// credential, and the sentinel checks only ever print these names/values.
// NODE_OPTIONS must stay startup-safe (--max-old-space-size is accepted by
// node and harmless) so a poisoned child can actually boot far enough to
// report; survival is caught by exact-value comparison either way.
const POISON_ENV = {
  OPENAI_API_KEY: 'sk-i5025-sentinel-openai',
  MINIMAX_API_KEY: 'sk-i5025-sentinel-minimax',
  GOOGLE_API_KEY: 'sk-i5025-sentinel-google',
  AWS_ACCESS_KEY_ID: 'AKIAI5025SENTINEL',
  CODEX_API_KEY: 'sk-i5025-sentinel-codex',
  ANTHROPIC_API_KEY: 'sk-i5025-sentinel-anthropic',
  NODE_OPTIONS: '--max-old-space-size=1233',
  HTTPS_PROXY: 'http://127.0.0.1:59989',
  HTTP_PROXY: 'http://127.0.0.1:59989',
  ALL_PROXY: 'http://127.0.0.1:59989',
  KB_KNOWLEDGE_ENGINE_URL: 'http://127.0.0.1:8787',
  KB_VECTORHUB_URL: 'http://127.0.0.1:8790',
};

// --- child mode: run boot and report the post-isolation snapshot -------------
// The parent launches this child with a POISONED copy of the real environment
// (only invented sentinel values added). The snapshot never serializes real
// machine values: pre-boot originals are compared IN the child and only key
// names / booleans / isolated per-run values leave the process.
if (process.argv[2] === '--child-boot') {
  const preBoot = {};
  for (const key of fixture.ISOLATION_PATH_KEYS) preBoot[key] = process.env[key] || null;
  const boot = launcher.boot({ prefix: 'i5025-env-check', paid: false, needsRealProfile: false, requireChrome: false });
  // Keys the lane itself mandates (the isolation map's KB_MODULES_AUTOSTART=0)
  // are not ambient survivors — the dispatch requires the lane value to be kept.
  const LANE_SET = { KB_MODULES_AUTOSTART: '0' };
  const whitelist = {};
  for (const key of fixture.ISOLATION_PATH_KEYS) whitelist[key] = process.env[key];
  const harness = require('./helpers/parallel-workbench-integration-5025-runtime-harness');
  const moduleRoot = boot.discovery.moduleRoot;
  const identity = harness.moduleIdentity(moduleRoot);
  const dirState = value => {
    if (!value) return { present: false, exists: false, isDir: false, insideRoot: false };
    let exists = false;
    let isDir = false;
    try { const stat = fs.statSync(value); exists = true; isDir = stat.isDirectory(); } catch { /* reported as absent */ }
    return { present: true, exists, isDir, insideRoot: isInside(value, boot.layout.root) };
  };
  const psCache = process.env.PSModuleAnalysisCachePath || null;
  const psParent = psCache ? path.dirname(psCache) : null;
  const snapshot = {
    layoutRoot: boot.layout.root,
    whitelist,
    redirectedOffenders: Object.keys(whitelist).filter(key => preBoot[key] && path.resolve(whitelist[key]) === path.resolve(preBoot[key])),
    ambientPresent: [...fixture.AMBIENT_MODULE_URLS, ...fixture.AMBIENT_MODEL_ENV].filter(key => process.env[key] !== undefined && process.env[key] !== LANE_SET[key]),
    overrides: {
      moduleRoot: process.env.PK_WB_MODULE_ROOT || null,
      installedProductModule: process.env.PK_WB_INSTALLED_PRODUCT_MODULE || null,
      chrome: process.env.PK_WB_CHROME || null,
      realProfileDir: process.env.PK_WB_REAL_PROFILE_DIR || null,
    },
    installedProductPackage: fixture.installedProductPackage(),
    identityLabel: identity.label,
    identityRoot: identity.root,
    sentinelSurvivors: Object.keys(POISON_ENV).filter(key => process.env[key] !== undefined),
    sentinelValueLeaks: Object.keys(POISON_ENV).filter(key => {
      const poison = POISON_ENV[key];
      return Object.values(process.env).some(value => value === poison);
    }),
    autostart: process.env.KB_MODULES_AUTOSTART || null,
    kbEngineUrlPoisoned: process.env.KB_KNOWLEDGE_ENGINE_URL === POISON_ENV.KB_KNOWLEDGE_ENGINE_URL,
    psModuleCache: {
      insideRoot: psCache ? isInside(psCache, boot.layout.root) : false,
      parentDir: psParent ? dirState(psParent) : null,
    },
    tempDirs: {
      TEMP: dirState(process.env.TEMP),
      TMP: dirState(process.env.TMP),
      TMPDIR: dirState(process.env.TMPDIR),
    },
  };
  fixture.removeTree(boot.layout.root);
  console.log(`I5025_ENV_CHILD ${JSON.stringify(snapshot)}`);
  process.exit(0);
}

function isInside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function main() {
  // --- 1. gates (in-process; they run before any mutation) -------------------
  {
    const savedPaid = process.env.PK_WB_ALLOW_PAID_TURNS;
    const savedProfile = process.env.PK_WB_REAL_PROFILE_DIR;
    delete process.env.PK_WB_ALLOW_PAID_TURNS;
    delete process.env.PK_WB_REAL_PROFILE_DIR;
    let paidRefused = false;
    try { launcher.boot({ paid: true, needsRealProfile: true, requireChrome: false }); } catch (error) { paidRefused = error.code === 'PK_WB_BOOT_REFUSED'; }
    let profileRefused = false;
    process.env.PK_WB_ALLOW_PAID_TURNS = '1';
    try { launcher.boot({ paid: true, needsRealProfile: true, requireChrome: false }); } catch (error) { profileRefused = error.code === 'PK_WB_BOOT_REFUSED'; }
    check('gate-paid-flag', paidRefused, paidRefused ? 'paid entry without PK_WB_ALLOW_PAID_TURNS=1 refused before any env mutation' : 'the paid gate did not refuse');
    check('gate-explicit-profile-path', profileRefused, profileRefused ? 'real-profile entry without an explicit PK_WB_REAL_PROFILE_DIR refused (no default real-profile discovery)' : 'the explicit-profile gate did not refuse');
    if (savedPaid === undefined) delete process.env.PK_WB_ALLOW_PAID_TURNS; else process.env.PK_WB_ALLOW_PAID_TURNS = savedPaid;
    if (savedProfile === undefined) delete process.env.PK_WB_REAL_PROFILE_DIR; else process.env.PK_WB_REAL_PROFILE_DIR = savedProfile;
  }

  // The parent's own real-environment discovery — the reference the child must
  // reproduce through its carried-through captures.
  const parentModuleRoot = fixture.resolveHostModuleRoot();
  const parentInstalled = sourceMap.resolveInstalledProductPackage();
  const expectedLabel = parentModuleRoot && parentModuleRoot === parentInstalled
    ? 'currently-installed-package:installed-product'
    : 'currently-installed-package:repository-pin';

  // --- 2 + 3. full boot inside a real child launched with a POISONED copy of --
  // the real environment (R3): the direct-entry path must scrub provider
  // credentials / NODE_OPTIONS / proxy URLs / ambient module URLs BY
  // WHITELIST REBUILD, keep the lane flags, and leave PS-module-cache + TEMP
  // as real directories inside the isolation root.
  {
    const child = spawnSync(process.execPath, [__filename, '--child-boot'], {
      encoding: 'utf8', windowsHide: true, timeout: 120000,
      env: { ...process.env, ...POISON_ENV },
    });
    const line = String(child.stdout || '').split(/\r?\n/).find(text => text.startsWith('I5025_ENV_CHILD '));
    const snapshot = line ? JSON.parse(line.slice('I5025_ENV_CHILD '.length)) : null;
    if (!snapshot) {
      check('child-boot', false, `child did not report a snapshot (status=${child.status} stderr=${String(child.stderr || '').slice(0, 300)})`);
    } else {
      const pathKeys = Object.keys(snapshot.whitelist);
      const allInside = pathKeys.every(key => isInside(path.resolve(snapshot.whitelist[key]), snapshot.layoutRoot));
      check('child-boot-full-whitelist', allInside && pathKeys.length >= 13, `all ${pathKeys.length} whitelist path keys inside the per-run layout root (${allInside ? 'yes' : 'NO'})`);
      check('child-boot-real-values-redirected', snapshot.redirectedOffenders.length === 0, snapshot.redirectedOffenders.length === 0 ? 'every whitelist path key that had a real-machine value is redirected off it by boot (compared in-child; no real values serialized)' : `keys that kept their real-machine value: ${snapshot.redirectedOffenders.join(',')}`);
      check('child-boot-ambient-stripped', snapshot.ambientPresent.length === 0, snapshot.ambientPresent.length === 0 ? 'no ambient module/credential var survived boot' : `survivors: ${snapshot.ambientPresent.join(',')}`);
      const carriedThrough = snapshot.overrides.moduleRoot === parentModuleRoot
        && snapshot.overrides.installedProductModule === parentInstalled
        && (!parentInstalled || snapshot.installedProductPackage === parentInstalled);
      check('child-boot-captures-carried', carriedThrough, `moduleRoot and installed-product package equal the parent's pre-isolation discovery (${carriedThrough ? 'yes' : `child=${snapshot.overrides.installedProductModule} parent=${parentInstalled}`})`);
      check('identity-label-survives-isolation', snapshot.identityLabel === expectedLabel, `post-isolation label "${snapshot.identityLabel}" === real-environment expectation "${expectedLabel}" (root=${snapshot.identityRoot})`);

      // R3 poison sentinels — direct-entry boot path.
      check('poison-env-scrubbed-direct-boot', snapshot.sentinelSurvivors.length === 0 && snapshot.sentinelValueLeaks.length === 0, snapshot.sentinelSurvivors.length === 0 && snapshot.sentinelValueLeaks.length === 0
        ? 'OPENAI/MINIMAX/GOOGLE/AWS/CODEX/ANTHROPIC keys, NODE_OPTIONS, proxy URLs and ambient module URLs are all gone after a real boot (no sentinel value survives under any key)'
        : `survivors: ${snapshot.sentinelSurvivors.join(',')} value-leaks: ${snapshot.sentinelValueLeaks.join(',')}`);
      check('poison-lane-values-kept-direct-boot', snapshot.autostart === '0' && !snapshot.kbEngineUrlPoisoned, `KB_MODULES_AUTOSTART=0 kept and the ambient module-URL poison did not resurface (${snapshot.autostart === '0' && !snapshot.kbEngineUrlPoisoned ? 'yes' : `autostart=${snapshot.autostart} engineUrlPoisoned=${snapshot.kbEngineUrlPoisoned}`})`);
      const psOk = snapshot.psModuleCache.insideRoot && snapshot.psModuleCache.parentDir && snapshot.psModuleCache.parentDir.exists && snapshot.psModuleCache.parentDir.isDir;
      check('ps-module-cache-in-isolation-root', psOk, psOk ? 'PSModuleAnalysisCachePath points inside the isolation root and its parent directory really exists on disk' : `insideRoot=${snapshot.psModuleCache.insideRoot} parentDir=${JSON.stringify(snapshot.psModuleCache.parentDir)}`);
      const tempEntries = Object.entries(snapshot.tempDirs);
      const tempOk = tempEntries.every(([, state]) => state.exists && state.isDir && state.insideRoot);
      check('temp-dirs-really-exist-in-isolation', tempOk, tempOk
        ? `TEMP/TMP/TMPDIR all exist as real directories inside the isolation root (fs.statSync verified, not string checks): ${tempEntries.map(([name]) => name).join('/')}`
        : `bad temp dir states: ${tempEntries.filter(([, state]) => !(state.exists && state.isDir && state.insideRoot)).map(([name]) => name).join(',')}`);
    }
  }

  // --- 4. the runner child env builder ----------------------------------------
  {
    const fakeSource = {
      PATH: 'C:\\windows\\system32', SystemRoot: 'C:\\windows', TEMP: 'C:\\Users\\dev\\AppData\\Local\\Temp',
      ANTHROPIC_API_KEY: 'sk-should-never-pass', KB_KNOWLEDGE_ENGINE_URL: 'http://127.0.0.1:8787',
      PK_WB_ALLOW_PAID_TURNS: '1', SOME_DEVELOPER_JUNK: 'junk',
    };
    const envPlain = launcher.buildRunnerChildEnv(fakeSource, { moduleRoot: 'C:\\mod', installedProductPackage: 'C:\\pkg', chrome: 'C:\\chrome.exe' });
    const envAuthorized = launcher.buildRunnerChildEnv(fakeSource, { moduleRoot: 'C:\\mod', installedProductPackage: 'C:\\pkg', chrome: 'C:\\chrome.exe', realProfileDir: 'C:\\profiles' });
    const ambientFree = !Object.keys(envPlain).some(key => launcher.RUNNER_ENV_PASSTHROUGH.includes(key) === false && key !== 'PK_WB_SAFE_LAUNCH' && !key.startsWith('PK_WB_'));
    check('runner-env-whitelist-only', ambientFree && envPlain.SystemRoot === 'C:\\windows' && envPlain.PATH === fakeSource.PATH, `only documented keys survive (junk/credentials dropped: ${!('SOME_DEVELOPER_JUNK' in envPlain) && !('ANTHROPIC_API_KEY' in envPlain) && !('KB_KNOWLEDGE_ENGINE_URL' in envPlain)})`);
    check('runner-env-captures-forwarded', envPlain.PK_WB_MODULE_ROOT === 'C:\\mod' && envPlain.PK_WB_INSTALLED_PRODUCT_MODULE === 'C:\\pkg' && envPlain.PK_WB_CHROME === 'C:\\chrome.exe' && envPlain.PK_WB_SAFE_LAUNCH === '1', 'runner captures forwarded as explicit overrides');
    check('runner-env-profile-only-when-authorized', envPlain.PK_WB_REAL_PROFILE_DIR === undefined && envAuthorized.PK_WB_REAL_PROFILE_DIR === 'C:\\profiles', 'no real profile path unless the operator passed one explicitly');

    // R3: the runner child env scrubs provider/NODE_OPTIONS/proxy/module-URL
    // poison even in Windows case variants, while whitelisted system vars
    // survive under ANY casing (Path/PATH, SystemRoot/SYSTEMROOT).
    const poisonSource = {
      Path: 'C:\\windows\\system32', SYSTEMROOT: 'C:\\Windows', TEMP: 'C:\\Users\\dev\\AppData\\Local\\Temp',
      NODE_OPTIONS: POISON_ENV.NODE_OPTIONS, node_options: '--max-old-space-size=1234',
      OPENAI_API_KEY: POISON_ENV.OPENAI_API_KEY, openai_api_key: 'sk-i5025-sentinel-openai-lower',
      MINIMAX_API_KEY: POISON_ENV.MINIMAX_API_KEY, CODEX_API_KEY: POISON_ENV.CODEX_API_KEY,
      HTTPS_PROXY: POISON_ENV.HTTPS_PROXY, KB_KNOWLEDGE_ENGINE_URL: POISON_ENV.KB_KNOWLEDGE_ENGINE_URL,
    };
    const envPoisoned = launcher.buildRunnerChildEnv(poisonSource, {});
    const lowered = Object.keys(envPoisoned).map(key => key.toLowerCase());
    const poisonNames = ['node_options', 'openai_api_key', 'minimax_api_key', 'codex_api_key', 'https_proxy', 'kb_knowledge_engine_url'];
    check('runner-env-poison-scrubbed', !poisonNames.some(name => lowered.includes(name)), !poisonNames.some(name => lowered.includes(name))
      ? 'provider credentials, NODE_OPTIONS (incl. case variants), proxy URLs and ambient module URLs never reach a runner child'
      : `leaks: ${poisonNames.filter(name => lowered.includes(name)).join(',')}`);
    check('runner-env-whitelist-case-insensitive', envPoisoned.Path === poisonSource.Path && envPoisoned.SYSTEMROOT === poisonSource.SYSTEMROOT, `whitelisted system vars survive under real Windows casing (Path=${envPoisoned.Path === poisonSource.Path}, SYSTEMROOT=${envPoisoned.SYSTEMROOT === poisonSource.SYSTEMROOT})`);
  }

  // --- 4b. fixture child base env: whitelist rebuild + lane values (R3) -------
  // hostEnv feeds every host/census child; with the parent env poisoned it
  // must still be built ONLY from the system whitelist, keep the complete
  // isolation map (incl. PSModuleAnalysisCachePath + real TEMP dirs), and let
  // the lane's explicit endpoint/fake markers win.
  {
    const saved = {};
    for (const [key, value] of Object.entries(POISON_ENV)) { saved[key] = process.env[key]; process.env[key] = value; }
    try {
      const layout = fixture.createIsolationLayout('i5025-env-check-hostenv');
      const laneExtras = { KB_KNOWLEDGE_ENGINE_URL: 'http://127.0.0.1:59990', PK_WB_PROFILE_SOURCE: 'real-readonly', PK_WB_FAKE_MARKER: 'i5025-fake' };
      const hostChildEnv = fixture.hostEnv(layout, laneExtras);
      const poisonValues = new Set(Object.values(POISON_ENV));
      // A lane-specified key is expected to be present — with the LANE value,
      // never the poison value (the leakedValues scan below proves that).
      const laneKeys = new Set(Object.keys(laneExtras));
      const poisonedKeys = Object.keys(POISON_ENV).filter(key => !laneKeys.has(key) && hostChildEnv[key] !== undefined);
      const leakedValues = Object.values(hostChildEnv).filter(value => poisonValues.has(value)).length;
      check('fixture-hostenv-whitelist-rebuild', poisonedKeys.length === 0 && leakedValues === 0, poisonedKeys.length === 0 && leakedValues === 0
        ? 'hostEnv is rebuilt from the system whitelist only — no poison key, no poison value under any key'
        : `keys: ${poisonedKeys.join(',')} values: ${leakedValues}`);
      const psParentDir = path.dirname(hostChildEnv.PSModuleAnalysisCachePath);
      const laneKept = hostChildEnv.KB_KNOWLEDGE_ENGINE_URL === laneExtras.KB_KNOWLEDGE_ENGINE_URL
        && hostChildEnv.PK_WB_PROFILE_SOURCE === 'real-readonly'
        && hostChildEnv.PK_WB_FAKE_MARKER === 'i5025-fake'
        && hostChildEnv.KB_MODULES_AUTOSTART === '0'
        && isInside(path.resolve(hostChildEnv.PSModuleAnalysisCachePath), layout.root)
        && fs.statSync(psParentDir).isDirectory()
        && fs.statSync(hostChildEnv.TEMP).isDirectory()
        && isInside(path.resolve(hostChildEnv.TEMP), layout.root);
      check('fixture-hostenv-lane-values-kept', laneKept, laneKept
        ? 'lane-specified module URL + fake/probe markers kept, KB_MODULES_AUTOSTART=0 kept, PS cache + TEMP are real dirs inside the isolation root'
        : `engineUrl=${hostChildEnv.KB_KNOWLEDGE_ENGINE_URL} autostart=${hostChildEnv.KB_MODULES_AUTOSTART}`);
      fixture.removeTree(layout.root);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  }

  // --- 5. the pure fragment ----------------------------------------------------
  {
    if (!fs.existsSync(FRAGMENT)) {
      check('fragment-absent-outside-git', true, `${path.relative(REPO_ROOT, FRAGMENT)} is not present — qa-autopilot/artifacts is gitignored delivery-time evidence; the durable tracked binding store is qa-autopilot/config/product-case-assertions.json, so the two fragment legs below only run where the delivered artifact exists`);
    }
    let fragment = null;
    try { fragment = JSON.parse(fs.readFileSync(FRAGMENT, 'utf8')); } catch (error) {
      if (fs.existsSync(FRAGMENT)) check('fragment-load', false, `cannot read ${path.relative(REPO_ROOT, FRAGMENT)}: ${error.message}`);
    }
    if (fragment) {
      const forbidden = new Set(['networkUsed', 'gitHistoryUsed', 'status', 'outcome', 'verdict', 'resolved', 'pass', 'fail']);
      const offenders = [];
      (function walk(node, trail) {
        if (!node || typeof node !== 'object') return;
        for (const [key, value] of Object.entries(node)) {
          if (forbidden.has(key.toLowerCase()) && !trail.endsWith('.note')) offenders.push(`${trail}.${key}`);
          walk(value, `${trail}.${key}`);
        }
      })(fragment, '');
      check('fragment-no-run-conclusions', offenders.length === 0, offenders.length === 0 ? 'machine definition carries no run-conclusion keys' : `offenders: ${offenders.join(', ')}`);

      let bindings = [];
      for (const caseEntry of Object.values(fragment.cases || {})) {
        for (const expected of caseEntry.expected || []) bindings = bindings.concat(expected.bindings || []);
      }
      let anchorOk = 0;
      const drift = [];
      for (const binding of bindings) {
        const file = path.join(REPO_ROOT, binding.file);
        let lines;
        try { lines = fs.readFileSync(file, 'utf8').split(/\r?\n/); } catch { drift.push(`${binding.id}: file missing`); continue; }
        const at = lines[binding.line - 1] || '';
        // exact match first; a source line with escaped quotes still matches
        // after backslash-normalisation
        const hit = at.includes(binding.anchor)
          || at.replace(/\\/g, '').includes(binding.anchor.replace(/\\/g, ''));
        if (hit) anchorOk += 1; else drift.push(`${binding.id} @ ${binding.file}:${binding.line}`);
      }
      check('fragment-50-anchors', bindings.length === 50 && anchorOk === 50, `${anchorOk}/${bindings.length} line anchors resolve against the current canonical sources${drift.length ? `; drift: ${drift.slice(0, 5).join(' | ')}` : ''}`);
    }
  }

  const pass = results.every(entry => entry.pass);
  console.log(pass ? 'PASS parallel-workbench-integration-5025-env-check' : 'FAIL parallel-workbench-integration-5025-env-check');
  process.exitCode = pass ? 0 : 1;
}

main();
