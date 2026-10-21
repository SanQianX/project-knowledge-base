'use strict';
// Touch only owned paths; never follow links. / 只操作拥有的路径，禁止跟随链接。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync, spawn } = require('node:child_process');
class QAError extends Error {
    constructor(code, message, exitCode = 2) { super(message); this.code = code; this.exitCode = exitCode; }
}
function must(condition, code, message, exitCode = 2) { if (!condition)
    throw new QAError(code, message, exitCode); }
function hash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function readJSON(file) { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
function inside(root, target, allowRoot = false) {
    const r = path.resolve(root), t = path.resolve(target), rel = path.relative(r, t);
    must((allowRoot || rel !== '') && !rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel), 'PATH_ESCAPE', 'Path is outside its owned root.');
    return t;
}
function noLinks(root, target, allowMissing = false) {
    const t = inside(root, target, true);
    let cur = path.parse(t).root;
    for (const part of t.slice(cur.length).split(path.sep).filter(Boolean)) {
        cur = path.join(cur, part);
        if (!fs.existsSync(cur)) {
            try {
                fs.lstatSync(cur);
            }
            catch (e) {
                if (e.code === 'ENOENT' && allowMissing)
                    return t;
                throw e;
            }
        }
        const s = fs.lstatSync(cur);
        must(!s.isSymbolicLink(), 'LINK_REJECTED', 'Symbolic links and junctions are not accepted: ' + cur);
    }
    if (fs.existsSync(t))
        inside(fs.realpathSync(root), fs.realpathSync(t), true);
    return t;
}
function atomicJSON(file, value, { exclusive = false } = {}) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    noLinks(path.dirname(file), file, true);
    const tmp = path.join(path.dirname(file), '.' + path.basename(file) + '.' + crypto.randomUUID() + '.tmp');
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try {
        fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n');
        fs.fsyncSync(fd);
    }
    finally {
        fs.closeSync(fd);
    }
    try {
        if (exclusive) {
            fs.linkSync(tmp, file);
            fs.unlinkSync(tmp);
        }
        else
            fs.renameSync(tmp, file);
    }
    catch (e) {
        try {
            fs.unlinkSync(tmp);
        }
        catch { }
        throw e;
    }
    // Directory fsync is best effort; Windows may not support it.
    try {
        const d = fs.openSync(path.dirname(file), 'r');
        try {
            fs.fsyncSync(d);
        }
        finally {
            fs.closeSync(d);
        }
    }
    catch { }
}
function acquireLock(file, details = {}) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const token = crypto.randomUUID();
    try {
        atomicJSON(file, { pid: process.pid, token, at: new Date().toISOString(), ...details }, { exclusive: true });
    }
    catch (e) {
        if (e.code === 'EEXIST')
            throw new QAError('LOCKED', 'Lock exists. Never auto-delete a lock by age alone.', 20);
        throw e;
    }
    return () => { if (readJSON(file).token === token)
        fs.unlinkSync(file); };
}
function redact(value) {
    let text = String(value);
    for (const [name, secret] of Object.entries(process.env)) {
        if (/(TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL)/i.test(name) && secret && secret.length >= 6)
            text = text.split(secret).join('[REDACTED]');
    }
    return text.replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [REDACTED]')
        .replace(/\b(?:sk-(?:api-)?[A-Za-z0-9_-]{12,}|npm_[A-Za-z0-9]{12,}|gh[pousr]_[A-Za-z0-9_]{12,})\b/g, '[REDACTED]');
}
function safeName(value) { must(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(value), 'INVALID_ID', 'Invalid ID.'); return value; }
function ownedRun(qa, id) {
    safeName(id);
    const root = path.resolve(qa, '.runtime', 'runs');
    fs.mkdirSync(root, { recursive: true });
    noLinks(qa, root);
    const dir = inside(root, path.join(root, id));
    must(!fs.existsSync(dir), 'RUN_EXISTS', 'Run directory already exists; reconcile instead of overwriting.');
    fs.mkdirSync(dir);
    atomicJSON(path.join(dir, '.qa-owner.json'), { schema: 1, id, root: fs.realpathSync(root), createdAt: new Date().toISOString(), status: 'ACTIVE' });
    return dir;
}
function setRunStatus(dir, status) {
    must(['ACTIVE', 'PASSED', 'FAILED', 'RETAIN'].includes(status), 'STATUS', 'Bad run status.');
    const file = path.join(dir, '.qa-owner.json'), state = readJSON(file);
    state.status = status;
    state.finishedAt = new Date().toISOString();
    atomicJSON(file, state);
}
/**
 * git 的标准模板目录。指向它而不是空目录：
 *  - 空目录会让 git init 跳过 .git/hooks 的创建，产品测试读取
 *    .git/hooks/post-commit 时得到 ENOENT；
 *  - 标准模板只含 *.sample 惰性样本，不会把用户的生产 Hook 复制进测试仓库，
 *    保护意图不变。找不到时退回 git 自身默认（仍不是空目录）。
 */
let gitStockTemplateDir = null;
function stockTemplateDir() {
    if (gitStockTemplateDir !== null) return gitStockTemplateDir || undefined;
    try {
        const exec = commandSync("git", ["--exec-path"], { timeout: 10000 }).trim();
        const tpl = path.resolve(exec, "..", "..", "share", "git-core", "templates");
        if (fs.existsSync(tpl) && fs.existsSync(path.join(tpl, "hooks"))) gitStockTemplateDir = tpl;
        else gitStockTemplateDir = "";
    } catch (_) { gitStockTemplateDir = ""; }
    return gitStockTemplateDir || undefined;
}

function isolatedEnv(run, additions = {}) {
    const env = {};
    for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'LANG', 'LC_ALL'])
        if (process.env[key])
            env[key] = process.env[key];
    for (const d of ['home', 'tmp', 'data', 'knowledge', 'bridge', 'appdata', 'localappdata', 'claude', 'npm-cache', 'git-template'])
        fs.mkdirSync(path.join(run, d), { recursive: true });
    Object.assign(env, {
        HOME: path.join(run, 'home'), USERPROFILE: path.join(run, 'home'), APPDATA: path.join(run, 'appdata'), LOCALAPPDATA: path.join(run, 'localappdata'),
        TEMP: path.join(run, 'tmp'), TMP: path.join(run, 'tmp'), TMPDIR: path.join(run, 'tmp'),
        KB_DATA_DIR: path.join(run, 'data'), KB_KNOWLEDGE_DATA_DIR: path.join(run, 'knowledge'),
        AI_CODING_EVENT_BRIDGE_HOME: path.join(run, 'bridge'), CLAUDE_CONFIG_DIR: path.join(run, 'claude'),
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(run, 'home', '.gitconfig'), GIT_TEMPLATE_DIR: stockTemplateDir() || path.join(run, 'git-template'),
        npm_config_cache: path.join(run, 'npm-cache'), npm_config_registry: 'https://registry.npmjs.org',
        npm_config_userconfig: path.join(run, 'home', '.npmrc'), FORCE_COLOR: '0', CI: '1',
        KB_MODULES_AUTOSTART: '0'
    });
    for (const [key, value] of Object.entries(additions)) {
        must(!/(NODE_OPTIONS|GIT_CONFIG_COUNT|NPM_TOKEN|GH_TOKEN|GITHUB_TOKEN)/i.test(key), 'ENV_FORBIDDEN', 'Unsafe child environment override.');
        env[key] = String(value);
    }
    return env;
}
function commandSync(exe, args, options = {}) {
    const r = spawnSync(exe, args, { encoding: 'utf8', shell: false, windowsHide: true, timeout: 30000, maxBuffer: 16 * 1024 * 1024, ...options });
    if (r.error)
        throw new QAError('COMMAND_START', redact(r.error.message), 20);
    if (r.status !== 0)
        throw new QAError('COMMAND_FAILED', `${path.basename(exe)} exited ${r.status}: ${redact(r.stderr || r.stdout).slice(-2000)}`, 10);
    return String(r.stdout || '').trim();
}
function executable(file) {
    must(path.isAbsolute(file || '') && fs.existsSync(file), 'EXECUTABLE_MISSING', 'An existing absolute executable path is required.', 20);
    must(!/\.(cmd|bat)$/i.test(file), 'SHELL_WRAPPER', 'Use node.exe plus the real JS entry, not a .cmd/.bat wrapper.', 20);
    return file;
}
function runLogged(exe, args, options) {
    executable(exe);
    const { cwd, env, logDir, timeoutMs = 120000, input = null } = options;
    fs.mkdirSync(logDir, { recursive: true });
    return new Promise(resolve => {
        const start = Date.now(), child = spawn(exe, args, { cwd, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        let out = '', err = '', timedOut = false, finished = false, size = 0, killGrace;
        const max = 8 * 1024 * 1024;
        const add = (dest, data) => { size += data.length; if (size > max) {
            timedOut = true;
            child.kill();
            return;
        } if (dest === 'out')
            out += data.toString();
        else
            err += data.toString(); };
        child.stdout.on('data', d => add('out', d));
        child.stderr.on('data', d => add('err', d));
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill();
            killGrace = setTimeout(() => {
                child.stdout.destroy();
                child.stderr.destroy();
                child.stdin.destroy();
                finish(null, 'UNCONFIRMED_PROCESS_TREE', new Error('Timed out; descendant ownership must be reconciled before cleanup.'));
            }, 5000);
        }, timeoutMs);
        const finish = (code, signal, error) => {
            if (finished)
                return;
            finished = true;
            clearTimeout(timer);
            clearTimeout(killGrace);
            fs.writeFileSync(path.join(logDir, 'stdout.log'), redact(out), { mode: 0o600 });
            fs.writeFileSync(path.join(logDir, 'stderr.log'), redact(err), { mode: 0o600 });
            resolve({ code, signal, error: error ? redact(error.message) : null, timedOut, durationMs: Date.now() - start, stdout: out, stderr: err, pid: child.pid });
        };
        child.on('error', e => finish(null, null, e));
        child.on('close', (c, s) => finish(c, s, null));
        child.stdin.on('error', () => { });
        if (input !== null)
            child.stdin.end(input);
        else
            child.stdin.end();
    });
}
function cleanupPlan(qa, olderThanHours = 24) {
    must(Number.isFinite(olderThanHours) && olderThanHours >= 1, 'RETENTION', 'Minimum retention is one hour.');
    const root = path.join(qa, '.runtime', 'runs');
    if (!fs.existsSync(root))
        return [];
    noLinks(qa, root);
    const plan = [];
    for (const e of fs.readdirSync(root, { withFileTypes: true })) {
        const dir = path.join(root, e.name);
        noLinks(root, dir);
        if (!e.isDirectory())
            continue;
        const marker = path.join(dir, '.qa-owner.json');
        if (!fs.existsSync(marker))
            continue;
        noLinks(root, marker);
        const m = readJSON(marker);
        if (m.id !== e.name || m.root !== fs.realpathSync(root) || m.status !== 'PASSED')
            continue;
        if (!Number.isFinite(Date.parse(m.finishedAt)) || Date.now() - Date.parse(m.finishedAt) < olderThanHours * 3600000)
            continue;
        const entries = [];
        function visit(folder) {
            for (const d of fs.readdirSync(folder, { withFileTypes: true })) {
                const f = path.join(folder, d.name);
                noLinks(root, f);
                const s = fs.lstatSync(f);
                must(!['.git', '.runtime', 'node_modules'].includes(d.name), 'CLEAN_PROTECTED', 'Protected subtree in clean target.');
                if (d.isDirectory())
                    visit(f);
                else {
                    must(s.isFile() && s.nlink === 1, 'CLEAN_SPECIAL', 'Special or hard-linked file rejected.');
                    entries.push({ relative: path.relative(root, f), sha256: hash(fs.readFileSync(f)) });
                }
            }
        }
        visit(dir);
        plan.push({ id: m.id, directory: dir, entries });
    }
    return plan;
}
function applyCleanup(qa, expected) {
    const current = cleanupPlan(qa, expected.olderThanHours);
    must(hash(JSON.stringify(current)) === expected.planHash, 'CLEAN_CHANGED', 'Dry-run inventory changed.');
    // Files are unlinked individually; no recursive rm and no following links.
    for (const item of current) {
        for (const f of item.entries) {
            const p = path.join(qa, '.runtime', 'runs', f.relative);
            noLinks(qa, p);
            must(hash(fs.readFileSync(p)) === f.sha256, 'CLEAN_CHANGED', 'File changed during cleanup.');
            fs.unlinkSync(p);
        }
        const removeEmpty = dir => { noLinks(qa, dir); for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
            must(d.isDirectory(), 'CLEAN_RACE', 'Unexpected file appeared.');
            removeEmpty(path.join(dir, d.name));
        } fs.rmdirSync(dir); };
        removeEmpty(item.directory);
    }
    return current.map(x => x.id);
}
module.exports = { QAError, must, hash, readJSON, inside, noLinks, atomicJSON, acquireLock, redact, safeName, ownedRun, setRunStatus, isolatedEnv, commandSync, executable, runLogged, cleanupPlan, applyCleanup };
