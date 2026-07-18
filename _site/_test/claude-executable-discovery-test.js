const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const runner = require('../lib/claude-cli-runner');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-discovery-test-'));

try {
  const nativeExe = path.join(temp, 'claude.exe');
  const npmRoot = path.join(temp, 'npm');
  const npmShim = path.join(npmRoot, 'claude.cmd');
  const npmCli = path.join(npmRoot, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
  fs.mkdirSync(path.dirname(npmCli), { recursive: true });
  fs.writeFileSync(nativeExe, 'test');
  fs.writeFileSync(npmShim, '@echo off');
  fs.writeFileSync(npmCli, '#!/usr/bin/env node');

  const fromEnv = runner.findClaudeExecutableForSdk({
    platform: 'win32',
    env: { CLAUDE_CODE_EXECPATH: nativeExe },
    runCommand: () => ({ status: 1, stdout: '' }),
  });
  assert.equal(fromEnv.cmd, nativeExe);
  assert.equal(fromEnv.source, 'CLAUDE_CODE_EXECPATH');

  const fromPath = runner.findClaudeExecutableForSdk({
    platform: 'win32',
    env: {},
    runCommand: () => ({ status: 0, stdout: `${nativeExe}\r\n` }),
  });
  assert.equal(fromPath.cmd, nativeExe);
  assert.equal(fromPath.source, 'PATH');

  const fromNpmShim = runner.findClaudeExecutableForSdk({
    platform: 'win32',
    env: {},
    runCommand: () => ({ status: 0, stdout: `${npmShim}\r\n` }),
  });
  assert.equal(fromNpmShim.cmd, npmCli, 'npm .cmd shim should resolve to the SDK-compatible cli.js');

  const missing = runner.findClaudeExecutableForSdk({
    platform: 'win32',
    env: {},
    exists: () => false,
    runCommand: () => ({ status: 1, stdout: '' }),
  });
  assert.equal(missing.cmd, null);
  assert.match(missing.reason, /Claude Code was not found/);

  console.log('claude-executable-discovery-test: PASS');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
