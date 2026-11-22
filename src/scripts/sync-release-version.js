'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function packageVersion(rootDir) {
  const version = String(readJson(path.join(rootDir, 'package.json')).version || '').trim();
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`package.json must contain a SemVer version, received: ${version || '(empty)'}`);
  }
  return version;
}

function releaseVersionTargets(rootDir, version, { webOnly = false } = {}) {
  return [
    {
      file: 'package-lock.json',
      update(value) {
        value.version = version;
        if (!value.packages || !value.packages['']) throw new Error('package-lock.json has no root package entry');
        value.packages[''].version = version;
      },
    },
    {
      file: 'desktop/package.json',
      update(value) { value.version = version; },
    },
    {
      file: 'desktop/package-lock.json',
      update(value) {
        value.version = version;
        if (!value.packages || !value.packages['']) throw new Error('desktop/package-lock.json has no root package entry');
        value.packages[''].version = version;
      },
    },
    {
      file: 'plugins/project-knowledge/.claude-plugin/plugin.json',
      update(value) { value.version = version; },
    },
    {
      file: 'plugins/project-knowledge/.codex-plugin/plugin.json',
      update(value) { value.version = version; },
    },
    {
      file: '.claude-plugin/marketplace.json',
      update(value) {
        if (!Array.isArray(value.plugins) || !value.plugins[0]) throw new Error('Claude marketplace has no project plugin');
        value.plugins[0].version = version;
      },
    },
    {
      file: 'plugins/project-knowledge/.mcp.json',
      update(value) {
        const server = value && value.mcpServers && value.mcpServers['project-knowledge'];
        const serialized = JSON.stringify(server || {});
        if (/npx/i.test(serialized) || /@sanqianx\/project-knowledge@/.test(serialized)) throw new Error('project-knowledge MCP server must use the bundled launcher; the npx/pinned package form is rejected');
        const args = Array.isArray(server && server.args) ? server.args : [];
        const bootstrap = String(args[1] || '');
        if (!server || server.command !== 'node' || args[0] !== '-e' || !bootstrap.includes('mcp-launcher.cjs')) throw new Error('project-knowledge MCP server must launch the bundled mcp-launcher.cjs via node -e');
        if (server.cwd !== undefined) throw new Error('project-knowledge MCP server must not pin a cwd; the plugin version is carried by env.KB_PLUGIN_VERSION');
        if (bootstrap.includes('process.cwd')) throw new Error('the MCP bootstrap must never consult process.cwd');
        server.env = { ...(server.env || {}), KB_PLUGIN_VERSION: version };
      },
    },
  ].filter(target => !webOnly || !target.file.startsWith('desktop/')).map(target => ({ ...target, path: path.join(rootDir, target.file) }));
}

function inspectReleaseVersion(rootDir, options) {
  const version = packageVersion(rootDir);
  const drift = [];
  for (const target of releaseVersionTargets(rootDir, version, options)) {
    const before = fs.readFileSync(target.path, 'utf8');
    const value = JSON.parse(before);
    target.update(value);
    const after = `${JSON.stringify(value, null, 2)}\n`;
    if (before.replace(/\r\n/g, '\n') !== after) drift.push(target.file);
  }
  return { version, drift };
}

function syncReleaseVersion(rootDir, options) {
  const version = packageVersion(rootDir);
  const changed = [];
  for (const target of releaseVersionTargets(rootDir, version, options)) {
    const before = fs.readFileSync(target.path, 'utf8');
    const value = JSON.parse(before);
    target.update(value);
    const after = `${JSON.stringify(value, null, 2)}\n`;
    if (before.replace(/\r\n/g, '\n') === after) continue;
    writeJson(target.path, value);
    changed.push(target.file);
  }
  return { version, changed };
}

function stageReleaseVersionFiles(rootDir, files) {
  if (!files.length) return;
  const result = spawnSync('git', ['-C', rootDir, 'add', '--', ...files], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`failed to stage synchronized release files: ${(result.stderr || result.stdout || '').trim()}`);
  }
}

function parseArgs(argv) {
  let rootDir = path.resolve(__dirname, '..', '..');
  let check = false;
  let tag = null;
  let stage = false;
  let webOnly = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--check') check = true;
    else if (arg === '--stage') stage = true;
    else if (arg === '--web-only') webOnly = true;
    else if (arg === '--root') rootDir = path.resolve(argv[++index] || '');
    else if (arg === '--tag') tag = String(argv[++index] || '').trim();
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return { rootDir, check, tag, stage, webOnly };
}

function main(argv = process.argv.slice(2)) {
  const { rootDir, check, tag, stage, webOnly } = parseArgs(argv);
  if (check) {
    const result = inspectReleaseVersion(rootDir, { webOnly });
    if (result.drift.length) {
      throw new Error(`Release version ${result.version} is out of sync: ${result.drift.join(', ')}`);
    }
    if (tag && tag !== `v${result.version}`) {
      throw new Error(`Release tag ${tag} must match package version v${result.version}`);
    }
    console.log(`release version ${result.version} is synchronized`);
    return result;
  }
  const result = syncReleaseVersion(rootDir, { webOnly });
  if (stage) stageReleaseVersionFiles(rootDir, result.changed);
  console.log(result.changed.length
    ? `${stage ? 'synchronized and staged' : 'synchronized'} release version ${result.version}: ${result.changed.join(', ')}`
    : `release version ${result.version} is already synchronized`);
  return result;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`release version synchronization failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { inspectReleaseVersion, main, releaseVersionTargets, stageReleaseVersionFiles, syncReleaseVersion };
