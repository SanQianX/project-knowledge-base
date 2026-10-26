'use strict';
// desktop/test/release-browser-5025-quota-pins-test.cjs
//
// Focused test for the Workbench quota-17 pin selector used by
// release-browser-5025-smoke.cjs.
//
// What it proves:
//   1. the frozen 17-entry baseline in release-preflight-5025-local-modules.cjs
//      is untouched (read-only guard);
//   2. the 0.13.8 reviewed table keeps EXACTLY the three R20 re-pins;
//   3. the 0.13.9 reviewed table adds EXACTLY ONE entry
//      (packages/ui/ai-profile-settings.js) with the approved sha256;
//   4. the selection is EXACT-VERSION: an unknown version selects nothing;
//   5. the official public 0.13.9 bytes audit clean against the 0.13.9 table
//      (12 exact + 1 versionDoc + 4 notShipped = 17) while the frozen
//      baseline REJECTS the very same bytes;
//   6. mutating one approved public file is rejected;
//   7. an unknown version is not silently accepted.
//
// The public module root is resolved from the ROOT package.json alias
// dependency ("claude-ai-workbench": "npm:@sanqianx/claude-ai-workbench@0.13.9"),
// so the test is portable: no absolute source path is hardcoded and no file
// key is copied from another lane.
//
// The audit runs in a NODE CHILD under the audited isolated environment; the
// child only REQUIRES the selector module, so this also proves that
// importing it never boots a browser. No service, no browser, no network,
// and nothing is read from the real user profile.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const envLib = require('./release-preflight-5025-env.cjs');
const localModules = require('./release-preflight-5025-local-modules.cjs');
const pins = require('./release-browser-5025-quota-pins.cjs');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SELECTOR_PATH = path.join(__dirname, 'release-browser-5025-quota-pins.cjs');
const LOCAL_MODULES_PATH = path.join(__dirname, 'release-preflight-5025-local-modules.cjs');

const WB_0138 = '0.13.8';
const WB_0139 = '0.13.9';
const APPROVED_0139_REL = 'packages/ui/ai-profile-settings.js';
const APPROVED_0139_SHA = '3c7a75833a3c4f607739ecf71a0716e27c8594cecd9d84e2f8ac99498a59e0e7';
const R20_REPINS = {
  'packages/server/lib/workbench-service.js': 'e72686c654e0373c562fbbe3c858c46fc104e198d5f6e44f59153247292bfea9',
  'packages/server/lib/http-handler.js': '143892a94e6a9d7a1e58a6dfba18f4e11f52d15465687a99addfcadf62b662f0',
  'packages/client/index.js': '493938f0ff357aea6db136fca216c6cfcb542d51f6628e1994a179b5ec296a12',
};

// The approved 0.13.9 entry is the R33/R33B quota patch (source commit
// 928c1bb), shipped in the official 0.13.9 artifact and proven identical to
// the installed official package by the R36 review.
const APPROVED_0139_SOURCE = 'r33-r33b-quota-928c1bb-official-r36';

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const argValue = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const KEEP = argv.includes('--keep');
const TEMP_ROOT = path.resolve(argValue('--temp-root', path.join(os.tmpdir(), 'release-browser-5025-quota-pins-test')));
const RUN_ROOT = path.join(TEMP_ROOT, 'run');

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const cases = [];
const check = (name, ok, detail) => {
  cases.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// Explicit containment: every path this test touches must live under
// `root`. No globbing, no traversal, no absolute source path.
function containedPath(root, rel) {
  const target = path.resolve(root, ...rel.split('/'));
  const relToRoot = path.relative(path.resolve(root), target);
  if (relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) {
    throw new Error(`path escapes the fixture root: ${rel}`);
  }
  return target;
}

// The public module root: resolved from the ROOT package.json alias
// dependency, so it follows whatever the root pins.
function resolvePublicModuleRoot() {
  const rootPkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  const dep = (rootPkg.dependencies || {})['claude-ai-workbench'];
  if (!dep || !dep.startsWith('npm:@sanqianx/claude-ai-workbench@')) {
    throw new Error(`root package.json does not pin the claude-ai-workbench alias: ${dep}`);
  }
  const { createRequire } = require('node:module');
  const req = createRequire(path.join(REPO_ROOT, 'package.json'));
  const pkgJson = req.resolve('claude-ai-workbench/package.json');
  return { root: path.dirname(pkgJson), version: JSON.parse(fs.readFileSync(pkgJson, 'utf8')).version, dep };
}

// Build a fixture that contains ONLY the explicit public files of the table:
// the shipped entries are copied byte-for-byte from the public package, the
// notShipped entries are deliberately absent.
function buildFixture(table, destRoot, publicRoot) {
  const pkgRoot = path.join(destRoot, 'package');
  fs.mkdirSync(pkgRoot, { recursive: true });
  const shipped = [];
  for (const [rel, audited] of Object.entries(table)) {
    if (audited.notShipped) continue;
    const src = containedPath(publicRoot, rel);
    const dst = containedPath(pkgRoot, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    shipped.push(rel);
  }
  return { pkgRoot, shipped };
}

// The child program: REQUIRES the selector (no browser), audits the fixture
// with the table the selector returns for the given version, prints JSON.
const CHILD_PROGRAM = `
const path = require('path');
// node -e has no script filename, so argv[1] is the FIRST user argument.
const [selectorPath, localModulesPath, fixtureDir, wbVersion] = process.argv.slice(1);
const pins = require(selectorPath);
const local = require(localModulesPath);
const table = pins.selectWbQuotaTable(wbVersion);
const quota = local.auditWbQuota({ version: wbVersion }, fixtureDir, table);
process.stdout.write(JSON.stringify({
  tableSelected: table !== undefined,
  label: pins.describeWbQuotaTable(wbVersion),
  quota,
}));
`;

function auditInChild(fixtureDir, wbVersion) {
  const r = spawnSync(process.execPath, ['-e', CHILD_PROGRAM, SELECTOR_PATH, LOCAL_MODULES_PATH, fixtureDir, wbVersion], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120000,
    cwd: RUN_ROOT,
    env: childEnv,
  });
  if (r.status !== 0) {
    throw new Error(`audit child failed: exit ${r.status} ${(r.stderr || '').slice(-400)}`);
  }
  const raw = r.stdout || '';
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`audit child printed non-JSON output (the selector module must not print on import): ${raw.slice(0, 200)}`);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// driver
// ---------------------------------------------------------------------------

// Isolation starts at the driver root, BEFORE any gate, subprocess or
// receipt read: the ambient environment is sanitized first and every
// writable root is redirected under the owned run directory.
const ambientUserProfile = process.env.USERPROFILE;
envLib.hardenProcessEnv(RUN_ROOT, { gui: false });
fs.mkdirSync(RUN_ROOT, { recursive: true });
const dirs = envLib.defaultDirs(RUN_ROOT);
envLib.ensureDirs(dirs);
const childEnv = envLib.buildIsolatedEnv({ sourceEnv: process.env, runDir: RUN_ROOT, dirs, gui: false });
envLib.assertEnvContract(childEnv, RUN_ROOT, { gui: false, originalUserProfile: ambientUserProfile });

try {
  // 1. the frozen baseline is untouched
  const frozen = localModules.WB_QUOTA_AUDITED;
  const frozenKeys = Object.keys(frozen);
  const frozenNotShipped = frozenKeys.filter((k) => frozen[k].notShipped);
  const frozenVersionDocs = frozenKeys.filter((k) => frozen[k].versionDoc);
  check('frozen-baseline-preserved',
    frozenKeys.length === 17 && frozenNotShipped.length === 4 && frozenVersionDocs.length === 1
      && frozen[APPROVED_0139_REL].sha256 === '923a1e56614e5b15dd302a1179bf93c2ee56947ece5deb0a07a4c270215c9277',
    `entries=${frozenKeys.length} notShipped=${frozenNotShipped.length} versionDoc=${frozenVersionDocs.length}`);

  // 2. the 0.13.8 reviewed table: 17 entries, exactly three R20 re-pins
  const t0138 = pins.WB_QUOTA_AUDITED_0138;
  const t0138Keys = Object.keys(t0138 || {});
  const delta0138 = t0138Keys.filter((k) => !(k in frozen) || frozen[k].sha256 !== t0138[k].sha256);
  check('0138-table-has-17-entries', t0138Keys.length === 17, `entries=${t0138Keys.length}`);
  check('0138-delta-is-exactly-the-three-r20-repins',
    delta0138.length === 3 && delta0138.every((k) => R20_REPINS[k] && t0138[k].sha256 === R20_REPINS[k]
      && t0138[k].source === 'r20-leader-0138'),
    `delta=${JSON.stringify(delta0138)}`);

  // 3. the 0.13.9 reviewed table: 17 entries, exactly one added entry
  const t0139 = pins.WB_QUOTA_AUDITED_0139;
  const t0139Keys = Object.keys(t0139 || {});
  const delta0139 = t0139Keys.filter((k) => !(k in t0138) || t0138[k].sha256 !== t0139[k].sha256);
  check('0139-table-has-17-entries', t0139Keys.length === 17, `entries=${t0139Keys.length}`);
  check('0139-delta-is-exactly-one-approved-entry',
    delta0139.length === 1 && delta0139[0] === APPROVED_0139_REL
      && t0139[APPROVED_0139_REL].sha256 === APPROVED_0139_SHA
      && String(t0139[APPROVED_0139_REL].source).includes('928c1bb'),
    `delta=${JSON.stringify(delta0139)}`);

  // 4. exact-version selection only
  check('selector-is-exact-version',
    pins.selectWbQuotaTable(WB_0138) !== undefined && pins.selectWbQuotaTable(WB_0139) !== undefined
      && pins.selectWbQuotaTable('0.13.7') === undefined
      && pins.selectWbQuotaTable('0.13.10') === undefined
      && pins.selectWbQuotaTable('0.14.0') === undefined
      && pins.selectWbQuotaTable(`${WB_0138} `) === undefined
      && pins.selectWbQuotaTable(undefined) === undefined,
    'unknown versions select nothing');
  check('label-identifies-the-reviewed-table',
    String(pins.describeWbQuotaTable(WB_0139)).includes(WB_0139)
      && String(pins.describeWbQuotaTable(WB_0138)).includes(WB_0138)
      && pins.describeWbQuotaTable('0.13.10') === 'frozen-default',
    `0139=${pins.describeWbQuotaTable(WB_0139)}`);

  // 5. the official public 0.13.9 bytes
  const publicInfo = resolvePublicModuleRoot();
  check('public-module-root-is-the-root-alias-dependency',
    publicInfo.version === WB_0139 && publicInfo.dep === `npm:@sanqianx/claude-ai-workbench@${WB_0139}`,
    `resolved ${publicInfo.dep} -> ${publicInfo.version}`);

  const goodRoot = path.join(RUN_ROOT, 'fixture-official');
  const good = buildFixture(t0139 || t0138, goodRoot, publicInfo.root);
  check('fixture-contains-only-the-explicit-public-files',
    good.shipped.length === 13 && good.shipped.includes('docs/sdk/openapi.yaml')
      && !good.shipped.some((rel) => frozen[rel] && frozen[rel].notShipped),
    `shipped=${good.shipped.length}`);

  const official = auditInChild(goodRoot, WB_0139);
  check('official-0139-audit-passes-against-the-0139-table',
    official.tableSelected === true && official.quota.failures.length === 0
      && official.quota.detail.audited === 17 && official.quota.detail.matched === 12
      && official.quota.detail.versionDocs === 1 && official.quota.detail.notShipped.length === 4,
    `failures=${official.quota.failures.length} detail=${JSON.stringify(official.quota.detail)}`);

  // 6. mutating one approved public file is rejected
  const mutatedRoot = path.join(RUN_ROOT, 'fixture-mutated');
  buildFixture(t0139 || t0138, mutatedRoot, publicInfo.root);
  const mutatedFile = containedPath(path.join(mutatedRoot, 'package'), APPROVED_0139_REL);
  fs.appendFileSync(mutatedFile, '\n// tampered\n');
  const mutated = auditInChild(mutatedRoot, WB_0139);
  check('mutated-public-file-is-rejected',
    mutated.quota.failures.length > 0
      && mutated.quota.failures.some((f) => f.includes(APPROVED_0139_REL)),
    `failures=${JSON.stringify(mutated.quota.failures)}`);

  // 7. an unknown version is not silently accepted: the frozen baseline
  //    rejects the official bytes, so an unknown version cannot pass by
  //    accident.
  const unknown = auditInChild(goodRoot, '0.13.10');
  check('unknown-version-is-not-silently-accepted',
    unknown.tableSelected === false && unknown.label === 'frozen-default'
      && unknown.quota.failures.length > 0
      && unknown.quota.failures.some((f) => f.includes(APPROVED_0139_REL)),
    `failures=${JSON.stringify(unknown.quota.failures)}`);

  const failed = cases.filter((c) => !c.ok);
  console.log(failed.length === 0
    ? `release-browser-5025-quota-pins PASS (${cases.length}/${cases.length})`
    : `release-browser-5025-quota-pins FAIL (${failed.length}/${cases.length} case(s) failed)`);
  process.exitCode = failed.length ? 1 : 0;
} finally {
  if (!KEEP) {
    fs.rmSync(RUN_ROOT, { recursive: true, force: true });
  }
}
