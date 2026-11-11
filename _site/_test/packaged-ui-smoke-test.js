// 打包 UI 冒烟：npm pack → 安装 tarball → 打包产物启动服务并驱动真实浏览器。
//
// 迁移说明（五页简化 UI，见 patches/ui-test-mapping-spec.md）：
// - 导航从六页改为五页：nav [data-view] 数量 6 → 5（work 导航按钮已移除，
//   #view-work 仅作为隐藏服务挂载保留在 DOM）。
// - 新首页空项目态（「从第一个项目开始 / 导入第一个项目」）依赖
//   /api/engine/overview 成功，因此本测试为打包实例接入真实 vendored 知识
//   引擎（独立空数据目录，经 createUpstreamProxy 改写 runtime token；
//   引擎进程本身从源码仓库的 dev 依赖解析，与被打包的 shell 进程分离）。
// - 打包文件清单断言不变：ui/ 仍含 index.html / knowledge-panel.html /
//   product.js / product.css，且不再含 app.js / app.css / i18n.js。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { spawnServer } = require('./helpers/spawn-server');
const { findChrome } = require('./helpers/find-chrome');
const { launchCdpBrowser, waitFor } = require('./helpers/cdp-browser');
const { createUpstreamProxy } = require('./helpers/module-fixture');

const ROOT = path.resolve(__dirname, '..', '..');
const ENGINE_ENTRY = path.join(path.dirname(require.resolve('@sanqianx/ai-coding-knowledge-engine/package.json', { paths: [ROOT] })), 'src', 'server.js');
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
  // Resolve the install path from the package's actual name (moved to
  // @sanqianx/project-knowledge in 4.7.0; prior releases used the unscoped
  // 'project-knowledge' which would live at node_modules/project-knowledge).
  const pkg = require(path.join(ROOT, 'package.json'));
  const installPath = pkg.name.startsWith('@')
    ? path.join(installDir, 'node_modules', pkg.name.split('/')[0], pkg.name.split('/')[1])
    : path.join(installDir, 'node_modules', pkg.name);
  return installPath;
}

(async () => {
  let server;
  let browser;
  let engine;
  let engineProxy;
  try {
    const packagedRoot = buildAndInstallPackage();
    for (const file of ['index.html', 'knowledge-panel.html', 'product.js', 'product.css']) assert(fs.existsSync(path.join(packagedRoot, 'ui', file)), `packed UI must include ${file}`);
    for (const file of ['app.js', 'app.css', 'i18n.js']) assert(!fs.existsSync(path.join(packagedRoot, 'ui', file)), `obsolete shell resource must not be shipped: ${file}`);

    // The five-page home renders its empty-project state only after the
    // engine overview answered, so the packaged instance gets the real
    // vendored engine (own empty data dir, dead vector/bridge endpoints)
    // behind the shared token-rewriting upstream proxy.
    const { createEngineServer } = require(ENGINE_ENTRY);
    const engineToken = crypto.randomBytes(24).toString('hex');
    engine = createEngineServer({
      dataDir: path.join(tempRoot, 'engine'),
      runtimeToken: engineToken,
      consume: false,
      debug: true,
      vectorUrl: 'http://127.0.0.1:0',
      bridgeUrl: 'http://127.0.0.1:0',
    });
    await engine.ready;
    await new Promise(resolve => engine.server.listen(0, '127.0.0.1', resolve));
    engineProxy = createUpstreamProxy({ target: `http://127.0.0.1:${engine.server.address().port}`, token: engineToken, tag: 'engine' });
    await engineProxy.start();

    server = spawnServer({ root: packagedRoot, port: PORT, dataDir: path.join(tempRoot, 'data'), tag: 'packaged-ui', analysisOwner: 'engine', stdio: 'ignore', extraEnv: { KB_KNOWLEDGE_ENGINE_URL: engineProxy.url } });
    await waitFor(async () => {
      try { return (await fetch(`${BASE}/api/health`)).ok ? { ok: true } : null; }
      catch { return null; }
    }, 'packaged server', 20000);

    const productResponse = await fetch(`${BASE}/product.js`);
    assert.strictEqual(productResponse.status, 200, 'packaged server must serve /product.js');
    assert.match(String(productResponse.headers.get('content-type') || ''), /javascript/i);

    browser = await launchCdpBrowser({ chrome: findChrome(), profileDir, url: `${BASE}/`, width: 1920, height: 1080 });
    await browser.setViewport(1920, 1080);
    await waitFor(async () => {
      const ready = await browser.evaluate("document.getElementById('homeContent').textContent.includes('第一个项目')");
      return ready ? { ok: true } : null;
    }, 'packaged UI bootstrap', 20000);

    assert.strictEqual(await browser.evaluate("document.getElementById('projectSelect').disabled"), true);
    assert.strictEqual(await browser.evaluate("document.querySelectorAll('nav [data-view]').length"), 5);
    assert.strictEqual(await browser.evaluate("document.querySelector('[data-view=\"work\"]')"), null, 'the packed UI ships no work navigation entry');
    assert.strictEqual(browser.exceptions.length, 0, `packaged UI runtime exceptions: ${JSON.stringify(browser.exceptions)}`);
    console.log('packaged-ui-smoke-test PASS');
  } finally {
    if (browser) await browser.close();
    if (server) await server.cleanup();
    if (engineProxy) await engineProxy.close();
    if (engine) await engine.close().catch(() => {});
    try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
  }
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
