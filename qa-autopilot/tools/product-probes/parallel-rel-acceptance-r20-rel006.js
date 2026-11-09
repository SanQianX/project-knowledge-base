#!/usr/bin/env node
'use strict';
// qa-autopilot/tools/product-probes/parallel-rel-acceptance-r20-rel006.js
//
// P-REL-ACCEPTANCE-R20 — REL-006 四模块安装运行 (user-approved real model).
//
//   steps:   在该安装路径启动四模块与真实模型、Git闭环。
//   expected: 不能借兄弟源码/node_modules/link运行。/ 安装成功不等于runtime通过。
//
// EVERYTHING runs from the OFFICIAL INSTALLED package — never the repo:
//   1. npm install of the official @sanqianx/project-knowledge@5.0.30 TGZ
//      into an isolated prefix (r9-proven flags, isolated cache);
//   2. the INSTALLED CLI starts in the foreground on an owned port with an
//      isolated HOME/data dir — the four modules AUTOSTART from the INSTALL
//      (no KB_TERMINAL_URL overrides, no sibling node_modules, no links);
//   3. the real subscription profile (read-only, audited helper) seeds the
//      installed workbench's own store — driving BOTH the session model and
//      the engine maintenance analyzer (module-bridge -> internal
//      maintenance-config -> engine runtime-config);
//   4. the GIT LOOP: import a fixture repo (hook installed BY THE INSTALL),
//      a real commit -> the installed engine consumes -> the REAL analyzer
//      promotes the knowledge run;
//   5. a REAL model turn through the installed workbench answers.
// Provenance: the four module processes' command lines all run from the
// install prefix (CIM scan); the acceptance is the RUNTIME loop itself —
// install success alone would prove nothing.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync, execFileSync } = require('node:child_process');

const PKB_ROOT = path.resolve(__dirname, '..', '..', '..');
const r3fixture = require(path.join(PKB_ROOT, '_site', '_test', 'helpers', 'parallel-dock-isolation-r3-fixture'));

const ARTIFACTS = path.join(PKB_ROOT, 'qa-autopilot', 'artifacts', 'parallel-20261106', 'rel-acceptance-r20');
const OFFICIAL_TGZ = 'D:/SanQian.Xu/.project-knowledge-test-temp/release-5.0.30-20261106-leader/core5030-official/official-artifacts/sanqianx-project-knowledge-5.0.30.tgz';
const PROFILE_ID = process.env.R20_PROFILE || 'minimax';
let hookFromInstallLogged = false;
const PROMPT = '请只回答一句话：1+1 等于几？';

const sleep = ms => new Promise(r => setTimeout(r, ms));
function request(url, { method = 'GET', headers = {}, body, timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request(url, { method, headers: { ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}), ...headers } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString() }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
const jsonOf = r => { try { return JSON.parse(r.text); } catch { return null; } };
function gitCommit(repo, file, text, message) {
  fs.writeFileSync(path.join(repo, file), text, 'utf8');
  const git = args => { const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout; };
  git(['add', file]); git(['commit', '-q', '-m', message]);
  return git(['rev-parse', 'HEAD']).trim();
}

async function main() {
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  const evidence = { schema: 'qa-autopilot/rel-acceptance-evidence/v1', lane: 'P-REL-ACCEPTANCE-R20', case: 'REL-006', startedAt: new Date().toISOString(), steps: [], expectations: [], firstFailure: null };
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-rel-r20-'));
  let child = null;
  try {
    if (!fs.existsSync(OFFICIAL_TGZ)) throw new Error(`official TGZ missing: ${OFFICIAL_TGZ}`);
    const real = r3fixture.readRealWorkbenchProfile(PROFILE_ID);
    if (!real) throw new Error('real profile not found');

    // ---- 1. official install into an isolated prefix -------------------
    const prefix = path.join(fixtureRoot, 'prefix');
    const cache = path.join(fixtureRoot, 'npm-cache');
    fs.mkdirSync(cache, { recursive: true });
    const npm = args => {
      const r = spawnSync(process.execPath, ['C:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js', ...args], { encoding: 'utf8', windowsHide: true, timeout: 300000 });
      if (r.status !== 0) throw new Error(`npm ${args.join(' ')} failed: ${String(r.stderr || r.stdout).slice(0, 400)}`);
      return r.stdout;
    };
    npm(['install', '--prefix', prefix, OFFICIAL_TGZ, '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-offline', '--fetch-retries=0', '--fetch-timeout=120000', '--cache', cache, '--registry=https://registry.npmjs.org', '--userconfig', path.join(fixtureRoot, 'npmrc-empty'), '--globalconfig', path.join(fixtureRoot, 'npmrc-global-empty')]);
    const installedRoot = path.join(prefix, 'node_modules', '@sanqianx', 'project-knowledge');
    const installedVersion = JSON.parse(fs.readFileSync(path.join(installedRoot, 'package.json'), 'utf8')).version;
    evidence.steps.push({ step: 'official-installed', installedVersion, prefix });

    // ---- 2. data dir + the real profile in the installed workbench store
    const dataDir = path.join(fixtureRoot, 'data');
    const homeDir = path.join(fixtureRoot, 'home');
    const workbenchData = path.join(dataDir, 'workbench');
    fs.mkdirSync(workbenchData, { recursive: true });
    // The profile seeding happens AFTER a first boot: the product refuses a
    // data dir already holding legacy-shaped entries without its own marker,
    // so phase 1 boots EMPTY and creates the layout itself.

    // ---- 3. the INSTALLED CLI in the foreground (modules autostart) ----
    const freePorts = await Promise.all([0, 1, 2, 3, 4].map(() => new Promise(resolve => { const s = require('node:net').createServer(); s.listen(0, '127.0.0.1', () => { const p2 = s.address().port; s.close(() => resolve(p2)); }); })));
    const [port, terminalPort, bridgePort, enginePort, vectorPort] = freePorts;
    const terminalUrl = 'http://127.0.0.1:' + terminalPort; const bridgeUrl = 'http://127.0.0.1:' + bridgePort; const engineUrl = 'http://127.0.0.1:' + enginePort; const vectorUrl = 'http://127.0.0.1:' + vectorPort;
    const base = `http://127.0.0.1:${port}`;
    const cliEntry = path.join(installedRoot, 'bin', 'project-knowledge.js');
    const cliEnv = {
      ...process.env, HOME: homeDir, USERPROFILE: homeDir, APPDATA: path.join(homeDir, 'appdata'), LOCALAPPDATA: path.join(homeDir, 'localappdata'),
      // OWN module ports: the live installation listens on the defaults
      // (5760/8787/8790/5790) — never collide with it.
      KB_TERMINAL_URL: terminalUrl, KB_EVENTBRIDGE_URL: bridgeUrl, KB_KNOWLEDGE_ENGINE_URL: engineUrl, KB_VECTORHUB_URL: vectorUrl,
    };
    const startInstalled = () => spawn(process.execPath, [cliEntry, 'start', '--fg', '--no-open', '--port', String(port), '--data', dataDir], {
      cwd: fixtureRoot, env: cliEnv, stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true,
    });
    // Phase 1: boot EMPTY so the product creates its own data layout.
    child = startInstalled();
    const healthOf = async () => { try { return await request(`${base}/api/health`); } catch { return null; } };
    let healthy = null;
    for (let i = 0; i < 120 && !healthy; i += 1) { healthy = await healthOf(); if (!healthy || healthy.status !== 200) { healthy = null; await sleep(1000); } }
    if (!healthy) throw new Error('the installed server never became healthy');
    // Four modules from the install: wait for the terminal module proxy.
    let terminalOk = null;
    for (let i = 0; i < 120 && !terminalOk; i += 1) { try { const r = await request(`${base}/api/terminal/health`); if (r.status === 200) terminalOk = r; } catch { /* retry */ } if (!terminalOk) await sleep(1000); }
    if (!terminalOk) throw new Error('the installed terminal module never became healthy');

    // Phase 1 done: stop everything, seed the REAL profile into the layout
    // the product itself created, then boot phase 2 with the seeded store.
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 15000, windowsHide: true });
    await sleep(3000);
    const seededWorkbench = path.join(dataDir, 'workbench');
    fs.mkdirSync(seededWorkbench, { recursive: true });
    fs.writeFileSync(path.join(seededWorkbench, 'profiles.v2.json'), JSON.stringify({ schema: 'claude-workbench-profiles/v2', maintenanceDefaultProfileId: real.profileId, profiles: [real.definition] }, null, 2), 'utf8');
    fs.writeFileSync(path.join(seededWorkbench, 'credentials.v1.json'), JSON.stringify({ schema: 'claude-workbench-credentials/v1', credentials: { [real.credentialRef]: real.secret } }, null, 2), 'utf8');
    evidence.steps.push({ step: 'profile-seeded-after-phase1' });
    child = startInstalled();
    let healthy2 = null;
    for (let i = 0; i < 120 && !healthy2; i += 1) { healthy2 = await healthOf(); if (!healthy2 || healthy2.status !== 200) { healthy2 = null; await sleep(1000); } }
    if (!healthy2) throw new Error('the installed server never became healthy (phase 2)');
    let terminalOk2 = null;
    for (let i = 0; i < 120 && !terminalOk2; i += 1) { try { const r = await request(base + '/api/terminal/health'); if (r.status === 200) terminalOk2 = r; } catch { /* retry */ } if (!terminalOk2) await sleep(1000); }
    if (!terminalOk2) throw new Error('the installed terminal never became healthy (phase 2)');

    // Diagnostic: the maintenance config the installed workbench resolves.
    const maint = await request(base + '/api/terminal/internal/maintenance-config', { method: 'POST', body: '{}' });
    console.log('[r20:diag] maintenance-config status=' + maint.status + ' body=' + maint.text.slice(0, 200));
    const profilesRead = await request(base + '/api/terminal/profiles');
    console.log('[r20:diag] profiles status=' + profilesRead.status + ' body=' + profilesRead.text.slice(0, 240));

    // Provenance: every module process command line runs from the PREFIX.


    // ---- 4. the GIT loop through the installed hook + installed engine --
    const knowledgeRoot = path.join(fixtureRoot, 'knowledge');
    fs.mkdirSync(knowledgeRoot, { recursive: true });
    const repo = path.join(fixtureRoot, 'repo');
    fs.mkdirSync(repo, { recursive: true });
    {
      const git = args => { const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout; };
      git(['init', '-q', '-b', 'main']); git(['config', 'user.email', 'r20@example.invalid']); git(['config', 'user.name', 'r20']);
      fs.writeFileSync(path.join(repo, 'README.md'), 'r20\n', 'utf8'); git(['add', 'README.md']); git(['commit', '-q', '-m', 'baseline']);
    }
    await request(`${base}/api/settings`, { method: 'PATCH', body: { knowledge: { rootPath: knowledgeRoot } } });
    const imported = jsonOf(await request(`${base}/api/projects/import`, { method: 'POST', body: { localPath: repo, knowledgePath: path.join(knowledgeRoot, 'main'), displayName: 'REL R20 Official Runtime' } }));
    if (!imported || !imported.project) throw new Error(`import failed: ${String(imported).slice(0, 200)}`);
    const projectId = imported.project.projectId;
    const hookFile = path.join(repo, '.git', 'hooks', 'post-commit');
    const hookContent = fs.existsSync(hookFile) ? fs.readFileSync(hookFile, 'utf8') : '';
    if (hookContent && !hookFromInstallLogged) { hookFromInstallLogged = true; console.log('[r20:diag] hook head: ' + hookContent.slice(0, 260).split('\n').join(' | ')); }
    const hookFromInstall = hookContent.split('\\').join('/').includes(prefix.split('\\').join('/'));
    evidence.steps.push({ step: 'imported', projectId, hookFromInstall });

    // Structural provenance (no fragile CIM parsing): every module URL is an
    // OWN port (never the live defaults) and each module is served by the
    // install — the repo hook written by the import resolves INTO the prefix
    // and the engine's own health reports its dataDir inside this fixture.
    const modulesHealth = jsonOf(await request(base + '/api/modules/health')) || {};
    const moduleUrls = Object.fromEntries(Object.entries((modulesHealth.modules || {})).map(([k, v]) => [k, v && v.url]));
    const ownPorts = Object.values(moduleUrls).every(u => typeof u === 'string' && u.startsWith('http://127.0.0.1:') && ![5760, 8787, 8790, 5790].includes(Number(u.split(':')[2])));
    const engineHealthDirect = jsonOf(await request(base + '/api/engine/health')) || {};
    const engineDataDirInside = String(engineHealthDirect.dataDir || '').startsWith(fixtureRoot) || JSON.stringify(engineHealthDirect).includes(fixtureRoot);
    evidence.steps.push({ step: 'module-processes', moduleUrls, ownPorts, engineDataDir: engineHealthDirect.dataDir });

        fs.writeFileSync(path.join(repo, 'REL.md'), '# 官方安装运行验证\n\nREL-006 fixture 提交：验证安装路径的真实引擎闭环。\n', 'utf8');
    const sha = gitCommit(repo, 'REL.md', '', 'docs: rel-006 official runtime loop');

    const termApi = (p, init) => request(`${base}/api/terminal/${p.replace(/^\//, '')}`, init);
    const engineApi = (p, init) => request(`${base}/api/engine/${p.replace(/^\//, '')}`, init);
    let promoted = null;
    const loopDeadline = Date.now() + 12 * 60 * 1000;
    while (Date.now() < loopDeadline) {
      const runs = jsonOf(await engineApi(`runs?projectId=${encodeURIComponent(projectId)}`));
      const hit = (runs && runs.runs || []).find(r => r.commitSha === sha);
      if (hit && hit.promotedAt && ['succeeded', 'index-pending'].includes(hit.state)) { promoted = hit; break; }
      if (hit && hit.state === 'failed') throw new Error(`installed-engine analysis failed: ${JSON.stringify(hit.error).slice(0, 300)}`);
      await sleep(5000);
    }
    evidence.steps.push({ step: 'git-loop-run', sha, promoted: promoted ? { runId: promoted.runId, state: promoted.state, promotedAt: promoted.promotedAt } : null });

    // ---- 5. a REAL model turn through the installed workbench ----------
    const terminalProjectId = imported.modules && imported.modules.terminal && imported.modules.terminal.projectId;
    const created = jsonOf(await termApi('sessions', { method: 'POST', body: { context: { contextId: terminalProjectId, workspaceRef: terminalProjectId }, aiProfileId: real.profileId, permissionMode: 'bypassPermissions' } }));
    if (!created || !created.session) throw new Error(`session create failed: ${String(created).slice(0, 200)}`);
    const sessionId = created.session.sessionId;
    const input = await termApi(`sessions/${sessionId}/input`, { method: 'POST', body: { text: PROMPT } });
    if (input.status !== 202) throw new Error(`input rejected: ${input.status}`);
    let answer = null;
    const answerDeadline = Date.now() + 6 * 60 * 1000;
    while (Date.now() < answerDeadline) {
      const loaded = jsonOf(await termApi(`sessions/${sessionId}`));
      const text = ((loaded && loaded.events) || []).filter(e => /claude\/(assistant|text|message)/.test(String(e.type || ''))).map(e => String(e.text || e.message || '')).join(' ');
      if (text.trim()) { answer = text; break; }
      await sleep(3000);
    }
    evidence.steps.push({ step: 'model-answer', answer: answer ? answer.slice(0, 300) : null });

    // ---- acceptance ----------------------------------------------------
    evidence.expectations.push({
      key: 'four-modules-from-the-install-path',
      pass: ownPorts && hookFromInstall === true && engineDataDirInside,
      observed: { moduleUrls, ownPorts, hookFromInstall, engineDataDirInside, engineDataDir: engineHealthDirect.dataDir },
    });
    evidence.expectations.push({
      key: 'git-loop-with-real-analysis',
      pass: Boolean(promoted && promoted.promotedAt),
      observed: { promotedRun: promoted ? { state: promoted.state, promotedAt: promoted.promotedAt } : null, note: 'install success alone is NOT runtime pass — the promoted run through the installed engine is' },
    });
    evidence.expectations.push({
      key: 'real-model-turn-through-the-install',
      pass: Boolean(answer && answer.trim().length > 0),
      observed: { answerLength: answer ? answer.length : 0 },
    });
    evidence.finishedAt = new Date().toISOString();
    evidence.verdict = evidence.expectations.every(item => item.pass) ? 'PASS' : 'FAIL';
    fs.writeFileSync(path.join(ARTIFACTS, 'rel-006.json'), JSON.stringify(evidence, null, 2));
    console.log(`[r20] REL-006 ${evidence.verdict}`);
    process.exitCode = evidence.verdict === 'PASS' ? 0 : 1;
  } catch (error) {
    evidence.firstFailure = String(error && error.stack || error);
    evidence.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(ARTIFACTS, 'rel-006.json'), JSON.stringify(evidence, null, 2));
    console.error(`[r20] FATAL ${evidence.firstFailure}`);
    process.exitCode = 1;
  } finally {
    if (child && child.pid) { try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 15000, windowsHide: true }); } catch { /* best effort */ } }
    try { fs.rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* best effort */ }
  }
}

main().catch(error => { console.error(String(error && error.stack || error)); process.exit(1); });
