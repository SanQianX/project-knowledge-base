'use strict';

// P-LIFECYCLE-NEGATIVE-R51 driver: SYS-005 端口冲突实际协议 + Hook 记录端点投递.
//
// Default --check validates prerequisites WITHOUT binding ports or starting
// any service. Explicit --run executes the bounded OWN probe.
//
// Real product bytes under test (read-only):
//   * bin/project-knowledge.js start --fg (real CLI port selection),
//   * _site/lib/server-app.js listen + runtime-endpoint claim,
//   * _site/scripts/hook-trigger.js endpoint resolution + delivery.
//
// OWN conflict model (never the installed default 5757): the CLI's implicit
// base port is KB_SITE_PORT=P, a verified-free HIGH port that our OWN blocker
// listener occupies first. Leg A (implicit port) must auto-fallback with the
// announced '(Port P was busy, using X instead)' line, never reuse P, and
// record the fallback endpoint; the real hook-trigger then delivers to the
// RECORDED address while its fallback port is a verified-free DEAD port —
// a hardcoded/wrong-port implementation could not produce a 2xx delivery.
// Leg B itemizes the explicit --port contract on another OWN occupied port.
//
// Real 5757/5760/5790/8787/8790 are never bound, closed or written.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { installLaneEnv } = require('./helpers/qa-r51-env.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const CASE_DIR = 'sys005-port-conflict';
const RUN = process.argv.includes('--run');
const REAL_PORTS = [5757, 5760, 5790, 8787, 8790];

function tcpFree(host, port) {
  return new Promise(resolve => {
    const tester = net.createServer();
    let done = false;
    const finish = free => { if (done) return; done = true; tester.close(() => resolve(free)); };
    tester.once('error', () => finish(false));
    tester.once('listening', () => finish(true));
    tester.listen(port, host);
  });
}
async function ephemeralFreePort() {
  return new Promise(resolve => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => { const port = probe.address().port; probe.close(() => resolve(port)); });
  });
}
async function pickPlanPort({ needNext, exclude = [] }) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const port = await ephemeralFreePort();
    if (port < 20000 || port > 60000 || REAL_PORTS.includes(port)) continue;
    if (REAL_PORTS.includes(port + 1)) continue;
    // The OS hands out ephemeral ports sequentially, so earlier picks in this
    // driver can land exactly on a later port's fallback window; keep every
    // planned port at least 25 away from any excluded port.
    if (exclude.some(e => Math.abs(port - e) < 25)) continue;
    if (!(await tcpFree('127.0.0.1', port))) continue;
    if (needNext && !(await tcpFree('127.0.0.1', port + 1))) continue;
    return port;
  }
  throw new Error('could not plan a verified-free high port');
}
function startBlocker() {
  const state = { sockets: 0, httpRequests: [] };
  const server = http.createServer((req, res) => {
    state.httpRequests.push({ at: new Date().toISOString(), method: req.method, url: req.url });
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'R51_OWN_BLOCKER', note: 'unrelated busy port fixture' }));
  });
  server.on('connection', () => { state.sockets += 1; });
  return {
    state,
    async listen(port) { await new Promise(resolve => server.listen(port, '127.0.0.1', resolve)); },
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}
async function fetchStatus(url, timeoutMs = 5000) {
  try { const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) }); return r.status; } catch { return null; }
}
function waitExit(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve('timeout'), timeoutMs);
    child.once('exit', code => { clearTimeout(timer); resolve(code); });
  });
}

async function main() {
  if (!RUN) {
    for (const rel of ['bin/project-knowledge.js', '_site/lib/server-app.js', '_site/lib/runtime-endpoint.js', '_site/scripts/hook-trigger.js']) {
      assert.ok(fs.existsSync(path.join(ROOT, rel)), `missing ${rel}`);
    }
    console.log('QA-R51 SYS005 CHECK OK (no port bound, no service started)');
    return;
  }

  const lane = installLaneEnv({ caseId: 'sys005' });
  const EVIDENCE = path.join(lane.evidenceRoot, CASE_DIR);
  fs.mkdirSync(EVIDENCE, { recursive: true });
  const endpointLib = require(path.join(ROOT, '_site', 'lib', 'runtime-endpoint.js'));
  const evidence = {
    caseId: 'SYS-005', lane: 'P-LIFECYCLE-NEGATIVE-R51', mode: 'REAL_CLI_REAL_HOOK_OWN_BLOCKER',
    startedAt: new Date().toISOString(),
    isolation: { laneTmp: lane.laneTmp, env: lane.envIsolationResolved },
    realPortsNeverTouched: REAL_PORTS,
    commands: [],
  };
  const record = (command, exitCode, stdoutTail, stderrTail) => {
    evidence.commands.push({ command, exitCode, stdoutTail: String(stdoutTail || '').split(/\r?\n/).slice(-8).join('\n').slice(0, 1200), stderrTail: String(stderrTail || '').split(/\r?\n/).slice(-8).join('\n').slice(0, 1200) });
  };

  const dataA = path.join(lane.laneTmp, 'data-a');
  const dataB = path.join(lane.laneTmp, 'data-b');
  const repo = path.join(lane.laneTmp, 'repo');
  let blockerA = null; let blockerB = null;
  let childA = null; let childB = null;
  try {
    const P = await pickPlanPort({ needNext: true });
    const P2 = await pickPlanPort({ needNext: false, exclude: [P] });
    const D = await pickPlanPort({ needNext: false, exclude: [P, P2] });
    blockerA = startBlocker(); await blockerA.listen(P);
    blockerB = startBlocker(); await blockerB.listen(P2);
    // Re-verify the whole fallback window right before the CLI spawn: our own
    // fixtures (and only ours) may occupy P; P+1..P+3 must be genuinely free.
    assert.ok(await tcpFree('127.0.0.1', P + 1) && await tcpFree('127.0.0.1', P + 2) && await tcpFree('127.0.0.1', P + 3), 'fallback window P+1..P+3 must be free of own fixtures before the CLI run');
    assert.equal(await tcpFree('127.0.0.1', P), false, 'blocker must own P');
    evidence.portPlan = {
      P, P2, deadFallbackPort: D,
      note: `P and P2 are verified-free high ports occupied FIRST by OWN blocker listeners (sockets counted, HTTP 409 answered); planned >=25 apart so no own fixture sits in P's fallback window; D is a verified-free port with nothing listening (harmless hook fallback target); none of ${REAL_PORTS.join('/')} involved`,
      windowFreeBeforeSpawn: { pPlus1: true, pPlus2: true, pPlus3: true },
    };

    // ---- Leg A: implicit KB_SITE_PORT=P on an OWN-occupied port ----
    const envA = { ...process.env, KB_SITE_PORT: String(P), KB_MODULES_AUTOSTART: '0', KB_MODULES_REGISTER: '0', KB_TERMINAL_URL: 'http://127.0.0.1:0', KB_VECTORHUB_URL: 'http://127.0.0.1:0', KB_EVENTBRIDGE_URL: 'http://127.0.0.1:0', KB_KNOWLEDGE_ENGINE_URL: 'http://127.0.0.1:0' };
    const cmdA = [path.join(ROOT, 'bin', 'project-knowledge.js'), 'start', '--data', dataA, '--no-open', '--fg'];
    childA = spawn(process.execPath, cmdA, { cwd: ROOT, env: envA, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let outA = ''; let errA = '';
    childA.stdout.on('data', c => { outA += c; });
    childA.stderr.on('data', c => { errA += c; });
    evidence.legA = { command: `node bin/project-knowledge.js start --data <own dataA> --no-open --fg (env KB_SITE_PORT=${P}, implicit port, occupied by OWN blocker)`, pid: childA.pid, startedAt: new Date().toISOString() };
    const listening = await new Promise(resolve => {
      const deadline = Date.now() + 60000;
      const poll = setInterval(() => {
        const match = /Listening at http:\/\/([\d.]+):(\d+)/.exec(outA);
        if (match) { clearInterval(poll); resolve({ host: match[1], port: Number(match[2]) }); }
        else if (childA.exitCode !== null || Date.now() > deadline) { clearInterval(poll); resolve(null); }
      }, 200);
    });
    assert.ok(listening, `leg A CLI did not reach Listening (exit=${childA.exitCode}) stdout=${outA.slice(-500)} stderr=${errA.slice(-500)}`);
    assert.ok(outA.includes(`(Port ${P} was busy, using`), `leg A must ANNOUNCE the fallback, got stdout: ${outA.slice(-500)}`);
    assert.equal(listening.port, P + 1, `implicit-port protocol must fall back to the first free port ${P + 1}, got ${listening.port}`);
    assert.notEqual(listening.port, P, 'must never reuse the conflicted port');
    const healthA = await fetchStatus(`http://127.0.0.1:${listening.port}/api/health`);
    assert.equal(healthA, 200, `fallback server /api/health must answer 200, got ${healthA}`);
    const recordA = endpointLib.readEndpoint(dataA);
    assert.ok(recordA, 'runtime-endpoint.json must exist after fallback startup');
    assert.equal(recordA.port, P + 1, `endpoint record must record the FALLBACK port, got ${recordA.port}`);
    assert.equal(recordA.pid, childA.pid, 'endpoint record must record the CLI server pid');
    assert.ok(recordA.startedAt, 'endpoint record must be startedAt-stamped');
    assert.ok(endpointLib.readLiveEndpoint(dataA), 'endpoint record must be LIVE');
    assert.deepEqual(blockerA.state.httpRequests, [], 'blocker on the conflicted port must receive ZERO HTTP requests');
    evidence.legA.result = {
      announcedFallback: true, listenPort: listening.port, healthStatus: healthA,
      endpointRecord: recordA, blockerSockets: blockerA.state.sockets, blockerHttpRequests: blockerA.state.httpRequests,
      stdoutTail: outA.split(/\r?\n/).filter(Boolean).slice(-6),
    };
    record('legA start (implicit occupied port)', null, outA, errA);

    // ---- Hook leg: real hook-trigger must deliver to the RECORDED endpoint ----
    fs.mkdirSync(repo, { recursive: true });
    const git = args => spawnSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, timeout: 15000 });
    let gitOut = '';
    for (const args of [['init', '-q'], ['config', 'user.name', 'r51-fixture'], ['config', 'user.email', 'r51@invalid'], ['add', '-A']]) {
      if (args[0] === 'add') fs.writeFileSync(path.join(repo, 'README.md'), '# r51 sys005 hook fixture\n');
      const r = git(args); if (r.status !== 0) gitOut += `git ${args.join(' ')} -> ${r.status}: ${r.stderr}`;
    }
    const commit = git(['commit', '-qm', 'r51 baseline']);
    const head = git(['rev-parse', 'HEAD']).stdout.trim();
    assert.equal(commit.status, 0, `fixture commit failed: ${commit.stderr}`);
    assert.ok(/^[0-9a-f]{40}$/.test(head), 'fixture repo must have a HEAD commit');
    evidence.hookFixture = { repo, head, gitIssues: gitOut || null };

    // Register the fixture project through the REAL product APIs first: the
    // real hook endpoint honestly answers 404 PROJECT_NOT_FOUND for unknown
    // projectIds, so acceptance requires a real import (dead module URLs are
    // fine — import registers the project with modules pending).
    const apiBase = `http://127.0.0.1:${listening.port}`;
    const jsonRequest = async (url, method, body) => {
      const response = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
      const text = await response.text();
      let parsed = null; try { parsed = JSON.parse(text); } catch {}
      return { status: response.status, body: parsed, raw: text.slice(0, 800) };
    };
    const knowledgeRoot = path.join(lane.laneTmp, 'knowledge-root');
    fs.mkdirSync(knowledgeRoot, { recursive: true });
    const settings = await jsonRequest(`${apiBase}/api/settings`, 'PATCH', { knowledge: { rootPath: knowledgeRoot } });
    assert.equal(settings.status, 200, `knowledge root PATCH failed: ${settings.raw}`);
    const brain = await jsonRequest(`${apiBase}/api/brain`, 'GET');
    assert.equal(brain.status, 200, `GET /api/brain failed: ${brain.raw}`);
    const brainId = brain.body && brain.body.brain && brain.body.brain.id;
    assert.ok(brainId, 'brain id must be readable');
    const imported = await jsonRequest(`${apiBase}/api/projects/import`, 'POST', {
      projectId: 'r51-sys005-probe', brainId, domainId: null, localPath: repo,
      knowledgePath: path.join(knowledgeRoot, 'project'), displayName: 'R51 Sys005 Fixture',
      knowledgeLanguage: 'zh-CN', confirmGitInit: true,
    });
    evidence.projectRegistration = { knowledgeRoot, brainId, importStatus: imported.status, importBodyHead: imported.raw };
    assert.ok(imported.status >= 200 && imported.status < 300, `project import failed (${imported.status}): ${imported.raw}`);

    const hookCmd = [path.join(ROOT, '_site', 'scripts', 'hook-trigger.js'), '--project-id', 'r51-sys005-probe', '--repo-root', repo, '--data-dir', dataA, '--host', '127.0.0.1', '--port', String(D)];
    const hookStarted = Date.now();
    const hook = spawnSync(process.execPath, hookCmd, { cwd: ROOT, encoding: 'utf8', windowsHide: true, env: { ...process.env }, timeout: 60000 });
    const hookMs = Date.now() - hookStarted;
    record(`node _site/scripts/hook-trigger.js --project-id r51-sys005-probe --repo-root <own repo> --data-dir <own dataA> --host 127.0.0.1 --port ${D} (dead fallback port)`, hook.status, hook.stdout, hook.stderr);
    assert.equal(hook.status, 0, `hook-trigger exited ${hook.status}: ${hook.stderr}`);
    assert.deepEqual(blockerA.state.httpRequests, [], 'hook must not touch the conflicted port');

    // Delivery proof lives in the OWN dataDir structured logs (component git-hook):
    const logHits = [];
    const walkLogs = dir => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const absolute = path.join(dir, entry.name);
        if (entry.isDirectory()) walkLogs(absolute);
        else {
          const text = fs.readFileSync(absolute, 'utf8');
          for (const line of text.split(/\r?\n/)) if (line.includes('hook.notification')) logHits.push({ file: path.relative(dataA, absolute), line: line.slice(0, 400) });
        }
      }
    };
    walkLogs(dataA);
    evidence.hookLeg = {
      fallbackPortWasDead: D, hookExitCode: hook.status, hookMs,
      notificationLines: logHits,
      blockerHttpRequestsAfterHook: blockerA.state.httpRequests,
    };
    const completed = logHits.filter(h => h.line.includes('hook.notification.completed'));
    const degraded = logHits.filter(h => h.line.includes('hook.notification.degraded'));
    const failed = logHits.filter(h => h.line.includes('hook.notification.failed'));
    assert.ok(completed.length > 0, `hook delivery must be COMPLETED against the recorded endpoint; log hits: ${JSON.stringify(logHits.slice(0, 4))}`);
    assert.equal(degraded.length, 0, `hook must not degrade when the record is live; degraded: ${JSON.stringify(degraded)}`);
    assert.equal(failed.length, 0, `hook delivery must be 2xx; failed: ${JSON.stringify(failed)}`);
    evidence.hookLeg.verdict = `delivered to the RECORDED endpoint ${recordA.host}:${recordA.port}: hook.notification.completed present, no degraded/failed; the fallback port ${D} had nothing listening and the conflicted port ${P} answered zero HTTP — a hardcoded-5757 or wrong-port implementation could not have produced a 2xx delivery`;

    // ---- Stop Leg A through the REAL stop protocol ----
    const stopCmd = [path.join(ROOT, 'bin', 'project-knowledge.js'), 'stop', '--data', dataA];
    const stop = spawnSync(process.execPath, stopCmd, { cwd: ROOT, encoding: 'utf8', windowsHide: true, env: { ...process.env }, timeout: 60000 });
    record('node bin/project-knowledge.js stop --data <own dataA>', stop.status, stop.stdout, stop.stderr);
    const exitA = await waitExit(childA, 20000);
    evidence.legA.stop = { cliExit: stop.status, cliStdout: (stop.stdout || '').trim(), serverExitCode: exitA, endpointAfterStop: endpointLib.readEndpoint(dataA) };
    assert.equal(stop.status, 0, `real CLI stop must succeed: ${stop.stderr}`);
    assert.equal(await fetchStatus(`http://127.0.0.1:${P + 1}/api/health`, 3000), null, 'fallback server must be gone after stop');

    // ---- Leg B: explicit --port on another OWN-occupied port (itemized actual) ----
    const envB = { ...process.env, KB_MODULES_AUTOSTART: '0', KB_MODULES_REGISTER: '0', KB_TERMINAL_URL: 'http://127.0.0.1:0', KB_VECTORHUB_URL: 'http://127.0.0.1:0', KB_EVENTBRIDGE_URL: 'http://127.0.0.1:0', KB_KNOWLEDGE_ENGINE_URL: 'http://127.0.0.1:0' };
    delete envB.KB_SITE_PORT;
    const cmdB = [path.join(ROOT, 'bin', 'project-knowledge.js'), 'start', '--data', dataB, '--no-open', '--fg', '--port', String(P2)];
    childB = spawn(process.execPath, cmdB, { cwd: ROOT, env: envB, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let outB = ''; let errB = '';
    childB.stdout.on('data', c => { outB += c; });
    childB.stderr.on('data', c => { errB += c; });
    const exitB = await waitExit(childB, 60000);
    record(`node bin/project-knowledge.js start --data <own dataB> --no-open --fg --port ${P2} (explicit port, occupied by OWN blocker)`, exitB, outB, errB);
    evidence.legB = {
      command: `start --fg --port ${P2} (occupied)`, pid: childB.pid, exitCode: exitB,
      announcedFallback: outB.includes('was busy, using'),
      stdoutTail: outB.split(/\r?\n/).filter(Boolean).slice(-6),
      stderrTail: errB.split(/\r?\n/).filter(Boolean).slice(-6),
      endpointRecordAfterFailure: endpointLib.readEndpoint(dataB),
      blockerHttpRequests: blockerB.state.httpRequests,
    };
    assert.ok(exitB !== 0 || outB.includes('Listening at'), 'unexpected: explicit occupied --port neither failed nor listened (record actual)');
    if (exitB !== 0) {
      assert.ok(/EADDRINUSE|busy|failed|错误|失败/i.test(outB + errB), `explicit-port failure must state the reason, got: ${(outB + errB).slice(-400)}`);
      evidence.legB.verdict = `REFUSAL/ERROR contract (no silent fallback): exit ${exitB} without a fallback announcement; failure reason captured verbatim`;
    } else {
      evidence.legB.verdict = `actual explicit --port behavior differed (listened somewhere) — recorded verbatim for Leader itemization`;
    }

    evidence.verdict = {
      '端口冲突:隐式端口实际协议': `PASS - OWN blocker on verified-free high port ${P}; real CLI auto-fell back to ${P + 1} WITH the announced '(Port ${P} was busy, using ${P + 1} instead)' line; endpoint record + /api/health on the fallback port; zero HTTP to the conflicted port; stopped via the real stop protocol`,
      '端口冲突:显式--port合同(如实分项)': evidence.legB.verdict,
      'Hook使用记录端点非写死端口': `PASS - ${evidence.hookLeg.verdict}`,
      boundary: 'conflict ports are OWN high-port blockers, never the installed default 5757; freePort\'s all-20-busy error branch and same-data-dir PROJECT_BUSY 409 were NOT exercised here (r13/r16 evidence covers adjacent semantics)',
    };
    fs.writeFileSync(path.join(EVIDENCE, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
    console.log('QA-R51 SYS005 PORT-CONFLICT PASS');
    process.exitCode = 0;
  } catch (error) {
    evidence.verdict = { failed: String((error && error.stack) || error) };
    try { fs.writeFileSync(path.join(EVIDENCE, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n'); } catch {}
    console.error(`QA-R51 SYS005 PORT-CONFLICT FAIL: ${error.message}`);
    process.exitCode = 1;
  } finally {
    const uncleared = [];
    if (childA && childA.exitCode === null) { try { childA.kill(); } catch {} uncleared.push(`legA child pid ${childA.pid} force-killed after failed stop path`); }
    if (childB && childB.exitCode === null) { try { childB.kill(); } catch {} uncleared.push(`legB child pid ${childB.pid} force-killed`); }
    try { await blockerA?.close(); } catch { uncleared.push('blockerA close error'); }
    try { await blockerB?.close(); } catch { uncleared.push('blockerB close error'); }
    if (uncleared.length) { try { const e = JSON.parse(fs.readFileSync(path.join(EVIDENCE, 'evidence.json'), 'utf8')); e.unclearedItems = uncleared; fs.writeFileSync(path.join(EVIDENCE, 'evidence.json'), JSON.stringify(e, null, 2) + '\n'); } catch {} }
    lane.cleanup();
  }
}

main();
