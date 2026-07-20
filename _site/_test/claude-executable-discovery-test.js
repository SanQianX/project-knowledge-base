const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const runner = require('../lib/claude-cli-runner');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-discovery-test-'));

(async () => {
  try {
    const nativeExe = path.join(temp, 'claude.exe');
    const npmRoot = path.join(temp, 'npm');
    const extensionlessNpmShim = path.join(npmRoot, 'claude');
    const npmShim = path.join(npmRoot, 'claude.cmd');
    const npmCli = path.join(npmRoot, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
    const npmExe = path.join(npmRoot, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    fs.mkdirSync(path.dirname(npmExe), { recursive: true });
    fs.writeFileSync(nativeExe, 'test');
    fs.writeFileSync(extensionlessNpmShim, '#!/bin/sh');
    fs.writeFileSync(npmShim, '@echo off');
    fs.writeFileSync(npmCli, '#!/usr/bin/env node');
    fs.writeFileSync(npmExe, 'native executable');

    const fromEnv = await runner.findClaudeExecutableForSdk({
      platform: 'win32',
      env: { CLAUDE_CODE_EXECPATH: nativeExe },
      runCommand: () => ({ status: 1, stdout: '' }),
    });
    assert.equal(fromEnv.cmd, nativeExe);
    assert.equal(fromEnv.source, 'CLAUDE_CODE_EXECPATH');

    const fromPath = await runner.findClaudeExecutableForSdk({
      platform: 'win32',
      env: {},
      runCommand: () => ({ status: 0, stdout: `${nativeExe}\r\n` }),
    });
    assert.equal(fromPath.cmd, nativeExe);
    assert.equal(fromPath.source, 'PATH');

    const fromExtensionlessNpmShim = await runner.findClaudeExecutableForSdk({
      platform: 'win32',
      env: {},
      runCommand: () => ({ status: 0, stdout: `${extensionlessNpmShim}\r\n${npmShim}\r\n` }),
    });
    assert.equal(fromExtensionlessNpmShim.cmd, npmExe,
      'extensionless npm shell shim should resolve to the package native executable');

    const fromCmdNpmShim = await runner.findClaudeExecutableForSdk({
      platform: 'win32',
      env: { CLAUDE_CODE_EXECPATH: npmShim },
      runCommand: () => ({ status: 1, stdout: '' }),
    });
    assert.equal(fromCmdNpmShim.cmd, npmExe,
      'configured npm .cmd shim should resolve to the package native executable');

    const missing = await runner.findClaudeExecutableForSdk({
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
})();
