// _site/_test/appearance-settings-test.js
//
// Appearance skin settings (kb-skin/v1, phase 1): preset palettes plus
// per-theme token overrides. Verifies:
//   - validateAppearance accepts the default shape and full token overrides;
//   - unknown presets, unknown tokens, malformed hex, unknown theme keys and
//     unknown top-level fields are rejected with INVALID_ARGUMENT;
//   - SettingsStore.replaceAppearance persists the appearance section
//     wholesale (reset drops stale overrides) and stays readable;
//   - legacy settings.json without an appearance section still validates and
//     falls back to the default skin;
//   - GET/PATCH /api/appearance returns the saved appearance and rejects
//     invalid payloads with 400.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnServer } = require('./helpers/spawn-server');
const { StorageLayout } = require('../lib/storage-layout');
const { SettingsStore, defaultAppearance, defaultSettings, validateAppearance } = require('../lib/settings-store');

const ROOT = path.resolve(__dirname, '..', '..');
const PORT = 8600 + (process.pid % 300);
const BASE = `http://127.0.0.1:${PORT}`;

function expectInvalidArgument(fn, label) {
  try { fn(); } catch (error) {
    assert.strictEqual(error.code, 'INVALID_ARGUMENT', `${label}: expected INVALID_ARGUMENT, got ${error.code}`);
    return error;
  }
  throw new Error(`${label}: expected INVALID_ARGUMENT, nothing thrown`);
}

(async () => {
  // --- validateAppearance: unit contract -----------------------------------
  {
    const base = validateAppearance(defaultAppearance());
    assert.strictEqual(base.preset, 'pure');
    assert.deepStrictEqual(base.overrides, { light: {}, dark: {} });

    const custom = validateAppearance({
      preset: 'steel',
      overrides: { light: { page: '#f3f5f7', accent: '#516F89' }, dark: { surface: '#20252d' } },
    });
    assert.strictEqual(custom.preset, 'steel');
    assert.strictEqual(custom.overrides.light.accent, '#516F89');
    assert.deepStrictEqual(custom.overrides.dark, { surface: '#20252d' });

    // preset defaults to pure when omitted.
    assert.strictEqual(validateAppearance({}).preset, 'pure');
  }

  // --- validateAppearance: rejections ---------------------------------------
  expectInvalidArgument(() => validateAppearance({ preset: 'neon' }), 'unknown preset');
  expectInvalidArgument(() => validateAppearance({ overrides: { light: { '--page': '#ffffff' } } }), 'unknown token');
  expectInvalidArgument(() => validateAppearance({ overrides: { light: { page: 'white' } } }), 'non-hex value');
  expectInvalidArgument(() => validateAppearance({ overrides: { light: { page: '#fff' } } }), 'short hex');
  expectInvalidArgument(() => validateAppearance({ overrides: { sepia: { page: '#ffffff' } } }), 'unknown theme');
  expectInvalidArgument(() => validateAppearance({ wallpaper: 'x' }), 'unknown top-level field');
  expectInvalidArgument(() => validateAppearance(null), 'non-object');

  // --- SettingsStore.replaceAppearance: persistence and full replacement ----
  {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-appearance-store-'));
    const layout = new StorageLayout({ dataDir });
    const settings = new SettingsStore({ layout });
    await settings.initialize({ knowledge: { rootPath: '' } });

    const saved = await settings.replaceAppearance({
      preset: 'oled',
      overrides: { light: { accent: '#2f6db5' }, dark: { page: '#000000', accent: '#7da2ff' } },
    });
    assert.strictEqual(saved.preset, 'oled');
    assert.strictEqual(settings.read().appearance.overrides.dark.page, '#000000');

    // Full replacement: resetting to defaults must drop stale overrides.
    const reset = await settings.replaceAppearance(defaultAppearance());
    assert.deepStrictEqual(reset.overrides, { light: {}, dark: {} });
    assert.deepStrictEqual(settings.read().appearance.overrides, { light: {}, dark: {} });

    // Invalid payloads never reach disk.
    await assert.rejects(() => settings.replaceAppearance({ preset: 'nope' }), /INVALID_ARGUMENT|未知的配色预设/);

    // Legacy settings.json without an appearance section still validates and
    // falls back to the default skin.
    const legacy = defaultSettings();
    delete legacy.appearance;
    fs.writeFileSync(layout.getSettingsPath(), JSON.stringify(legacy, null, 2));
    const migrated = settings.read();
    assert.deepStrictEqual(migrated.appearance, defaultAppearance());

    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  // --- HTTP routes -----------------------------------------------------------
  const { server, dataDir, cleanup } = spawnServer({ root: ROOT, port: PORT, tag: 'appearance' });
  try {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch {}
      if (attempt === 99) throw new Error('server did not start');
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    const initial = await (await fetch(`${BASE}/api/appearance`)).json();
    assert.strictEqual(initial.ok, true);
    assert.strictEqual(initial.appearance.preset, 'pure');

    const patched = await (await fetch(`${BASE}/api/appearance`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appearance: { preset: 'steel', overrides: { dark: { accent: '#8aa8cf', page: '#171a1f' } } } }),
    })).json();
    assert.strictEqual(patched.ok, true);
    assert.strictEqual(patched.appearance.preset, 'steel');
    assert.strictEqual(patched.appearance.overrides.dark.accent, '#8aa8cf');

    const reread = await (await fetch(`${BASE}/api/appearance`)).json();
    assert.deepStrictEqual(reread.appearance, patched.appearance);

    for (const [label, payload] of [
      ['unknown preset', { appearance: { preset: 'neon' } }],
      ['unknown token', { appearance: { overrides: { light: { '--evil': '#000000' } } } }],
      ['malformed hex', { appearance: { overrides: { light: { page: 'javascript:alert(1)' } } } }],
    ]) {
      const response = await fetch(`${BASE}/api/appearance`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      assert.strictEqual(response.status, 400, `${label}: expected 400`);
      const body = await response.json();
      assert.strictEqual(body.ok, false);
    }

    // A rejected PATCH must not corrupt the previously saved skin.
    const afterReject = await (await fetch(`${BASE}/api/appearance`)).json();
    assert.strictEqual(afterReject.appearance.preset, 'steel');
  } finally {
    cleanup();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  console.log('appearance-settings-test PASS');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
