'use strict';
// P-WB-DRAFTS-R4 — WB-005 草稿与附件隔离的真实 UI 收尾验收（第四次派发）。
//
// 前三次从未通过（报告 hangRuling：最后一次打印了全部 PASS 但进程不退出，
// 判 HUNG；更早两次分别是宿主重启后的侧栏竞态与 state 全局竞态，一次是
// 驱动对项目级草稿的错误预期）。本入口相对旧驱动的变化，全部是驱动侧：
//   1. 退出纪律：verdict 打印后先等 CDP websocket 的 close 事件（至多
//      1.5s），随后无条件强制 process.exit —— 旧驱动只设 exitCode，长命
//      句柄（CDP websocket close 握手未完成）把事件循环拖住，这就是三挂
//      的根因类别（hangRuling 认可 force-exit after the verdict）。
//   2. 整探针 watchdog（非 unref，450s）：超时写 checkpoint 证据后强制
//      exit 3，绝不无限等待；每个子步骤再套独立预算，超时抛 STEP TIMEOUT。
//   3. Page.reload / 宿主重启之后，先等侧栏真实渲染出两个项目行、产品
//      state.projects 就绪，再点击（旧 08:14/08:17 竞态的根修）。
//   4. 先记录 source/pinned/served 三份 UI 哈希与进程/数据身份，served
//      与磁盘不一致即 BLOCKED。
//   5. 草稿文本按派发原文：A=1111、B=2222；会话二独立草稿 1111-two。
//   6. 恢复预期按产品真实生命周期（apps/agent-terminal/app.js）：
//      文本草稿走 localStorage（切换/刷新/重启都恢复）；首个会话创建时
//      项目级草稿迁入该会话、项目级留空墓碑；附件字节只进页面内存
//      （切换/返回恢复，刷新/重启后按设计消失），且永不进入存储。
// 不调用 store API 代替 UI 行为；不发送任何模型请求（1111/2222 绝不出现在
// 任何模型请求里）；不动安装模块，只重启本用例自有隔离宿主。
//
// 退出码：0 = 全部证明；3 = 诚实 BLOCKED/超时；1 = 脚本错误。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const fixture = require('./helpers/parallel-workbench-fixture');
const harness = require('./helpers/parallel-workbench-runtime-harness');

const DRAFT_A = '1111';
const DRAFT_B = '2222';
const DRAFT_S2 = '1111-two';
const PROFILE_ID = String(process.env.PK_WB_MODEL_PROFILE || 'minimax');
const REQUESTED_MODEL = String(process.env.PK_WB_MODEL_ID || 'MiniMax-M3.1-Flash');
const LOCKED_VERSION = '0.13.6';

const KB_ROOT = path.resolve(__dirname, '..', '..');
const EVIDENCE_DIR = path.join(KB_ROOT, 'qa-autopilot', 'artifacts', 'parallel-20261023', 'workbench-drafts-r4');
const PROBE_TIMEOUT_MS = Number(process.env.PK_WB_DRAFTS_R4_TIMEOUT_MS || 450000);

const results = [];
const stepTimings = [];
function record(caseId, status, detail) {
  results.push({ caseId, status, detail });
  console.log(`CASE ${caseId} ${status} ${JSON.stringify(detail).slice(0, 300)}`);
}
function assertTrue(condition, message) { if (!condition) throw new Error(message); }

// 每步骤独立预算：waitUntil 自身的超时管“条件迟迟不满足”，预算管
// “evaluate/fetch 本身挂死”这类 waitUntil 管不到的等待。
async function withBudget(label, budgetMs, fn) {
  const started = Date.now();
  let timer = null;
  try {
    const value = await Promise.race([
      fn(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`STEP TIMEOUT: ${label} exceeded its ${budgetMs}ms budget`)), budgetMs);
      }),
    ]);
    stepTimings.push({ step: label, ms: Date.now() - started, outcome: 'ok' });
    return value;
  } catch (error) {
    stepTimings.push({ step: label, ms: Date.now() - started, outcome: String(error && error.message || error).slice(0, 200) });
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function sha256Text(text) { return crypto.createHash('sha256').update(text, 'utf8').digest('hex'); }

async function waitSidebarProjects(browser, count) {
  return harness.waitUntil(async () => {
    const ids = await browser.evaluate("Array.from(document.querySelectorAll('#project-list .proj')).map(node => node.dataset.project)");
    return ids.length === count ? ids : null;
  }, `the sidebar to list ${count} projects`, 30000);
}

// 等产品自己的 input 处理器把草稿写进它自己的 localStorage 键（只读旁观，
// 不代写）：证明持久化发生在产品侧，后续的切换/刷新/重启恢复才是产品行为。
async function waitStorageDraft(browser, projectId, sessionId, text) {
  const key = JSON.stringify([projectId, sessionId || null]);
  return harness.waitUntil(async () => {
    const storage = await harness.readDraftStorage(browser);
    return storage.parsed && Object.prototype.hasOwnProperty.call(storage.parsed, key) && storage.parsed[key] === text;
  }, `the product to persist its own draft ${key} as ${JSON.stringify(text)}`, 15000);
}

// 挂起/失败归因快照：网络（宿主健康）、DOM（页面就绪度）、服务（进程存活）。
async function diagnose(host, browser) {
  const out = { at: new Date().toISOString() };
  if (host && host.base) {
    try {
      const health = await harness.getJson(`${host.base}${harness.API_BASE}/health`);
      out.hostHealth = { status: health.status, ok: health.ok, body: health.body };
    } catch (error) { out.hostHealth = { error: String(error && error.message || error).slice(0, 160) }; }
    if (host.child && host.child.child) {
      out.hostPid = host.child.child.pid;
      out.hostPidAlive = harness.listProcesses().some(entry => entry.pid === host.child.child.pid);
    }
  }
  if (browser) {
    try {
      out.page = await browser.evaluate("({ readyState: document.readyState, hasInput: !!document.getElementById('chat-input'), stateDefined: typeof state !== 'undefined' && !!state, sidebarProjects: document.querySelectorAll('#project-list .proj').length, composer: (document.getElementById('chat-input') || {}).value || '' })");
    } catch (error) { out.page = { error: String(error && error.message || error).slice(0, 200) }; }
  }
  return out;
}

(async () => {
  const startedAt = new Date().toISOString();
  fs.mkdirSync(path.join(EVIDENCE_DIR, 'evidence'), { recursive: true });
  const realProfilesBefore = fixture.digestDirectory(fixture.realWorkbenchProfileDir());

  // 整探针 watchdog：非 unref —— 它既保证“永不无限等待”（到点强制退），
  // 也保证被挂住的 await 之外事件循环仍有心跳可触发它。
  let watchdogCleared = false;
  const watchdog = setTimeout(() => {
    const target = path.join(EVIDENCE_DIR, 'evidence', 'drafts-r4-watchdog.json');
    try {
      fs.writeFileSync(target, `${JSON.stringify({
        probe: 'parallel-workbench-drafts-r4-probe', firedAt: new Date().toISOString(), startedAt,
        verdict: 'WATCHDOG TIMEOUT', exitCode: 3, steps: stepTimings, cases: results,
      }, null, 2)}\n`);
    } catch { /* best effort */ }
    console.log(`WATCHDOG TIMEOUT after ${PROBE_TIMEOUT_MS}ms — checkpoint at ${target}; forcing exit 3`);
    process.exit(3);
  }, PROBE_TIMEOUT_MS);

  let host = null;
  let browser = null;
  let opened = null;
  let identity = null;
  let sceneKept = null;
  let bDetail = null;
  let cDetail = null;
  let dDetail = null;
  let eDetail = null;
  let fDetail = null;
  let gDetail = null;

  try {
    host = await withBudget('start-host', 90000, () => harness.startHost({ prefix: 'parallel-wb-drafts-r4' }));
    opened = await withBudget('open-browser', 90000, () => harness.openBrowser(host.base, host.layout));
    browser = opened.browser;
    identity = harness.moduleIdentity(host.moduleRoot);
    assertTrue(identity.version === LOCKED_VERSION, `the hosted module is ${identity.version}, the case requires the locked ${LOCKED_VERSION}`);

    // --- a. 真实宿主/浏览器身份：source(pinned disk) vs served 哈希一致 ----
    const health = await harness.getJson(`${host.base}${harness.API_BASE}/health`);
    assertTrue(health.ok && health.body && health.body.status === 'ok', 'the isolated host is not healthy');
    const servedFiles = {};
    for (const rel of ['app.js', 'index.html']) {
      const response = await fetch(`${host.base}/agent-terminal/${rel}`, { signal: AbortSignal.timeout(10000) });
      const text = await response.text();
      servedFiles[rel] = {
        httpStatus: response.status,
        servedSha256: sha256Text(text),
        diskSha256: harness.sha256File(path.join(host.moduleRoot, 'apps', 'agent-terminal', rel)),
      };
    }
    const servedMatches = Object.values(servedFiles).every(file => file.httpStatus === 200 && file.servedSha256 && file.servedSha256 === file.diskSha256);
    assertTrue(servedMatches, 'the served agent-terminal UI is not byte-identical to the hosted module files');

    const projectA = await withBudget('create-project-a', 60000, () => harness.ensureProject(browser, path.join(host.layout.root, 'r4-project-a'), { name: 'r4-project-a' }));
    const projectB = await withBudget('create-project-b', 60000, () => harness.ensureProject(browser, path.join(host.layout.root, 'r4-project-b'), { name: 'r4-project-b' }));
    assertTrue(projectA.created === true && projectB.created === true, 'the two projects were not created through the product form');
    assertTrue(projectA.projectId && projectB.projectId && projectA.projectId !== projectB.projectId, 'the two projects do not have distinct ids');
    record('WB005-R4.a-real-browser-and-host', 'PASS', {
      browser: 'real Chrome via CDP (headless), isolated user-data-dir below the isolated layout',
      chrome: opened.chrome,
      module: identity,
      servedUiIntegrity: { checked: Object.keys(servedFiles), servedEqualsDisk: servedMatches, files: servedFiles },
      host: { mode: 'standalone', pid: host.child.child.pid, port: host.port, dataDir: host.layout.dataDir, workspace: host.layout.workspace, tempRoot: path.dirname(host.layout.root) },
      projects: [
        { id: projectA.projectId, name: projectA.name, createdThroughTheProductForm: true },
        { id: projectB.projectId, name: projectB.name, createdThroughTheProductForm: true },
      ],
      health: health.body,
    });

    // 只选模型让产品具备建会话条件；从不发送消息，见 g 项证据。
    const profiles = await harness.getJson(`${host.base}${harness.API_BASE}/profiles`);
    const listed = Array.isArray(profiles.body && profiles.body.profiles) ? profiles.body.profiles : [];
    const profile = listed.find(item => item.id === PROFILE_ID) || null;
    assertTrue(profile, `the ${PROFILE_ID} profile is not visible through the read-only facade`);
    await withBudget('select-model', 60000, () => harness.selectModel(browser, profile.name, REQUESTED_MODEL));

    // --- b. 项目级草稿：A=1111、B=2222，产品侧边栏切换各自恢复 ------------
    await withBudget('project-drafts', 90000, async () => {
      await harness.selectProject(browser, projectA.projectId);
      await harness.typeText(browser, DRAFT_A);
      await waitStorageDraft(browser, projectA.projectId, null, DRAFT_A);
      await harness.selectProject(browser, projectB.projectId);
      const firstEntryB = await harness.readState(browser);
      assertTrue(firstEntryB.inputValue === '', `project B must start with an empty composer, saw ${JSON.stringify(firstEntryB.inputValue)}`);
      await harness.typeText(browser, DRAFT_B);
      await waitStorageDraft(browser, projectB.projectId, null, DRAFT_B);
      await harness.selectProject(browser, projectA.projectId);
      const backInA = await harness.readState(browser);
      assertTrue(backInA.inputValue === DRAFT_A, `project A did not restore its draft: ${JSON.stringify(backInA.inputValue)}`);
      await harness.selectProject(browser, projectB.projectId);
      const backInB = await harness.readState(browser);
      assertTrue(backInB.inputValue === DRAFT_B, `project B did not restore its draft: ${JSON.stringify(backInB.inputValue)}`);
      assertTrue(!backInA.inputValue.includes(DRAFT_B) && !backInB.inputValue.includes(DRAFT_A), 'a project draft leaked across projects');
      bDetail = {
        switch: "the product's own sidebar project head (.proj-item), a real click",
        projectA: { id: projectA.projectId, draft: DRAFT_A, composerAfterSwitchBack: backInA.inputValue },
        projectB: { id: projectB.projectId, draft: DRAFT_B, composerOnFirstEntry: firstEntryB.inputValue, composerAfterSwitchBack: backInB.inputValue },
        crossLeak: backInA.inputValue.includes(DRAFT_B) || backInB.inputValue.includes(DRAFT_A),
        persistedByTheProduct: true,
      };
    });
    record('WB005-R4.b-project-drafts-are-isolated', 'PASS', bDetail);

    // --- c. 真实浏览器刷新后项目级草稿恢复（此时还没有任何会话）-----------
    await withBudget('refresh-project-drafts', 60000, async () => {
      await harness.reloadPage(browser);
      await waitSidebarProjects(browser, 2);
      await harness.selectProject(browser, projectA.projectId);
      const aAfter = await harness.readState(browser);
      assertTrue(aAfter.inputValue === DRAFT_A, `project A draft lost after refresh: ${JSON.stringify(aAfter.inputValue)}`);
      await harness.selectProject(browser, projectB.projectId);
      const bAfter = await harness.readState(browser);
      assertTrue(bAfter.inputValue === DRAFT_B, `project B draft lost after refresh: ${JSON.stringify(bAfter.inputValue)}`);
      cDetail = {
        refresh: 'a real Page.reload; the sidebar re-rendered both projects before any click',
        composerInProjectAAfterRefresh: aAfter.inputValue,
        composerInProjectBAfterRefresh: bAfter.inputValue,
        storageKeysAfterRefresh: (await harness.readDraftStorage(browser)).keys,
      };
    });
    record('WB005-R4.c-drafts-survive-a-real-browser-refresh', 'PASS', cDetail);

    // --- d. 同一项目两个会话的草稿隔离 -------------------------------------
    let sessionS1 = null;
    let sessionS2 = null;
    await withBudget('session-drafts', 120000, async () => {
      await harness.selectProject(browser, projectA.projectId);
      await harness.clickNewSession(browser);
      const s1State = await harness.waitForState(browser, state => state.product && state.product.activeSessionId, 'the first session of project A', 30000);
      sessionS1 = s1State.product.activeSessionId;
      // 首会话创建时产品把项目级草稿 1111 迁入该会话（app.js newSession）。
      const inS1 = await harness.readState(browser);
      assertTrue(inS1.inputValue === DRAFT_A, `the project draft did not migrate into the first session: ${JSON.stringify(inS1.inputValue)}`);
      const tombstone = await harness.readDraftStorage(browser);
      const tombstoneKey = JSON.stringify([projectA.projectId, null]);
      assertTrue(tombstone.parsed && tombstone.parsed[tombstoneKey] === '', 'the project-level entry must be an empty migration tombstone after the first session');

      await harness.clickNewSession(browser);
      const s2State = await harness.waitForState(browser, state => state.product && state.product.activeSessionId && state.product.activeSessionId !== sessionS1, 'the second session of project A', 30000);
      sessionS2 = s2State.product.activeSessionId;
      const s2Fresh = await harness.readState(browser);
      assertTrue(s2Fresh.inputValue === '', `session two must start empty, saw ${JSON.stringify(s2Fresh.inputValue)}`);
      await harness.typeText(browser, DRAFT_S2);
      await waitStorageDraft(browser, projectA.projectId, sessionS2, DRAFT_S2);

      await harness.openSessionRow(browser, projectA.projectId, sessionS1);
      const backInS1 = await harness.readState(browser);
      assertTrue(backInS1.inputValue === DRAFT_A, `session one draft not restored: ${JSON.stringify(backInS1.inputValue)}`);
      assertTrue(!backInS1.inputValue.includes(DRAFT_S2), 'session two draft leaked into session one');
      await harness.openSessionRow(browser, projectA.projectId, sessionS2);
      const backInS2 = await harness.readState(browser);
      assertTrue(backInS2.inputValue === DRAFT_S2, `session two draft not restored: ${JSON.stringify(backInS2.inputValue)}`);
      assertTrue(backInS2.inputValue !== DRAFT_A, 'session two must not hold session one draft (exact equality)');
      dDetail = {
        switch: "the product's own sidebar session row (.session), real clicks",
        projectId: projectA.projectId,
        migrationIntoFirstSession: { sessionId: sessionS1, composerAfterCreate: inS1.inputValue, projectLevelTombstone: true },
        sessionOne: { sessionId: sessionS1, draft: DRAFT_A, composerAfterReopen: backInS1.inputValue },
        sessionTwo: { sessionId: sessionS2, draft: DRAFT_S2, composerOnCreate: s2Fresh.inputValue, composerAfterReopen: backInS2.inputValue },
        sessionOneDraftLeakedIntoSessionTwo: s2Fresh.inputValue !== '',
        sessionTwoDraftLeakedIntoSessionOne: backInS1.inputValue === DRAFT_S2,
      };
    });
    record('WB005-R4.d-session-drafts-are-isolated', 'PASS', dDetail);

    // --- e. 附件生命周期与跨项目隔离 ---------------------------------------
    await withBudget('attachments', 120000, async () => {
      await harness.openSessionRow(browser, projectA.projectId, sessionS1);
      const tokenA = `R4-ATTACH-A-${crypto.randomBytes(4).toString('hex')}`;
      const contentA = `${tokenA}\nP-WB-DRAFTS-R4 attachment of project A session one\n`;
      await harness.attachFile(browser, 'r4-note.txt', contentA);
      const s1WithAttachment = await harness.readState(browser);
      assertTrue(s1WithAttachment.attachments.length === 1 && s1WithAttachment.attachments[0].includes('r4-note.txt'), 'the attachment did not reach the tray of session one');
      assertTrue(s1WithAttachment.product.attachmentCount === 1, 'the product did not count the attachment');
      const base64A = Buffer.from(contentA, 'utf8').toString('base64');
      const storageWithA = await harness.readDraftStorage(browser);
      const bytesAInStorage = storageWithA.raw.includes(tokenA) || storageWithA.raw.includes(base64A);

      await harness.selectProject(browser, projectB.projectId);
      const trayInB = await harness.readState(browser);
      assertTrue(trayInB.attachments.length === 0 && trayInB.product.attachmentCount === 0, "A's attachment leaked into project B");

      const tokenB = `R4-ATTACH-B-${crypto.randomBytes(4).toString('hex')}`;
      const contentB = `${tokenB}\nP-WB-DRAFTS-R4 attachment of project B\n`;
      await harness.attachFile(browser, 'r4-b.txt', contentB);
      const bWithAttachment = await harness.readState(browser);
      assertTrue(bWithAttachment.attachments.length === 1 && bWithAttachment.attachments[0].includes('r4-b.txt'), 'the attachment of project B did not reach its tray');
      const base64B = Buffer.from(contentB, 'utf8').toString('base64');
      const storageWithB = await harness.readDraftStorage(browser);
      const bytesBInStorage = storageWithB.raw.includes(tokenB) || storageWithB.raw.includes(base64B);
      assertTrue(!bytesAInStorage && !bytesBInStorage, 'attachment bytes entered the browser storage');

      await harness.openSessionRow(browser, projectA.projectId, sessionS1);
      const backInS1 = await harness.readState(browser);
      assertTrue(backInS1.attachments.length === 1 && backInS1.attachments[0].includes('r4-note.txt'), "session one's attachment did not come back");
      assertTrue(!backInS1.attachments.join(' ').includes('r4-b.txt'), "B's attachment leaked into A's session");
      eDetail = {
        attach: "the product's own <input type=\"file\"> change handler (a real File into the real input)",
        sessionOne: { sessionId: sessionS1, file: 'r4-note.txt', tray: s1WithAttachment.attachments, productAttachmentCount: s1WithAttachment.product.attachmentCount, trayAfterReturn: backInS1.attachments },
        projectB: { file: 'r4-b.txt', trayWhenInA: trayInB.attachments, ownTray: bWithAttachment.attachments },
        attachmentBytesInBrowserStorage: bytesAInStorage || bytesBInStorage,
        storageKeys: storageWithB.keys,
        contract: 'app.js writeDraft(): only the text is persisted, attachment bytes stay in page memory',
      };
    });
    record('WB005-R4.e-attachment-lifecycle-and-isolation', 'PASS', eDetail);

    // --- f. 只重启本用例自己的隔离宿主（同布局/同端口/同浏览器 profile）----
    await withBudget('own-host-restart', 180000, async () => {
      const oldPid = host.child.child.pid;
      const oldPort = host.port;
      await harness.stopHost(host);
      const exitInfo = await host.child.exited;
      const oldGone = !harness.listProcesses().some(entry => entry.pid === oldPid);
      assertTrue(oldGone && Boolean(exitInfo), 'the own host did not really exit');

      const restarted = await harness.startHost({ layout: host.layout, port: oldPort });
      host = restarted;
      const identityAfter = harness.moduleIdentity(restarted.moduleRoot);
      assertTrue(identityAfter.version === LOCKED_VERSION && identityAfter.uiFiles['apps/agent-terminal/app.js'] === identity.uiFiles['apps/agent-terminal/app.js'], 'the restarted host serves different UI bytes');
      const healthAfter = await harness.getJson(`${restarted.base}${harness.API_BASE}/health`);
      assertTrue(healthAfter.ok && healthAfter.body && healthAfter.body.status === 'ok', 'the restarted host is not healthy');

      await harness.reloadPage(browser);
      await waitSidebarProjects(browser, 2);
      const stateAfterRestart = await harness.waitForState(browser, state => state.product && state.product.projects.length === 2, 'both projects after the restart', 30000);

      await harness.selectProject(browser, projectB.projectId);
      const bAfter = await harness.readState(browser);
      assertTrue(bAfter.inputValue === DRAFT_B, `project B draft lost after the own-host restart: ${JSON.stringify(bAfter.inputValue)}`);
      assertTrue(bAfter.attachments.length === 0, 'a memory-backed attachment survived the restart or leaked into B');

      await harness.selectProject(browser, projectA.projectId);
      const aProjectAfter = await harness.readState(browser);
      assertTrue(aProjectAfter.inputValue === '', `project A project-level entry must stay the migration tombstone, saw ${JSON.stringify(aProjectAfter.inputValue)}`);
      await harness.openSessionRow(browser, projectA.projectId, sessionS1);
      const s1After = await harness.readState(browser);
      assertTrue(s1After.inputValue === DRAFT_A, `session one draft lost after the restart: ${JSON.stringify(s1After.inputValue)}`);
      await harness.openSessionRow(browser, projectA.projectId, sessionS2);
      const s2After = await harness.readState(browser);
      assertTrue(s2After.inputValue === DRAFT_S2, `session two draft lost after the restart: ${JSON.stringify(s2After.inputValue)}`);

      const storageFinal = await harness.readDraftStorage(browser);
      fDetail = {
        restart: "only this case's own isolated host child was stopped and restarted (same layout, same port, same browser profile)",
        oldHostPid: oldPid, oldHostExited: true, oldHostProcessStillListed: !oldGone, oldHostExitCode: exitInfo && exitInfo.code,
        newHostPid: restarted.child.child.pid, portKept: oldPort === restarted.port,
        healthAfterRestart: healthAfter.body,
        projectsAfterRestart: stateAfterRestart.product.projects.map(project => ({ id: project.id, name: project.name })),
        composerInProjectBAfterRestart: bAfter.inputValue,
        attachmentTrayInProjectBAfterRestart: bAfter.attachments,
        projectAProjectLevelAfterRestart: aProjectAfter.inputValue,
        projectAProjectLevelNote: 'the empty value is the migration tombstone the product itself wrote; the draft lives in session one',
        composerInSessionOneAfterRestart: s1After.inputValue,
        composerInSessionTwoAfterRestart: s2After.inputValue,
        storageKeysAfterRestart: storageFinal.keys,
      };
    });
    record('WB005-R4.f-own-host-restart-keeps-projects-and-drafts', 'PASS', fDetail);

    // --- g. 全程零模型请求 -------------------------------------------------
    await withBudget('no-model-request', 30000, async () => {
      const events = await harness.recordedEvents(browser);
      const modelEvents = events.filter(event => event.type === 'claude/result' || event.type === 'claude/init' || event.type === 'claude/user-prompt');
      assertTrue(modelEvents.length === 0, `the draft case triggered model stream events: ${JSON.stringify(modelEvents.map(event => event.type))}`);
      gDetail = { recordedStreamEvents: events.map(event => event.type), modelStreamEvents: [], draftsNeverSentToAnyModel: [DRAFT_A, DRAFT_B, DRAFT_S2], paidTurns: 0 };
    });
    record('WB005-R4.g-no-model-request-was-made', 'PASS', gDetail);
  } catch (error) {
    const diagnosis = await diagnose(host, browser).catch(() => null);
    record('WB005-R4.runtime', 'BLOCKED', { error: String(error && error.message || error), diagnosis, stepsSoFar: stepTimings.slice() });
    sceneKept = host ? host.layout.root : null;
  } finally {
    // 先关浏览器（内部会杀 Chrome 树并清 profile），再显式等 CDP websocket
    // 的 close 事件（至多 1.5s）——旧驱动不等这一步，close 握手未完成的长命
    // socket 拖住事件循环，进程永不退出。
    if (browser) {
      try { await browser.close(); } catch { /* disposable */ }
      try {
        await Promise.race([
          new Promise(resolve => { try { browser.socket.once('close', resolve); } catch { resolve(); } }),
          new Promise(resolve => setTimeout(resolve, 1500)),
        ]);
      } catch { /* best effort */ }
    }
    try { if (host && host.child) await harness.stopHost(host); } catch { /* best effort */ }
  }

  // 宿主已停（只读门面本就不写），对比真实 profile 目录字节级不变。
  const digestComparison = fixture.compareDigests(realProfilesBefore, fixture.digestDirectory(fixture.realWorkbenchProfileDir()));
  record('WB005-R4.h-real-profiles-byte-identical', digestComparison.byteIdentical ? 'PASS' : 'FAIL', {
    profileDir: fixture.realWorkbenchProfileDir(),
    comparison: 'byte-level SHA256, computed in memory; digests never printed, logged or persisted',
    fileCount: digestComparison.count,
    changedFiles: digestComparison.changedFiles,
    addedFiles: digestComparison.addedFiles,
    removedFiles: digestComparison.removedFiles,
  });

  watchdogCleared = true;
  clearTimeout(watchdog);

  const essential = [
    'WB005-R4.a-real-browser-and-host',
    'WB005-R4.b-project-drafts-are-isolated',
    'WB005-R4.c-drafts-survive-a-real-browser-refresh',
    'WB005-R4.d-session-drafts-are-isolated',
    'WB005-R4.e-attachment-lifecycle-and-isolation',
    'WB005-R4.f-own-host-restart-keeps-projects-and-drafts',
    'WB005-R4.g-no-model-request-was-made',
    'WB005-R4.h-real-profiles-byte-identical',
  ];
  const proven = essential.every(id => (results.find(entry => entry.caseId === id) || {}).status === 'PASS');

  const summary = {
    lane: 'workbench-drafts-r4',
    file: 'parallel-workbench-drafts-r4-probe.js',
    case: 'WB-005',
    title: '草稿与附件隔离（真实浏览器 + 真实 UI 操作，R4 收尾）',
    startedAt,
    finishedAt: new Date().toISOString(),
    module: identity,
    host: host ? { mode: 'standalone', pid: host.child.child.pid, port: host.port, dataDir: host.layout.dataDir, workspace: host.layout.workspace } : null,
    timeouts: { wholeProbeWatchdogMs: PROBE_TIMEOUT_MS, perStepBudgets: 'withBudget labels in steps below', exitDiscipline: 'graceful CDP close wait (<=1.5s) then forced process.exit after the verdict' },
    drafts: { projectA: DRAFT_A, projectB: DRAFT_B, sessionTwoOfProjectA: DRAFT_S2, sentToAnyModel: false },
    uiActions: [
      "the product's own add-project form to create both projects",
      "the product's own sidebar project head (.proj-item) to switch projects",
      "the product's own sidebar session row (.session) to open sessions",
      "the product's own 新会话 button to create sessions",
      "the product's own <input type=\"file\"> change handler to attach files",
      'a real Page.reload of the real page (twice: refresh case and after the own-host restart)',
      'a real stop+start of only this case\'s own isolated host child',
    ],
    storeApiUsedAsUiSubstitute: false,
    recoveryExpectationsFollowTheProductLifecycle: 'text drafts are storage-backed and must survive switch/refresh/restart; the first session migrates the project-level draft and leaves a tombstone; attachments are page-memory only and must vanish on refresh/restart without ever entering storage',
    steps: stepTimings,
    cases: results,
    verdict: proven
      ? 'PASS: 草稿按项目/会话隔离并在切换/刷新/自有宿主重启后分别恢复；附件按会话生命周期不跨项目泄漏且字节永不入存储；全程零模型请求；进程真实退出（exit code 由运行方观测）'
      : 'BLOCKED',
    paidTurnsSent: 0,
    quotaEndpointQueried: false,
    sceneKeptOnFailure: sceneKept,
  };

  harness.writeEvidence(path.join(EVIDENCE_DIR, 'evidence', 'drafts-r4-probe.json'), summary);
  if (!proven) {
    if (sceneKept) console.log(`SCENE KEPT ${sceneKept}`);
  } else if (host) {
    fixture.removeTree(host.layout.root);
  }
  console.log(`parallel-workbench-drafts-r4-probe verdict=${summary.verdict}`);
  const exitCode = proven ? 0 : 3;
  // 强制退出（hangRuling 认可的根修）：verdict 打印后进程必须真的退。
  setTimeout(() => process.exit(exitCode), 300);
  process.exitCode = exitCode;
})().catch(error => {
  console.error(error);
  setTimeout(() => process.exit(1), 300);
  process.exitCode = 1;
});
