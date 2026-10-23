'use strict';
// Fail closed when quota meaning is unknown. / 额度含义不明时拒绝新调用。
const fs = require('node:fs');
const path = require('node:path');
const { must, QAError, commandSync, executable, readJSON } = require('./safety.cjs');
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
    // REV-02：发布方 gate 是准入上界。gate 的 UNKNOWN/PAUSED/WAITING_RECOVERY
    // 或显式 deny 不能因为 remainingPercent 充足被再次放行；admitTask/admitRequest
    // 的显式 false 只收紧、从不放宽。gate 缺失时不额外授权，仅按额度阈值判定。
    const gate = (q.gate && typeof q.gate === 'object') ? q.gate : null;
    const gateState = gate ? String(gate.state || '').toUpperCase() : null;
    if (gate && (gate.deny === true || gateState === 'PAUSED'))
        return { state: 'PAUSED', admitTask: false, admitRequest: false, successes: 0 };
    if (gate && (gateState === 'UNKNOWN' || gateState === 'WAITING_RECOVERY'))
        return { state: gateState, admitTask: false, admitRequest: false, successes: 0 };
    const stop = cfg.stopTaskPercent ?? 20, hard = cfg.stopRequestPercent ?? 10, resume = cfg.resumePercent ?? 35;
    must(hard >= 0 && hard < stop && stop < resume && resume <= 100, 'QUOTA_THRESHOLDS', 'Require hard < stop < resume.');
    let decision;
    if (n <= hard)
        decision = { state: 'PAUSED', admitTask: false, admitRequest: false, successes: 0 };
    else if (n <= stop)
        decision = { state: 'DRAINING', admitTask: false, admitRequest: true, successes: 0 };
    else if (previous !== 'RUNNING') {
        const count = n >= resume ? successes + 1 : 0;
        decision = count < (cfg.resumeConsecutive || 2)
            ? { state: 'WAITING_RECOVERY', admitTask: false, admitRequest: false, successes: count }
            : { state: 'RUNNING', admitTask: true, admitRequest: true, successes: 0 };
    }
    else
        decision = { state: 'RUNNING', admitTask: true, admitRequest: true, successes: 0 };
    if (gate && gate.admitTask === false)
        decision = { ...decision, admitTask: false };
    if (gate && gate.admitRequest === false)
        decision = { ...decision, admitRequest: false };
    return decision;
}
async function fetchQuota(cfg) {
    must(['cli', 'http', 'published-file'].includes(cfg.mode), 'QUOTA_NOT_CONFIGURED', 'Set and verify a real subscription quota provider.', 20);
    if (cfg.mode === 'published-file') {
        // 只读任务代理已发布的额度状态：不接触真实密钥，也不绕过代理。
        // REV-02：发布文件是唯一事实源——路径必须显式绝对、普通文件（拒绝符号
        // 链接/目录）、有限大小；checkedAt 必须是发布方写下的有限 epoch 毫秒且在
        // 新鲜窗口内。缺失/字符串/负数/过远未来/陈旧一律 fail-closed，绝不用
        // Date.now() 兜底伪造新鲜。该文件目前没有发布方进程身份字段，因此不
        // 宣称发布方真实性，也不把该约定路径称作 OS 级隔离。
        const file = cfg.file;
        must(typeof file === 'string' && path.isAbsolute(file), 'QUOTA_NOT_CONFIGURED', 'quota.file must be an explicit absolute local path approved by review.', 20);
        must(fs.existsSync(file), 'QUOTA_NOT_CONFIGURED', 'Point quota.file at the state published by the task-only quota gateway.', 20);
        const st = fs.lstatSync(file);
        must(st.isFile() && !st.isSymbolicLink(), 'QUOTA_NOT_CONFIGURED', 'The published quota file must be a regular file, not a link or directory.', 20);
        must(st.size > 0 && st.size <= 65536, 'QUOTA_SIZE', 'Published quota file is empty or unexpectedly large.', 20);
        const raw = readJSON(file);
        const q = raw.quota || {};
        must(q.state === 'KNOWN' && percent(q.remainingPercent), 'QUOTA_UNKNOWN', 'The published quota state is not KNOWN with an explicit percent.', 20);
        const now = Date.now();
        must(typeof q.checkedAt === 'number' && Number.isFinite(q.checkedAt) && q.checkedAt > 0, 'QUOTA_STALE', 'Published quota has no valid epoch-ms checkedAt; refusing to fabricate freshness.', 20);
        must(q.checkedAt <= now + 5000, 'QUOTA_STALE', 'Published checkedAt is in the future; the file cannot be trusted as fresh.', 20);
        must(now - q.checkedAt <= (cfg.maxAgeMs || 120000), 'QUOTA_STALE', 'Published quota is older than maxAgeMs; fail closed.', 20);
        return { state: 'KNOWN', model: q.model || null, remainingPercent: q.remainingPercent,
            fiveHourRemainingPercent: q.fiveHourRemainingPercent ?? null, weeklyRemainingPercent: q.weeklyRemainingPercent ?? null,
            source: 'published_' + (q.source || 'gateway'), checkedAt: q.checkedAt, gate: raw.gate || null };
    }
    if (cfg.mode === 'cli') {
        const exe = executable(cfg.executable);
        const text = commandSync(exe, cfg.args, { timeout: 10000 });
        return normalizeQuota(JSON.parse(text), cfg);
    }
    const u = new URL(cfg.url);
    must(u.protocol === 'https:' && ['api.minimax.io', 'api.minimax.cn', 'api.minimaxi.com', 'www.minimax.io', 'www.minimax.cn'].includes(u.hostname) && u.pathname === '/v1/token_plan/remains' && !u.search && !u.username && !u.password, 'QUOTA_ENDPOINT', 'Only verified MiniMax quota endpoints are accepted.');
    const key = process.env[cfg.keyEnv || 'MINIMAX_API_KEY'];
    must(key && !key.startsWith('sk-api-'), 'SUBSCRIPTION_KEY_REQUIRED', 'A verified subscription key is required; PAYG fallback is forbidden.', 20);
    let r;
    try {
        r = await fetch(u, { headers: { Authorization: 'Bearer ' + key }, redirect: 'error', signal: AbortSignal.timeout(10000) });
    }
    catch (e) {
        // 超时与网络失败必须单独分类：既不是“额度耗尽”，也不是“额度充足”。
        // 分类后调用方只能得到失败，不能得到 KNOWN 额度并据此放行新调用。
        const timeout = e?.name === 'TimeoutError' || e?.name === 'AbortError';
        throw new QAError(timeout ? 'QUOTA_TIMEOUT' : 'QUOTA_UNAVAILABLE', timeout ? 'Quota endpoint timed out; the quota stays unknown.' : 'Quota endpoint unreachable; the quota stays unknown.', 20);
    }
    if ([401, 403].includes(r.status))
        throw new QAError('QUOTA_AUTH', 'Subscription quota authorization failed.', 20);
    if (r.status === 429)
        throw new QAError('QUOTA_RATE_LIMIT', 'Quota endpoint rate-limited; do not infer subscription exhaustion.', 20);
    if (!r.ok)
        throw Object.assign(new QAError('QUOTA_HTTP', 'Quota endpoint unavailable.', 20), { httpStatus: r.status });
    const text = await r.text();
    must(text.length < 1024 * 1024, 'QUOTA_SIZE', 'Quota response unexpectedly large.');
    return normalizeQuota(JSON.parse(text), cfg);
}
module.exports = { normalizeQuota, quotaDecision, fetchQuota };
