'use strict';
// P-PROFILE-BLANK-REAL-R49 driver: SYS-003 凭据留空 against the REAL
// Workbench 0.13.9 module bytes (the root's exact-pinned install), spawned
// only through qa-autopilot/tools/product-probes/qa-r49-run.cjs under the
// audited full-env isolation harness. This file is a probe entry (-probe, not
// -test) so the default suite runner never launches it.
//
// Case (qa-autopilot/config/test-cases.json SYS-003):
//   step:     已有凭据后留空保存，再读取mask元数据
//   expected: 留空不覆盖; 响应、日志不泄露secret
//
// What is REAL here (all product bytes from node_modules/claude-ai-workbench):
//   A. profile HTTP half — create + set FAKE credential + blank-save via the
//      exact client serializer contract (PUT /profiles/:id with the form's
//      profile JSON and NO secret — precisely what client.saveProfile sends
//      when the real form emits credential: ""); disk credential bytes must
//      stay identical; masked GET metadata; explicit-clear contrast
//      (PUT .../credential {secret:""} must 400 — blank is NOT a clear);
//   B. embedding HTTP half — seed FAKE secret, blank-save with secret:""
//      (the root UI serializer contract, ui/product.js:609, sends the raw
//      empty value), FAKE preserved, {enabled:false} is the real clear;
//   C. UI half — the real /profile-settings/ form (real ai-profile-editor
//      custom element + real host page.js persist()) in a real isolated
//      browser: create a fictional profile with a FAKE key through the form,
//      then 更换 (replace-key) → the password input is shown blank → save
//      other-field changes with the key left blank → stored FAKE unchanged;
//   D. leak scan — every HTTP response body, the server stdout/stderr tails,
//      dataDir/diagnostics.jsonl and the live UI DOM must not contain any
//      FAKE secret raw value;
//   E. identity chain — executed module file hashes must equal the
//      module-runtime-manifest.json terminal (0.13.9) pinned hashes.
// No /test, /quota, /detect-models call is ever made; every invented endpoint
// host is under the reserved .invalid TLD, so no dial can reach a provider.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const MODULE_ROOT = path.join(ROOT, 'node_modules', 'claude-ai-workbench');
const EVIDENCE = String(process.env.PK_R49_EVIDENCE || '').trim();
const API = '/api/claude-workbench/v1';

const FAKE_KEY = 'r49-fake-profile-key-DO-NOT-DIAL-774411';
const FAKE_EMBED = 'r49-fake-embedding-secret-8811ZZCANNOT-be-real';
const FAKE_KEY_UI = 'r49-fake-ui-key-5566CANNOT-be-real-9931';

const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
const maskOf = secret => {
  const value = String(secret || '');
  if (!value) return '';
  if (value.length <= 12) return `${value.slice(0, 2)}****${value.slice(-2)}`;
  return `${value.slice(0, 6)}****${value.slice(-6)}`;
};

function record(name, body) {
  fs.writeFileSync(path.join(EVIDENCE, name), typeof body === 'string' ? body : JSON.stringify(body, null, 2) + '\n');
}
function log(step, detail) {
  console.log(`[r49] ${step}${detail ? ' :: ' + detail : ''}`);
}

// ---- HTTP helper against the real module server -------------------------

const responseLog = [];
function request(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path: pathname, method,
      headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {},
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        responseLog.push({ method, path: pathname, status: res.statusCode, bodyText: text });
        let json = null;
        try { json = JSON.parse(text); } catch { /* keep text */ }
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function waitFor(fn, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try { const value = await fn(); if (value) return value; } catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error('Timed out waiting for ' + label + (lastError ? ': ' + lastError.message : ''));
}

// ---- state ----------------------------------------------------------------

let port = 0;
let hostChild = null;
let hostStdout = '';
let hostStderr = '';
let browser = null;
const dataDir = String(process.env.PK_R49_DATA_DIR || '').trim();
const credFile = path.join(dataDir, 'credentials.v1.json');
const profileFile = path.join(dataDir, 'profiles.v2.json');

function readCreds() { return JSON.parse(fs.readFileSync(credFile, 'utf8')); }

// ---- E. identity chain (before touching anything) ------------------------

function identityChain() {
  const modulePkg = JSON.parse(fs.readFileSync(path.join(MODULE_ROOT, 'package.json'), 'utf8'));
  assert.equal(modulePkg.name, '@sanqianx/claude-ai-workbench');
  assert.equal(modulePkg.version, '0.13.9', 'module must be the root-pinned 0.13.9');
  const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(rootPkg.dependencies['claude-ai-workbench'], 'npm:@sanqianx/claude-ai-workbench@0.13.9', 'root dependency pin');
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'module-runtime-manifest.json'), 'utf8'));
  assert.equal(manifest.modules.terminal.version, '0.13.9');
  const files = [
    'packages/server/index.js',
    'packages/server/lib/profile-store.js',
    'packages/server/lib/http-handler.js',
    'packages/server/lib/workbench-service.js',
    'packages/contracts/index.js',
    'packages/client/index.js',
    'packages/ui/ai-profile-settings.js',
    'apps/ai-profile-settings-host/index.html',
    'apps/ai-profile-settings-host/page.js',
  ];
  const entries = {};
  for (const rel of files) {
    const digest = sha256(fs.readFileSync(path.join(MODULE_ROOT, rel)));
    const pinned = manifest.modules.terminal.files[rel];
    assert.ok(pinned, `manifest pin missing for ${rel}`);
    assert.equal(digest, pinned, `executed bytes must equal the 0.13.9 manifest pin for ${rel}`);
    entries[rel] = digest;
  }
  return { moduleVersion: modulePkg.version, rootPin: rootPkg.dependencies['claude-ai-workbench'], manifestTerminal: manifest.modules.terminal.version, files: entries, verified: files.length };
}

// ---- sections -------------------------------------------------------------

async function sectionA() {
  log('A1 create fictional profile via HTTP (client contract)');
  const create = await request('PUT', `${API}/profiles/r49fake`, {
    id: 'r49fake', name: 'R49-Fake', provider: 'r49-fake-provider',
    baseUrl: 'https://r49-fake.invalid/anthropic', models: { default: 'r49-fake-model' },
  });
  assert.equal(create.status, 200);
  assert.equal(create.json.credentialConfigured, false);
  assert.ok(!('apiKey' in create.json) && !('secret' in create.json) && !('authToken' in create.json), 'create response must not carry secret-shaped fields');

  log('A2 set FAKE credential via the explicit credential endpoint');
  const set = await request('PUT', `${API}/profiles/r49fake/credential`, { secret: FAKE_KEY });
  assert.equal(set.status, 204);
  assert.equal(readCreds().credentials['credential:r49fake'], FAKE_KEY);
  const credHash0 = sha256(fs.readFileSync(credFile));

  log('A3 masked metadata read (GET /profiles)');
  const list = await request('GET', `${API}/profiles`);
  assert.equal(list.status, 200);
  const listed = list.json.profiles.find(p => p.id === 'r49fake');
  assert.ok(listed, 'created profile must be listed');
  assert.equal(listed.credentialConfigured, true);
  assert.equal(listed.credentialMasked, maskOf(FAKE_KEY));
  assert.ok(!list.text.includes(FAKE_KEY), 'masked read must not contain the raw FAKE key');

  log('A4 blank-save: profile saved with the password left blank (serializer contract), other field changed');
  const blankSave = await request('PUT', `${API}/profiles/r49fake`, {
    id: 'r49fake', name: 'R49-Fake', provider: 'r49-fake-provider',
    baseUrl: 'https://r49-fake.invalid/anthropic', models: { default: 'r49-fake-model-v2' },
  });
  assert.equal(blankSave.status, 200);
  assert.equal(blankSave.json.models.default, 'r49-fake-model-v2', 'other-field change must persist');
  assert.equal(blankSave.json.credentialConfigured, true, 'blank save must not unset the credential');
  assert.ok(!blankSave.text.includes(FAKE_KEY));

  log('A5 disk bytes unchanged across the blank save');
  assert.equal(sha256(fs.readFileSync(credFile)), credHash0, '留空不覆盖: stored credential bytes must be identical');
  assert.equal(readCreds().credentials['credential:r49fake'], FAKE_KEY);

  log('A6 explicit-clear contrast: blank secret on the credential endpoint must be rejected (400), not a clear');
  const blankCred = await request('PUT', `${API}/profiles/r49fake/credential`, { secret: '' });
  assert.equal(blankCred.status, 400, 'blank credential must be rejected, not treated as clear');
  assert.equal(readCreds().credentials['credential:r49fake'], FAKE_KEY, 'rejected blank must leave the stored value intact');

  return { credHash0 };
}

async function sectionB() {
  log('B1 seed FAKE embedding secret');
  const seed = await request('PUT', `${API}/embedding-config`, {
    provider: 'openai', model: 'r49-embed-model', endpoint: 'https://r49-embed.invalid/v1', secret: FAKE_EMBED,
  });
  assert.equal(seed.status, 200);
  assert.equal(seed.json.configured, true);
  assert.equal(readCreds().credentials['knowledge-embedding'], FAKE_EMBED);
  const credHash = sha256(fs.readFileSync(credFile));

  log('B2 blank-save embedding (secret: "" — the root UI serializer contract sends the raw empty value)');
  const blankSave = await request('PUT', `${API}/embedding-config`, {
    provider: 'openai', model: 'r49-embed-model-v2', endpoint: 'https://r49-embed.invalid/v1', secret: '',
  });
  assert.equal(blankSave.status, 200);
  assert.equal(blankSave.json.configured, true, 'blank secret must not unset the embedding credential');
  assert.equal(blankSave.json.config.model, 'r49-embed-model-v2');
  assert.ok(!blankSave.text.includes(FAKE_EMBED));

  log('B3 stored FAKE embedding secret preserved');
  assert.equal(readCreds().credentials['knowledge-embedding'], FAKE_EMBED, '留空不覆盖 (embedding)');
  assert.equal(sha256(fs.readFileSync(credFile)), credHash, 'credential file bytes must be identical across the embedding blank save');

  log('B4 explicit clear contrast: {enabled:false} is the real clear operation');
  const clear = await request('PUT', `${API}/embedding-config`, { enabled: false });
  assert.equal(clear.status, 200);
  assert.equal(clear.json.configured, false);
  assert.ok(!readCreds().credentials['knowledge-embedding'], 'the explicit clear must remove the credential');
}

async function sectionC() {
  const { findChrome } = require('./helpers/find-chrome');
  const { launchCdpBrowser } = require('./helpers/cdp-browser');
  const base = `http://127.0.0.1:${port}`;

  log('C1 launch isolated browser on the real /profile-settings/ form');
  browser = await launchCdpBrowser({ chrome: findChrome(), profileDir: path.join(EVIDENCE, 'browser-profile'), url: `${base}/profile-settings/`, width: 1360, height: 900 });
  const run = expression => browser.evaluate(expression);
  await waitFor(() => run("Boolean(document.querySelector('#addProfile') && document.querySelector('ai-profile-list') && document.querySelector('ai-profile-list').shadowRoot)"), 'settings page loaded');
  await browser.screenshot(path.join(EVIDENCE, 'ui-01-initial.png'));

  log('C2 create a fictional profile through the real form (FAKE key typed once)');
  await run("document.querySelector('#addProfile').click()");
  await waitFor(() => run("document.querySelector('#profileEditor').shadowRoot && document.querySelector('#profileEditor').shadowRoot.querySelector('form [name=\"name\"]')"), 'editor form rendered');
  await run(`(() => {
    const form = document.querySelector('#profileEditor').shadowRoot;
    const set = (name, value) => { form.querySelector('form [name="' + name + '"]').value = value; };
    set('name', 'R49-UI-Fake'); set('provider', 'r49-ui-provider');
    set('baseUrl', 'https://r49-ui-fake.invalid/anthropic');
    set('model', 'r49-ui-model'); set('apiKey', ${JSON.stringify(FAKE_KEY_UI)});
  })()`);
  await run("document.querySelector('#profileEditor').shadowRoot.querySelector('[data-action=\"save\"]').click()");
  await waitFor(() => run("document.querySelector('#profileList').shadowRoot && document.querySelector('#profileList').shadowRoot.textContent.includes('R49-UI-Fake')"), 'created profile appears in the list');
  assert(await run("document.querySelector('#profileList').shadowRoot.textContent.includes('Key 已配置')"), 'the real list must report the key as configured');
  await browser.screenshot(path.join(EVIDENCE, 'ui-02-created.png'));

  const uiProfileId = await run("(() => { const list = document.querySelector('#profileList'); const hit = (list.profiles || []).find(p => p.name === 'R49-UI-Fake'); return hit ? hit.id : null; })()");
  assert.ok(uiProfileId && uiProfileId.startsWith('profile-'), `the form must have generated the profile id (got ${uiProfileId})`);

  log('C3 masked display: the editor must show the mask, never the raw key');
  await run(`(() => { const rows = document.querySelector('#profileList').shadowRoot.querySelectorAll('.item'); for (const row of rows) { if (row.textContent.includes('R49-UI-Fake')) { row.querySelector('[data-action=\"edit\"]').click(); return true; } } return false; })()`);
  await waitFor(() => run("document.querySelector('#profileEditor').shadowRoot && document.querySelector('#profileEditor').shadowRoot.querySelector('form')"), 'editor opened for the saved profile');
  const maskedShown = await run(`document.querySelector('#profileEditor').shadowRoot.querySelector('input[readonly][aria-label="API Key 已保存"]')?.value || ''`);
  assert.equal(maskedShown, maskOf(FAKE_KEY_UI), 'the editor must display the masked value');
  assert.ok(!(await run("JSON.stringify(document.querySelector('#profileEditor').shadowRoot.innerHTML)")).includes(FAKE_KEY_UI), 'editor DOM must not contain the raw key');

  log('C4 the blank-save: 更换 (replace-key) shows the password input blank; keep it blank, change another field, save');
  await run("document.querySelector('#profileEditor').shadowRoot.querySelector('[data-action=\"replace-key\"]').click()");
  const blankInput = await waitFor(() => run("(() => { const input = document.querySelector('#profileEditor').shadowRoot.querySelector('form [name=\"apiKey\"]'); return input ? ('present:' + JSON.stringify(input.value)) : null; })()"), 'blank apiKey input visible');
  assert.equal(blankInput, 'present:""', 'the replace-key input must be present and blank (密码输入留空)');
  await run(`(() => { document.querySelector('#profileEditor').shadowRoot.querySelector('form [name=\"model\"]').value = 'r49-ui-model-v2'; })()`);
  const credBeforeSave = sha256(fs.readFileSync(credFile));
  await run("document.querySelector('#profileEditor').shadowRoot.querySelector('[data-action=\"save\"]').click()");
  await waitFor(() => run("document.querySelector('#listFeedback') && document.querySelector('#listFeedback').textContent.includes('已保存')"), 'save confirmed by the real host page');
  await browser.screenshot(path.join(EVIDENCE, 'ui-03-after-blank-save.png'));

  log('C5 the stored FAKE key survived the blank save');
  assert.equal(sha256(fs.readFileSync(credFile)), credBeforeSave, 'credential file bytes must be identical across the UI blank save');
  assert.equal(readCreds().credentials[`credential:${uiProfileId}`], FAKE_KEY_UI, 'stored runtime credential must keep the FAKE value');
  assert(await run("document.querySelector('#profileList').shadowRoot.textContent.includes('Key 已配置')"), 'the list must still report the key as configured');

  const verify = await request('GET', `${API}/profiles`);
  const uiProfile = verify.json.profiles.find(p => p.id === uiProfileId);
  assert.equal(uiProfile.models.default, 'r49-ui-model-v2', 'the other-field change must persist');
  assert.equal(uiProfile.credentialConfigured, true);
  assert.equal(uiProfile.credentialMasked, maskOf(FAKE_KEY_UI));
  assert.ok(!verify.text.includes(FAKE_KEY_UI));

  log('C6 UI DOM leak scan');
  const domDump = await run("(() => { const parts = [document.documentElement.outerHTML]; for (const el of document.querySelectorAll('*')) { if (el.shadowRoot) parts.push(el.shadowRoot.innerHTML); } return parts.join('\\n'); })()");
  assert.ok(!domDump.includes(FAKE_KEY_UI), 'the live UI DOM must not contain the raw key');
  fs.writeFileSync(path.join(EVIDENCE, 'ui-dom-dump.html'), domDump);
  return { uiProfileId };
}

function sectionD() {
  log('D leak scan over responses, server output, diagnostics, DOM');
  const diagnosticsFile = path.join(dataDir, 'diagnostics.jsonl');
  const diagnostics = fs.existsSync(diagnosticsFile) ? fs.readFileSync(diagnosticsFile, 'utf8') : '';
  const surfaces = {
    responses: responseLog.map(r => `[${r.status}] ${r.bodyText}`).join('\n'),
    hostStdout,
    hostStderr,
    diagnostics,
    uiDom: fs.existsSync(path.join(EVIDENCE, 'ui-dom-dump.html')) ? fs.readFileSync(path.join(EVIDENCE, 'ui-dom-dump.html'), 'utf8') : '',
  };
  const hits = [];
  for (const [name, text] of Object.entries(surfaces)) {
    for (const secret of [FAKE_KEY, FAKE_EMBED, FAKE_KEY_UI]) {
      if (String(text).includes(secret)) hits.push({ surface: name, secretPrefix: secret.slice(0, 12) });
    }
  }
  record('leak-scan.json', { surfaces: Object.fromEntries(Object.entries(surfaces).map(([k, v]) => [k, { bytes: String(v).length}])), hits, clean: hits.length === 0 });
  assert.equal(hits.length, 0, `raw secrets leaked to: ${JSON.stringify(hits)}`);
  return { hits: 0 };
}

// ---- main -----------------------------------------------------------------

(async () => {
  if (!EVIDENCE || !dataDir) throw new Error('PK_R49_EVIDENCE and PK_R49_DATA_DIR are required');
  fs.mkdirSync(EVIDENCE, { recursive: true });
  const startedAt = new Date().toISOString();
  const identity = identityChain();
  log('identity', `${identity.verified} module files == manifest 0.13.9 pins`);

  const hostEnv = { ...process.env, PK_R49_MODULE_ROOT: MODULE_ROOT, PK_R49_DATA_DIR: dataDir, PK_R49_WORKSPACE: path.join(EVIDENCE, 'workspace') };
  fs.mkdirSync(hostEnv.PK_R49_WORKSPACE, { recursive: true });
  hostChild = spawn(process.execPath, [path.join(__dirname, 'helpers', 'qa-r49-wb-host.js')], { env: hostEnv, windowsHide: true });
  hostChild.stdout.on('data', chunk => { hostStdout += String(chunk); });
  hostChild.stderr.on('data', chunk => { hostStderr += String(chunk); });

  const readyLine = await waitFor(() => (hostStdout.match(/R49_WB_HOST_READY http:\/\/127\.0\.0\.1:(\d+)/) || [])[1], 'real module server READY', 30000);
  port = Number(readyLine);
  log('host ready', `port ${port}`);

  const sections = { startedAt, identity };
  try {
    sections.A = await sectionA();
    sections.B = await sectionB();
    sections.C = await sectionC();
    sections.D = sectionD();
    sections.finishedAt = new Date().toISOString();
    record('r49-evidence.json', sections);
    log('ALL SECTIONS PASS');
  } finally {
    record('responses.json', responseLog);
    record('host-stdout.txt', hostStdout);
    record('host-stderr.txt', hostStderr);
    const diagFile = path.join(dataDir, 'diagnostics.jsonl');
    if (fs.existsSync(diagFile)) fs.copyFileSync(diagFile, path.join(EVIDENCE, 'diagnostics.jsonl'));
    if (fs.existsSync(credFile)) fs.copyFileSync(credFile, path.join(EVIDENCE, 'credentials.v1.json.final'));
    if (fs.existsSync(profileFile)) fs.copyFileSync(profileFile, path.join(EVIDENCE, 'profiles.v2.json.final'));
    if (browser) await browser.close();
    if (hostChild && hostChild.exitCode === null) {
      hostChild.kill('SIGTERM');
      await new Promise(resolve => { hostChild.once('exit', resolve); setTimeout(resolve, 5000).unref(); });
    }
  }
  process.exit(0);
})().catch(async error => {
  console.error('R49 PROBE FAILED:', error && error.stack || error);
  try {
    record('first-failure.json', {
      at: new Date().toISOString(),
      message: String(error && error.message || error),
      stack: String(error && error.stack || ''),
      responsesSoFar: responseLog,
      hostStdoutTail: hostStdout.slice(-4000),
      hostStderrTail: hostStderr.slice(-4000),
    });
  } catch { /* evidence write best-effort */ }
  try { if (browser) await browser.close(); } catch { /* best-effort */ }
  if (hostChild && hostChild.exitCode === null) {
    try { hostChild.kill('SIGTERM'); } catch { /* already gone */ }
    await new Promise(resolve => { hostChild.once('exit', resolve); setTimeout(resolve, 5000).unref(); });
  }
  process.exit(1);
});
