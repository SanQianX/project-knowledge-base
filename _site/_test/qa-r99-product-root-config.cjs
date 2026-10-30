'use strict';
// _site/_test/qa-r99-product-root-config.cjs — P-MEMORY-RELEASE-PREP-R99
//
// Configuration-rejection test for the harness PRODUCT_ROOT parameter
// (official-prefix acceptance). Pure validation: resolveProductRoot runs its
// location rules BEFORE the existence checks and itself never spawns
// anything. The final case proves a bad root rejects startHarness BEFORE
// driver isolation (isolation wipes process.env — an intact PATH afterwards
// proves it never ran, so no child process can exist).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

async function main() {
  // QA_R99_DENY_ROOTS is captured at harness module load; set it first.
  const denyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-r99-deny-'));
  process.env.QA_R99_DENY_ROOTS = denyRoot;

  const harness = require('./helpers/qa-r91-harness.cjs');
  const { resolveProductRoot, REAL_ENV_MARKERS, ROOT, ENGINE_SOURCE_ROOT } = harness;

  let passed = 0;
  const ok = name => { passed += 1; console.log(`ok - ${name}`); };
  const expectReject = (candidate, reason, name) => {
    assert.throws(() => resolveProductRoot(candidate), error => {
      assert.equal(error.code, 'INVALID_PRODUCT_ROOT');
      assert.equal(error.reason, reason);
      return true;
    }, `expected ${reason} for ${JSON.stringify(candidate)}`);
    ok(name);
  };
  const stubEntry = root => {
    fs.mkdirSync(path.join(root, '_site', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(root, '_site', 'lib', 'server-app.js'), '// stub entry — validation only, never spawned\n');
  };

  // -------------------------------------------------- shape rejections
  expectReject('', 'NOT_ABSOLUTE', 'empty candidate is NOT_ABSOLUTE');
  expectReject('relative/prefix', 'NOT_ABSOLUTE', 'relative path is NOT_ABSOLUTE');

  // ------------------------------- protected real locations, proven to run
  // BEFORE the existence check: these crafted paths DO NOT exist, yet must
  // fail as PROTECTED_LOCATION, not MISSING_ROOT.
  if (REAL_ENV_MARKERS.appdata) {
    expectReject(path.join(REAL_ENV_MARKERS.appdata, 'npm', 'qa-r99-no-such-prefix'), 'PROTECTED_LOCATION', 'inside the live npm global prefix rejected before existence');
  }
  if (REAL_ENV_MARKERS.programFiles) {
    expectReject(path.join(REAL_ENV_MARKERS.programFiles, 'qa-r99-no-such-prefix'), 'PROTECTED_LOCATION', 'inside Program Files rejected before existence');
  }
  expectReject(path.join(denyRoot, 'nested'), 'PROTECTED_LOCATION', 'inside a QA_R99_DENY_ROOTS entry rejected');

  // --------------------------- canonical source roots are not official prefixes
  expectReject(ROOT, 'PROTECTED_SOURCE_ROOT', 'the canonical test repository is rejected');
  expectReject(path.join(ROOT, '_site'), 'PROTECTED_SOURCE_ROOT', 'inside the canonical repository is rejected');
  expectReject(ENGINE_SOURCE_ROOT, 'PROTECTED_SOURCE_ROOT', 'the engine source checkout is rejected');

  // ------------------------------------ missing root outside protected areas
  expectReject(path.join(os.tmpdir(), 'qa-r99-absent-prefix'), 'MISSING_ROOT', 'nonexistent root outside protected areas is MISSING_ROOT');

  // --------------------------------------------- root exists, entry missing
  const noEntry = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-r99-no-entry-'));
  expectReject(noEntry, 'MISSING_SITE_ENTRY', 'existing directory without _site/lib/server-app.js');

  // ----------------------------------------------- invalid package shapes
  const badJson = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-r99-bad-json-'));
  stubEntry(badJson);
  fs.writeFileSync(path.join(badJson, 'package.json'), '{not json');
  expectReject(badJson, 'INVALID_PACKAGE', 'unparseable package.json');

  const noFields = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-r99-no-fields-'));
  stubEntry(noFields);
  fs.writeFileSync(path.join(noFields, 'package.json'), JSON.stringify({ name: 'only-name' }));
  expectReject(noFields, 'INVALID_PACKAGE', 'package.json without name+version');

  // ------------------- the one accepted shape: a synthetic official prefix
  // under the OS temp area (outside every protected location).
  const good = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-r99-good-prefix-'));
  stubEntry(good);
  fs.writeFileSync(path.join(good, 'package.json'), JSON.stringify({ name: 'qa-r99-synthetic-prefix', version: '9.9.9-test' }, null, 2));
  const resolved = resolveProductRoot(good);
  assert.equal(resolved.root, path.resolve(good));
  assert.equal(resolved.siteEntry, path.join(path.resolve(good), '_site', 'lib', 'server-app.js'));
  assert.equal(resolved.engineRoot, path.join(path.resolve(good), '_modules', 'knowledge-engine'));
  assert.deepEqual({ name: resolved.packageJson.name, version: resolved.packageJson.version }, { name: 'qa-r99-synthetic-prefix', version: '9.9.9-test' });
  ok('synthetic official prefix accepted with root/siteEntry/engineRoot/packageJson');

  // -------- a bad root rejects startHarness BEFORE isolation: isolation
  // wipes process.env, so an intact PATH/USERPROFILE afterwards proves it
  // never ran — and nothing was spawned.
  const pathBefore = process.env.PATH;
  const homeBefore = process.env.USERPROFILE;
  await assert.rejects(
    () => harness.startHarness({ tag: 'r99-no-spawn', productRoot: 'relative/prefix' }),
    error => error.code === 'INVALID_PRODUCT_ROOT' && error.reason === 'NOT_ABSOLUTE',
  );
  assert.equal(process.env.PATH, pathBefore, 'driver isolation must not have run');
  assert.equal(process.env.USERPROFILE, homeBefore, 'driver isolation must not have run');
  ok('startHarness rejects a bad root before isolation — nothing spawned, env intact');

  for (const dir of [denyRoot, noEntry, badJson, noFields, good]) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
  console.log(`\nqa-r99-product-root-config: ${passed} checks passed`);
}

main().catch(error => { console.error(error && error.stack || error); process.exit(1); });
