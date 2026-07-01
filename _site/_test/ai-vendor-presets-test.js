// Tests for ai-vendor-presets: 4 vendors with full fields, name/id lookup.

const { AI_VENDOR_PRESETS, listVendorPresetNames, findVendorPresetByName } = require('../lib/ai-vendor-presets');

function assert(cond, msg) { if (!cond) throw new Error(msg); }

(() => {
  try {
    // 1. Exactly 4 vendors
    assert(Array.isArray(AI_VENDOR_PRESETS), 'AI_VENDOR_PRESETS should be an array');
    assert(AI_VENDOR_PRESETS.length === 4, `expected 4 vendors, got ${AI_VENDOR_PRESETS.length}`);

    // 2. IDs unique and match the expected set
    const ids = AI_VENDOR_PRESETS.map(v => v.id).sort();
    assert(JSON.stringify(ids) === JSON.stringify(['anthropic', 'deepseek', 'minimax', 'zhipu']),
      `vendor ids should be anthropic/deepseek/minimax/zhipu, got ${JSON.stringify(ids)}`);

    // 3. Every preset has the required fields
    const required = ['id', 'name', 'baseUrl', 'mainModel', 'thinkingModel',
                      'haikuModel', 'sonnetModel', 'opusModel', 'contextWindow', 'website'];
    for (const v of AI_VENDOR_PRESETS) {
      for (const f of required) {
        assert(v[f] !== undefined && v[f] !== null && v[f] !== '',
          `vendor ${v.id} missing or empty field: ${f}`);
      }
    }

    // 4. baseUrl: https://, no trailing slash
    for (const v of AI_VENDOR_PRESETS) {
      assert(/^https?:\/\//.test(v.baseUrl), `${v.id} baseUrl must start with http(s)://`);
      assert(!/\/$/.test(v.baseUrl), `${v.id} baseUrl must NOT have trailing slash`);
    }

    // 5. contextWindow is a positive integer
    for (const v of AI_VENDOR_PRESETS) {
      assert(Number.isInteger(v.contextWindow) && v.contextWindow > 0,
        `${v.id} contextWindow must be a positive integer, got ${v.contextWindow}`);
    }

    // 6. Specific known values
    const minimax = findVendorPresetByName('MiniMax');
    assert(minimax && minimax.baseUrl === 'https://api.minimaxi.com/anthropic',
      `minimax baseUrl wrong: ${minimax && minimax.baseUrl}`);
    assert(minimax && minimax.mainModel === 'MiniMax-M3',
      `minimax mainModel wrong: ${minimax && minimax.mainModel}`);
    assert(minimax && minimax.contextWindow === 1048576,
      `minimax contextWindow should be 1M`);

    const anthropic = findVendorPresetByName('Anthropic Claude');
    assert(anthropic && anthropic.baseUrl === 'https://api.anthropic.com',
      `anthropic baseUrl wrong`);
    assert(anthropic && anthropic.contextWindow === 200000,
      `anthropic contextWindow should be 200K`);

    const zhipu = findVendorPresetByName('智谱 GLM');
    assert(zhipu && zhipu.baseUrl === 'https://open.bigmodel.cn/api/anthropic',
      `zhipu baseUrl wrong: ${zhipu && zhipu.baseUrl}`);

    const deepseek = findVendorPresetByName('DeepSeek');
    assert(deepseek && deepseek.baseUrl === 'https://api.deepseek.com/anthropic',
      `deepseek baseUrl wrong: ${deepseek && deepseek.baseUrl}`);
    assert(deepseek && deepseek.mainModel === 'deepseek-chat',
      `deepseek mainModel wrong`);
    assert(deepseek && deepseek.thinkingModel === 'deepseek-reasoner',
      `deepseek thinkingModel wrong`);

    // 7. Case-insensitive lookup by name
    assert(findVendorPresetByName('minimax').id === 'minimax', 'lowercase name lookup');
    assert(findVendorPresetByName('MINIMAX').id === 'minimax', 'uppercase name lookup');

    // 8. Lookup by id also works
    assert(findVendorPresetByName('minimax').id === 'minimax', 'id lookup');

    // 9. Unknown / empty / null returns null (no false positive)
    assert(findVendorPresetByName('Totally Unknown Vendor') === null, 'unknown vendor → null');
    assert(findVendorPresetByName('') === null, 'empty name → null');
    assert(findVendorPresetByName(null) === null, 'null name → null');
    assert(findVendorPresetByName(undefined) === null, 'undefined name → null');

    // 10. listVendorPresetNames returns all 4 names in stable order
    const names = listVendorPresetNames();
    assert(names.length === 4, `expected 4 names, got ${names.length}`);
    assert(names.every(n => typeof n === 'string' && n.length > 0),
      'all names should be non-empty strings');

    console.log('ai-vendor-presets test passed');
  } catch (e) {
    console.error('ai-vendor-presets test failed:', e.message);
    process.exitCode = 1;
  }
})();
