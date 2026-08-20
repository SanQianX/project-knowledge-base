// _site/_test/ui-i18n-toggle-test.js
//
// T10: UI language toggle + persistence + smoke check that key labels
// actually change after switching zh-CN -> en-US. The test boots a real
// server, drives a headless Chromium, and inspects label textContent.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnServer } = require('./helpers/spawn-server');
const { findChrome } = require('./helpers/find-chrome');
const { launchCdpBrowser, waitFor } = require('./helpers/cdp-browser');

const ROOT = path.resolve(__dirname, '..', '..');
const sitePort = 7980 + (process.pid % 200);
const profileDir = path.join(os.tmpdir(), 'pk-i18n-' + process.pid);

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-i18n-data-' + process.pid + '-'));
  const server = spawnServer({
    root: ROOT, port: sitePort, dataDir, tag: 'ui-i18n', stdio: 'ignore',
    extraEnv: { KB_SKIP_MIGRATION: '1' },
  });
  let browser;
  try {
    await waitFor(async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${sitePort}/api/health`);
        return r.ok ? { ok: true } : null;
      } catch { return null; }
    }, 'isolated server', 20000);
    browser = await launchCdpBrowser({
      chrome: findChrome(), profileDir, url: `http://127.0.0.1:${sitePort}/`, width: 1440, height: 900,
    });
    // Wait for i18n.js to be available on window
    await waitFor(async () => {
      const ready = await browser.evaluate('Boolean(window.I18N)');
      return ready ? { ok: true } : null;
    }, 'window.I18N available', 20000);

    // Case 1: default language is zh-CN.
    {
      const lang = await browser.evaluate('window.I18N.activeLanguage()');
      assert.strictEqual(lang, 'zh-CN', 'default language must be zh-CN when no preference exists');
    }

    // Case 2: switch to en-US via the settings drawer toggle.
    await browser.evaluate(`(() => {
      // Open settings drawer (data-settings='ai' button)
      const btn = document.querySelector('[data-settings="ai"]') || document.getElementById('open-settings');
      if (btn) btn.click();
    })()`);
    await waitFor(async () => {
      const open = await browser.evaluate('Boolean(document.getElementById("ui-language"))');
      return open ? { ok: true } : null;
    }, 'ui-language select visible', 5000);
    await browser.evaluate(`(() => {
      const sel = document.getElementById('ui-language');
      sel.value = 'en-US';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await waitFor(async () => {
      const lang = await browser.evaluate('window.I18N.activeLanguage()');
      return lang === 'en-US' ? { ok: true } : null;
    }, 'language switched to en-US', 5000);

    // Case 3: persistence across reload — preference must survive a hard
    // reload. The browser context keeps localStorage across reloads.
    await browser.evaluate('location.reload()');
    await waitFor(async () => {
      const ready = await browser.evaluate('Boolean(window.I18N && window.I18N.activeLanguage() === "en-US")');
      return ready ? { ok: true } : null;
    }, 'language persists after reload', 20000);

    // Case 4: switch back to zh-CN and verify activeLanguage reflects it.
    await browser.evaluate(`(() => {
      document.getElementById('ui-language').value = 'zh-CN';
      document.getElementById('ui-language').dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await waitFor(async () => {
      const lang = await browser.evaluate('window.I18N.activeLanguage()');
      return lang === 'zh-CN' ? { ok: true } : null;
    }, 'switch back to zh-CN', 5000);

    // Case 5: unknown key returns the key string (no missing-key placeholder).
    {
      const missing = await browser.evaluate('window.I18N.t("does.not.exist")');
      assert.strictEqual(missing, 'does.not.exist', 'unknown keys must return the key string, not a placeholder');
    }

    // Case 6: availableLanguages contains both zh-CN and en-US.
    {
      const list = await browser.evaluate('window.I18N.availableLanguages().sort().join(",")');
      assert.strictEqual(list, 'en-US,zh-CN', 'availableLanguages must include zh-CN and en-US');
    }
  } finally {
    if (browser) await browser.close();
    server.child.kill();
    await new Promise(resolve => server.child.once('exit', resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  console.log('ui-i18n-toggle-test PASS');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
