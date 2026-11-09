'use strict';
// WB-QUOTA-01-R2 RED re-confirmation — EXPLICIT, never part of default CI.
//
// Runs the leader's three counterproofs (plus the modelCode injection) one
// more time against the FROZEN r1 source snapshot
// (leader-review-r1/source-snapshot) — NOT the working tree — and records
// that the r1 code still fails them. Exit code 0 means every counterproof
// reproduced (i.e. the snapshot is red as documented); a green run here
// would mean the counterproofs no longer describe the snapshot.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SNAPSHOT = path.join(__dirname, '..', '..', 'artifacts', 'parallel-20261023', 'model-quota-feature', 'leader-review-r1', 'source-snapshot');
const OUT = path.join(__dirname, '..', '..', 'artifacts', 'parallel-20261023', 'model-quota-feature', 'red-r2-local.json');

const findings = [];
const check = async (name, expectFail, fn) => {
  try {
    const detail = await fn();
    findings.push({ name, snapshotBehavior: detail, verdict: expectFail ? 'unexpectedly-fixed' : 'fixed' });
  } catch (error) {
    findings.push({ name, error: String(error.message), verdict: expectFail ? 'red-reproduced' : 'not-reproduced' });
  }
};

const { ProfileQuotaService } = require(path.join(SNAPSHOT, 'packages', 'server', 'lib', 'profile-quota'));
const jsonResponse = (status, body) => ({ status, text: async () => JSON.stringify(body) });
const GLM_PROFILE = { id: 'glm', name: 'GLM', provider: '智谱GLM', baseUrl: 'https://open.bigmodel.cn/api/anthropic', models: { default: 'glm-4.6' } };
const MINIMAX_PROFILE = { id: 'dual', name: 'M', provider: 'MiniMax', baseUrl: 'https://api.minimaxi.com/anthropic', models: { default: 'MiniMax-M3.1-Flash' } };
const GLM_DUAL = { ...GLM_PROFILE, id: 'dual' };
const assert = (condition, message) => { if (!condition) throw new Error(message); };

(async () => {
  // 1. null-not-zero
  await check('null-not-zero', true, async () => {
    const body = { code: 200, success: true, data: { level: 'max', limits: [{ type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: null, nextResetTime: null }] } };
    const result = await new ProfileQuotaService({ fetch: async () => jsonResponse(200, body) }).getQuota({ profile: GLM_PROFILE, credential: 'k' });
    assert(result.windows[0].usedPercent === null && result.windows[0].remainingPercent === null,
      `snapshot fabricated usedPercent=${result.windows[0].usedPercent}/remainingPercent=${result.windows[0].remainingPercent}`);
    return { usedPercent: result.windows[0].usedPercent, remainingPercent: result.windows[0].remainingPercent };
  });

  // 2. inflight provider switch (same id + same fake key)
  await check('inflight-provider-switch', true, async () => {
    const calls = [];
    const releases = new Map();
    const fetch = (url, init) => {
      calls.push(url);
      return new Promise(resolve => releases.set(url, () => resolve(url.includes('minimaxi') ? jsonResponse(200, { model_remains: [], base_resp: { status_code: 4 } }) : jsonResponse(200, { code: 200, success: true, data: { level: 'GLM', limits: [{ type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 10, nextResetTime: 1792765731899 }] } }))));
    };
    const service = new ProfileQuotaService({ fetch });
    const glmPending = service.getQuota({ profile: GLM_DUAL, credential: 'same-fake-key-abcdef' });
    const minimaxPending = service.getQuota({ profile: MINIMAX_PROFILE, credential: 'same-fake-key-abcdef' });
    await new Promise(resolve => setImmediate(resolve));
    assert(calls.length === 2, `snapshot issued ${calls.length} calls for a provider switch (joined inflight)`);
    releases.get(calls[1])();
    const second = await minimaxPending;
    assert(second.provider === 'minimax', `the MiniMax request received provider=${second.provider}`);
    releases.get(calls[0])();
    await glmPending;
    return { calls: calls.length, secondProvider: second.provider };
  });

  // 3. stale lost in valid TTL
  await check('stale-lost-in-valid-ttl', true, async () => {
    let mode = 'ok';
    const service = new ProfileQuotaService({ fetch: async () => jsonResponse(200, mode === 'ok' ? { code: 200, success: true, data: { level: 'max', limits: [{ type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 28, nextResetTime: 1792765731899 }] } } : { nope: 1 }) });
    await service.getQuota({ profile: GLM_PROFILE, credential: 'k' });
    mode = 'fail';
    const failedRefresh = await service.getQuota({ profile: GLM_PROFILE, credential: 'k', refresh: true });
    assert(failedRefresh.stale === true, 'refresh failure must be stale');
    const followingRead = await service.getQuota({ profile: GLM_PROFILE, credential: 'k' });
    assert(followingRead.stale === true, `snapshot washed the failure away: stale=${followingRead.stale}`);
    return { failedRefreshStale: failedRefresh.stale, followingReadStale: followingRead.stale };
  });

  // 4. (bonus) minimax status_code null read as success in the snapshot
  await check('status-code-null-success', true, async () => {
    const result = await new ProfileQuotaService({ fetch: async () => jsonResponse(200, { base_resp: { status_code: null }, model_remains: [{}] }) }).getQuota({ profile: MINIMAX_PROFILE, credential: 'k' });
    assert(result.status === 'error', `snapshot treated status_code:null as ${result.status}`);
    return { status: result.status };
  });

  // 5. (bonus) r1 UI renders the malicious modelCode as markup
  check('ui-modelcode-injection', true, () => {
    const source = fs.readFileSync(path.join(SNAPSHOT, 'packages', 'ui', 'ai-profile-settings.js'), 'utf8');
    const sandbox = {
      Date, JSON, Number, String, Array, Object, Promise, Map, Set, Boolean, RegExp, Math,
      customElements: { get: () => undefined, define() {} },
      CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
      setTimeout, clearTimeout,
      HTMLElement: class {
        constructor() { this.shadowRoot = { innerHTML: '', addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; } }; this.isConnected = true; }
        attachShadow() { return this.shadowRoot; }
        dispatchEvent() { return true; }
      },
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(source, sandbox);
    const list = new sandbox.AiProfileList();
    list.profiles = [GLM_PROFILE];
    list.handleClick({ composedPath: () => [{ matches: () => true, dataset: { action: 'quota', id: 'glm' } }] });
    const malicious = '<img src=x onerror=1>';
    list.setQuota('glm', { status: 'ok', checkedAt: new Date(0).toISOString(), windows: [
      { kind: 'tools', duration: { number: 1, unit: 'months' }, used: 1, total: 2, remaining: 1, unit: 'tool-calls', resetAt: 1794901032984, resetAtUnit: 'ms', details: [{ modelCode: malicious, usage: 1 }] },
    ] });
    assert(!list.shadowRoot.innerHTML.includes(malicious), 'snapshot injected the raw modelCode into innerHTML');
    return { injected: true };
  });

  const reproduced = findings.filter(item => item.verdict === 'red-reproduced').length;
  const evidence = {
    probe: 'parallel-model-quota-r2-red-check',
    ranAt: new Date().toISOString(),
    target: 'leader-review-r1/source-snapshot (frozen r1 code, NOT the working tree)',
    findings,
    reproduced,
    total: findings.length,
    summary: reproduced === findings.length
      ? `RED confirmed: all ${findings.length} counterproofs reproduce against the frozen r1 snapshot`
      : `PARTIAL: ${reproduced}/${findings.length} reproduced against the snapshot`,
  };
  fs.writeFileSync(OUT, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(evidence.summary);
  console.log(`red evidence -> ${OUT}`);
  const exitCode = reproduced === findings.length ? 0 : 1;
  setTimeout(() => process.exit(exitCode), 250).unref();
  process.exitCode = exitCode;
})().catch(error => {
  console.error(error);
  setTimeout(() => process.exit(1), 250).unref();
});
