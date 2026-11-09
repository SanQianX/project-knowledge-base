'use strict';
// WB-QUOTA-01 official endpoint probe — ONE authorized read-only query per
// provider against that provider's documented quota/usage endpoint.
//
// * MiniMax: https://www.minimaxi.com/v1/token_plan/remains (Bearer, this
//   round's official Token Plan FAQ). Read-only, consumes no paid turn.
// * GLM: <base>/api/monitor/usage/quota/limit with a raw Authorization token,
//   exactly as the official zai-coding-plugins glm-plan-usage plugin does
//   (Authorization: <ANTHROPIC_AUTH_TOKEN>, no Bearer prefix).
//
// Credentials are read in memory from the real workbench profile store and
// never printed, logged, or persisted: every string in the captured evidence
// is deep-sanitized against the credential values before it leaves this
// process. Exit code 0 = at least the schema of one provider captured.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const PROFILE_DIR = process.env.PK_WB_REAL_PROFILE_DIR
  ? path.resolve(process.env.PK_WB_REAL_PROFILE_DIR)
  : path.join(os.homedir(), '.project-knowledge-v5', 'workbench');
const ARTIFACT_DIR = path.resolve('D:/SanQian.Xu/project-knowledge-base/qa-autopilot/artifacts/parallel-20261023/model-quota-feature');
const TIMEOUT_MS = 12000;

function loadRealCredentials() {
  const credentials = JSON.parse(fs.readFileSync(path.join(PROFILE_DIR, 'credentials.v1.json'), 'utf8')).credentials;
  const pick = id => (typeof credentials[`credential:${id}`] === 'string' ? credentials[`credential:${id}`] : null);
  return { pick };
}

// Redact any string that contains (part of) a secret, plus anything that
// structurally looks like a bearer/JWT token, wherever it appears.
function sanitizer(secrets) {
  const needles = secrets.filter(s => s && s.length >= 8);
  const looksLikeToken = v => /^[A-Za-z0-9._\-]{24,}$/.test(v) || /^ey[A-Za-z0-9_-]{10,}/.test(v);
  const walk = value => {
    if (typeof value === 'string') {
      if (needles.some(n => value.includes(n)) || looksLikeToken(value)) return `<redacted:len-${value.length}>`;
      return value.length > 300 ? `${value.slice(0, 300)}…<len-${value.length}>` : value;
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') {
      const out = {};
      for (const key of Object.keys(value)) out[key] = walk(value[key]);
      return out;
    }
    return value;
  };
  return walk;
}

async function fetchJson(url, headers) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { method: 'GET', headers, signal: controller.signal });
    const text = await response.text();
    let body = null;
    try { body = JSON.parse(text); } catch { body = { rawPreview: text.slice(0, 500) }; }
    return { httpStatus: response.status, elapsedMs: Date.now() - started, body };
  } catch (error) {
    return { httpStatus: null, elapsedMs: Date.now() - started, body: null, transportError: String(error && error.message || error) };
  } finally {
    clearTimeout(timer);
  }
}

(async () => {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const { pick } = loadRealCredentials();
  const secrets = [pick('glm'), pick('minimax'), pick('qa-minimax-20261023')].filter(Boolean);
  const sanitize = sanitizer(secrets);
  const cases = [];

  // --- MiniMax: the current official Token Plan endpoint -----------------
  const minimaxKey = pick('minimax');
  if (minimaxKey) {
    const attempt = await fetchJson('https://www.minimaxi.com/v1/token_plan/remains', {
      Authorization: `Bearer ${minimaxKey}`,
      'Content-Type': 'application/json',
    });
    let result = { endpoint: 'https://www.minimaxi.com/v1/token_plan/remains', authScheme: 'Bearer', ...attempt, body: sanitize(attempt.body) };
    if (attempt.httpStatus === 404 || attempt.httpStatus === 421) {
      const fallback = await fetchJson('https://api.minimaxi.com/v1/token_plan/remains', {
        Authorization: `Bearer ${minimaxKey}`,
        'Content-Type': 'application/json',
      });
      result = { endpoint: 'https://www.minimaxi.com/v1/token_plan/remains', authScheme: 'Bearer', ...attempt, body: sanitize(attempt.body),
        fallbackAttempt: { endpoint: 'https://api.minimaxi.com/v1/token_plan/remains', ...fallback, body: sanitize(fallback.body) } };
    }
    cases.push({ provider: 'minimax', profileId: 'minimax', ...result });
  } else {
    cases.push({ provider: 'minimax', profileId: 'minimax', skipped: 'no credential configured' });
  }

  // --- GLM: the official plugin's quota/limit call, raw Authorization ----
  const glmKey = pick('glm');
  if (glmKey) {
    const attempt = await fetchJson('https://open.bigmodel.cn/api/monitor/usage/quota/limit', {
      Authorization: glmKey,
      'Accept-Language': 'en-US,en',
      'Content-Type': 'application/json',
    });
    cases.push({ provider: 'glm', profileId: 'glm', endpoint: 'https://open.bigmodel.cn/api/monitor/usage/quota/limit', authScheme: 'raw Authorization token (official plugin parity)', ...attempt, body: sanitize(attempt.body) });
  } else {
    cases.push({ provider: 'glm', profileId: 'glm', skipped: 'no credential configured' });
  }

  const captured = cases.filter(entry => entry.httpStatus !== undefined && entry.body);
  const evidence = {
    probe: 'parallel-model-quota-official-probe',
    ranAt: new Date().toISOString(),
    authorization: 'WB-QUOTA-01 dispatch: 按需调用当前profile的官方只读余额/订阅额度接口（一次、只读、不产生付费回合）',
    credentialHandling: 'read in memory from the real workbench profile store; every output string deep-redacted against the credential values; no header is ever logged',
    cases,
  };
  const target = path.join(ARTIFACT_DIR, 'official-probe.json');
  fs.writeFileSync(target, `${JSON.stringify(evidence, null, 2)}\n`);
  for (const entry of cases) {
    console.log(`PROBE ${entry.provider} httpStatus=${entry.httpStatus} elapsedMs=${entry.elapsedMs} endpoint=${entry.endpoint}${entry.skipped ? ` skipped=${entry.skipped}` : ''}`);
  }
  console.log(`official probe evidence -> ${target}`);
  process.exitCode = captured.length > 0 ? 0 : 3;
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  setTimeout(() => process.exit(process.exitCode || 0), 250).unref();
});
