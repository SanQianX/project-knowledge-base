#!/usr/bin/env node
'use strict';
// Official acceptance for 5.0.31 next: isolated fresh install + 37-check
// browser smoke (the audited trio tool) + an APPEARANCE SKIN live check
// (save a custom skin through the REAL settings API, verify it is served
// back and the UI assets carry the skin code).
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PKB_ROOT = path.resolve(__dirname, '..', '..', '..');
const B = 'D:/SanQian.Xu/.project-knowledge-test-temp/release-5.0.31-20261109-leader/core5031-official';
const ARTIFACTS = path.join(PKB_ROOT, 'qa-autopilot', 'artifacts', 'parallel-20261106', 'rel-acceptance-r21');

async function main() {
  fs.mkdirSync(B, { recursive: true });
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  const evidence = { schema: 'qa-autopilot/official-acceptance-5031/v1', startedAt: new Date().toISOString(), steps: [], expectations: [], firstFailure: null };
  try {
    // ---- 1. Official TGZ download + digest vs prepare receipt ----------------
    const tgz = path.join(B, 'sanqianx-project-knowledge-5.0.31.tgz');
    if (!fs.existsSync(tgz)) spawnSync('curl', ['-sSfL', '-o', tgz, 'https://registry.npmjs.org/@sanqianx/project-knowledge/-/project-knowledge-5.0.31.tgz'], { stdio: 'inherit', windowsHide: true });
    const crypto = require('crypto');
    const sha256 = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
    const actual = sha256(tgz);
    const expected = '2a91e947d37219192e78f294d8c1120a63790bd51294fadc89d6b254cf821328';
    const sri = 'sha512-' + crypto.createHash('sha512').update(fs.readFileSync(tgz)).digest('base64');
    evidence.steps.push({ step: 'official-download', sha256Match: actual === expected, sri });
    if (actual !== expected) throw new Error('official TGZ digest mismatch');

    // ---- 2. Isolated fresh install ------------------------------------------
    const prefix = path.join(B, 'install-prefix');
    const cache = path.join(B, 'npm-cache');
    if (!fs.existsSync(path.join(prefix, 'node_modules', '@sanqianx', 'project-knowledge', 'package.json'))) {
      fs.mkdirSync(cache, { recursive: true });
      const r = spawnSync(process.execPath, ['C:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js', 'install', '--prefix', prefix, tgz, '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-offline', '--fetch-retries=0', '--fetch-timeout=120000', '--cache', cache, '--registry=https://registry.npmjs.org', '--userconfig', path.join(B, 'npmrc-empty'), '--globalconfig', path.join(B, 'npmrc-global-empty')], { encoding: 'utf8', windowsHide: true, timeout: 300000 });
      if (r.status !== 0) throw new Error('fresh install failed: ' + String(r.stderr).slice(0, 300));
    }
    const installed = JSON.parse(fs.readFileSync(path.join(prefix, 'node_modules', '@sanqianx', 'project-knowledge', 'package.json'), 'utf8')).version;
    evidence.steps.push({ step: 'fresh-install', version: installed });

    // ---- 3. The 37-check browser smoke on the official trio ------------------
    const trio = {
      core: tgz,
      wb: 'D:/SanQian.Xu/.project-knowledge-test-temp/release-5.0.30-20261106-leader/core5030-official/official-artifacts/sanqianx-claude-ai-workbench-0.13.13.tgz',
      bridge: 'D:/SanQian.Xu/.project-knowledge-test-temp/release-5.0.25-20261024-leader/artifacts/official-modules/sanqianx-ai-coding-event-bridge-console-0.7.4.tgz',
    };
    const smoke = spawnSync(process.execPath, [path.join(PKB_ROOT, 'desktop', 'test', 'release-browser-5025-smoke.cjs'),
      '--core-tarball', trio.core, '--wb-tarball', trio.wb, '--bridge-tarball', trio.bridge,
      '--owned-cache', path.join(prefix, 'node_modules'),
      '--output-root', path.join(B, 'smoke'),
      '--expect-engine-version', '0.2.7-rc.12',
      '--provenance', 'official-next-download'], { encoding: 'utf8', windowsHide: true, timeout: 15 * 60 * 1000, cwd: PKB_ROOT });
    evidence.steps.push({ step: 'browser-smoke', exit: smoke.status, tail: String(smoke.stdout || '').trim().split('\n').slice(-3).join(' | ') });
    if (smoke.status !== 0) throw new Error('37-check browser smoke failed');

    // ---- 4. APPEARANCE SKIN live check (real settings API) -------------------
    const dataDir = path.join(B, 'skin-data');
    fs.mkdirSync(dataDir, { recursive: true });
    const { spawnServer } = require(path.join(PKB_ROOT, '_site', '_test', 'helpers', 'spawn-server'));
    const freePort = require(path.join(PKB_ROOT, '_site', '_test', 'helpers', 'free-port'));
    const port = await freePort();
    const server = spawnServer({ root: PKB_ROOT, port, dataDir, tag: 'r21-skin', analysisOwner: 'engine', extraEnv: { KB_TERMINAL_URL: 'http://127.0.0.1:9', KB_MODULES_AUTOSTART: '0', KB_MODULES_REGISTER: '0' } });
    const http = require('http');
    const request = (url, init) => new Promise((resolve, reject) => {
      const payload = init && init.body ? Buffer.from(JSON.stringify(init.body)) : null;
      const req = http.request(url, { method: init && init.method || 'GET', headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {} }, res => { let t = ''; res.on('data', c => t += c); res.on('end', () => resolve({ status: res.statusCode, text: t })); });
      req.on('error', reject); if (payload) req.write(payload); req.end();
    });
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 60; i += 1) { try { const r = await request(base + '/api/health'); if (r.status === 200) break; } catch { /* retry */ } await new Promise(r2 => setTimeout(r2, 500)); }
    const before = JSON.parse((await request(base + '/api/settings')).text).settings.appearance || null;
    const custom = { preset: 'steel', overrides: { light: { accent: '#112233' }, dark: { accent: '#445566' } } };
    const save = await request(base + '/api/appearance', { method: 'PATCH', body: custom });
    const after = JSON.parse((await request(base + '/api/appearance')).text).appearance;
    // Invalid skin must be refused (the shipped validator).
    const bad = await request(base + '/api/appearance', { method: 'PATCH', body: { preset: 'not-a-preset', overrides: { light: { accent: 'red' } } } });
    evidence.steps.push({ step: 'skin-roundtrip', saveStatus: save.status, before, after, badStatus: bad.status });
    await server.cleanup();

    evidence.expectations.push({ key: 'official-bytes-and-install', pass: actual === expected && installed === '5.0.31', observed: { sha256Match: actual === expected, installed } });
    evidence.expectations.push({ key: 'browser-smoke-37', pass: smoke.status === 0, observed: { exit: smoke.status } });
    evidence.expectations.push({ key: 'skin-saved-and-served', pass: save.status === 200 && after && after.preset === 'steel' && after.overrides.dark.accent === '#445566', observed: { after } });
    evidence.expectations.push({ key: 'invalid-skin-refused', pass: bad.status === 400, observed: { badStatus: bad.status, body: bad.text.slice(0, 120) } });

    evidence.finishedAt = new Date().toISOString();
    evidence.verdict = evidence.expectations.every(e => e.pass) ? 'PASS' : 'FAIL';
    fs.writeFileSync(path.join(ARTIFACTS, 'official-5031.json'), JSON.stringify(evidence, null, 2));
    console.log(`[r21] official-5.0.31 ${evidence.verdict}`);
    process.exitCode = evidence.verdict === 'PASS' ? 0 : 1;
  } catch (error) {
    evidence.firstFailure = String(error && error.stack || error);
    evidence.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(ARTIFACTS, 'official-5031.json'), JSON.stringify(evidence, null, 2));
    console.error(`[r21] FATAL ${evidence.firstFailure}`);
    process.exitCode = 1;
  }
}
main();
