'use strict';
// npm trusted-publisher authorization probe (assessment only).
//
// It asks the npm registry exactly one question: does the GitHub Actions OIDC
// identity of THIS workflow file already have a trusted publisher for the
// selected package? Nothing else happens here:
//
//   - no publish, no dist-tag, no npm access change, no token creation,
//   - no npm credential configuration is read, written or repaired,
//   - the short-lived registry token stays in memory: it is never printed,
//     logged, written to disk, put in the receipt or in an environment dump,
//   - the receipt carries whitelisted metadata only.
//
// The exchange is npm's documented OIDC flow, reproduced from npm 11.6.2
// lib/utils/oidc.js and npm-registry-fetch/lib/index.js:
//
//   1. GET  <ACTIONS_ID_TOKEN_REQUEST_URL>&audience=npm:registry.npmjs.org
//          Authorization: Bearer <ACTIONS_ID_TOKEN_REQUEST_TOKEN>  -> { value }
//   2. POST https://registry.npmjs.org/-/npm/v1/oidc/token/exchange/package/<escapedName>
//          Authorization: Bearer <idToken>, no body                 -> { token }
//
// A 404 from step 2 means the registry did not authorize this identity for
// this package. That is deliberately NOT explained further here: a missing
// package and a trusted-publisher mismatch are indistinguishable from the
// outside, and the receipt reports only the classification.
//
// Run: node qa-autopilot/tools/npm-oidc-auth-probe.cjs --package <name> [--receipt <file>]

const fs = require('node:fs');
const path = require('node:path');

const REGISTRY = 'https://registry.npmjs.org';
const AUDIENCE = 'npm:registry.npmjs.org';
const CORE_PACKAGE = '@sanqianx/project-knowledge';
const DESKTOP_PACKAGE = '@sanqianx/project-knowledge-desktop';
// Assessment-only module names. They exist in this allowlist for one reason:
// to let the ROOT workflow identity ask npm whether it is already a trusted
// publisher for them. They are NOT publication targets here. The stable
// prepare/publish route stays core-only and refuses them with PACKAGE_NAME.
const WORKBENCH_PACKAGE = '@sanqianx/claude-ai-workbench';
const BRIDGE_CONSOLE_PACKAGE = '@sanqianx/ai-coding-event-bridge-console';
const ALLOWED_PACKAGES = Object.freeze([CORE_PACKAGE, DESKTOP_PACKAGE, WORKBENCH_PACKAGE, BRIDGE_CONSOLE_PACKAGE]);
const RECEIPT_FIELDS = Object.freeze(['package', 'status', 'success', 'errorCode', 'timestamp']);
const REPOSITORY = 'SanQianX/project-knowledge-base';
const WORKFLOW_REF_PREFIX = REPOSITORY + '/.github/workflows/publish.yml@';
const OIDC_HOST_SUFFIXES = Object.freeze(['.actions.githubusercontent.com', '.githubusercontent.com']);
const REQUEST_TIMEOUT_MS = 15000;

const EXIT = Object.freeze({ OK: 0, USAGE: 2, NOT_AUTHORIZED: 3, NETWORK: 4 });

// npm-package-arg's escapedName: the scope slash is escaped, the '@' is not.
function escapePackageName(name) {
  return name[0] === '@' ? name.replace('/', '%2f') : name;
}

function isAllowedPackage(name) {
  return typeof name === 'string' && ALLOWED_PACKAGES.includes(name);
}

// Only an allowlisted package name may appear in the receipt; anything else
// is dropped rather than echoed back into an artifact.
function receiptSafeName(name) {
  return isAllowedPackage(name) ? name : null;
}

function buildReceipt({ packageName = null, status = 0, success = false, errorCode = null, timestamp }) {
  const value = {
    package: receiptSafeName(packageName),
    status: Number.isFinite(status) ? status : 0,
    success: Boolean(success),
    errorCode: errorCode || null,
    timestamp: typeof timestamp === 'string' ? timestamp : new Date(0).toISOString(),
  };
  const receipt = {};
  for (const field of RECEIPT_FIELDS) receipt[field] = value[field];
  return receipt;
}

// The probe is only meaningful for this repository and this workflow file:
// the OIDC identity carries job_workflow_ref, and npm matches a trusted
// publisher on the workflow filename.
function assertRunnerIdentity(env) {
  if (env.GITHUB_REPOSITORY !== REPOSITORY) return 'ECIDENTITY';
  const ref = typeof env.GITHUB_WORKFLOW_REF === 'string' ? env.GITHUB_WORKFLOW_REF : '';
  if (!ref.startsWith(WORKFLOW_REF_PREFIX)) return 'ECIDENTITY';
  return null;
}

function validateIdTokenUrl(raw) {
  let url;
  try { url = new URL(raw); } catch (_) { return null; }
  if (url.protocol !== 'https:') return null;
  const host = url.hostname.toLowerCase();
  const allowed = OIDC_HOST_SUFFIXES.some(suffix => host.endsWith(suffix));
  return allowed ? url : null;
}

function classifyExchangeStatus(status) {
  if (status >= 300 && status < 400) return 'EREGISTRYREDIRECT';
  if (status === 404) return 'EREGISTRYNOTFOUND';
  if (status === 401 || status === 403) return 'EREGISTRYUNAUTHORIZED';
  if (status >= 200 && status < 300) return null;
  return 'EREGISTRYERROR';
}

async function probe(options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const now = options.now || (() => new Date().toISOString());
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : REQUEST_TIMEOUT_MS;
  const packageName = options.packageName;

  if (!isAllowedPackage(packageName)) {
    return { exitCode: EXIT.USAGE, receipt: buildReceipt({ packageName: null, errorCode: 'EALLOWLIST', timestamp: now() }) };
  }
  const identity = assertRunnerIdentity(env);
  if (identity) {
    return { exitCode: EXIT.USAGE, receipt: buildReceipt({ packageName, errorCode: identity, timestamp: now() }) };
  }
  const requestUrl = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!requestUrl || !requestToken) {
    return { exitCode: EXIT.USAGE, receipt: buildReceipt({ packageName, errorCode: 'ENOGITHUBTOKEN', timestamp: now() }) };
  }
  const idUrl = validateIdTokenUrl(requestUrl);
  if (!idUrl) {
    return { exitCode: EXIT.USAGE, receipt: buildReceipt({ packageName, errorCode: 'EINVALIDTOKENURL', timestamp: now() }) };
  }
  idUrl.searchParams.set('audience', AUDIENCE);

  let idResponse;
  try {
    idResponse = await fetchImpl(idUrl.href, {
      method: 'GET',
      headers: { accept: 'application/json', authorization: 'Bearer ' + requestToken },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (_) {
    return { exitCode: EXIT.NETWORK, receipt: buildReceipt({ packageName, errorCode: 'ENETWORK', timestamp: now() }) };
  }
  if (!idResponse || !idResponse.ok) {
    const status = idResponse && typeof idResponse.status === 'number' ? idResponse.status : 0;
    return { exitCode: EXIT.NETWORK, receipt: buildReceipt({ packageName, status, errorCode: 'EGITHUBTOKEN', timestamp: now() }) };
  }
  let idToken = null;
  try {
    const json = await idResponse.json();
    idToken = json && typeof json.value === 'string' ? json.value : null;
  } catch (_) { idToken = null; }
  if (!idToken) {
    return { exitCode: EXIT.NETWORK, receipt: buildReceipt({ packageName, status: idResponse.status, errorCode: 'EGITHUBTOKEN', timestamp: now() }) };
  }

  const exchangeUrl = REGISTRY + '/-/npm/v1/oidc/token/exchange/package/' + escapePackageName(packageName);
  let exchangeResponse;
  try {
    exchangeResponse = await fetchImpl(exchangeUrl, {
      method: 'POST',
      headers: { accept: 'application/json', authorization: 'Bearer ' + idToken },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (_) {
    return { exitCode: EXIT.NETWORK, receipt: buildReceipt({ packageName, errorCode: 'ENETWORK', timestamp: now() }) };
  }

  const status = exchangeResponse && typeof exchangeResponse.status === 'number' ? exchangeResponse.status : 0;
  const classified = classifyExchangeStatus(status);
  if (classified) {
    const exitCode = classified === 'EREGISTRYERROR' ? EXIT.NETWORK : EXIT.NOT_AUTHORIZED;
    return { exitCode, receipt: buildReceipt({ packageName, status, errorCode: classified, timestamp: now() }) };
  }
  let body = null;
  try { body = await exchangeResponse.json(); } catch (_) { body = null; }
  const token = body && typeof body.token === 'string' ? body.token : null;
  if (!token) {
    return { exitCode: EXIT.NOT_AUTHORIZED, receipt: buildReceipt({ packageName, status, errorCode: 'EREGISTRYTOKENMISSING', timestamp: now() }) };
  }
  // The short-lived registry token exists only in this function's memory. It is
  // not returned, printed, written or logged.
  return { exitCode: EXIT.OK, receipt: buildReceipt({ packageName, status, success: true, errorCode: null, timestamp: now() }) };
}

function parseArgs(argv) {
  const parsed = { packageName: null, receiptFile: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--package') parsed.packageName = argv[++i];
    else if (arg.startsWith('--package=')) parsed.packageName = arg.slice('--package='.length);
    else if (arg === '--receipt') parsed.receiptFile = argv[++i];
    else if (arg.startsWith('--receipt=')) parsed.receiptFile = arg.slice('--receipt='.length);
    else throw new Error('EUSAGE');
  }
  return parsed;
}

async function main(argv) {
  let args;
  try { args = parseArgs(argv); }
  catch (_) {
    const receipt = buildReceipt({ packageName: null, errorCode: 'EUSAGE', timestamp: new Date().toISOString() });
    process.stdout.write(JSON.stringify(receipt) + '\n');
    return EXIT.USAGE;
  }
  const { exitCode, receipt } = await probe({ packageName: args.packageName });
  const line = JSON.stringify(receipt);
  process.stdout.write(line + '\n');
  if (args.receiptFile) {
    const file = path.resolve(args.receiptFile);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(receipt, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  }
  return exitCode;
}

module.exports = {
  probe, main, parseArgs, buildReceipt, escapePackageName, isAllowedPackage,
  classifyExchangeStatus, validateIdTokenUrl, assertRunnerIdentity,
  ALLOWED_PACKAGES, RECEIPT_FIELDS, CORE_PACKAGE, DESKTOP_PACKAGE,
  WORKBENCH_PACKAGE, BRIDGE_CONSOLE_PACKAGE,
  REGISTRY, AUDIENCE, REPOSITORY, WORKFLOW_REF_PREFIX, EXIT,
};

if (require.main === module) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(() => {
    process.stdout.write(JSON.stringify(buildReceipt({ errorCode: 'EPROBEFAILED', timestamp: new Date().toISOString() })) + '\n');
    process.exitCode = EXIT.USAGE;
  });
}
