'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { installedFileBytes } = require('../scripts/pack-module-candidates');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-bin-content-'));
const npmCli = process.env.npm_execpath || path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
function npm(args, cwd) {
  const result = spawnSync(process.execPath, [npmCli, ...args], { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
try {
  const source = path.join(root, 'source'), installed = path.join(root, 'installed');
  fs.mkdirSync(source); fs.mkdirSync(installed);
  const pkg = { name: 'kb-bin-content-fixture', version: '1.0.0', bin: { 'kb-content-fixture': './bin.js' }, files: ['bin.js', 'readme.txt'] };
  const bytes = Buffer.from('#!/usr/bin/env node\r\nconsole.log("安装验收");\r\n');
  fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify(pkg));
  fs.writeFileSync(path.join(source, 'bin.js'), bytes);
  fs.writeFileSync(path.join(source, 'readme.txt'), bytes);
  assert.equal(typeof installedFileBytes, 'function', 'candidate hashes must model npm bin normalization');
  const packed = JSON.parse(npm(['pack', '--ignore-scripts', '--json', '--pack-destination', root], source))[0];
  fs.writeFileSync(path.join(installed, 'package.json'), JSON.stringify({ name: 'kb-bin-consumer', version: '1.0.0', private: true }));
  npm(['install', `file:${path.join(root, packed.filename)}`, '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false'], installed);
  const actual = fs.readFileSync(path.join(installed, 'node_modules', pkg.name, 'bin.js'));
  assert.notDeepEqual(actual, bytes, 'npm changes a CRLF shebang on installation');
  assert.deepEqual(installedFileBytes(pkg, 'bin.js', bytes), actual, 'manifest bytes match actual npm installation');
  assert.deepEqual(installedFileBytes(pkg, 'readme.txt', bytes), bytes, 'ordinary files retain their exact bytes');
  assert.deepEqual(installedFileBytes({ bin: 'bin.js' }, 'bin.js', bytes), actual, 'string bin form is supported');
  assert.deepEqual(installedFileBytes(pkg, 'bin.js', actual), actual, 'an already normalized bin is unchanged');
  assert.ok(actual.includes(Buffer.from('验收");\r\n')), 'only the shebang is normalized');
  console.log('candidate-bin-content-test PASS');
} finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
