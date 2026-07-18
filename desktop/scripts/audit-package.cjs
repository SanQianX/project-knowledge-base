const fs = require('fs');
const path = require('path');
const asar = require('@electron/asar');

const desktopRoot = path.resolve(__dirname, '..');
const bundleRoot = path.join(desktopRoot, 'out', 'Project Knowledge-win32-x64');
const asarPath = path.join(bundleRoot, 'resources', 'app.asar');
const reportPath = path.join(desktopRoot, 'out', 'package-size-report.json');
const maxBundleMiB = Number(process.env.KB_MAX_DESKTOP_BUNDLE_MIB || 750);
const maxInstallerMiB = Number(process.env.KB_MAX_DESKTOP_INSTALLER_MIB || 320);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function directoryBytes(directory) {
  let total = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    total += entry.isDirectory() ? directoryBytes(target) : fs.statSync(target).size;
  }
  return total;
}

function listAsarFiles() {
  return asar.listPackage(asarPath).map(file => file.replace(/\\/g, '/').replace(/^\//, ''));
}

function findInstaller() {
  const makeRoot = path.join(desktopRoot, 'out', 'make', 'squirrel.windows', 'x64');
  if (!fs.existsSync(makeRoot)) return null;
  return fs.readdirSync(makeRoot)
    .filter(file => /Setup\.exe$/i.test(file))
    .map(file => path.join(makeRoot, file))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] || null;
}

assert(fs.existsSync(asarPath), `packaged app not found: ${asarPath}`);
const files = listAsarFiles();
const contains = fragment => files.some(file => file.includes(fragment));

const forbidden = [
  'node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe',
  'node_modules/@lancedb/lancedb/node_modules/@huggingface/',
  'node_modules/@lancedb/lancedb/node_modules/onnxruntime-node/',
  'node_modules/onnxruntime-node/bin/napi-v3/darwin/',
  'node_modules/onnxruntime-node/bin/napi-v3/linux/',
  'node_modules/onnxruntime-node/bin/napi-v3/win32/arm64/',
];
for (const fragment of forbidden) assert(!contains(fragment), `forbidden packaged runtime found: ${fragment}`);

for (const required of [
  'node_modules/@lancedb/lancedb-win32-x64-msvc/lancedb.win32-x64-msvc.node',
  'node_modules/onnxruntime-node/bin/napi-v3/win32/x64/onnxruntime_binding.node',
  'node_modules/onnxruntime-web/dist/ort.node.min.mjs',
  'node_modules/@huggingface/transformers/dist/transformers.node.mjs',
]) {
  assert(contains(required), `required packaged runtime missing: ${required}`);
}

const unexpectedOrtWeb = files.filter(file => (
  file.startsWith('node_modules/onnxruntime-web/dist/')
  && !/\/ort\.node\.min\.(?:js|mjs)$/.test(file)
));
assert(unexpectedOrtWeb.length === 0, `unexpected onnxruntime-web files: ${unexpectedOrtWeb.slice(0, 5).join(', ')}`);

const bundleBytes = directoryBytes(bundleRoot);
const installer = findInstaller();
const installerBytes = installer ? fs.statSync(installer).size : null;
const toMiB = bytes => bytes == null ? null : Number((bytes / 1048576).toFixed(1));

assert(toMiB(bundleBytes) <= maxBundleMiB,
  `packaged application is ${toMiB(bundleBytes)} MiB (budget ${maxBundleMiB} MiB)`);
if (installerBytes != null) {
  assert(toMiB(installerBytes) <= maxInstallerMiB,
    `installer is ${toMiB(installerBytes)} MiB (budget ${maxInstallerMiB} MiB)`);
}

const report = {
  generatedAt: new Date().toISOString(),
  platform: 'win32-x64',
  bundle: { bytes: bundleBytes, mib: toMiB(bundleBytes), maxMiB: maxBundleMiB },
  installer: installer ? {
    path: path.relative(desktopRoot, installer).replace(/\\/g, '/'),
    bytes: installerBytes,
    mib: toMiB(installerBytes),
    maxMiB: maxInstallerMiB,
  } : null,
};
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`package-audit PASS: bundle ${report.bundle.mib} MiB${report.installer ? `, installer ${report.installer.mib} MiB` : ''}`);
