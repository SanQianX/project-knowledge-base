'use strict';
// Fail closed when quota meaning is unknown. / 额度含义不明时拒绝新调用。
const { must, QAError, commandSync, executable } = require('./safety.cjs');
function percent(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100; }
function normalizeQuota(raw, cfg, now = Date.now()) {
    if (!raw || raw.base_resp?.status_code && raw.base_resp.status_code !== 0)
        return { state: 'UNKNOWN', reason: 'UPSTREAM_ERROR', checkedAt: now };
    const rows = raw.model_remains;
    if (!Array.isArray(rows))
        return { state: 'UNKNOWN', reason: 'NOT_SUBSCRIPTION_QUOTA', checkedAt: now };
    const names = cfg.modelNames || [];
    const selected = rows.filter(r => names.includes(r.model_name));
    if (selected.length !== 1)
        return { state: 'UNKNOWN', reason: 'MODEL_MAPPING_REQUIRED', checkedAt: now };
    const m = selected[0];
    let remaining = m.current_interval_remaining_percent;
    let source = 'explicit_percent';
    if (!percent(remaining)) {
        const n = m.current_interval_usage_count, total = m.current_interval_total_count;
        if (!(typeof n === 'number' && typeof total === 'number' && Number.isFinite(n) && Number.isFinite(total) && total > 0 && n >= 0 && n <= total && ['used', 'remaining'].includes(cfg.verifiedCountMeaning) && cfg.countMeaningEvidence)) {
            return { state: 'UNKNOWN', reason: 'AMBIGUOUS_USAGE_COUNT', checkedAt: now };
        }
        remaining = (cfg.verifiedCountMeaning === 'used' ? total - n : n) / total * 100;
        source = 'verified_count_contract';
    }
    // Weekly field names must be selected from a redacted real-account schema receipt.
    let weekly = null;
    if (cfg.weeklyPercentField && percent(m[cfg.weeklyPercentField]))
        weekly = m[cfg.weeklyPercentField];
    else if (!(cfg.weeklyUnlimitedApproved === true && cfg.weeklyEntitlementEvidence))
        return { state: 'UNKNOWN', reason: 'WEEKLY_ENTITLEMENT_UNVERIFIED', checkedAt: now };
    const effective = weekly === null ? remaining : Math.min(weekly, remaining);
    return { state: 'KNOWN', model: m.model_name, remainingPercent: effective, fiveHourRemainingPercent: remaining, weeklyRemainingPercent: weekly, source, checkedAt: now };
}
function quotaDecision(q, cfg, previous = 'PAUSED', now = Date.now(), successes = 0) {
    if (!q || q.state !== 'KNOWN' || now - q.checkedAt > (cfg.maxAgeMs || 120000) || q.checkedAt > now + 5000)
        return { state: 'UNKNOWN', admitTask: false, admitRequest: false, successes: 0 };
    const n = q.remainingPercent;
    if (!percent(n))
        return { state: 'UNKNOWN', admitTask: false, admitRequest: false, successes: 0 };
    const stop = cfg.stopTaskPercent ?? 20, hard = cfg.stopRequestPercent ?? 10, resume = cfg.resumePercent ?? 35;
    must(hard >= 0 && hard < stop && stop < resume && resume <= 100, 'QUOTA_THRESHOLDS', 'Require hard < stop < resume.');
    if (n <= hard)
        return { state: 'PAUSED', admitTask: false, admitRequest: false, successes: 0 };
    if (n <= stop)
        return { state: 'DRAINING', admitTask: false, admitRequest: true, successes: 0 };
    if (previous !== 'RUNNING') {
        const count = n >= resume ? successes + 1 : 0;
        if (count < (cfg.resumeConsecutive || 2))
            return { state: 'WAITING_RECOVERY', admitTask: false, admitRequest: false, successes: count };
    }
    return { state: 'RUNNING', admitTask: true, admitRequest: true, successes: 0 };
}
async function fetchQuota(cfg) {
    must(cfg.mode === 'cli' || cfg.mode === 'http', 'QUOTA_NOT_CONFIGURED', 'Set and verify a real subscription quota provider.', 20);
    if (cfg.mode === 'cli') {
        const exe = executable(cfg.executable);
        const text = commandSync(exe, cfg.args, { timeout: 10000 });
        return normalizeQuota(JSON.parse(text), cfg);
    }
    const u = new URL(cfg.url);
    must(u.protocol === 'https:' && ['api.minimax.io', 'api.minimax.cn', 'api.minimaxi.com', 'www.minimax.io', 'www.minimax.cn'].includes(u.hostname) && u.pathname === '/v1/token_plan/remains' && !u.search && !u.username && !u.password, 'QUOTA_ENDPOINT', 'Only verified MiniMax quota endpoints are accepted.');
    const key = process.env[cfg.keyEnv || 'MINIMAX_API_KEY'];
    must(key && !key.startsWith('sk-api-'), 'SUBSCRIPTION_KEY_REQUIRED', 'A verified subscription key is required; PAYG fallback is forbidden.', 20);
    const r = await fetch(u, { headers: { Authorization: 'Bearer ' + key }, redirect: 'error', signal: AbortSignal.timeout(10000) });
    if ([401, 403].includes(r.status))
        throw new QAError('QUOTA_AUTH', 'Subscription quota authorization failed.', 20);
    if (r.status === 429)
        throw new QAError('QUOTA_RATE_LIMIT', 'Quota endpoint rate-limited; do not infer subscription exhaustion.', 20);
    must(r.ok, 'QUOTA_HTTP', 'Quota endpoint unavailable.', 20);
    const text = await r.text();
    must(text.length < 1024 * 1024, 'QUOTA_SIZE', 'Quota response unexpectedly large.');
    return normalizeQuota(JSON.parse(text), cfg);
}
module.exports = { normalizeQuota, quotaDecision, fetchQuota };
