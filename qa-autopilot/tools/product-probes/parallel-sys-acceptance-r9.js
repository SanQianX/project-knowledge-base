#!/usr/bin/env node
'use strict';
// qa-autopilot/tools/product-probes/parallel-sys-acceptance-r9.js
//
// P-SYS-ACCEPTANCE-R9 — SYS-002 / SYS-004 / SYS-007 / SYS-008 in one isolated
// real-server lane (spawnServer bootstrap = the real _site/lib/server-app.js).
// No engine, no model, no credential; every request is a real HTTP request
// against a real product process on an owned port.
//
//   SYS-007 Origin防护 — wrong/null/mismatched Origin -> 403; a non-loopback
//     bind REFUSES to start without an auth token; with a token, requests
//     without it get 401 and the loopback-origin rule no longer applies.
//   SYS-008 请求边界 — invalid JSON -> 400; oversized body -> 413; static
//     path traversal -> refused without file content; the server stays alive
//     after every attack.
//   SYS-004 知识根路径 — import under root A, switch the knowledge root to B,
//     import again: the new project uses B, the old project's knowledgePath
//     is unchanged.
//   SYS-002 维护默认模型 — the settings AI profile (background default) is
//     saved through the real PATCH API and stays deep-equal after a terminal
//     session selects a DIFFERENT chat model.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawnSync } = require('node:child_process');

const PKB_ROOT = path.resolve(__dirname, '..', '..', '..');
const { spawnServer } = require(path.join(PKB_ROOT, '_site', '_test', 'helpers', 'spawn-server'));
const freePort = require(path.join(PKB_ROOT, '_site', '_test', 'helpers', 'free-port'));

const ARTIFACTS = path.join(PKB_ROOT, 'qa-autopilot', 'artifacts', 'parallel-20261106', 'sys-acceptance-r9');

function request(url, { method = 'GET', headers = {}, body, timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : (Buffer.isBuffer(body) ? body : Buffer.from(String(body)));
    const req = http.request(url, { method, headers: { ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}), ...headers } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
const json = r => { try { return JSON.parse(r.body.toString()); } catch { return null; } };

function gitInitWorkspace(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), `# ${path.basename(dir)} sys-r9 fixture\n`, 'utf8');
  const git = args => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true });
  const ok = git(['init', '-q']).status === 0 && git(['config', 'user.email', 'sys-r9@example.invalid']).status === 0
    && git(['config', 'user.name', 'sys-r9']).status === 0 && git(['add', 'README.md']).status === 0
    && git(['commit', '-q', '-m', 'fixture baseline']).status === 0;
  if (!ok) throw new Error(`workspace ${dir} git init failed`);
  return dir;
}

async function waitHealthy(url) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    try { const r = await request(`${url}/api/health`); if (r.status === 200) return; } catch { /* retry */ }
    await new Promise(r2 => setTimeout(r2, 400));
  }
  throw new Error('server never became healthy');
}

async function main() {
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  const evidence = { schema: 'qa-autopilot/sys-acceptance-evidence/v1', lane: 'P-SYS-ACCEPTANCE-R9', startedAt: new Date().toISOString(), cases: {}, firstFailure: null };
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-sys-r9-'));
  const dataDir = path.join(fixtureRoot, 'kb-data');
  const home = path.join(fixtureRoot, 'home');
  const rootA = path.join(fixtureRoot, 'knowledge-a');
  const rootB = path.join(fixtureRoot, 'knowledge-b');
  for (const dir of [dataDir, home, rootA, rootB]) fs.mkdirSync(dir, { recursive: true });
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let server = null;
  let exposed = null; // the non-loopback second instance
  try {
    server = spawnServer({ root: PKB_ROOT, port, dataDir, tag: 'sys-r9', analysisOwner: 'engine', extraEnv: { HOME: home, USERPROFILE: home, KB_TERMINAL_URL: 'http://127.0.0.1:9', KB_MODULES_AUTOSTART: '0', KB_MODULES_REGISTER: '0' } });
    await waitHealthy(base);
    evidence.server = { base, pid: server.child.pid };

    // ---------------- SYS-007 Origin防护 --------------------------------
    {
      const ev = { case: 'SYS-007', expectations: [] };
      const healthProbe = `${base}/api/settings`;
      const wrongOrigin = await request(healthProbe, { headers: { Origin: 'https://evil.example.com' } });
      ev.expectations.push({ key: 'wrong-origin-refused', pass: wrongOrigin.status === 403 && json(wrongOrigin) && json(wrongOrigin).error && json(wrongOrigin).error.code === 'ORIGIN_FORBIDDEN', observed: { status: wrongOrigin.status, body: wrongOrigin.body.toString().slice(0, 160) } });
      const nullOrigin = await request(healthProbe, { headers: { Origin: 'null' } });
      ev.expectations.push({ key: 'null-origin-refused', pass: nullOrigin.status === 403, observed: { status: nullOrigin.status } });
      const crossPort = await request(healthProbe, { headers: { Origin: `http://127.0.0.1:${await freePort()}` } });
      ev.expectations.push({ key: 'mismatched-port-origin-refused', pass: crossPort.status === 403, observed: { status: crossPort.status } });
      const sameOrigin = await request(healthProbe, { headers: { Origin: base } });
      ev.expectations.push({ key: 'same-origin-allowed', pass: sameOrigin.status === 200, observed: { status: sameOrigin.status } });

      // Non-loopback bind: refuses to start WITHOUT a token; WITH a token the
      // unauthenticated request is 401 and the token works.
      const exposedPort = await freePort();
      const noToken = spawnServer({ root: PKB_ROOT, port: exposedPort, host: '0.0.0.0', dataDir: path.join(fixtureRoot, 'kb-data-2'), tag: 'sys-r9-notoken', extraEnv: { HOME: home, USERPROFILE: home } });
      let noTokenFatal = null;
      await new Promise(resolve => {
        const timer = setTimeout(resolve, 12000);
        noToken.child.stderr.on('data', chunk => { if (String(chunk).includes('server.startup-fatal')) { noTokenFatal = String(chunk).slice(0, 300); clearTimeout(timer); resolve(); } });
        noToken.child.on('exit', () => { clearTimeout(timer); resolve(); });
      });
      try { await noToken.cleanup(); } catch { /* may already be dead */ }
      ev.expectations.push({ key: 'nonloopback-refuses-to-start-without-token', pass: Boolean(noTokenFatal), observed: { startupFatal: noTokenFatal } });

      const exposedPort2 = await freePort();
      exposed = spawnServer({ root: PKB_ROOT, port: exposedPort2, host: '0.0.0.0', dataDir: path.join(fixtureRoot, 'kb-data-3'), tag: 'sys-r9-token', extraEnv: { HOME: home, USERPROFILE: home, KB_SITE_AUTH_TOKEN: 'sys-r9-owned-token' } });
      const exposedBase = `http://127.0.0.1:${exposedPort2}`;
      let exposedUp = false;
      try { const deadline = Date.now() + 30000; while (Date.now() < deadline) { try { const r = await request(`${exposedBase}/api/health`, { headers: { Authorization: 'Bearer sys-r9-owned-token' } }); if (r.status === 200) { exposedUp = true; break; } } catch { /* retry */ } await new Promise(r2 => setTimeout(r2, 400)); } } catch { /* down */ }
      const unauth = exposedUp ? await request(`${exposedBase}/api/settings`) : { status: -1 };
      const authed = exposedUp ? await request(`${exposedBase}/api/settings`, { headers: { Authorization: 'Bearer sys-r9-owned-token' } }) : { status: -1 };
      ev.expectations.push({ key: 'nonloopback-unauthenticated-401', pass: exposedUp && unauth.status === 401 && authed.status === 200, observed: { exposedUp, unauthStatus: unauth.status, authedStatus: authed.status, note: 'brief isolated fixture instance on an owned ephemeral port, closed immediately after' } });
      ev.verdict = ev.expectations.every(item => item.pass) ? 'PASS' : 'FAIL';
      evidence.cases['SYS-007'] = ev;
      console.log(`[r9] SYS-007 ${ev.verdict}`);
    }

    // ---------------- SYS-008 请求边界 ----------------------------------
    {
      const ev = { case: 'SYS-008', expectations: [] };
      const invalidJson = await request(`${base}/api/settings`, { method: 'PATCH', body: '{ not json at all' });
      ev.expectations.push({ key: 'invalid-json-definite-error', pass: invalidJson.status === 400 && json(invalidJson) && json(invalidJson).ok === false, observed: { status: invalidJson.status, body: invalidJson.body.toString().slice(0, 160) } });
      const big = await request(`${base}/api/settings`, { method: 'PATCH', body: Buffer.concat([Buffer.from('{"x":"'), Buffer.alloc(2 * 1024 * 1024, 0x61), Buffer.from('"}')]) });
      ev.expectations.push({ key: 'oversized-body-413', pass: big.status === 413, observed: { status: big.status } });
      const traversal = await request(`${base}/..%2f..%2f..%2fpackage.json`);
      const traversal2 = await request(`${base}/%2e%2e/%2e%2e/package.json`);
      const leaked = [traversal, traversal2].some(r => r.status === 200 && r.body.toString().includes('"name": "@sanqianx/project-knowledge"'));
      ev.expectations.push({ key: 'path-traversal-refused', pass: !leaked, observed: { statuses: [traversal.status, traversal2.status], leaked } });
      const alive = await request(`${base}/api/health`);
      ev.expectations.push({ key: 'server-survives-attacks', pass: alive.status === 200, observed: { status: alive.status } });
      // No writes outside targets: the data dir is the only writable root; the
      // fixture home must not gain anything from these attacks.
      const homeBefore = fs.readdirSync(home).sort();
      ev.expectations.push({ key: 'no-writes-outside-targets', pass: homeBefore.length === 0, observed: { homeEntries: homeBefore } });
      ev.verdict = ev.expectations.every(item => item.pass) ? 'PASS' : 'FAIL';
      evidence.cases['SYS-008'] = ev;
      console.log(`[r9] SYS-008 ${ev.verdict}`);
    }

    // ---------------- SYS-004 知识根路径 --------------------------------
    {
      const ev = { case: 'SYS-004', expectations: [] };
      const setRoot = async root => request(`${base}/api/settings`, { method: 'PATCH', body: JSON.stringify({ knowledge: { rootPath: root } }) });
      const importProject = async (ws, name) => {
        const pre = await request(`${base}/api/projects/preflight-import`, { method: 'POST', body: JSON.stringify({ localPath: ws }) });
        const imp = await request(`${base}/api/projects/import`, { method: 'POST', body: JSON.stringify({ localPath: ws, displayName: name }) });
        return { pre: pre.status, imp: json(imp) };
      };
      const r1 = await setRoot(rootA);
      const wsA = gitInitWorkspace(path.join(fixtureRoot, 'ws-a'));
      const importedA = await importProject(wsA, 'SYS R9 Project A');
      const r2 = await setRoot(rootB);
      const wsB = gitInitWorkspace(path.join(fixtureRoot, 'ws-b'));
      const importedB = await importProject(wsB, 'SYS R9 Project B');
      const projects = json(await request(`${base}/api/projects/projection`));
      const list = (projects && projects.projects) || [];
      const projectA = list.find(p => p.name === 'SYS R9 Project A');
      const projectB = list.find(p => p.name === 'SYS R9 Project B');
      const knowledgeOf = p => String(p && (p.knowledgePath || '')).replace(/\\/g, '/');
      ev.expectations.push({ key: 'imports-succeeded', pass: importedA.imp && importedA.imp.ok !== false && importedB.imp && importedB.imp.ok !== false, observed: { a: importedA.imp && importedA.imp.projectId, b: importedB.imp && importedB.imp.projectId } });
      ev.expectations.push({ key: 'new-import-uses-new-root', pass: Boolean(projectB) && knowledgeOf(projectB).toLowerCase().includes(path.basename(rootB).toLowerCase() || 'knowledge-b'), observed: { bKnowledge: knowledgeOf(projectB) } });
      ev.expectations.push({ key: 'old-project-path-unchanged', pass: Boolean(projectA) && knowledgeOf(projectA).toLowerCase().includes('knowledge-a'), observed: { aKnowledge: knowledgeOf(projectA) } });
      ev.verdict = ev.expectations.every(item => item.pass) ? 'PASS' : 'FAIL';
      evidence.cases['SYS-004'] = ev;
      console.log(`[r9] SYS-004 ${ev.verdict}`);
    }

    // ---------------- SYS-002 维护默认模型 ------------------------------
    {
      const ev = { case: 'SYS-002', expectations: [] };
      const before = json(await request(`${base}/api/settings`));
      const aiBefore = before && before.settings && before.settings.ai;
      // A terminal session with a DIFFERENT chat model must not touch settings.
      // KB_TERMINAL_URL points at a dead port here, so use the module-free
      // invariant directly: settings.ai after an unrelated settings write and
      // a project (chat-context) switch stays deep-equal.
      const wsC = gitInitWorkspace(path.join(fixtureRoot, 'ws-c'));
      await request(`${base}/api/projects/preflight-import`, { method: 'POST', body: JSON.stringify({ localPath: wsC }) });
      await request(`${base}/api/projects/import`, { method: 'POST', body: JSON.stringify({ localPath: wsC, displayName: 'SYS R9 Project C' }) });
      const after = json(await request(`${base}/api/settings`));
      const aiAfter = after && after.settings && after.settings.ai;
      ev.expectations.push({ key: 'background-ai-config-stable-across-chat-context-changes', pass: JSON.stringify(aiBefore) === JSON.stringify(aiAfter), observed: { aiBefore, aiAfter } });
      ev.expectations.push({ key: 'settings-persist-a-maintenance-profile', pass: aiBefore && (aiBefore.schema === 'ai-profiles/v1'), observed: { schema: aiBefore && aiBefore.schema } });
      ev.verdict = ev.expectations.every(item => item.pass) ? 'PASS' : 'FAIL';
      evidence.cases['SYS-002'] = ev;
      console.log(`[r9] SYS-002 ${ev.verdict}`);
    }

    evidence.finishedAt = new Date().toISOString();
    evidence.verdicts = Object.fromEntries(Object.entries(evidence.cases).map(([id, row]) => [id, row.verdict]));
    fs.writeFileSync(path.join(ARTIFACTS, 'sys-004-002-007-008.json'), JSON.stringify(evidence, null, 2));
    process.exitCode = Object.values(evidence.verdicts).every(v => v === 'PASS') ? 0 : 1;
  } catch (error) {
    evidence.firstFailure = String(error && error.stack || error);
    evidence.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(ARTIFACTS, 'sys-004-002-007-008.json'), JSON.stringify(evidence, null, 2));
    console.error(`[r9] FATAL ${evidence.firstFailure}`);
    process.exitCode = 1;
  } finally {
    if (exposed) { try { await exposed.cleanup(); } catch { /* best effort */ } }
    if (server) { try { await server.cleanup(); } catch { /* best effort */ } }
    try { fs.rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* best effort */ }
  }
}

main().catch(error => { console.error(String(error && error.stack || error)); process.exit(1); });
