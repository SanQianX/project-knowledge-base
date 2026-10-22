'use strict';
// 隔离与保护的可执行规则。/ Isolation and protection rules that can be executed and regression-tested.
//
// 这里不写“应当隔离”的声明，而是给出可被正反例执行的检查：
//   - productEnv / assertEnvIsolated：产品子进程的数据目录、模块 URL、端口、凭据。
//   - runtimeIdentity / assertRuntimeIdentity：运行实例的 version/pid/dataDir 是否仍是受保护的那个。
//   - snapshotProtected / diffProtected：受保护目标的身份与哈希前后对比。
//   - directoryManifest：静态安装产物的递归清单哈希。
//   - preflightSuite：执行前识别会碰到受保护端口或受保护路径的用例，具名例外按内容哈希绑定。
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const crypto = require('node:crypto');
const { hash, isolatedEnv } = require('./safety.cjs');

// 产品子进程必须重置的模块 URL。继承真实值会让隔离运行连上开发实例。
const MODULE_URL_KEYS = [
    'KB_KNOWLEDGE_ENGINE_URL', 'KB_EVENTBRIDGE_URL', 'KB_EVENT_BRIDGE_URL',
    'KB_TERMINAL_URL', 'KB_VECTORHUB_URL'
];
// 模块开关：产品用 `=== '0'` 判定关闭，所以置 '0'。
// 注意：AI_CODING_EVENT_BRIDGE_CAPTURE 不在这里关掉。它是 bridge 的采集总开关，
// 关掉会让 capture 用例（它要的就是采集）直接拿不到 turnId。真正的隔离手段是
// AI_CODING_EVENT_BRIDGE_HOME 落在隔离运行目录内，由 assertEnvIsolated 把关。
const MODULE_FLAG_KEYS = [
    'KB_MODULES_REGISTER', 'KB_MODULES_AUTOSTART'
];
// 模块命令与模块路径：产品用真值判定（`if (process.env.X)` / `.filter(Boolean)`），
// 置 '0' 仍是真值，会被当成“已配置显式命令”而走错分支——例如 vector-hub 的
// 规范分支会因此丢掉 VECTOR_HUB_ROOT，让 vector-storage-root-test 假失败。
// 必须置空串。
const MODULE_COMMAND_KEYS = [
    'KB_KNOWLEDGE_ENGINE_COMMAND', 'KB_EVENTBRIDGE_COMMAND', 'KB_TERMINAL_COMMAND',
    'KB_VECTORHUB_COMMAND', 'AI_CODING_EVENT_BRIDGE_MODULE', 'KB_WORKBENCH_RUNTIME_TOKEN'
];
// 绝不允许出现在产品子进程里的凭据。
const SECRET_ENV_KEYS = [
    'MINIMAX_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY',
    'QA_GATEWAY_TOKEN', 'KB_SITE_AUTH_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN', 'NPM_TOKEN'
];
// 产品内置的模块默认端口（module-bridge 的 defaultTerminalUrl 等）。
// QA 子进程绝不能指向它们：这些端口上跑着开发实例的真实模块。
const PRODUCT_DEFAULT_MODULE_PORTS = [5760, 8787, 8790, 5790];

// 重置后的模块 URL：指向一个合法但无人监听的回环地址。
//
// 端口 0 不能用：产品的 module-port-resolver 对模块 URL 要求端口在 1..65535，
// `http://127.0.0.1:0` 会被判为 INVALID_MODULE_URL，直接让产品用例抛错。
// 端口 1 是合法端口且默认无人监听（连接立即被拒），产品既不会连上真实模块，
// 也不会因为 URL 非法而改变自身行为。
const DEAD_MODULE_HOST = '127.0.0.1';
const DEAD_MODULE_PORT = 1;
const DEAD_MODULE_URL = 'http://' + DEAD_MODULE_HOST + ':' + DEAD_MODULE_PORT;

/** 指定端口的死地址；端口必须是 1..65535 的合法端口。 */
function deadModuleUrl(port = DEAD_MODULE_PORT) {
    const p = Number(port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error('DEAD_MODULE_PORT_INVALID: ' + port);
    return 'http://' + DEAD_MODULE_HOST + ':' + p;
}

function protectedSection(cfg) { return (cfg && cfg.protected) || {}; }
function normalize(target) { return path.resolve(String(target || '')).replace(/\\/g, '/').toLowerCase(); }

/** 受保护前缀（数据目录、知识根、全局 npm）与受保护文件。 */
function protectedPaths(cfg) {
    const prot = protectedSection(cfg);
    return {
        prefixes: [prot.dataDir, prot.knowledgeRoot, prot.globalNpmRoot].filter(Boolean).map(String),
        files: (prot.files || []).map(String)
    };
}

/** 目标路径是否落在受保护范围内。 */
function isProtectedPath(target, cfg) {
    if (!target) return false;
    const p = normalize(target);
    const { prefixes, files } = protectedPaths(cfg);
    for (const prefix of prefixes) {
        const n = normalize(prefix);
        if (p === n || p.startsWith(n + '/')) return true;
    }
    return files.map(normalize).includes(p);
}

/** 受保护端口：桌面后端端口与配置中登记的保留端口。 */
function protectedPorts(cfg) {
    const prot = protectedSection(cfg);
    const ports = [];
    if (prot.desktop && prot.desktop.port) ports.push(Number(prot.desktop.port));
    for (const p of prot.reservedPorts || []) ports.push(Number(p));
    return [...new Set(ports.filter(p => Number.isInteger(p) && p > 0))];
}

function moduleResets(deadPort = DEAD_MODULE_PORT) {
    const out = {};
    const url = deadModuleUrl(deadPort);
    for (const key of MODULE_URL_KEYS) out[key] = url;
    for (const key of MODULE_FLAG_KEYS) out[key] = '0';
    for (const key of MODULE_COMMAND_KEYS) out[key] = '';
    return out;
}

/**
 * 产品子进程的隔离环境。
 * 与 isolatedEnv 的区别：显式声明数据目录、显式重置模块 URL/开关、显式剔除凭据。
 * additions.KB_DEAD_MODULE_PORT 指定死地址端口（默认 1）；它不是环境变量，
 * 只用来构造模块 URL，不会传给产品子进程。
 */
function productEnv(cfg, runDir, additions = {}) {
    const extra = Object.assign({}, additions);
    const deadPort = Number(extra.KB_DEAD_MODULE_PORT || DEAD_MODULE_PORT);
    delete extra.KB_DEAD_MODULE_PORT;
    const env = Object.assign(isolatedEnv(runDir), moduleResets(deadPort), {
        KB_DATA_DIR: path.join(runDir, 'data'),
        KB_KNOWLEDGE_DATA_DIR: path.join(runDir, 'knowledge')
    });
    for (const key of SECRET_ENV_KEYS) delete env[key];
    for (const [key, value] of Object.entries(extra)) {
        if (SECRET_ENV_KEYS.includes(key)) throw new Error('ENV_FORBIDDEN: secret environment key refused: ' + key);
        env[key] = String(value);
    }
    return env;
}

/**
 * 隔离环境的可执行检查。返回违规列表而不是抛错，便于回归做正反例。
 * opts.runRoot 给定时，数据目录必须落在这个运行目录内。
 */
function assertEnvIsolated(env, cfg, opts = {}) {
    const violations = [];
    const runRoot = opts.runRoot ? normalize(opts.runRoot) : null;
    for (const key of ['KB_DATA_DIR', 'KB_KNOWLEDGE_DATA_DIR']) {
        const value = env[key];
        if (!value) { violations.push(key + ' 未设置'); continue; }
        if (isProtectedPath(value, cfg)) violations.push(key + ' 指向受保护路径: ' + value);
        if (runRoot) {
            const n = normalize(value);
            if (!(n === runRoot || n.startsWith(runRoot + '/'))) violations.push(key + ' 不在隔离运行目录内: ' + value);
        }
    }
    // 模块 URL 的安全属性是“合法但连不到真实模块”：回环地址、端口合法（产品要求
    // 1..65535，端口 0 会被判 INVALID_MODULE_URL）、且不是受保护端口。
    for (const key of MODULE_URL_KEYS) {
        const value = env[key];
        if (value === undefined) continue;
        let parsed = null;
        try { parsed = new URL(String(value)); } catch { violations.push(key + ' 不是合法 URL: ' + value); continue; }
        if (parsed.hostname !== DEAD_MODULE_HOST) violations.push(key + ' 未指向回环地址: ' + value);
        const p = Number(parsed.port);
        if (!Number.isInteger(p) || p < 1 || p > 65535) violations.push(key + ' 端口非法（产品会判 INVALID_MODULE_URL）: ' + value);
        else if (protectedPorts(cfg).includes(p)) violations.push(key + ' 占用受保护端口: ' + p);
        else if (PRODUCT_DEFAULT_MODULE_PORTS.includes(p)) violations.push(key + ' 指向产品的真实模块默认端口: ' + p);
    }
    // 命令与模块路径必须为假值：产品用真值判定，'0' 会被当成“已配置显式命令”。
    for (const key of MODULE_COMMAND_KEYS) {
        if (env[key]) violations.push(key + ' 未清空为假值: ' + env[key]);
    }
    for (const key of SECRET_ENV_KEYS) if (env[key]) violations.push(key + ' 泄漏到子进程环境');
    // bridge 采集保持开启（capture 用例要的就是采集），隔离靠 journal 落点：
    // AI_CODING_EVENT_BRIDGE_HOME 必须在隔离运行目录内，不能指向真实 journal。
    const bridgeHome = env.AI_CODING_EVENT_BRIDGE_HOME;
    if (!bridgeHome) violations.push('AI_CODING_EVENT_BRIDGE_HOME 未设置');
    else if (isProtectedPath(bridgeHome, cfg)) violations.push('AI_CODING_EVENT_BRIDGE_HOME 指向受保护路径: ' + bridgeHome);
    else if (runRoot) {
        const n = normalize(bridgeHome);
        if (!(n === runRoot || n.startsWith(runRoot + '/'))) violations.push('AI_CODING_EVENT_BRIDGE_HOME 不在隔离运行目录内: ' + bridgeHome);
    }
    const port = Number(env.KB_SITE_PORT || 0);
    if (port && protectedPorts(cfg).includes(port)) violations.push('KB_SITE_PORT 占用受保护端口: ' + port);
    return { ok: violations.length === 0, violations };
}

/** 取一个当前空闲的回环端口，供隔离运行独占。 */
function allocatePort(host = '127.0.0.1') {
    return new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.unref();
        probe.once('error', reject);
        probe.listen(0, host, () => {
            const port = probe.address().port;
            probe.close(() => resolve(port));
        });
    });
}

function fileHash(file) {
    try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
    catch { return null; }
}

/**
 * 真实可变目录的只读观察口径。
 *
 * 归属限制（重要）：运行中的桌面持续写自己的事件目录与日志，
 * 不做任何 QA 动作时这些目录也会变化。因此“目录变化”本身不构成 QA 越界的证据，
 * 本规则只提供可核对的观察口径，不宣称能拦住子目录内部的写入。
 * QA 侧真正的保护来自：隔离的数据目录（KB_DATA_DIR / KB_KNOWLEDGE_DATA_DIR）、
 * 被重置的模块 URL、独立端口，以及对真实写入/真实连接的拒绝。
 * 静态安装产物不在此列：它们不会被运行中的实例改写，见 directoryManifest。
 */
function directoryFingerprint(dir) {
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true })
            .filter(e => !e.isSymbolicLink())
            .map(e => ({ name: e.name, dir: e.isDirectory() }))
            .sort((a, b) => a.name.localeCompare(b.name));
        const files = entries.filter(e => !e.dir).map(e => {
            const volatile = /\.log$/i.test(e.name);
            return { name: e.name, volatile, sha256: volatile ? null : fileHash(path.join(dir, e.name)) };
        });
        const fingerprint = hash(JSON.stringify({ entries, files: files.map(f => [f.name, f.sha256]) }));
        return { exists: true, count: entries.length, entries, files, fingerprint };
    }
    catch (e) { return { exists: false, error: e.code || 'ERROR' }; }
}

/**
 * 静态安装目录的递归清单哈希。
 * 只用于静态安装产物（全局 npm 包）：这类文件不会被运行中的实例改写，
 * 因此可以递归覆盖到子目录，不存在“自身会变”的干扰。
 */
function directoryManifest(dir) {
    const files = [];
    const walk = (current, rel) => {
        let entries = [];
        try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
        for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            if (e.isSymbolicLink()) continue;
            const full = path.join(current, e.name);
            const r = rel ? rel + '/' + e.name : e.name;
            if (e.isDirectory()) walk(full, r);
            else {
                let size = null;
                try { size = fs.statSync(full).size; } catch { }
                files.push({ path: r, size, sha256: fileHash(full) });
            }
        }
    };
    walk(String(dir), '');
    return { path: String(dir), exists: fs.existsSync(dir), count: files.length, manifestHash: hash(JSON.stringify(files)), files };
}

function httpGet(url, timeoutMs = 5000) {
    return new Promise(resolve => {
        const req = http.get(url, { timeout: timeoutMs }, res => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', d => { body += d; });
            res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body }));
        });
        req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, body: '', error: 'timeout' }); });
        req.on('error', e => resolve({ ok: false, status: 0, body: '', error: e.code || e.message }));
    });
}

function processAlive(pid) {
    if (!pid) return false;
    try { process.kill(Number(pid), 0); return true; }
    catch (e) { return e.code === 'EPERM'; }
}

function safeJson(text) {
    try { const v = JSON.parse(text); return { ok: v.ok, projects: v.projects, schema: v.schema }; }
    catch { return null; }
}

/**
 * 运行实例身份：/api/runtime/identity。
 * /api/health 的 200 只能证明“有东西在应答”，不能证明应答的还是被保护的那个 5.0.24 实例。
 */
async function runtimeIdentity(cfg) {
    const desktop = protectedSection(cfg).desktop || {};
    if (!desktop.host || !desktop.port) return { ok: false, status: 0, body: null, error: 'IDENTITY_ENDPOINT_UNKNOWN' };
    const r = await httpGet(`http://${desktop.host}:${desktop.port}/api/runtime/identity`);
    let body = null;
    try { body = JSON.parse(r.body); } catch { }
    return { ok: r.ok && !!body, status: r.status, body, error: r.error || null };
}

/**
 * 运行身份门禁：version / pid / dataDir 必须与受保护配置一致。
 * protected 配置缺失时直接拒绝执行——没有基准就没有可比对的门禁。
 */
async function assertRuntimeIdentity(cfg) {
    const prot = protectedSection(cfg);
    const desktop = prot.desktop || {};
    const violations = [];
    if (!desktop.version || !desktop.pid || !prot.dataDir || !desktop.host || !desktop.port) {
        violations.push('PROTECTED_CONFIG_MISSING: 受保护配置缺少 desktop.host/port/version/pid 或 dataDir，无法核对运行身份');
        return { ok: false, violations, identity: null };
    }
    const identity = await runtimeIdentity(cfg);
    if (!identity.ok || !identity.body) {
        violations.push('IDENTITY_UNREACHABLE: 运行实例身份不可读（status ' + identity.status + '）');
        return { ok: false, violations, identity };
    }
    const b = identity.body;
    if (String(b.version) !== String(desktop.version)) violations.push('IDENTITY_VERSION_MISMATCH: 运行版本 ' + b.version + ' ≠ 受保护版本 ' + desktop.version);
    if (Number(b.pid) !== Number(desktop.pid)) violations.push('IDENTITY_PID_MISMATCH: 运行 pid ' + b.pid + ' ≠ 受保护 pid ' + desktop.pid);
    if (!b.dataDir || normalize(b.dataDir) !== normalize(prot.dataDir)) violations.push('IDENTITY_DATADIR_MISMATCH: 运行 dataDir ' + b.dataDir + ' ≠ 受保护 dataDir ' + prot.dataDir);
    if (Number(b.port) !== Number(desktop.port)) violations.push('IDENTITY_PORT_MISMATCH: 运行端口 ' + b.port + ' ≠ 受保护端口 ' + desktop.port);
    if (!processAlive(desktop.pid)) violations.push('IDENTITY_PROCESS_GONE: 受保护 pid ' + desktop.pid + ' 不在运行');
    return { ok: violations.length === 0, violations, identity };
}

/**
 * 受保护目标的当前身份。只读：HTTP GET、stat、hash，不写、不停任何进程。
 */
async function snapshotProtected(cfg) {
    const prot = protectedSection(cfg);
    const desktop = prot.desktop || {};
    const files = (prot.files || []).map(p => ({ path: String(p), sha256: fileHash(p) }));
    const dirs = {};
    for (const key of ['dataDir', 'knowledgeRoot', 'globalNpmRoot']) {
        if (prot[key]) dirs[key] = { path: String(prot[key]), ...directoryFingerprint(prot[key]) };
    }
    const installs = {};
    for (const root of prot.installRoots || []) {
        installs[String(root)] = directoryManifest(root);
    }
    let health = null;
    if (desktop.host && desktop.port) {
        const r = await httpGet(`http://${desktop.host}:${desktop.port}/api/health`);
        health = { ok: r.ok, status: r.status, body: r.ok ? safeJson(r.body) : null, error: r.error || null };
    }
    const identity = await runtimeIdentity(cfg);
    return {
        schema: 'qa-autopilot/protected-snapshot/v2',
        at: new Date().toISOString(),
        desktop: { pid: desktop.pid ?? null, host: desktop.host ?? null, port: desktop.port ?? null, alive: processAlive(desktop.pid), health },
        identity: { ok: identity.ok, status: identity.status, body: identity.body, error: identity.error || null },
        files, dirs, installs
    };
}

/**
 * 前后快照对比。
 *
 * 两类结果必须分开：
 *   - violation：可归因于 QA 的差异（受保护文件被改/被加、静态安装清单变化、目录消失、桌面实例被替换）。
 *   - observation：真实可变目录（dataDir / knowledgeRoot）的内容变化。运行中的桌面一直在写自己的
 *     事件与日志文件，没有任何 QA 动作时这些目录也会变，因此这类差异**不构成 QA 越界的证据**，
 *     只能作为观察记录。
 */
function diffProtected(before, after) {
    const violations = [];
    if (!before || !after) return [{ reason: 'MISSING_SNAPSHOT' }];
    const b = before.desktop || {}, a = after.desktop || {};
    if (b.pid !== a.pid) violations.push({ reason: 'DESKTOP_PID_CHANGED', before: b.pid, after: a.pid });
    if (b.alive !== a.alive) violations.push({ reason: 'DESKTOP_LIFECYCLE_CHANGED', before: b.alive, after: a.alive });
    if (b.port !== a.port) violations.push({ reason: 'DESKTOP_PORT_CHANGED', before: b.port, after: a.port });
    const bh = b.health && b.health.body, ah = a.health && a.health.body;
    if (bh && ah && bh.projects !== ah.projects) violations.push({ reason: 'DESKTOP_PROJECT_COUNT_CHANGED', before: bh.projects, after: ah.projects });
    if (b.health && b.health.ok && a.health && !a.health.ok) violations.push({ reason: 'DESKTOP_HEALTH_LOST', before: b.health.status, after: a.health.status });
    const bi = before.identity || {}, ai = after.identity || {};
    if (bi.ok && !ai.ok) violations.push({ reason: 'IDENTITY_LOST', before: bi.body, after: null });
    if (bi.body && ai.body) {
        if (String(bi.body.version) !== String(ai.body.version)) violations.push({ reason: 'IDENTITY_VERSION_CHANGED', before: bi.body.version, after: ai.body.version });
        if (Number(bi.body.pid) !== Number(ai.body.pid)) violations.push({ reason: 'IDENTITY_PID_CHANGED', before: bi.body.pid, after: ai.body.pid });
        if (normalize(bi.body.dataDir || '') !== normalize(ai.body.dataDir || '')) violations.push({ reason: 'IDENTITY_DATADIR_CHANGED', before: bi.body.dataDir, after: ai.body.dataDir });
    }
    const bFiles = new Map((before.files || []).map(f => [f.path, f.sha256]));
    for (const f of after.files || []) {
        const prev = bFiles.get(f.path);
        if (prev === undefined) violations.push({ reason: 'PROTECTED_FILE_ADDED', path: f.path });
        else if (prev !== f.sha256) violations.push({ reason: 'PROTECTED_FILE_CHANGED', path: f.path, before: prev, after: f.sha256 });
    }
    const bInstalls = before.installs || {}, aInstalls = after.installs || {};
    for (const root of Object.keys(aInstalls)) {
        const prev = bInstalls[root];
        if (!prev) continue;
        if (prev.manifestHash !== aInstalls[root].manifestHash) {
            violations.push({ reason: 'INSTALL_MANIFEST_CHANGED', path: root, before: prev.manifestHash, after: aInstalls[root].manifestHash, files: aInstalls[root].files });
        }
    }
    const bDirs = before.dirs || {}, aDirs = after.dirs || {};
    for (const key of Object.keys(aDirs)) {
        const prev = bDirs[key];
        if (!prev) continue;
        if (prev.exists !== aDirs[key].exists) violations.push({ reason: 'PROTECTED_DIR_VANISHED', path: aDirs[key].path });
        else if (prev.exists && prev.fingerprint !== aDirs[key].fingerprint) {
            const beforeNames = new Set((prev.entries || []).map(e => e.name));
            const afterNames = new Set((aDirs[key].entries || []).map(e => e.name));
            const beforeFiles = new Map((prev.files || []).map(f => [f.name, f.sha256]));
            violations.push({
                reason: 'PROTECTED_DIR_CHANGED',
                class: 'observation',
                attribution: '运行中的桌面持续写自己的事件与日志；真实可变目录的变化不能归因于 QA，不作为越界证据。',
                path: aDirs[key].path,
                added: [...afterNames].filter(n => !beforeNames.has(n)),
                removed: [...beforeNames].filter(n => !afterNames.has(n)),
                changedFiles: (aDirs[key].files || []).filter(f => !f.volatile && beforeFiles.has(f.name) && beforeFiles.get(f.name) !== f.sha256).map(f => f.name)
            });
        }
    }
    for (const v of violations) if (!v.class) v.class = 'violation';
    return violations;
}

/** 把差异分成“可归因于 QA 的违规”与“只能观察到的变化”。 */
function classifyDrift(drift) {
    const list = drift || [];
    return {
        violations: list.filter(d => d.class !== 'observation'),
        observations: list.filter(d => d.class === 'observation')
    };
}

/**
 * 受保护路径在用例文本里的字面量形态：
 * Windows 路径在 JS 字符串里常写成 'C:\\Users\\...'（反斜杠被转义两次），
 * 也可能写成正斜杠。分隔符统一按 [\\/]+ 匹配，避免只认一种写法而漏判。
 */
function pathLiteralPattern(p) {
    const parts = String(p).split(/[\\/]+/).filter(Boolean);
    if (!parts.length) return /$^/;
    const body = parts.map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\\\/]+');
    return new RegExp(body, 'i');
}

/** 具名例外表：每条按“文件 + 文件内容 sha256 + 审查理由”绑定。 */
function preflightExceptions(cfg) {
    const list = (cfg && cfg.preflightExceptions) || [];
    return Array.isArray(list) ? list.filter(e => e && e.file && e.sha256 && e.reason) : [];
}

/**
 * 具名静态单元例外。
 * 例外只对 PROTECTED_PORT_LITERAL 生效，且必须同时匹配文件名与文件内容 sha256：
 * 源文件一改，例外立即失效。受保护路径字面量一律不放行。
 */
function matchPreflightException(cfg, file, fileSha256, kind) {
    if (kind !== 'PROTECTED_PORT_LITERAL') return null;
    return preflightExceptions(cfg).find(e => e.file === file && e.sha256 === fileSha256) || null;
}

function preflightSuite(repoRoot, files, cfg) {
    const ports = protectedPorts(cfg);
    const findings = [];
    const blocking = [];
    const exceptionsApplied = [];
    for (const file of files) {
        const full = path.join(repoRoot, '_site', '_test', file);
        let text = '';
        try { text = fs.readFileSync(full, 'utf8'); } catch { continue; }
        const sha256 = fileHash(full);
        for (const port of ports) {
            const re = new RegExp('(?:port|PORT|localhost|127\\.0\\.0\\.1)[^\\n]{0,24}\\b' + port + '\\b');
            if (!re.test(text)) continue;
            const exception = matchPreflightException(cfg, file, sha256, 'PROTECTED_PORT_LITERAL');
            if (exception) {
                const record = { file, kind: 'PROTECTED_PORT_LITERAL_EXCEPTED', port, sha256, reason: exception.reason, approvedBy: exception.approvedBy || null, approvedAt: exception.approvedAt || null, detail: '受保护端口 ' + port + ' 字面量，按具名静态单元例外放行' };
                findings.push(record);
                exceptionsApplied.push(record);
            }
            else {
                const record = { file, kind: 'PROTECTED_PORT_LITERAL', port, sha256, detail: '用例文本中出现受保护端口 ' + port };
                findings.push(record);
                blocking.push(record);
            }
        }
        for (const p of protectedPaths(cfg).prefixes) {
            if (!pathLiteralPattern(p).test(text)) continue;
            const record = { file, kind: 'PROTECTED_PATH_LITERAL', path: p, sha256, detail: '用例文本中出现受保护路径 ' + p };
            findings.push(record);
            blocking.push(record);
        }
    }
    return { ok: blocking.length === 0, findings, blocking, exceptionsApplied };
}

module.exports = {
    MODULE_URL_KEYS, MODULE_FLAG_KEYS, MODULE_COMMAND_KEYS, SECRET_ENV_KEYS,
    DEAD_MODULE_HOST, DEAD_MODULE_PORT, DEAD_MODULE_URL, deadModuleUrl,
    protectedSection, protectedPaths, isProtectedPath, protectedPorts, moduleResets,
    productEnv, assertEnvIsolated, allocatePort, fileHash, directoryFingerprint, directoryManifest,
    runtimeIdentity, assertRuntimeIdentity, snapshotProtected, diffProtected, classifyDrift,
    preflightSuite, preflightExceptions, matchPreflightException, processAlive, httpGet
};
