'use strict';
const { must, readJSON, atomicJSON } = require('../lib/safety.cjs');
const path = require('node:path');
function quantile(values, p) { must(values.length > 0, 'NO_SAMPLES', 'No samples'); const a = [...values].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.ceil(a.length * p) - 1)]; }
function summarize(samples) { must(samples.length > 0, 'NO_SAMPLES', 'No measurements.'); const ok = samples.filter(s => s.ok); return { count: samples.length, errors: samples.length - ok.length, p50Ms: quantile(samples.map(s => s.ms), .5), p95Ms: quantile(samples.map(s => s.ms), .95), p99Ms: quantile(samples.map(s => s.ms), .99) }; }
function compare(now, base, policy) { must(policy.approved === true && policy.environmentId === base.environmentId && now.environmentId === base.environmentId && now.scenario === base.scenario && now.fixtureHash === base.fixtureHash, 'BASELINE_MISMATCH', 'Approved matching environment, scenario and fixture required.', 20); must(Number.isFinite(policy.maxP95RegressionPercent) && policy.maxP95RegressionPercent >= 0 && Number.isFinite(policy.maxErrorRate) && policy.maxErrorRate >= 0, 'PERF_POLICY', 'Explicit reviewed thresholds required.'); const regression = base.summary.p95Ms > 0 ? (now.summary.p95Ms / base.summary.p95Ms - 1) * 100 : Infinity; return { status: regression <= policy.maxP95RegressionPercent && now.summary.errors / now.summary.count <= policy.maxErrorRate ? 'PASS' : 'FAIL', regressionPercent: regression }; }
async function measure(config) { const u = new URL(config.baseUrl); must(u.protocol === 'http:' && u.hostname === '127.0.0.1' && u.port, 'TARGET', 'Only an explicitly owned loopback instance is allowed.'); must(config.ownedInstanceVerified === true && config.identityReceipt && config.environmentId && config.fixtureHash, 'IDENTITY', 'Verify process, source SHA and data-directory ownership first.', 20); must(Number.isInteger(config.count) && config.count >= 20 && config.count <= 2000 && Number.isInteger(config.concurrency) && config.concurrency >= 1 && config.concurrency <= 8, 'LOAD_BOUND', 'Use count 20..2000 and concurrency 1..8.'); must(['/api/health', '/api/projects/aggregated'].includes(config.route), 'READ_ONLY_ROUTE', 'This starter only permits reviewed read-only routes.'); let next = 0; const samples = []; await Promise.all(Array.from({ length: config.concurrency }, async () => { while (next < config.count) {
    const index = next++, start = performance.now();
    let ok = false;
    try {
        const r = await fetch(u.origin + config.route, { redirect: 'error', signal: AbortSignal.timeout(5000) });
        const b = await r.json();
        ok = r.ok && b.ok !== false;
    }
    catch { }
    samples.push({ index, ms: performance.now() - start, ok });
} })); return { schema: 1, status: 'MEASURED_NOT_ACCEPTED', mode: 'BOUNDED_HTTP', scenario: config.route + '#c' + config.concurrency, environmentId: config.environmentId, fixtureHash: config.fixtureHash, summary: summarize(samples), samples, at: new Date().toISOString() }; }
async function main() { const cfg = readJSON(process.argv[2]); const result = await measure(cfg); atomicJSON(path.resolve(process.argv[3]), result); console.log(JSON.stringify(result.summary)); }
if (require.main === module)
    main().catch(e => { console.error(e.message); process.exitCode = 20; });
module.exports = { quantile, summarize, compare, measure };
