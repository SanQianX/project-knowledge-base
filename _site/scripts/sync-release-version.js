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

function releaseVersionTargets(rootDir, version) {
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
        const args = value && value.mcpServers && value.mcpServers['project-knowledge'] && value.mcpServers['project-knowledge'].args;
        if (!Array.isArray(args)) throw new Error('project-knowledge MCP server has no args array');
        const index = args.findIndex(arg => /^project-knowledge@/.test(String(arg)));
        if (index < 0) throw new Error('project-knowledge MCP server has no pinned package argument');
        args[index] = `project-knowledge@${version}`;
      },
    },
  ].map(target => ({ ...target, path: path.join(rootDir, target.file) }));
}

function inspectReleaseVersion(rootDir) {
  const version = packageVersion(rootDir);
  const drift = [];
  for (const target of releaseVersionTargets(rootDir, version)) {
    const before = fs.readFileSync(target.path, 'utf8');
    const value = JSON.parse(before);
    target.update(value);
    const after = `${JSON.stringify(value, null, 2)}\n`;
    if (before.replace(/\r\n/g, '\n') !== after) drift.push(target.file);
  }
  return { version, drift };
}

function syncReleaseVersion(rootDir) {
  const version = packageVersion(rootDir);
  const changed = [];
  for (const target of releaseVersionTargets(rootDir, version)) {
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
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--check') check = true;
    else if (arg === '--stage') stage = true;
    else if (arg === '--root') rootDir = path.resolve(argv[++index] || '');
    else if (arg === '--tag') tag = String(argv[++index] || '').trim();
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return { rootDir, check, tag, stage };
}

function main(argv = process.argv.slice(2)) {
  const { rootDir, check, tag, stage } = parseArgs(argv);
  if (check) {
    const result = inspectReleaseVersion(rootDir);
    if (result.drift.length) {
      throw new Error(`Release version ${result.version} is out of sync: ${result.drift.join(', ')}`);
    }
    if (tag && tag !== `v${result.version}`) {
      throw new Error(`Release tag ${tag} must match package version v${result.version}`);
    }
    console.log(`release version ${result.version} is synchronized`);
    return result;
  }
  const result = syncReleaseVersion(rootDir);
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
