#!/usr/bin/env node
'use strict';
// qa-autopilot/tools/product-probes/parallel-cap-acceptance-r19-cap010.js
//
// P-CAP-ACCEPTANCE-R19 — CAP-010 真实送达 (user-approved real model usage).
//
//   steps:   已确认上下文注入后，模型引用任务事实并实际使用。
//   expected: 单凭Hook日志或output事件不足以声明送达。
//
// The FULL knowledge loop, every link real:
//   real console + real vendored engine (REAL HeadlessAnalyzer on a REAL
//   minimax profile via /api/runtime-config) + real lane vector hub + REAL
//   workbench module (KB_KNOWLEDGE_ENGINE_URL wired) + real product server.
//
//   1. a fixture commit carrying a UNIQUE fact lands through the real hook;
//   2. the engine consumes it and the REAL analyzer (minimax) produces the
//      knowledge staging -> PROMOTION writes the fact into the project
//      knowledge (run succeeded with promotedAt);
//   3. the workbench session input triggers knowledge.retrieve -> the ENGINE
//      /api/context retrieves the promoted fact (lexical-hybrid) and builds
//      the injection prompt;
//   4. the REAL model turn answers with the delivered fact verbatim — the
//      fact exists ONLY in the promoted knowledge, so a correct answer is
//      delivery-and-use proof; hook logs alone could never produce it.
//
// The real subscription profile is read READ-ONLY from the installed
// workbench store (the audited r3 fixture helper); the secret is used only
// in process memory (engine runtime-config + the isolated workbench store)
// and never written to the evidence.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');

const PKB_ROOT = path.resolve(__dirname, '..', '..', '..');
const r5shell = require(path.join(PKB_ROOT, '_site', '_test', 'helpers', 'parallel-capture-safety-r5-cap-shell'));
const r3fixture = require(path.join(PKB_ROOT, '_site', '_test', 'helpers', 'parallel-dock-isolation-r3-fixture'));
const { createUpstreamProxy } = require(path.join(PKB_ROOT, '_site', '_test', 'helpers', 'module-fixture'));
const { spawnServer } = require(path.join(PKB_ROOT, '_site', '_test', 'helpers', 'spawn-server'));
const freePort = require(path.join(PKB_ROOT, '_site', '_test', 'helpers', 'free-port'));

const ARTIFACTS = path.join(PKB_ROOT, 'qa-autopilot', 'artifacts', 'parallel-20261106', 'cap-acceptance-r19');
const CONSOLE_ENTRY = path.join(PKB_ROOT, 'node_modules', '@sanqianx', 'ai-coding-event-bridge-console', 'src', 'bin.js');
const ENGINE_ENTRY = path.join(PKB_ROOT, '_modules', 'knowledge-engine', 'src', 'server.js');
const TERMINAL_ENTRY = path.join(PKB_ROOT, 'node_modules', 'claude-ai-workbench', 'packages', 'server', 'bin', 'agent-terminal-server.js');

const PROFILE_ID = process.env.R19_PROFILE || 'minimax';
const SECRET_FACT = '内部代号 R19-DELTA 的分支策略是 trunk-based-1011';
const QUESTION = '请仅依据本次会话交付的知识引用回答：内部代号 R19-DELTA 的分支策略是什么？如果知识引用中没有该事实，请只回答「未交付」。';

const sleep = ms => new Promise(r => setTimeout(r, ms));
function request(url, { method = 'GET', headers = {}, body, timeoutMs = 15000 } = {}) {
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

async function main() {
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  const evidence = { schema: 'qa-autopilot/cap-acceptance-evidence/v1', lane: 'P-CAP-ACCEPTANCE-R19', case: 'CAP-010', startedAt: new Date().toISOString(), steps: [], expectations: [], firstFailure: null, modelLimitation: null };
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-cap-r19-'));
  const children = [];
  let browserlessCleanup = [];
  try {
    // ---- the real profile (READ-ONLY; secret stays in memory) ----------
    const real = r3fixture.readRealWorkbenchProfile(PROFILE_ID);
    if (!real) throw new Error(`real profile ${PROFILE_ID} not found in the installed workbench store`);
    evidence.steps.push({ step: 'real-profile-read', profileId: real.profileId, provider: real.definition.provider, baseUrl: real.definition.baseUrl, model: real.definition.models && real.definition.models.default, secretRecorded: false });

    // ---- isolated layout ----------------------------------------------
    const homeDir = path.join(fixtureRoot, 'home');
    const bridgeHome = path.join(fixtureRoot, 'bridge-home');
    const engineData = path.join(fixtureRoot, 'engine');
    const productData = path.join(fixtureRoot, 'data');
    const workbenchData = path.join(fixtureRoot, 'workbench');
    const knowledgeRoot = path.join(fixtureRoot, 'knowledge');
    const repo = path.join(fixtureRoot, 'repo');
    for (const dir of [homeDir, bridgeHome, engineData, productData, workbenchData, knowledgeRoot]) fs.mkdirSync(dir, { recursive: true });

    // ---- real console ---------------------------------------------------
    const consolePort = await freePort();
    const consoleUrl = `http://127.0.0.1:${consolePort}`;
    const consoleChild = spawn(process.execPath, [CONSOLE_ENTRY, 'serve', '--host', '127.0.0.1', '--port', String(consolePort), '--home', bridgeHome], { env: { ...process.env, AI_CODING_EVENT_BRIDGE_HOME: bridgeHome }, stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true });
    children.push(consoleChild);
    for (let i = 0; i < 60; i += 1) { try { const r = await request(`${consoleUrl}/api/journals`); if (r.status === 200) break; } catch { /* retry */ } await sleep(500); }

    // ---- lane vector hub (real /api/sync contract; lexical fallback keeps
    //     retrieval honest even without real embeddings) --------------------
    const laneVector = await r5shell.startLaneVectorHub({ tag: 'cap-r19' });
    browserlessCleanup.push(() => Promise.resolve(laneVector.stop && laneVector.stop()));

    // ---- real engine (REAL analyzer default) + token proxy -------------
    const engineToken = crypto.randomUUID();
    const { createEngineServer } = require(ENGINE_ENTRY);
    const engine = createEngineServer({ dataDir: engineData, runtimeToken: engineToken, bridgeUrl: consoleUrl, vectorUrl: laneVector.url, consume: false });
    await engine.ready;
    await new Promise(resolve => engine.server.listen(0, '127.0.0.1', resolve));
    const engineUrl = `http://127.0.0.1:${engine.server.address().port}`;
    const engineProxy = createUpstreamProxy({ target: engineUrl, token: engineToken, tag: 'r19-engine' });
    await engineProxy.start();
    browserlessCleanup.push(() => engineProxy.close());

    // ---- real workbench module with the engine wired --------------------
    const terminalPort = await freePort();
    const terminalUrl = `http://127.0.0.1:${terminalPort}`;
    // Seed the module's own profile store (its persisted format) with the
    // real profile so the SESSION model is the real subscription too.
    fs.writeFileSync(path.join(workbenchData, 'profiles.v2.json'), JSON.stringify({ schema: 'ai-profiles/v2', profiles: [real.definition] }, null, 2), 'utf8');
    fs.writeFileSync(path.join(workbenchData, 'credentials.v1.json'), JSON.stringify({ schema: 'workbench-credentials/v1', credentials: { [real.credentialRef]: real.secret } }, null, 2), 'utf8');
    const terminalEnv = {
      ...process.env,
      AGENT_TERMINAL_PORT: String(terminalPort), AGENT_TERMINAL_HOST: '127.0.0.1',
      AGENT_TERMINAL_DATA_DIR: workbenchData,
      KB_KNOWLEDGE_ENGINE_URL: engineProxy.url,
      KB_WORKBENCH_DISABLE_PICKER: '1',
      HOME: homeDir, USERPROFILE: homeDir,
    };
    const terminal = spawn(process.execPath, [TERMINAL_ENTRY], { cwd: PKB_ROOT, env: terminalEnv, stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true });
    children.push(terminal);
    for (let i = 0; i < 90; i += 1) { try { const r = await request(`${terminalUrl}/api/claude-workbench/v1/health`); if (r.status === 200) break; } catch { /* retry */ } await sleep(500); }

    // ---- real product server (engine owner) -----------------------------
    const productPort = await freePort();
    const productUrl = `http://127.0.0.1:${productPort}`;
    const server = spawnServer({
      root: PKB_ROOT, port: productPort, dataDir: productData, tag: 'cap-r19', analysisOwner: 'engine',
      extraEnv: {
        HOME: homeDir, USERPROFILE: homeDir, CLAUDE_CONFIG_DIR: path.join(homeDir, '.claude'),
        KB_MODULES_REGISTER: '1', KB_MODULES_AUTOSTART: '0',
        KB_TERMINAL_URL: terminalUrl, KB_EVENTBRIDGE_URL: consoleUrl, KB_VECTORHUB_URL: laneVector.url,
        KB_KNOWLEDGE_ENGINE_URL: engineProxy.url,
        AI_CODING_EVENT_BRIDGE_HOME: bridgeHome,
      },
    });
    browserlessCleanup.push(() => server.cleanup());
    for (let i = 0; i < 90; i += 1) { try { const r = await request(`${productUrl}/api/health`); if (r.status === 200) break; } catch { /* retry */ } await sleep(500); }

    // ---- import the fixture project (hook + engine registration) -------
    {
      const git = args => { const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout; };
      fs.mkdirSync(repo, { recursive: true });
      git(['init', '-q', '-b', 'main']); git(['config', 'user.email', 'r19@example.invalid']); git(['config', 'user.name', 'r19']);
      fs.writeFileSync(path.join(repo, 'README.md'), 'r19\n', 'utf8'); git(['add', 'README.md']); git(['commit', '-q', '-m', 'baseline']);
    }
    const termApi = (p, init) => request(`${productUrl}/api/terminal/${p.replace(/^\//, '')}`, init);
    await request(`${productUrl}/api/settings`, { method: 'PATCH', body: { knowledge: { rootPath: knowledgeRoot } } });
    const knowledgePath = path.join(knowledgeRoot, 'main'); fs.mkdirSync(knowledgePath, { recursive: true });
    const imported = await request(`${productUrl}/api/projects/import`, { method: 'POST', body: { localPath: repo, knowledgePath, displayName: 'CAP R19 Delivery' } });
    const importBody = jsonOf(imported);
    assert.ok(imported.status === 201 && importBody.project, `import: ${imported.status} ${imported.text.slice(0, 200)}`);
    const projectId = importBody.project.projectId;
    evidence.steps.push({ step: 'imported', projectId, modules: Object.fromEntries(Object.entries(importBody.modules || {}).map(([k, v]) => [k, v && v.ok]) ) });

    // ---- engine: REAL analyzer profile + activate consumption ----------
    const runtimeConfig = await request(`${engineUrl}/api/runtime-config`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${engineToken}` },
      body: { projectId, profile: { apiKey: real.secret, baseUrl: real.definition.baseUrl, mainModel: real.definition.models && real.definition.models.default } },
    });
    assert.ok(runtimeConfig.status === 200, `runtime-config: ${runtimeConfig.status} ${runtimeConfig.text.slice(0, 200)}`);
    evidence.steps.push({ step: 'engine-runtime-config', status: runtimeConfig.status });
    const activate = await request(`${engineUrl}/api/control`, { method: 'POST', headers: { Authorization: `Bearer ${engineToken}` }, body: { enabled: true } });
    assert.ok(activate.status === 200, `activate: ${activate.status}`);

    // ---- the FACT commit -> real analysis -> promotion ------------------
    fs.writeFileSync(path.join(repo, 'STRATEGY.md'), `# 项目分支策略\n\n${SECRET_FACT}。本文件是唯一来源。\n`, 'utf8');
    {
      const git = args => { const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout; };
      git(['add', 'STRATEGY.md']); git(['commit', '-q', '-m', 'docs: record the R19-DELTA branch strategy']);
    }
    const factSha = spawnSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).stdout.trim();
    evidence.steps.push({ step: 'fact-commit', sha: factSha });

    const engineGet = async (route, token) => request(`${engineUrl}${route}`, token ? { headers: { Authorization: `Bearer ${engineToken}` } } : {});
    let promotedRun = null;
    const analysisDeadline = Date.now() + 12 * 60 * 1000; // a real model analysis may take minutes
    while (Date.now() < analysisDeadline) {
      const runs = jsonOf(await engineGet(`/api/runs?projectId=${encodeURIComponent(projectId)}`));
      const hit = (runs && runs.runs || []).find(r => r.commitSha === factSha);
      if (hit && hit.promotedAt && ['succeeded', 'index-pending'].includes(hit.state)) { promotedRun = hit; break; }
      if (Date.now() % 20000 < 4000) { const h = jsonOf(await engineGet('/api/health', true)); console.log(`[r19:poll] run=${hit ? hit.state + "/" + hit.phase : "none"} journal=${h && h.journal && JSON.stringify({ enabled: h.journal.enabled, failures: h.journal.failures })}`); }
      if (hit && hit.state === 'failed') throw new Error(`the real analysis failed: ${JSON.stringify(hit.error)}`);
      await sleep(4000);
    }
    assert.ok(promotedRun, 'the real analysis promoted the fact commit');
    // index-pending is the honest promoted state when the lane vector cannot
    // produce real vectors — knowledge IS promoted; retrieval goes lexical.
    evidence.steps.push({ step: 'analysis-promoted', runId: promotedRun.runId, promotedAt: promotedRun.promotedAt });

    // The engine /api/context must retrieve the fact (the workbench's
    // retrieval route — proven directly first).
    const contextProbe = jsonOf(await request(`${engineUrl}/api/context`, { method: 'POST', headers: { Authorization: `Bearer ${engineToken}`, 'Content-Type': 'application/json' }, body: { repoPath: repo, query: QUESTION, client: 'workbench', sessionId: 'r19-probe' } }));
    const contextHasFact = Boolean(contextProbe && contextProbe.prompt && contextProbe.prompt.includes('trunk-based-1011'));
    evidence.steps.push({ step: 'engine-context-probe', status: contextProbe && contextProbe.status, promptLength: contextProbe && contextProbe.prompt && contextProbe.prompt.length, hasFact: contextHasFact, promptHead: contextProbe && contextProbe.prompt ? contextProbe.prompt.slice(0, 240) : null });
    assert.ok(contextHasFact, `the engine context prompt must carry the delivered fact (status=${contextProbe && contextProbe.status})`);

    // ---- the REAL model turn through the REAL workbench -----------------
    const terminalProjectId = importBody.modules && importBody.modules.terminal && importBody.modules.terminal.projectId;
    assert.ok(terminalProjectId, 'the import registered the terminal project');
    const created = jsonOf(await termApi('sessions', { method: 'POST', body: { context: { contextId: terminalProjectId, workspaceRef: terminalProjectId }, aiProfileId: real.profileId, permissionMode: 'bypassPermissions' } }));
    assert.ok(created && created.session, `session create failed: ${JSON.stringify(created).slice(0, 200)}`);
    const sessionId = created.session.sessionId;
    const input = await termApi(`sessions/${sessionId}/input`, { method: 'POST', body: { text: QUESTION } });
    assert.ok(input.status === 202, `input: ${input.status} ${input.text.slice(0, 200)}`);

    let answer = null;
    const answerDeadline = Date.now() + 6 * 60 * 1000;
    while (Date.now() < answerDeadline) {
      const loaded = jsonOf(await termApi(`sessions/${sessionId}`));
      const events = (loaded && loaded.events) || [];
      const assistantText = events.filter(e => /claude\/(assistant|text|message)/.test(String(e.type || ''))).map(e => String(e.text || e.message || '')).join(' ');
      if (assistantText.trim()) { answer = assistantText; break; }
      const errorEvent = events.find(e => /error/i.test(String(e.type || '')) && e.error);
      if (errorEvent) throw new Error(`model error: ${JSON.stringify(errorEvent).slice(0, 300)}`);
      await sleep(3000);
    }
    assert.ok(answer, 'the real model answered');
    const answerUsedFact = /trunk-based-1011/.test(answer);
    evidence.steps.push({ step: 'model-answer', answer: answer.slice(0, 600) });

    evidence.expectations.push({
      key: 'delivered-fact-retrieved-by-engine',
      pass: contextHasFact,
      observed: { engineContextStatus: contextProbe && contextProbe.status, references: (contextProbe && contextProbe.references || []).length },
    });
    evidence.expectations.push({
      key: 'model-actually-uses-delivered-fact',
      pass: answerUsedFact,
      observed: { answer: answer.slice(0, 400), note: 'the fact exists ONLY in the promoted knowledge; hook logs and output events alone could not produce this answer' },
    });
    evidence.finishedAt = new Date().toISOString();
    evidence.verdict = evidence.expectations.every(item => item.pass) ? 'PASS' : 'FAIL';
    fs.writeFileSync(path.join(ARTIFACTS, 'cap-010.json'), JSON.stringify(evidence, null, 2));
    console.log(`[r19] CAP-010 ${evidence.verdict}`);
    process.exitCode = evidence.verdict === 'PASS' ? 0 : 1;
  } catch (error) {
    evidence.modelLimitation = /quota|rate|429|余额|限流/i.test(String(error)) ? { kind: 'provider-limit', error: String(error.message).slice(0, 200) } : null;
    evidence.firstFailure = String(error && error.stack || error);
    evidence.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(ARTIFACTS, 'cap-010.json'), JSON.stringify(evidence, null, 2));
    console.error(`[r19] FATAL ${evidence.firstFailure}`);
    process.exitCode = 1;
  } finally {
    for (const child of children) { try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 10000, windowsHide: true }); } catch { /* best effort */ } }
    for (const cleanup of browserlessCleanup.reverse()) { try { await cleanup(); } catch { /* best effort */ } }
    try { fs.rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* best effort */ }
  }
}

main().catch(error => { console.error(String(error && error.stack || error)); process.exit(1); });
