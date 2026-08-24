const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { spawnServer } = require('./helpers/spawn-server');
const { findChrome } = require('./helpers/find-chrome');
const { launchCdpBrowser, waitFor } = require('./helpers/cdp-browser');

const ROOT = path.resolve(__dirname, '..', '..');
const PORT = 8250 + (process.pid % 500);
const BASE = `http://127.0.0.1:${PORT}`;
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `pk-packaged-ui-${process.pid}-`));
const packDir = path.join(tempRoot, 'pack');
const installDir = path.join(tempRoot, 'install');
const profileDir = path.join(tempRoot, 'chrome-profile');
fs.mkdirSync(packDir, { recursive: true });
fs.mkdirSync(installDir, { recursive: true });

function npmCliPath() {
  return process.env.npm_execpath
    || path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
}

function buildAndInstallPackage() {
  const packed = spawnSync(process.execPath, [npmCliPath(), 'pack', '--json', '--pack-destination', packDir], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.strictEqual(packed.status, 0, packed.stderr || packed.stdout);
  const report = JSON.parse(packed.stdout);
  const tarball = path.join(packDir, report[0].filename);
  assert(fs.existsSync(tarball), `npm pack did not create ${tarball}`);

  const installed = spawnSync(process.execPath, [npmCliPath(), 'install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', installDir, tarball], {
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.strictEqual(installed.status, 0, installed.stderr || installed.stdout);
  return path.join(installDir, 'node_modules', 'project-knowledge');
}

(async () => {
  let server;
  let browser;
  try {
    const packagedRoot = buildAndInstallPackage();
    assert(fs.existsSync(path.join(packagedRoot, 'ui', 'i18n.js')), 'packed UI must include ui/i18n.js');

    server = spawnServer({ root: packagedRoot, port: PORT, tag: 'packaged-ui', stdio: 'ignore' });
    await waitFor(async () => {
      try { return (await fetch(`${BASE}/api/health`)).ok ? { ok: true } : null; }
      catch { return null; }
    }, 'packaged server', 20000);

    const i18nResponse = await fetch(`${BASE}/i18n.js`);
    assert.strictEqual(i18nResponse.status, 200, 'packaged server must serve /i18n.js');
    assert.match(String(i18nResponse.headers.get('content-type') || ''), /javascript/i);

    browser = await launchCdpBrowser({ chrome: findChrome(), profileDir, url: `${BASE}/`, width: 1440, height: 900 });
    await waitFor(async () => {
      const ready = await browser.evaluate('Boolean(window.I18N && window.__PK_APP__)');
      return ready ? { ok: true } : null;
    }, 'packaged UI bootstrap', 20000);

    const state = await browser.evaluate('window.__PK_APP__.getState()');
    assert.strictEqual(state.projects, 0);
    assert.strictEqual(browser.exceptions.length, 0, `packaged UI runtime exceptions: ${JSON.stringify(browser.exceptions)}`);
    console.log('packaged-ui-smoke-test PASS');
  } finally {
    if (browser) await browser.close();
    if (server) await server.cleanup();
    try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
  }
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
