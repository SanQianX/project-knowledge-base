'use strict';
// Keep the real subscription key out of the worker. / 工作模型不得持有真实订阅密钥。
const http = require('node:http');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { must, readJSON, atomicJSON, redact } = require('../lib/safety.cjs');
const { fetchQuota, quotaDecision } = require('../lib/quota.cjs');
function tokenEqual(a, b) { const x = Buffer.from(a || ''), y = Buffer.from(b || ''); return x.length === y.length && crypto.timingSafeEqual(x, y); }
function createGateway(options) {
    const { queryQuota, upstreamFetch = fetch, apiKey, localToken, upstreamBase, model, policy, onQuota = () => { } } = options;
    must(localToken && localToken.length >= 24, 'GATEWAY_TOKEN', 'Provide a strong local gateway token.');
    let quota = null, gate = { state: 'UNKNOWN', admitRequest: false, admitTask: false, successes: 0 }, active = 0, lastSample = 0;
    const routes = { '/v1/messages': '/anthropic/v1/messages', '/anthropic/v1/messages': '/anthropic/v1/messages', '/v1/chat/completions': '/v1/chat/completions' };
    async function sample() {
        try {
            quota = await queryQuota();
        }
        catch {
            quota = { state: 'UNKNOWN', checkedAt: Date.now(), reason: 'QUERY_FAILED' };
        }
        gate = quotaDecision(quota, policy, gate.state, Date.now(), gate.successes);
        lastSample = Date.now();
        onQuota({ quota, gate });
        return gate;
    }
    const server = http.createServer(async (req, res) => {
        const json = (status, body) => { if (!res.headersSent)
            res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
        if (req.url === '/health' && req.method === 'GET')
            return json(200, { kind: 'qa-quota-gateway', state: gate.state, active });
        const supplied = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '') || String(req.headers['x-api-key'] || '');
        if (!tokenEqual(supplied, localToken))
            return json(401, { error: { type: 'authentication_error', message: 'Local gateway token required.' } });
        if (req.method !== 'POST' || !routes[req.url])
            return json(404, { error: { type: 'not_found_error', message: 'Route not permitted.' } });
        if (active >= (policy.maxConcurrentRequests || policy.maxConcurrent || 1))
            return json(429, { error: { type: 'rate_limit_error', code: 'QA_CONCURRENCY', message: 'Retry after the active request ends.' } });
        active++;
        let timeout;
        const abort = new AbortController();
        const disconnect = () => { if (!res.writableEnded)
            abort.abort(); };
        res.once('close', disconnect);
        try {
            if (Date.now() - lastSample >= (policy.sampleMs || 60000))
                await sample();
            if (Date.now() - (quota?.checkedAt || 0) > (policy.maxAgeMs || 120000))
                gate = { ...gate, state: 'UNKNOWN', admitRequest: false };
            if (!gate.admitRequest) {
                res.setHeader('Retry-After', '120');
                return json(429, { error: { type: 'rate_limit_error', code: 'QA_QUOTA_PAUSED', message: 'Quota guard paused new calls; checkpoint and wait.' } });
            }
            const chunks = [];
            let total = 0;
            for await (const chunk of req) {
                total += chunk.length;
                must(total <= (policy.maxRequestBytes || 2 * 1024 * 1024), 'BODY_TOO_LARGE', 'Request too large.');
                chunks.push(chunk);
            }
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            must(body.model === model, 'MODEL_MISMATCH', 'Unapproved model.');
            must(Number.isInteger(body.max_tokens) && body.max_tokens > 0 && body.max_tokens <= (policy.maxOutputTokens || 4096), 'OUTPUT_BOUND', 'Explicit bounded max_tokens required.');
            const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey };
            for (const h of ['anthropic-version', 'anthropic-beta'])
                if (req.headers[h])
                    headers[h] = req.headers[h];
            timeout = setTimeout(() => abort.abort(), policy.requestTimeoutMs || 600000);
            const upstream = await upstreamFetch(upstreamBase + routes[req.url], { method: 'POST', headers, body: JSON.stringify(body), redirect: 'error', signal: abort.signal });
            res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') || 'application/json', 'Cache-Control': 'no-store' });
            if (upstream.body)
                await pipeline(Readable.fromWeb(upstream.body), res);
            else
                res.end();
        }
        catch (error) {
            if (!res.headersSent)
                json(503, { error: { type: 'api_error', code: error.code || 'QA_GATEWAY', message: 'Request denied or upstream unavailable. Details remain in controller diagnostics.' } });
            else
                res.destroy();
        }
        finally {
            active--;
            clearTimeout(timeout);
            res.removeListener('close', disconnect);
        }
    });
    return { server, sample, status: () => ({ quota, gate, active }) };
}
async function main() {
    const cfg = readJSON(process.argv[2]);
    const upstreamBase = cfg.gateway.upstreamOrigin;
    const u = new URL(upstreamBase);
    must(u.protocol === 'https:' && ['api.minimax.io', 'api.minimax.cn', 'api.minimaxi.com'].includes(u.hostname) && u.pathname === '/', 'UPSTREAM', 'Only approved MiniMax API origins are accepted.');
    const apiKey = process.env[cfg.quota.keyEnv || 'MINIMAX_API_KEY'];
    must(apiKey && !apiKey.startsWith('sk-api-'), 'KEY', 'Verified subscription key required.');
    const gateway = createGateway({ apiKey, localToken: process.env.QA_GATEWAY_TOKEN, upstreamBase: upstreamBase.replace(/\/$/, ''), model: cfg.gateway.model,
        policy: { ...cfg.quota, ...cfg.gateway }, queryQuota: () => fetchQuota(cfg.quota),
        onQuota: q => atomicJSON(require('node:path').join(cfg.qaRoot, 'state', 'gateway-quota.json'), q)
    });
    await gateway.sample();
    const timer = setInterval(() => gateway.sample().catch(() => { }), cfg.quota.sampleMs || 60000);
    gateway.server.listen(cfg.gateway.port || 0, '127.0.0.1', () => console.log(JSON.stringify({ kind: 'qa-quota-gateway', port: gateway.server.address().port, credentialsInOutput: false })));
    const stop = () => { clearInterval(timer); gateway.server.close(); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
}
if (require.main === module)
    main().catch(e => { console.error(redact(e.message)); process.exitCode = 20; });
module.exports = { createGateway, tokenEqual };
