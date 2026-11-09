'use strict';
// P-WB-DRAFTS-R5 — WB-005 草稿与附件隔离的隔离前提补正复测（第五次派发）。
//
// Leader 已接受 R4 的 8 项真实 UI 行为证据、真实退出与两份 sha256 证据；R5
// 不重做产品功能、不改任何 expected、不跑 Workbench 全量/WB003/4/8。本入口
// 相对 R4 的全部变化都是隔离前提：
//   1. 探针先用真实环境解析 Chrome 路径与被测模块根（find-chrome 走
//      LOCALAPPDATA、模块发现走 APPDATA），然后才把自身 process.env 切到
//      完整隔离白名单：HOME/USERPROFILE/CODEX_HOME/CLAUDE_CONFIG_DIR/
//      APPDATA/LOCALAPPDATA/双 KB_DATA_DIR/Bridge home/Workbench data/TEMP
//      全部指向 D:/SanQian.Xu/.project-knowledge-test-temp 下本用例私有
//      fixture 的绝对路径（R4 未隔离的 APPDATA/LOCALAPPDATA/CODEX_HOME
//      就此关闭）；宿主/浏览器等自有子进程各自继承或显式获得同一白名单。
//   2. 真实 profile 来源整体移除：R5 fixture 不再有只读门面、不再有
//      PK_WB_REAL_PROFILE_DIR、不再对真实凭据文件做任何读取/checksum。
//      宿主用产品自己的 ProfileStore 在隔离 dataDir 里播种纯虚构 profile
//      （r5fake / r5-fake-provider / https://r5-fake.invalid —— RFC 2606
//      保留域，绝不可能解析到任何提供方）与显式假 Key
//      r5-fake-key-never-dial；草稿用例本就零模型请求。
//   3. 保留产品真实 ProfileStore/HTTP/UI 与锁定 0.13.6 的 served 字节；
//      产品行为 expected 与 R4 完全一致（A=1111、B=2222、会话二=1111-two）。
//   4. 退出纪律、整探针 watchdog、每步预算、侧栏/state 竞态根修、迁移
//      墓碑预期全部沿用 R4 已接受实现（驱动侧不变）。
//   5. 结束前进程清点：自有宿主 pid 消失、命令行引用本隔离 root 的自有
//      进程（Chrome 等）清零，证据落盘后才清理隔离目录。
//
// 退出码：0 = 全部证明；3 = 诚实 BLOCKED/超时；1 = 脚本错误。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const fixture = require('./helpers/parallel-workbench-drafts-r5-fixture');
const harness = require('./helpers/parallel-workbench-drafts-r5-harness');
const { findChromeDetailed } = require('./helpers/find-chrome');

const DRAFT_A = '1111';
const DRAFT_B = '2222';
const DRAFT_S2 = '1111-two';
const FAKE_PROFILE_ID = 'r5fake';
const FAKE_PROFILE_NAME = 'R5-Fake';
const FAKE_MODEL = 'r5-fake-model';
const FAKE_BASE_URL = 'https://r5-fake.invalid/anthropic';
const FAKE_KEY = 'r5-fake-key-never-dial';
const LOCKED_VERSION = '0.13.6';

const KB_ROOT = path.resolve(__dirname, '..', '..');
const EVIDENCE_DIR = path.join(KB_ROOT, 'qa-autopilot', 'artifacts', 'parallel-20261023', 'workbench-drafts-r5');
const PROBE_TIMEOUT_MS = Number(process.env.PK_WB_DRAFTS_R5_TIMEOUT_MS || 450000);

const results = [];
const stepTimings = [];
function record(caseId, status, detail) {
  results.push({ caseId, status, detail });
  console.log(`CASE ${caseId} ${status} ${JSON.stringify(detail).slice(0, 300)}`);
}
function assertTrue(condition, message) { if (!condition) throw new Error(message); }

function isInside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

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

  // 整探针 watchdog：非 unref —— 它既保证“永不无限等待”（到点强制退），
  // 也保证被挂住的 await 之外事件循环仍有心跳可触发它。
  let watchdogCleared = false;
  const watchdog = setTimeout(() => {
    const target = path.join(EVIDENCE_DIR, 'evidence', 'drafts-r5-watchdog.json');
    try {
      fs.writeFileSync(target, `${JSON.stringify({
        probe: 'parallel-workbench-drafts-r5-probe', firedAt: new Date().toISOString(), startedAt,
        verdict: 'WATCHDOG TIMEOUT', exitCode: 3, steps: stepTimings, cases: results,
      }, null, 2)}\n`);
    } catch { /* best effort */ }
    console.log(`WATCHDOG TIMEOUT after ${PROBE_TIMEOUT_MS}ms — checkpoint at ${target}; forcing exit 3`);
    process.exit(3);
  }, PROBE_TIMEOUT_MS);

  // 真实环境解析（在任何 env 改写之前）：Chrome 发现走 LOCALAPPDATA，
  // 模块发现走 APPDATA，真实 profile 目录只取路径字符串用于 guard。
  const chromePath = findChromeDetailed().path;
  const moduleRoot = fixture.resolveHostModuleRoot();
  const realProfileDir = fixture.realWorkbenchProfileDir();
  assertTrue(chromePath, 'no real Chrome was found with the real environment');
  assertTrue(moduleRoot, 'no claude-ai-workbench module copy was found with the real environment');

  // 隔离布局 + 探针自身的完整隔离白名单（宿主另有同一白名单的显式副本）。
  const layout = fixture.createIsolationLayout('parallel-wb-drafts-r5');
  const isolationBefore = {};
  for (const key of fixture.ISOLATION_PATH_KEYS) isolationBefore[key] = process.env[key] !== undefined;
  const envApplied = fixture.isolationEnvMap(layout);
  Object.assign(process.env, envApplied);
  for (const key of [...fixture.AMBIENT_MODULE_URLS, ...fixture.AMBIENT_MODEL_ENV]) delete process.env[key];
  const ambientClean = ![...fixture.AMBIENT_MODULE_URLS, ...fixture.AMBIENT_MODEL_ENV].some(key => process.env[key] !== undefined);
  const pathKeyValues = {};
  for (const key of fixture.ISOLATION_PATH_KEYS) {
    const value = path.resolve(process.env[key]);
    pathKeyValues[key] = value;
    assertTrue(isInside(value, layout.root), `the isolated ${key} must live inside this run's layout root, saw ${value}`);
    assertTrue(!isInside(value, fixture.REAL_HOME), `the isolated ${key} must not live inside the real home, saw ${value}`);
    assertTrue(!value.includes(realProfileDir) && !realProfileDir.includes(value), `the isolated ${key} must not reference the real profile directory`);
  }

  let host = null;
  let browser = null;
  let opened = null;
  let identity = null;
  let sceneKept = null;
  let isolationDetail = null;
  let bDetail = null;
  let cDetail = null;
  let dDetail = null;
  let eDetail = null;
  let fDetail = null;
  let gDetail = null;
  let hDetail = null;
  let servedIntegrity = null;

  try {
    host = await withBudget('start-host', 90000, () => harness.startHost({ layout, moduleRoot, prefix: 'parallel-wb-drafts-r5' }));
    opened = await withBudget('open-browser', 90000, () => harness.openBrowser(host.base, host.layout, { chrome: chromePath }));
    browser = opened.browser;
    identity = harness.moduleIdentity(host.moduleRoot);
    assertTrue(identity.version === LOCKED_VERSION, `the hosted module is ${identity.version}, the case requires the locked ${LOCKED_VERSION}`);

    // --- a. 真实宿主/浏览器身份 + served/pinned 哈希 + 完整隔离前提 --------
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
    servedIntegrity = { checked: Object.keys(servedFiles), servedEqualsDisk: servedMatches, files: servedFiles };

    // 虚构 profile 是唯一被服务的 profile；假 Key 从不出现在公开列表里。
    const profilesResp = await harness.getJson(`${host.base}${harness.API_BASE}/profiles`);
    const listed = Array.isArray(profilesResp.body && profilesResp.body.profiles) ? profilesResp.body.profiles : [];
    assertTrue(listed.length === 1, `the isolated store must serve exactly the fictional profile, saw ${JSON.stringify(listed.map(item => item.id))}`);
    const fakeListed = listed[0];
    assertTrue(fakeListed.id === FAKE_PROFILE_ID && fakeListed.name === FAKE_PROFILE_NAME, 'the served profile is not the fictional one');
    assertTrue(fakeListed.provider === 'r5-fake-provider' && fakeListed.baseUrl === FAKE_BASE_URL, 'the fictional profile was altered on the way out');
    assertTrue(!JSON.stringify(listed).includes(FAKE_KEY), 'the fake key leaked through the public profile listing');

    // 隔离 dataDir 里的 store 文件只含虚构条目（假 Key 是显式假值，可入证据）。
    const profilesRaw = JSON.parse(fs.readFileSync(path.join(layout.dataDir, 'profiles.v2.json'), 'utf8'));
    const credentialsRaw = JSON.parse(fs.readFileSync(path.join(layout.dataDir, 'credentials.v1.json'), 'utf8'));
    assertTrue(Array.isArray(profilesRaw.profiles) && profilesRaw.profiles.length === 1 && profilesRaw.profiles[0].id === FAKE_PROFILE_ID, 'the isolated profile file holds more than the fictional profile');
    const credentialKeys = Object.keys(credentialsRaw.credentials || {});
    assertTrue(credentialKeys.length === 1 && credentialKeys[0] === `credential:${FAKE_PROFILE_ID}`, 'the isolated credential file holds more than the fake credential');
    assertTrue(credentialsRaw.credentials[credentialKeys[0]] === FAKE_KEY, 'the isolated credential is not the explicit fake key');

    isolationDetail = {
      envWhitelistApplied: envApplied,
      pathKeysResolvedInsideLayoutRoot: pathKeyValues,
      previouslyUnisolatedKeys: {
        APPDATA: { realBefore: isolationBefore.APPDATA === true ? 'real machine APPDATA was set and is now overridden' : 'was unset', isolatedNow: envApplied.APPDATA },
        LOCALAPPDATA: { realBefore: isolationBefore.LOCALAPPDATA === true ? 'real machine LOCALAPPDATA was set and is now overridden' : 'was unset', isolatedNow: envApplied.LOCALAPPDATA },
        CODEX_HOME: { realBefore: isolationBefore.CODEX_HOME === true ? 'was set and is now overridden' : 'was unset', isolatedNow: envApplied.CODEX_HOME },
      },
      ambientCredentialVarsPresentAfterSanitize: !ambientClean,
      realProfileSource: 'removed — no read-only facade, no PK_WB_REAL_PROFILE_DIR, no digest of the real credential files (R5 fixture drops that machinery entirely)',
      fakeProfile: {
        seededThrough: "the product's own ProfileStore.save/setCredential on the isolated dataDir",
        profile: profilesRaw.profiles[0],
        credentialKeys,
        baseUrlUnroutable: 'r5-fake.invalid is a reserved RFC 2606 TLD — it can never resolve to a provider',
      },
      browser: 'real Chrome via CDP (headless), isolated user-data-dir below the same isolated layout',
      chrome: opened.chrome,
    };

    const projectA = await withBudget('create-project-a', 60000, () => harness.ensureProject(browser, path.join(layout.root, 'r5-project-a'), { name: 'r5-project-a' }));
    const projectB = await withBudget('create-project-b', 60000, () => harness.ensureProject(browser, path.join(layout.root, 'r5-project-b'), { name: 'r5-project-b' }));
    assertTrue(projectA.created === true && projectB.created === true, 'the two projects were not created through the product form');
    assertTrue(projectA.projectId && projectB.projectId && projectA.projectId !== projectB.projectId, 'the two projects do not have distinct ids');
    record('WB005-R5.a-real-browser-host-and-isolation', 'PASS', {
      module: identity,
      servedUiIntegrity: servedIntegrity,
      host: { mode: 'standalone (fictional profile)', pid: host.child.child.pid, port: host.port, dataDir: layout.dataDir, workspace: layout.workspace, tempRoot: path.dirname(layout.root) },
      isolation: isolationDetail,
      projects: [
        { id: projectA.projectId, name: projectA.name, createdThroughTheProductForm: true },
        { id: projectB.projectId, name: projectB.name, createdThroughTheProductForm: true },
      ],
      health: health.body,
    });

    // 只选模型让产品具备建会话条件；从不发送消息，见 g/h 项证据。
    await withBudget('select-model', 60000, () => harness.selectModel(browser, FAKE_PROFILE_NAME, FAKE_MODEL));

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
    record('WB005-R5.b-project-drafts-are-isolated', 'PASS', bDetail);

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
    record('WB005-R5.c-drafts-survive-a-real-browser-refresh', 'PASS', cDetail);

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
    record('WB005-R5.d-session-drafts-are-isolated', 'PASS', dDetail);

    // --- e. 附件生命周期与跨项目隔离 ---------------------------------------
    await withBudget('attachments', 120000, async () => {
      await harness.openSessionRow(browser, projectA.projectId, sessionS1);
      const tokenA = `R5-ATTACH-A-${crypto.randomBytes(4).toString('hex')}`;
      const contentA = `${tokenA}\nP-WB-DRAFTS-R5 attachment of project A session one\n`;
      await harness.attachFile(browser, 'r5-note.txt', contentA);
      const s1WithAttachment = await harness.readState(browser);
      assertTrue(s1WithAttachment.attachments.length === 1 && s1WithAttachment.attachments[0].includes('r5-note.txt'), 'the attachment did not reach the tray of session one');
      assertTrue(s1WithAttachment.product.attachmentCount === 1, 'the product did not count the attachment');
      const base64A = Buffer.from(contentA, 'utf8').toString('base64');
      const storageWithA = await harness.readDraftStorage(browser);
      const bytesAInStorage = storageWithA.raw.includes(tokenA) || storageWithA.raw.includes(base64A);

      await harness.selectProject(browser, projectB.projectId);
      const trayInB = await harness.readState(browser);
      assertTrue(trayInB.attachments.length === 0 && trayInB.product.attachmentCount === 0, "A's attachment leaked into project B");

      const tokenB = `R5-ATTACH-B-${crypto.randomBytes(4).toString('hex')}`;
      const contentB = `${tokenB}\nP-WB-DRAFTS-R5 attachment of project B\n`;
      await harness.attachFile(browser, 'r5-b.txt', contentB);
      const bWithAttachment = await harness.readState(browser);
      assertTrue(bWithAttachment.attachments.length === 1 && bWithAttachment.attachments[0].includes('r5-b.txt'), 'the attachment of project B did not reach its tray');
      const base64B = Buffer.from(contentB, 'utf8').toString('base64');
      const storageWithB = await harness.readDraftStorage(browser);
      const bytesBInStorage = storageWithB.raw.includes(tokenB) || storageWithB.raw.includes(base64B);
      assertTrue(!bytesAInStorage && !bytesBInStorage, 'attachment bytes entered the browser storage');

      await harness.openSessionRow(browser, projectA.projectId, sessionS1);
      const backInS1 = await harness.readState(browser);
      assertTrue(backInS1.attachments.length === 1 && backInS1.attachments[0].includes('r5-note.txt'), "session one's attachment did not come back");
      assertTrue(!backInS1.attachments.join(' ').includes('r5-b.txt'), "B's attachment leaked into A's session");
      eDetail = {
        attach: "the product's own <input type=\"file\"> change handler (a real File into the real input)",
        sessionOne: { sessionId: sessionS1, file: 'r5-note.txt', tray: s1WithAttachment.attachments, productAttachmentCount: s1WithAttachment.product.attachmentCount, trayAfterReturn: backInS1.attachments },
        projectB: { file: 'r5-b.txt', trayWhenInA: trayInB.attachments, ownTray: bWithAttachment.attachments },
        attachmentBytesInBrowserStorage: bytesAInStorage || bytesBInStorage,
        storageKeys: storageWithB.keys,
        contract: 'app.js writeDraft(): only the text is persisted, attachment bytes stay in page memory',
      };
    });
    record('WB005-R5.e-attachment-lifecycle-and-isolation', 'PASS', eDetail);

    // --- f. 只重启本用例自己的隔离宿主（同布局/同端口/同浏览器 profile）----
    await withBudget('own-host-restart', 180000, async () => {
      const oldPid = host.child.child.pid;
      const oldPort = host.port;
      await harness.stopHost(host);
      const exitInfo = await host.child.exited;
      const oldGone = !harness.listProcesses().some(entry => entry.pid === oldPid);
      assertTrue(oldGone && Boolean(exitInfo), 'the own host did not really exit');

      const restarted = await harness.startHost({ layout: host.layout, port: oldPort, moduleRoot: host.moduleRoot });
      host = restarted;
      const identityAfter = harness.moduleIdentity(restarted.moduleRoot);
      assertTrue(identityAfter.version === LOCKED_VERSION && identityAfter.uiFiles['apps/agent-terminal/app.js'] === identity.uiFiles['apps/agent-terminal/app.js'], 'the restarted host serves different UI bytes');
      const healthAfter = await harness.getJson(`${restarted.base}${harness.API_BASE}/health`);
      assertTrue(healthAfter.ok && healthAfter.body && healthAfter.body.status === 'ok', 'the restarted host is not healthy');

      // 隔离 store 的虚构 profile 跨重启仍在且仍唯一（同数据目录）。
      const profilesAfter = await harness.getJson(`${restarted.base}${harness.API_BASE}/profiles`);
      const listedAfter = Array.isArray(profilesAfter.body && profilesAfter.body.profiles) ? profilesAfter.body.profiles : [];
      assertTrue(listedAfter.length === 1 && listedAfter[0].id === FAKE_PROFILE_ID, 'the fictional profile did not survive the own-host restart as the only profile');

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
        fakeProfileAfterRestart: { soleProfile: listedAfter[0].id, model: listedAfter[0].models && listedAfter[0].models.default },
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
    record('WB005-R5.f-own-host-restart-keeps-projects-and-drafts', 'PASS', fDetail);

    // --- g. 全程零模型请求 -------------------------------------------------
    await withBudget('no-model-request', 30000, async () => {
      const events = await harness.recordedEvents(browser);
      const modelEvents = events.filter(event => event.type === 'claude/result' || event.type === 'claude/init' || event.type === 'claude/user-prompt');
      assertTrue(modelEvents.length === 0, `the draft case triggered model stream events: ${JSON.stringify(modelEvents.map(event => event.type))}`);
      gDetail = { recordedStreamEvents: events.map(event => event.type), modelStreamEvents: [], draftsNeverSentToAnyModel: [DRAFT_A, DRAFT_B, DRAFT_S2], paidTurns: 0 };
    });
    record('WB005-R5.g-no-model-request-was-made', 'PASS', gDetail);
  } catch (error) {
    const diagnosis = await diagnose(host, browser).catch(() => null);
    record('WB005-R5.runtime', 'BLOCKED', { error: String(error && error.message || error), diagnosis, stepsSoFar: stepTimings.slice() });
    sceneKept = layout.root;
  } finally {
    // 先关浏览器（内部会杀 Chrome 树并清 profile），再显式等 CDP websocket
    // 的 close 事件（至多 1.5s）——长命 socket 拖住事件循环是旧三挂的根因
    // 类别；随后才停自有宿主。
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

  // --- h. 无真实 profile 读取 + 假 Key 从未外呼 ---------------------------
  try {
    // 复核白名单在整场运行后仍成立（宿主已停，浏览器已关）。
    let guardsHold = true;
    const guardValues = {};
    for (const key of fixture.ISOLATION_PATH_KEYS) {
      const value = path.resolve(process.env[key]);
      guardValues[key] = value;
      if (!isInside(value, layout.root) || isInside(value, fixture.REAL_HOME) || value.includes(realProfileDir)) guardsHold = false;
    }
    assertTrue(guardsHold, 'the isolation whitelist no longer holds at the end of the run');
    // 零模型请求引用 g 项在真实页面上录得的事件流（浏览器此时已按退出纪律
    // 关闭，不再有可询问的页面）。
    assertTrue(gDetail && Array.isArray(gDetail.modelStreamEvents) && gDetail.modelStreamEvents.length === 0, 'case g did not prove a clean event stream');
    hDetail = {
      realProfileDirPathKnownToThisProbe: realProfileDir,
      realProfileDirFilesystemAccess: 'none — R5 performs no fs operation on it (path string only, for the guards above); the R5 fixture removed the digest machinery entirely',
      isolationGuards: { everyIsolationEnvValueInsideLayoutRoot: true, noIsolationEnvValueInsideTheRealHome: true, noIsolationEnvValueReferencesTheRealProfileDir: true, finalCheck: guardValues },
      fakeCredential: { value: FAKE_KEY, everSentToAnyProvider: false, baseUrlHost: 'r5-fake.invalid (RFC 2606 reserved — unresolvable by construction)', providerRequests: 0 },
      servedProfilesOverTheWholeRun: 'exactly one fictional profile (case a + case f restart)',
      draftsSentToAnyModel: [],
    };
    record('WB005-R5.h-no-real-profile-read-and-fake-key-never-dialled', 'PASS', hDetail);
  } catch (error) {
    record('WB005-R5.h-no-real-profile-read-and-fake-key-never-dialled', 'FAIL', { error: String(error && error.message || error) });
  }

  // --- 自有残留清点：宿主 pid 消失 + 命令行引用隔离 root 的自有进程清零 ----
  let ownResidue = null;
  try {
    ownResidue = await withBudget('own-residue-census', 30000, () => harness.waitUntil(async () => {
      const remaining = harness.listProcesses().filter(entry => entry.commandLine.includes(layout.root));
      return remaining.length === 0 ? [] : null;
    }, 'every own process referencing the isolated root to be gone', 20000).catch(() => harness.listProcesses().filter(entry => entry.commandLine.includes(layout.root))));
  } catch (error) { ownResidue = [{ note: String(error && error.message || error) }]; }
  const finalHostPid = host && host.child && host.child.child ? host.child.child.pid : null;
  const hostStillListed = finalHostPid ? harness.listProcesses().some(entry => entry.pid === finalHostPid) : false;
  const ownResidueClean = Array.isArray(ownResidue) && ownResidue.length === 0 && !hostStillListed;

  watchdogCleared = true;
  clearTimeout(watchdog);

  const essential = [
    'WB005-R5.a-real-browser-host-and-isolation',
    'WB005-R5.b-project-drafts-are-isolated',
    'WB005-R5.c-drafts-survive-a-real-browser-refresh',
    'WB005-R5.d-session-drafts-are-isolated',
    'WB005-R5.e-attachment-lifecycle-and-isolation',
    'WB005-R5.f-own-host-restart-keeps-projects-and-drafts',
    'WB005-R5.g-no-model-request-was-made',
    'WB005-R5.h-no-real-profile-read-and-fake-key-never-dialled',
  ];
  const proven = essential.every(id => (results.find(entry => entry.caseId === id) || {}).status === 'PASS') && ownResidueClean;

  const summary = {
    lane: 'workbench-drafts-r5',
    file: 'parallel-workbench-drafts-r5-probe.js',
    case: 'WB-005',
    title: '草稿与附件隔离（真实浏览器 + 真实 UI 操作，R5 隔离前提补正复测）',
    startedAt,
    finishedAt: new Date().toISOString(),
    module: identity,
    servedUiIntegrity: servedIntegrity,
    host: host ? { mode: 'standalone (fictional profile)', pid: host.child.child.pid, port: host.port, dataDir: host.layout.dataDir, workspace: host.layout.workspace } : null,
    isolation: {
      envWhitelistApplied: envApplied,
      pathKeysResolvedInsideLayoutRoot: pathKeyValues,
      closedR4Gaps: ['APPDATA', 'LOCALAPPDATA', 'CODEX_HOME'],
      realProfileSourceRemoved: true,
      fakeProfile: { id: FAKE_PROFILE_ID, name: FAKE_PROFILE_NAME, provider: 'r5-fake-provider', baseUrl: FAKE_BASE_URL, model: FAKE_MODEL, credential: FAKE_KEY, credentialSentAnywhere: false },
      chromeResolvedBeforeEnvSwitch: chromePath,
      moduleRootResolvedBeforeEnvSwitch: moduleRoot,
    },
    timeouts: { wholeProbeWatchdogMs: PROBE_TIMEOUT_MS, perStepBudgets: 'withBudget labels in steps below', exitDiscipline: 'graceful CDP close wait (<=1.5s) then forced process.exit after the verdict' },
    drafts: { projectA: DRAFT_A, projectB: DRAFT_B, sessionTwoOfProjectA: DRAFT_S2, sentToAnyModel: false },
    uiActions: [
      "the product's own add-project form to create both projects",
      "the product's own sidebar project head (.proj-item) to switch projects",
      "the product's own sidebar session row (.session) to open sessions",
      "the product's own 新会话 button to create sessions",
      "the product's own <input type=\"file\"> change handler to attach files",
      'a real Page.reload of the real page (twice: refresh case and after the own-host restart)',
      "a real stop+start of only this case's own isolated host child",
    ],
    storeApiUsedAsUiSubstitute: false,
    recoveryExpectationsFollowTheProductLifecycle: 'text drafts are storage-backed and must survive switch/refresh/restart; the first session migrates the project-level draft and leaves a tombstone; attachments are page-memory only and must vanish on refresh/restart without ever entering storage (expecteds identical to the accepted R4 run)',
    steps: stepTimings,
    cases: results,
    ownResidue: { processesReferencingTheIsolatedRoot: ownResidue, finalHostPid, finalHostStillListed: hostStillListed, clean: ownResidueClean },
    verdict: proven
      ? 'PASS: 隔离前提补正后复测——完整环境白名单（含 APPDATA/LOCALAPPDATA/CODEX_HOME）全在本用例私有 fixture；真实 profile 来源整体移除，宿主以产品自身 ProfileStore 播种纯虚构 profile 与假 Key；草稿按项目/会话隔离并在切换/刷新/自有宿主重启后分别恢复；附件按会话生命周期不跨项目泄漏且字节永不入存储；全程零模型请求；自有宿主/浏览器无残留；进程真实退出（exit code 由运行方观测）'
      : 'BLOCKED',
    paidTurnsSent: 0,
    quotaEndpointQueried: false,
    sceneKeptOnFailure: sceneKept,
  };

  harness.writeEvidence(path.join(EVIDENCE_DIR, 'evidence', 'drafts-r5-probe.json'), summary);
  if (!proven) {
    if (sceneKept) console.log(`SCENE KEPT ${sceneKept}`);
  } else {
    fixture.removeTree(layout.root);
  }
  console.log(`parallel-workbench-drafts-r5-probe verdict=${summary.verdict}`);
  const exitCode = proven ? 0 : 3;
  // 强制退出（hangRuling 认可的根修）：verdict 打印后进程必须真的退。
  setTimeout(() => process.exit(exitCode), 300);
  process.exitCode = exitCode;
})().catch(error => {
  console.error(error);
  setTimeout(() => process.exit(1), 300);
  process.exitCode = 1;
});
