// tests/agentic-context-limit-test.js
//
// The deep time limit of a smart search is bounded in four places that must
// agree: the limit the page lets the user set, the limit the host accepts,
// the time the host proxy waits for the engine, and the time the page itself
// waits for the host. The default stays one minute. A model that thinks
// before it answers spends several seconds on each of the calls a search
// makes, so the limit may be set to two minutes.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { validateAgenticContext } = require('../src/projects/settings-store');

const ROOT = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
const DEFAULT_MS = 60000;
const MAX_MS = 120000;

// --- the limit the host accepts -------------------------------------------
assert.strictEqual(validateAgenticContext({ enabled: true }).deepTimeoutMs, DEFAULT_MS, 'the default is one minute');
assert.strictEqual(validateAgenticContext({ enabled: true, deepTimeoutMs: MAX_MS }).deepTimeoutMs, MAX_MS, 'two minutes are accepted');
for (const value of [MAX_MS + 1, 1999, 60000.5, '60000', null]) {
  assert.throws(() => validateAgenticContext({ enabled: true, deepTimeoutMs: value }),
    error => error.code === 'INVALID_ARGUMENT', `deepTimeoutMs ${JSON.stringify(value)} must be refused`);
}

// --- the limit the page lets the user set ---------------------------------
const input = /<input type="number" id="agenticContextTimeout" min="(\d+)" max="(\d+)" value="(\d+)">/.exec(read('resources/ui/index.html'));
assert.ok(input, 'the page has the deep time limit input');
assert.deepStrictEqual([Number(input[1]), Number(input[2]), Number(input[3])], [2, MAX_MS / 1000, DEFAULT_MS / 1000], 'the input offers 2 seconds to the maximum, one minute by default');

// --- the two waits: each covers the limit; the proxy gives up before the page ---
const pageWaitMs = Number(/timeoutMs: deep \? (\d+) : 15000/.exec(read('resources/ui/product.js'))?.[1]);
const proxyWaitMs = Number(/const DEEP_CONTEXT_PROXY_TIMEOUT_MS = (\d+);/.exec(read('src/module_bridge/module-bridge.js'))?.[1]);
assert.ok(Number.isFinite(pageWaitMs), 'the page names how long it waits for a smart search');
assert.ok(Number.isFinite(proxyWaitMs), 'the proxy names how long it waits for the engine');
assert.ok(pageWaitMs >= MAX_MS, `the page waits ${pageWaitMs} ms, less than the ${MAX_MS} ms limit`);
assert.ok(proxyWaitMs >= MAX_MS, `the proxy waits ${proxyWaitMs} ms, less than the ${MAX_MS} ms limit`);
assert.ok(proxyWaitMs < pageWaitMs, `the proxy (${proxyWaitMs} ms) must give up before the page (${pageWaitMs} ms), so the page reads why`);

console.log('agentic-context-limit-test PASS');
