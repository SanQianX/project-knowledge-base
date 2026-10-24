'use strict';
// _site/_test/helpers/parallel-qa-engine-endpoint-guard.js — P-QA-ENGINE-ENDPOINT-FIX-R5
//
// Fail-closed endpoint discipline for every engine construction in this lane.
// The engine coordinator ignores env for its vector/bridge legs (hardcoded
// LIVE fallbacks 127.0.0.1:8787/8790), so tests must pass explicit OWN urls —
// these helpers refuse anything else instead of silently defaulting live:
//
//   assertOwnedEndpoint(url, {role})      throws PK_ENGINE_ENDPOINT_REFUSED for
//                                         missing/non-http/non-loopback/port-0/
//                                         protected-port URLs; accepts ONLY
//                                         http on loopback with an explicit
//                                         non-protected port.
//   guardedCreateEngineServer(options)    requires a safe options.vectorUrl AND
//                                         (safe options.bridgeUrl OR an
//                                         options.bridge double); only then
//                                         lazily requires the product server.
//                                         Refusals never load product code.
//   installEgressGuard()                  patches global.fetch: protected ports
//                                         and non-loopback hosts throw
//                                         PK_PROTECTED_EGRESS_BLOCKED BEFORE
//                                         any I/O (no socket is opened); every
//                                         allowed call is recorded and passed
//                                         through. Covers requestIndex
//                                         (default-param fetch), retrieval
//                                         recallIndex, coordinator health and
//                                         ModuleBridge._fetch, which all read
//                                         global fetch at call time.
//   createEngineVectorStandin()           minimal OWN vector contract server
//                                         (ephemeral loopback port): POST
//                                         /api/import, POST /api/sync, GET
//                                         /api/projects, GET /api/search.
//                                         /api/search answers 503 so retrieval
//                                         degrades to lexical — this stand-in
//                                         proves request routing and contract
//                                         parity, NOT real vector quality.
//   createEngineBridgeDouble()            in-process bridge test double with
//                                         the full drain surface; never opens
//                                         a socket.
const http = require('node:http');
const path = require('node:path');
const { PROTECTED_PORTS } = require('./parallel-qa-engine-endpoint-isolate');

const REFUSAL_CODE = 'PK_ENGINE_ENDPOINT_REFUSED';
const EGRESS_BLOCK_CODE = 'PK_PROTECTED_EGRESS_BLOCKED';
const ENGINE_SERVER_MODULE = path.resolve(__dirname, '..', '..', '..', '_modules', 'knowledge-engine', 'src', 'server.js');

function refusal(message, extra = {}) {
  return Object.assign(new Error(message), { code: REFUSAL_CODE, ...extra });
}

function assertOwnedEndpoint(value, { role = 'endpoint' } = {}) {
  if (typeof value !== 'string' || !value.trim()) throw refusal(`${role}: 缺少显式 URL，拒绝回落 LIVE 默认端口。`, { role });
  let url;
  try { url = new URL(value); } catch { throw refusal(`${role}: URL 无法解析（${value}）。`, { role }); }
  if (url.protocol !== 'http:') throw refusal(`${role}: 只允许 http://（收到 ${url.protocol}//）。`, { role });
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw refusal(`${role}: 只允许回环地址（收到 ${url.hostname}）。`, { role });
  const port = Number(url.port);
  if (!url.port || !Number.isInteger(port) || port <= 0) throw refusal(`${role}: 必须显式指定非零端口（收到 ${value}）。`, { role });
  if (PROTECTED_PORTS.has(port)) throw refusal(`${role}: 端口 ${port} 属于保护模块端口（${[...PROTECTED_PORTS].join('/')}），拒绝 LIVE 默认接触。`, { role, port });
  return url;
}

function assertBridgeOption(options) {
  if (options.bridge !== undefined) {
    if (!options.bridge || typeof options.bridge !== 'object' || Array.isArray(options.bridge)) throw refusal('bridge 替身必须是对象。');
    return options.bridge;
  }
  assertOwnedEndpoint(options.bridgeUrl, { role: 'bridgeUrl' });
  return null;
}

function guardedCreateEngineServer(options = {}) {
  assertOwnedEndpoint(options.vectorUrl, { role: 'vectorUrl' });
  assertBridgeOption(options);
  const { createEngineServer } = require(ENGINE_SERVER_MODULE);
  return createEngineServer(options);
}

function installEgressGuard() {
  const original = global.fetch;
  if (typeof original !== 'function') throw new Error('global.fetch 不可用，无法安装出口守卫。');
  const blocked = [];
  const requests = [];
  function judge(url) {
    let port;
    if (url.port === '') port = url.protocol === 'https:' ? 443 : url.protocol === 'http:' ? 80 : NaN;
    else port = Number(url.port);
    if (Number.isInteger(port) && PROTECTED_PORTS.has(port)) return `protected-port:${port}`;
    // URL.hostname keeps IPv6 literals in bracketed form — this list must
    // match assertOwnedEndpoint's exactly ('[::1]', never bare '::1', which
    // no URL.hostname ever yields).
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return `non-loopback-host:${url.hostname}`;
    return null;
  }
  const guard = async (input, init) => {
    let href = null, method = null;
    try {
      const url = input instanceof URL ? new URL(input.href) : new URL(typeof input === 'string' ? input : input?.url);
      href = url.href;
      method = (init?.method) || (typeof input === 'object' && input?.method) || 'GET';
      const reason = judge(url);
      if (reason) {
        const error = Object.assign(new Error(`出口守卫：${reason} — ${href}（已阻止，未建立任何连接）`), { code: EGRESS_BLOCK_CODE, target: href, reason });
        blocked.push({ href, method, reason, at: Date.now() });
        throw error;
      }
      requests.push({ href, method, at: Date.now() });
    } catch (error) {
      if (error && error.code === EGRESS_BLOCK_CODE) throw error;
      const record = { href: String(input), method: 'UNKNOWN', reason: 'unparseable-target', at: Date.now() };
      blocked.push(record);
      throw Object.assign(new Error(`出口守卫：无法解析目标，按拒绝处理 — ${record.href}`), { code: EGRESS_BLOCK_CODE, target: record.href, reason: 'unparseable-target' });
    }
    return original(input, init);
  };
  global.fetch = guard;
  return {
    blocked,
    requests,
    uninstall() { if (global.fetch === guard) global.fetch = original; },
  };
}

function respondJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function createEngineVectorStandin({ label = 'r5-vector-standin' } = {}) {
  const records = [];
  const projects = new Map();
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      let body = null;
      try { const text = Buffer.concat(chunks).toString('utf8'); if (text) body = JSON.parse(text); } catch { body = null; }
      records.push({ method: req.method, path: req.url, body, at: Date.now() });
      const route = (req.url || '').split('?')[0];
      if (req.method === 'POST' && route === '/api/import') {
        const name = String(body?.projectName || '(missing-projectName)');
        const sourceDir = String(body?.sourceDir || '');
        projects.set(name, { name, hasIndex: true, sourceDir });
        respondJson(res, 200, { ok: true, project: { name, hasIndex: true, sourceDir } });
        return;
      }
      if (req.method === 'POST' && route === '/api/sync') {
        const name = String(body?.project || '(missing-project)');
        const sourceDir = String(body?.sourceDir || '');
        projects.set(name, { name, hasIndex: true, sourceDir });
        respondJson(res, 200, { ok: true });
        return;
      }
      if (req.method === 'GET' && route === '/api/projects') {
        respondJson(res, 200, { projects: [...projects.values()] });
        return;
      }
      if (req.method === 'GET' && route === '/api/search') {
        // Stand-in deliberately reports unavailable: retrieval must degrade to
        // lexical. This fixture proves request routing and contract parity —
        // it must never be cited as real vector retrieval quality.
        respondJson(res, 503, { ok: false, error: { code: 'VECTOR_UNAVAILABLE_STANDIN', message: `${label}: 替身不提供向量检索质量` } });
        return;
      }
      respondJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: `${label}: 未实现该向量契约路由` } });
    });
  });
  const listening = new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
  const standin = {
    label,
    records,
    projects,
    url: null,
    async close() { await listening.catch(() => {}); await new Promise(resolve => server.close(resolve)); },
  };
  standin.ready = listening.then(port => { standin.url = `http://127.0.0.1:${port}`; return standin.url; });
  return standin;
}

function createEngineBridgeDouble() {
  return {
    double: 'r5-bridge-double',
    calls: [],
    async registerConsumer(consumer, options) { this.calls.push({ op: 'registerConsumer', consumer }); return { ok: true }; },
    async listJournals() { this.calls.push({ op: 'listJournals' }); return []; },
    async readEvents(query) { this.calls.push({ op: 'readEvents', query }); return []; },
    async ackConsumerCursor(consumer, through, options) { this.calls.push({ op: 'ackConsumerCursor', consumer, through }); return { ok: true }; },
    async close() { this.calls.push({ op: 'close' }); },
  };
}

module.exports = {
  REFUSAL_CODE,
  EGRESS_BLOCK_CODE,
  PROTECTED_PORTS,
  assertOwnedEndpoint,
  guardedCreateEngineServer,
  installEgressGuard,
  createEngineVectorStandin,
  createEngineBridgeDouble,
};
