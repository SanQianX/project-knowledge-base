'use strict';
// Regression: the module supervisor's backoff counter must reset after a
// stable run. Before the fix, attempts accumulated for the whole shell
// lifetime, so one-off exits spread over weeks eventually hit the give-up
// cap and left the module dead while the shell kept proxying to its port —
// the endless MODULE_UNREACHABLE episodes in the shell UI.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { ModuleBridge } = require('../lib/module-bridge');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function supervisedBridge() {
  const bridge = new ModuleBridge();
  const events = [];
  bridge.logger = {
    info: () => {},
    warn: (event, message) => events.push({ event, message }),
    error: () => {},
  };
  return { bridge, events };
}
const restarted = events => events.filter(entry => entry.event === 'modules.supervisor' && /restarting/.test(entry.message)).length;
const gaveUp = events => events.filter(entry => entry.event === 'modules.supervisor' && /stopped/.test(entry.message)).length;

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-supervisor-backoff-'));

  // A quick crash loop must still be abandoned (the cap keeps its purpose).
  // No _stableAfterMs override here: quick exits face the production default.
  const crashLoop = supervisedBridge();
  const quickExit = path.join(root, 'quick-exit.js');
  fs.writeFileSync(quickExit, 'process.exit(0);');
  crashLoop.bridge._spawnSupervised({ name: 'fixture', command: `node ${JSON.stringify(quickExit)}`, _attempts: 5 });
  await sleep(300);
  assert.equal(crashLoop.bridge.supervised.length, 0, 'the exited child must not linger as supervised');
  assert.equal(restarted(crashLoop.events), 0, 'a sixth quick exit must not schedule a restart');
  assert.equal(gaveUp(crashLoop.events), 1, 'a sixth quick exit must give up');
  await crashLoop.bridge.stopSupervised();

  // A service that ran stably before exiting must respawn with a fresh counter.
  const stable = supervisedBridge();
  const linger = path.join(root, 'linger.js');
  fs.writeFileSync(linger, 'setTimeout(() => process.exit(0), 50);');
  const spawnedSpecs = [];
  const spawnOriginal = stable.bridge._spawnSupervised.bind(stable.bridge);
  stable.bridge._spawnSupervised = spec => { spawnedSpecs.push(spec); return spawnOriginal(spec); };
  stable.bridge._spawnSupervised({ name: 'fixture', command: `node ${JSON.stringify(linger)}`, _attempts: 5, _stableAfterMs: 0 });
  await sleep(300);
  assert.equal(spawnedSpecs.length, 1, 'the first child is the only spawn so far');
  assert.equal(restarted(stable.events), 1, 'a stable exit at the attempt cap must schedule a restart, not give up');
  assert.equal(gaveUp(stable.events), 0, 'a stable exit must never abandon the service');
  await sleep(2000 + 400); // first backoff of a fresh incident: 1000 * 2^1 = 2s
  assert.equal(spawnedSpecs.length, 2, 'the service must have been respawned');
  assert.equal(spawnedSpecs[1]._attempts, 1, 'the respawn opens a fresh incident instead of inheriting the old count');
  assert.equal(gaveUp(stable.events), 0, 'the respawned service must not be abandoned');
  await stable.bridge.stopSupervised();

  console.log('module supervisor backoff reset test PASS');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
