const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, '_site', 'scripts', 'sync-release-version.js');
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), `project-knowledge-release-version-${process.pid}-`));
const FILES = [
  'package.json',
  'package-lock.json',
  'desktop/package.json',
  'desktop/package-lock.json',
  'plugins/project-knowledge/.claude-plugin/plugin.json',
  'plugins/project-knowledge/.codex-plugin/plugin.json',
  '.claude-plugin/marketplace.json',
  'plugins/project-knowledge/.mcp.json',
];

function copyFixture() {
  for (const relative of FILES) {
    const destination = path.join(TEMP, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(ROOT, relative), destination);
  }
}

function run(args) {
  return spawnSync(process.execPath, [SCRIPT, '--root', TEMP, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
  });
}

try {
  copyFixture();
  const rootPackage = path.join(TEMP, 'package.json');
  const value = JSON.parse(fs.readFileSync(rootPackage, 'utf8'));
  value.version = '9.8.7';
  fs.writeFileSync(rootPackage, `${JSON.stringify(value, null, 2)}\n`, 'utf8');

  const before = run(['--check']);
  assert.notStrictEqual(before.status, 0, 'check must fail before derived version files are synchronized');
  assert.match(before.stderr, /out of sync/);

  const sync = run([]);
  assert.strictEqual(sync.status, 0, sync.stderr || sync.stdout);
  const check = run(['--check']);
  assert.strictEqual(check.status, 0, check.stderr || check.stdout);
  const matchingTag = run(['--check', '--tag', 'v9.8.7']);
  assert.strictEqual(matchingTag.status, 0, matchingTag.stderr || matchingTag.stdout);
  const mismatchedTag = run(['--check', '--tag', 'v9.8.8']);
  assert.notStrictEqual(mismatchedTag.status, 0, 'check must reject a tag that does not match package.json');
  assert.match(mismatchedTag.stderr, /must match package version/);

  const claude = JSON.parse(fs.readFileSync(path.join(TEMP, 'plugins/project-knowledge/.claude-plugin/plugin.json'), 'utf8'));
  const codex = JSON.parse(fs.readFileSync(path.join(TEMP, 'plugins/project-knowledge/.codex-plugin/plugin.json'), 'utf8'));
  const marketplace = JSON.parse(fs.readFileSync(path.join(TEMP, '.claude-plugin/marketplace.json'), 'utf8'));
  const mcp = JSON.parse(fs.readFileSync(path.join(TEMP, 'plugins/project-knowledge/.mcp.json'), 'utf8'));
  const desktopLock = JSON.parse(fs.readFileSync(path.join(TEMP, 'desktop/package-lock.json'), 'utf8'));
  assert.strictEqual(claude.version, '9.8.7');
  assert.strictEqual(codex.version, '9.8.7');
  assert.strictEqual(marketplace.plugins[0].version, '9.8.7');
  assert(mcp.mcpServers['project-knowledge'].args.includes('project-knowledge@9.8.7'));
  assert.strictEqual(desktopLock.version, '9.8.7');
  assert.strictEqual(desktopLock.packages[''].version, '9.8.7');
  const scripts = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts;
  assert.strictEqual(scripts.preversion, 'npm run release:verify');
  assert.strictEqual(scripts.version, 'npm run release:sync');
  assert.strictEqual(scripts.postversion, 'npm run release:verify');
  console.log('release-version-sync-test PASS');
} finally {
  fs.rmSync(TEMP, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
