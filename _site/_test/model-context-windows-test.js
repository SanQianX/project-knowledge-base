// Tests for model-context-windows: lookup table + resolution priority chain.
//   profile.contextWindow (explicit override)
//     → model name table (anthropic / minimax / glm / gpt / deepseek / qwen / gemini)
//       → CLAUDE_CONTEXT_WINDOW env
//         → 200000 fallback

const { lookupContextWindow, resolveContextWindow } = require('../lib/model-context-windows');

function assert(cond, msg) { if (!cond) throw new Error(msg); }

(() => {
  try {
    // ---- lookupContextWindow: family prefix matching ----
    assert(lookupContextWindow('claude-opus-4-7') === 200000, 'claude-opus-4-7 → 200000');
    assert(lookupContextWindow('claude-sonnet-4-6') === 200000, 'claude-sonnet-4-6 → 200000');
    assert(lookupContextWindow('claude-haiku-4-5') === 200000, 'claude-haiku-4-5 → 200000');
    assert(lookupContextWindow('claude-3-5-sonnet-20241022') === 200000, 'claude-3-5 → 200000');

    assert(lookupContextWindow('glm-5.2') === 1048576, 'glm-5.2 → 1M');
    assert(lookupContextWindow('GLM-4.6') === 1048576, 'GLM-4.6 (uppercase) → 1M');
    assert(lookupContextWindow('glm-4.5-air') === 128000, 'glm-4.5-air → 128000');
    assert(lookupContextWindow('glm-4-plus') === 128000, 'glm-4-plus → 128000');

    assert(lookupContextWindow('MiniMax-M3') === 1048576, 'MiniMax-M3 → 1M');
    assert(lookupContextWindow('minimax-m2') === 1048576, 'minimax-m2 → 1M');

    assert(lookupContextWindow('gpt-5-mini') === 200000, 'gpt-5-mini → 200000');
    assert(lookupContextWindow('gpt-4o-2024-08-06') === 128000, 'gpt-4o → 128000');
    assert(lookupContextWindow('gpt-4.1-2025-04-14') === 1047576, 'gpt-4.1 → 1047576');

    assert(lookupContextWindow('deepseek-v3') === 128000, 'deepseek-v3 → 128000');
    assert(lookupContextWindow('deepseek-r1') === 128000, 'deepseek-r1 → 128000');

    assert(lookupContextWindow('qwen3-coder') === 131072, 'qwen3 → 131072');
    assert(lookupContextWindow('gemini-2.5-pro') === 1048576, 'gemini-2.5 → 1M');

    assert(lookupContextWindow('totally-unknown-model') === null, 'unknown → null');
    assert(lookupContextWindow('') === null, 'empty → null');
    assert(lookupContextWindow(null) === null, 'null → null');
    assert(lookupContextWindow(undefined) === null, 'undefined → null');

    // ---- resolveContextWindow: priority chain ----

    // 1. profile.contextWindow wins over everything
    assert(resolveContextWindow({ profileContextWindow: 500000, model: 'claude-opus-4' }) === 500000,
      'explicit profileContextWindow must override table');

    // 2. table wins when profile is empty
    assert(resolveContextWindow({ model: 'glm-5.2' }) === 1048576,
      'table hit should be used when profileContextWindow empty');

    // 3. env wins when profile + table both miss
    assert(resolveContextWindow({ model: 'unknown-model', env: { CLAUDE_CONTEXT_WINDOW: '99999' } }) === 99999,
      'env should be used when table misses');

    // 4. fallback (200000 default) when nothing matches
    assert(resolveContextWindow({ model: 'unknown-model' }) === 200000,
      'default fallback should be 200000');

    // 5. profile.contextWindow = 0 / negative treated as unset
    assert(resolveContextWindow({ profileContextWindow: 0, model: 'glm-5.2' }) === 1048576,
      'profileContextWindow=0 should fall through to table');
    assert(resolveContextWindow({ profileContextWindow: -1, model: 'glm-5.2' }) === 1048576,
      'negative profileContextWindow should fall through to table');

    // 6. non-finite profileContextWindow (NaN, string) ignored
    assert(resolveContextWindow({ profileContextWindow: NaN, model: 'minimax-m3' }) === 1048576,
      'NaN profileContextWindow should fall through');
    assert(resolveContextWindow({ profileContextWindow: 'abc', model: 'minimax-m3' }) === 1048576,
      'non-numeric string profileContextWindow should fall through');

    // 7. custom fallback honored when nothing else matches
    assert(resolveContextWindow({ model: 'unknown', fallback: 12345 }) === 12345,
      'custom fallback should be respected');

    // 8. no args at all → fallback
    assert(resolveContextWindow() === 200000,
      'no-args call should hit default fallback');

    // 9. fractional context window floored
    assert(resolveContextWindow({ profileContextWindow: 123456.789, model: 'x' }) === 123456,
      'fractional contextWindow should be floored');

    console.log('model-context-windows test passed');
  } catch (e) {
    console.error('model-context-windows test failed:', e.message);
    process.exitCode = 1;
  }
})();
