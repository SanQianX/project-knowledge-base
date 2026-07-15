const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const desktopRoot = path.resolve(__dirname, '..');
const projectRoot = path.resolve(desktopRoot, '..');
const cacheDir = path.join(desktopRoot, '.core-package');
const target = path.join(desktopRoot, 'node_modules', 'project-knowledge');

fs.rmSync(cacheDir, { recursive: true, force: true });
fs.mkdirSync(cacheDir, { recursive: true });

const npmCli = process.env.npm_execpath
  || path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
const packed = spawnSync(process.execPath, [npmCli, 'pack', projectRoot, '--json', '--pack-destination', cacheDir], {
  cwd: desktopRoot,
  encoding: 'utf-8',
  windowsHide: true,
});
if (packed.status !== 0) {
  throw new Error(`npm pack failed: ${packed.error && packed.error.message || packed.stderr || packed.stdout}`);
}
const result = JSON.parse(packed.stdout);
const tarball = path.join(cacheDir, result[0].filename);

fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(target, { recursive: true });
const extracted = spawnSync('tar', ['-xzf', tarball, '-C', target, '--strip-components=1'], {
  cwd: desktopRoot,
  encoding: 'utf-8',
  windowsHide: true,
});
if (extracted.status !== 0) {
  throw new Error(`core package extraction failed: ${extracted.stderr || extracted.stdout}`);
}

const rootVersion = require(path.join(projectRoot, 'package.json')).version;
const desktopPackagePath = path.join(desktopRoot, 'package.json');
const desktopPackage = JSON.parse(fs.readFileSync(desktopPackagePath, 'utf-8'));
if (desktopPackage.version !== rootVersion) {
  throw new Error(`desktop version ${desktopPackage.version} must match core version ${rootVersion}`);
}
console.log(`Prepared project-knowledge ${rootVersion} for desktop packaging.`);
