'use strict';
const assert = require('node:assert/strict');
// Requiring the launcher must be side-effect free: without the require.main
// guard this require would spawn Electron or delegate to the core CLI, so the
// fact that this line returns at all is part of the contract under test.
const { parse } = require('../bin/project-knowledge-desktop.cjs');
assert.equal(typeof parse, 'function', 'launcher must export parse via require without running main');

assert.equal(parse([]).command, 'start', 'no arguments defaults to start');
assert.equal(parse(['start']).command, 'start');
assert.equal(parse(['status']).command, 'status');
assert.equal(parse(['STATUS']).command, 'status', 'commands are case-insensitive');
assert.equal(parse(['stop']).command, 'stop');
assert.equal(parse(['Stop']).command, 'stop', 'commands are case-insensitive');

assert.equal(parse(['--version']).version, true);
assert.equal(parse(['-v']).version, true);
assert.equal(parse(['--help']).help, true);
assert.equal(parse(['-h']).help, true);

const startCombo = parse(['start', '--data', 'D:/kb-data']);
assert.equal(startCombo.command, 'start');
assert.equal(startCombo.dataDir, 'D:/kb-data');
const statusCombo = parse(['status', '--data', 'D:/kb-data']);
assert.equal(statusCombo.command, 'status');
assert.equal(statusCombo.dataDir, 'D:/kb-data');
const stopCombo = parse(['stop', '--data', 'D:/kb-data']);
assert.equal(stopCombo.command, 'stop');
assert.equal(stopCombo.dataDir, 'D:/kb-data');

assert.throws(() => parse(['--data']), '--data without a value must throw');
assert.throws(() => parse(['restart']), /restart/, 'unknown command error must name the command');
assert.throws(() => parse(['--frobnicate']), /--frobnicate/, 'unknown option error must name the option');

console.log('cli args test PASS');
