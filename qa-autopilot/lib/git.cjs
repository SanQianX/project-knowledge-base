'use strict';
// Bind each write to verified source and remote state. / 每次写入绑定已验证源码与远程状态。
//
// 2026-10-23（L-QA-01）治理模型改为 main-only：
//   - 只允许 main。qa/*、备份分支、发布分支一律拒绝。
//   - 基准不再自动创建 tag，改为可审计的 SHA/receipt。
//   - 隔离 clone 必须自证：origin 精确、HEAD 对齐 main、树干净、与源目录不同、无硬链接、无多余分支。
const fs = require('node:fs');
const path = require('node:path');
const { must, hash, readJSON, inside, noLinks, atomicJSON, commandSync, acquireLock, isolatedEnv } = require('./safety.cjs');
const SHA = /^[a-f0-9]{40}$/;
// runner 收据 id 的实际形状：'test-' + safeName(suite) + '-' + Date.now()，单段、无分隔符、非绝对路径。
// 长度上限覆盖最坏情况 5 + 101 + 1 + 13 = 120 字符。
const RUNNER_ARTIFACTS_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
function git(cfg, args, cwd = cfg.repoRoot) {
    const mutations = new Set(['add', 'commit', 'push', 'tag', 'checkout', 'revert']);
    let options = args;
    if (mutations.has(args[0])) {
        const hooks = path.join(cwd, '.git', 'qa-controller-empty-hooks');
        fs.mkdirSync(hooks, { recursive: true });
        noLinks(cwd, hooks);
        must(fs.readdirSync(hooks).length === 0, 'HOOK_ISOLATION', 'Controller hook directory is not empty.');
        options = ['-c', 'core.hooksPath=' + hooks, ...args];
    }
    return commandSync(cfg.tools?.git || 'git', options, { cwd, timeout: 60000 });
}
function allowedOrigin(remote, expectedRepo, extra = []) {
    const expected = [`https://github.com/${expectedRepo}`, `https://github.com/${expectedRepo}.git`, `git@github.com:${expectedRepo}.git`, `ssh://git@github.com:${expectedRepo}.git`];
    // 额外的精确 origin（例如本机镜像）只能显式登记，且必须是完整字符串匹配。
    return [...expected, ...(extra || [])].includes(remote);
}
/**
 * 只接受 main。
 * 2026-10-22 的分支归一结论：日常开发与 QA 都在 main，不再保留 qa/* 短期分支。
 */
function branchName(branch) {
    must(branch === 'main', 'BRANCH_FORBIDDEN', 'Only main is allowed. QA, backup and release branches are forbidden by the 2026-10-22 consolidation decision.');
    return branch;
}
function mainBranch(cfg) { return branchName(cfg.mainBranch || 'main'); }
function head(cfg) { return git(cfg, ['rev-parse', 'HEAD']); }

/** 用户工作区一侧的检查：origin 精确、根目录一致。 */
function assertSource(cfg) {
    const src = { ...cfg, repoRoot: cfg.sourceRoot };
    const root = fs.realpathSync(cfg.sourceRoot);
    noLinks(cfg.sourceRoot, cfg.sourceRoot);
    must(fs.realpathSync(git(src, ['rev-parse', '--show-toplevel'])) === root, 'REPO_ROOT', 'Source root mismatch.');
    must(allowedOrigin(git(src, ['remote', 'get-url', 'origin']), cfg.githubRepo, cfg.originAllowlist), 'REMOTE_MISMATCH', 'Unexpected origin repository.');
    return root;
}

/**
 * 隔离 clone 一侧的自证。verifyClone 是它的可执行版本。
 * requireClean 只对 clone 自证与运行期调用方生效；提交路径（commitPush）必须能看到
 * worker 已经评审过的未提交改动，因此那里显式关闭该检查，改由 allowlist 与密文扫描把关。
 */
function assertClone(cfg, mutate = false, options = {}) {
    const root = fs.realpathSync(cfg.repoRoot);
    noLinks(cfg.repoRoot, cfg.repoRoot);
    must(fs.realpathSync(git(cfg, ['rev-parse', '--show-toplevel'])) === root, 'REPO_ROOT', 'Repository root mismatch.');
    must(allowedOrigin(git(cfg, ['remote', 'get-url', 'origin']), cfg.githubRepo, cfg.originAllowlist), 'REMOTE_MISMATCH', 'Unexpected origin repository.');
    must(root !== fs.realpathSync(cfg.sourceRoot), 'SOURCE_WRITE_FORBIDDEN', 'The QA work root must be an independent clone, not the user worktree.');
    must(git(cfg, ['branch', '--show-current']) === mainBranch(cfg), 'BRANCH_MISMATCH', 'The QA work root must stay on main.');
    if (options.requireClean !== false)
        must(git(cfg, ['status', '--porcelain=v1', '--untracked-files=all']).trim() === '', 'DIRTY_WORKROOT', 'The QA work root must be clean.');
    if (mutate)
        must(cfg.authorization?.remoteWriteEnabled === true && cfg.authorization?.controllerIsolationVerified === true, 'WRITE_NOT_AUTHORIZED', 'Remote writes require the reviewed controller configuration.', 20);
    return root;
}
function assertRepo(cfg, mutate = false, options = {}) { return assertClone(cfg, mutate, options); }
function snapshot(cfg) {
    const names = git(cfg, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean);
    const records = [];
    for (const name of [...new Set(names)].sort()) {
        const f = path.join(cfg.repoRoot, name);
        noLinks(cfg.repoRoot, f, true);
        if (!fs.existsSync(f)) {
            records.push([name, 'DELETED']);
            continue;
        }
        const stat = fs.lstatSync(f);
        must(stat.isFile(), 'SPECIAL_FILE', 'Submodules/special files require a separate source manifest: ' + name, 20);
        records.push([name, hash(fs.readFileSync(f)), stat.mode & 0o111]);
    }
    return { fingerprint: hash(JSON.stringify(records)), records, head: head(cfg) };
}
function changedFiles(cfg) {
    return [...new Set([
            ...git(cfg, ['diff', '--name-only', '-z', 'HEAD']).split('\0'),
            ...git(cfg, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0')
        ].filter(Boolean))].sort();
}
function validateChanges(cfg, contract, files) {
    must(/^QA-\d{3,6}$/.test(contract.bugId || ''), 'BUG_ID', 'Expected QA-001 style ID.');
    must(Array.isArray(contract.allowedFiles) && contract.allowedFiles.length > 0, 'FILE_ALLOWLIST', 'Explicit file allowlist required.');
    must(files.length > 0 && files.length <= (cfg.limits?.maxChangedFiles || 15), 'DIFF_SIZE', 'Empty or too-large change set.');
    for (const f of files) {
        must(contract.allowedFiles.includes(f), 'OUT_OF_SCOPE', 'File not in task contract: ' + f);
        must(!/(^|\/)(\.git|node_modules|state|artifacts|\.runtime|\.env)(\/|$)|(?:^|\/)(?:ai-profiles|settings|credentials)\.json$/i.test(f), 'SENSITIVE_PATH', 'Sensitive/generated path in commit: ' + f);
        const protectedFile = /^\.github\//.test(f) || /^_site\/_test\//.test(f) || /^qa-autopilot\/(?:lib|scripts|tools|config|tests|baselines)\//.test(f) || /(?:^|\/)package(?:-lock)?\.json$|manifest\.json$|hook|promotion|migration|storage/i.test(f);
        if (protectedFile)
            must(Array.isArray(contract.approvedProtectedFiles) && contract.approvedProtectedFiles.includes(f) && contract.approvalReceipt, 'PROTECTED_FILE', 'Protected-file change needs controller-approved review: ' + f, 20);
    }
    must(!contract.publicApiChange && !contract.storageContractChange, 'DESIGN_CHANGE', 'Public API / storage changes need a new reviewed task, not an automatic fix.', 20);
}
function parseRemoteRefs(text) { return new Map(String(text).split(/\r?\n/).filter(Boolean).map(line => { const [sha, ref] = line.split(/\s+/); must(SHA.test(sha) && ref, 'REMOTE_REF', 'Malformed remote ref.'); return [ref, sha]; })); }
function remoteHead(cfg, ref) {
    // 远程不可达时不得抛出并中断校验：远程 ref 观测不到就是观测不到，
    // 上层据此把 headMatchesRemoteMain 判为 false，整体仍然 fail-closed。
    try { return parseRemoteRefs(git(cfg, ['ls-remote', 'origin', ref])).get(ref) || null; }
    catch { return null; }
}
function audit(cfg) {
    assertSource(cfg);
    const src = { ...cfg, repoRoot: cfg.sourceRoot };
    const pkg = readJSON(path.join(cfg.sourceRoot, 'package.json'));
    const h = head(src), remote = remoteHead(src, 'refs/heads/' + mainBranch(cfg));
    const workflow = fs.readFileSync(path.join(cfg.sourceRoot, '.github/workflows/publish.yml'), 'utf8');
    return { schema: 1, at: new Date().toISOString(), sourceRoot: cfg.sourceRoot, plannedWorkRoot: cfg.repoRoot,
        head: h, remoteMain: remote, sourceMatchesRemote: h === remote,
        statusPorcelain: git(src, ['status', '--porcelain=v1', '--untracked-files=all']),
        name: pkg.name, version: pkg.version, node: process.version, dependencies: pkg.dependencies,
        publishReview: { tagWildcard: /['"]v\*['"]/.test(workflow), explicitNext: /--tag[ =]+next/.test(workflow), note: 'Static risk indicator, not proof of an executed publication.' },
        files: pkg.files, scripts: pkg.scripts };
}
function verifyReceipt(cfg, receipt, contract) {
    const s = snapshot(cfg);
    must(receipt.schema === 1 && receipt.kind === 'suite' && receipt.status === 'PASS' && receipt.exitCode === 0 && receipt.executed > 0, 'TEST_RECEIPT', 'A genuine nonempty passing suite receipt is required.');
    must(receipt.fingerprint === s.fingerprint && receipt.head === s.head, 'STALE_TESTS', 'Files or HEAD changed after verification.');
    must(receipt.contractHash === hash(JSON.stringify(contract)), 'CONTRACT_CHANGED', 'Verification belongs to a different task contract.');
    must(receipt.skipped === 0 && !receipt.timedOut && !receipt.flaky, 'TEST_GAP', 'Skipped/flaky/timeout results cannot authorize a commit.');
    return s;
}
/** REV-01 待测补丁指纹：按文件名排序的 [file, sha256(内容)] 列表哈希；删除的文件记 DELETED。 */
function patchFingerprint(cfg, files) {
    const records = [];
    for (const f of [...files].sort()) {
        const full = path.join(cfg.repoRoot, f);
        records.push([f, fs.existsSync(full) ? hash(fs.readFileSync(full)) : 'DELETED']);
    }
    return hash(JSON.stringify(records));
}
/**
 * REV-01 合同明确绑定的“待测补丁”模式。这不是放宽干净基线自证：
 * 基线必须未动（HEAD 仍等于 origin/main，不领先不落后），改动文件必须
 * 严格落在合同 allowlist 内（未声明文件直接拒绝），补丁内容被指纹化进收据。
 * runSuite 以该模式在脏树上取得真实收据；commitPush 侧由 verifyRunnerReceipt 复核。
 */
function assertPatchUnderTest(cfg, contract) {
    assertRepo(cfg, false, { requireClean: false });
    const h = head(cfg), ref = 'refs/heads/' + mainBranch(cfg);
    const remote = remoteHead(cfg, ref);
    must(remote !== null && remote === h, 'BASELINE_DRIFT', 'Patch-under-test requires the local HEAD to still equal origin/main; reconcile the baseline first.', 20);
    const files = changedFiles(cfg);
    validateChanges(cfg, contract, files);
    return { mode: 'patch-under-test', head: h, remoteMain: remote, files, patchSha256: patchFingerprint(cfg, files), contractHash: hash(JSON.stringify(contract)) };
}
/**
 * REV-01：commitPush 只接受真实 runner 写出的收据。收据必须原样存在于
 * qaRoot/artifacts/<id>/receipt.json，携带待测补丁绑定，且每一项结果真实通过。
 * 这关闭“用 snapshot 在内存里拼一个 PASS 对象”的短路路径；不宣称抵御拥有
 * 同用户文件系统权限的攻击者改写 artifacts（OS 级沙箱仍属 BLOCKED）。
 */
function verifyRunnerReceipt(cfg, receipt, contract) {
    must(receipt && receipt.schema === 1 && receipt.kind === 'suite' && typeof receipt.id === 'string' && receipt.id !== '', 'RECEIPT_NOT_RUNNER', 'A receipt written by the real runner (with its artifacts id) is required.');
    // L-QAFIX-02：id 只能是 runner 实际生成的单段安全 id（test-<safeName>-<ts>）。
    // 分隔符、绝对路径、'..' 一律在读文件之前拒绝；哈希一致不构成路径授权。
    must(RUNNER_ARTIFACTS_ID.test(receipt.id) && !receipt.id.includes('..') && path.basename(receipt.id) === receipt.id,
        'RECEIPT_NOT_RUNNER', 'Receipt id is not a runner-generated single-segment artifacts id: ' + JSON.stringify(receipt.id));
    const artifactsRoot = path.join(cfg.qaRoot, 'artifacts');
    const onDiskPath = path.join(artifactsRoot, receipt.id, 'receipt.json');
    inside(artifactsRoot, onDiskPath);
    noLinks(artifactsRoot, onDiskPath, true);
    must(fs.existsSync(onDiskPath), 'RECEIPT_NOT_RUNNER', 'No runner artifact behind this receipt: ' + onDiskPath, 20);
    let onDisk = null;
    try { onDisk = JSON.parse(fs.readFileSync(onDiskPath, 'utf8')); }
    catch { must(false, 'RECEIPT_NOT_RUNNER', 'Runner receipt artifact is unreadable.'); }
    must(hash(JSON.stringify(onDisk)) === hash(JSON.stringify(receipt)), 'RECEIPT_NOT_RUNNER', 'Submitted receipt differs from the on-disk runner receipt.');
    must(onDisk.status === 'PASS' && onDisk.exitCode === 0 && onDisk.executed > 0, 'TEST_RECEIPT', 'A genuine nonempty passing suite receipt is required.');
    must(Array.isArray(onDisk.results) && onDisk.results.length > 0 && onDisk.results.every(r => r && r.status === 'PASS' && r.exitCode === 0 && !r.timedOut && !r.skipped), 'TEST_RECEIPT', 'Every suite result must be a real pass.');
    must(onDisk.skipped === 0 && !onDisk.timedOut && !onDisk.flaky, 'TEST_GAP', 'Skipped/flaky/timeout results cannot authorize a commit.');
    must(onDisk.contractHash === hash(JSON.stringify(contract)), 'CONTRACT_CHANGED', 'Verification belongs to a different task contract.');
    const binding = onDisk.patchUnderTest;
    must(binding && binding.mode === 'patch-under-test' && Array.isArray(binding.files), 'RECEIPT_NOT_RUNNER', 'Receipt lacks the patch-under-test binding; a clean-tree self-attestation cannot authorize a fix commit.');
    const s = snapshot(cfg);
    must(onDisk.fingerprint === s.fingerprint && onDisk.head === s.head, 'STALE_TESTS', 'Files or HEAD changed after verification.');
    const files = changedFiles(cfg);
    must(JSON.stringify(binding.files) === JSON.stringify(files), 'PATCH_DRIFT', 'The current change set differs from the tested patch.');
    must(binding.patchSha256 === patchFingerprint(cfg, files), 'PATCH_DRIFT', 'Patch content changed after the tested run.');
    return { snapshot: s, files };
}
/**
 * 凭据特征扫描。既用于 diff 行，也用于新增/修改文件的完整正文：
 * 只扫 git diff 会漏掉尚未跟踪的新文件。
 */
const SECRET_PATTERN = /(?:npm_[A-Za-z0-9]{24,}|gh[pousr]_[A-Za-z0-9_]{24,}|sk-[A-Za-z0-9_-]{24,}|BEGIN (?:RSA |OPENSSH )?PRIVATE KEY)/;
function detectSecret(text) { return SECRET_PATTERN.test(String(text)); }

function commitPush(cfg, contract, receipt, store, apply = false) {
    assertRepo(cfg, apply, { requireClean: false });
    // REV-01：收据必须来自真实 runner（含待测补丁绑定与逐项结果），
    // 不再接受仅用 snapshot 拼出来的 PASS 对象。
    const verified = verifyRunnerReceipt(cfg, receipt, contract);
    const files = verified.files;
    validateChanges(cfg, contract, files);
    const s = verified.snapshot, ref = 'refs/heads/' + mainBranch(cfg);
    const remote = remoteHead(cfg, ref);
    must(remote === s.head, 'REMOTE_DIVERGED', 'Remote main HEAD must match the verified parent before a new commit.', 20);
    must(!git(cfg, ['diff', '--cached', '--name-only']), 'STAGED_CHANGES', 'Pre-existing staged changes must be reconciled.');
    const patch = git(cfg, ['diff', '--no-ext-diff', '--no-color', 'HEAD', '--', ...files]);
    must(!/^[+](?![+]).*(?:npm_[A-Za-z0-9]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|sk-[A-Za-z0-9_-]{16,}|BEGIN (?:RSA |OPENSSH )?PRIVATE KEY)/m.test(patch), 'SECRET_DETECTED', 'Possible credential in diff.');
    must(Buffer.byteLength(patch) <= (cfg.limits?.maxPatchBytes || 200000), 'PATCH_TOO_LARGE', 'Split this change or obtain a reviewed larger budget.');
    for (const f of files) {
        const full = path.join(cfg.repoRoot, f);
        if (fs.existsSync(full)) {
            const text = fs.readFileSync(full, 'utf8');
            must(!detectSecret(text), 'SECRET_DETECTED', 'Possible credential in a changed or newly added file.');
        }
    }
    const type = contract.kind === 'cleanup' ? 'refactor' : 'fix';
    const message = `${type}(${contract.bugId}): ${String(contract.summary || '').replace(/[\r\n]/g, ' ').slice(0, 140)}`;
    const intent = { parent: s.head, ref, fingerprint: s.fingerprint, files, message };
    if (!apply)
        return { dryRun: true, ...intent };
    const release = acquireLock(path.join(cfg.qaRoot, 'state', 'git-write.lock'));
    try {
        const id = 'commit-' + contract.bugId + '-' + s.fingerprint;
        const begun = store.beginOperation(id, intent);
        must(!begun.existing, 'RECONCILE_REQUIRED', 'An operation with this ID already exists. Read Git and remote state; never retry a write blindly.', 20);
        git(cfg, ['add', '--', ...files]);
        git(cfg, ['diff', '--cached', '--check']);
        must(snapshot(cfg).fingerprint === s.fingerprint, 'FILES_CHANGED', 'Working files changed while staging.');
        const staged = git(cfg, ['diff', '--cached', '--name-only', '-z']).split('\0').filter(Boolean).sort();
        must(JSON.stringify(staged) === JSON.stringify(files), 'STAGE_MISMATCH', 'Staged set does not match reviewed file set.');
        git(cfg, ['commit', '-m', message, '-m', `QA-Verification: ${receipt.fingerprint}\nQA-Contract: ${receipt.contractHash}`]);
        const sha = head(cfg);
        must(git(cfg, ['rev-parse', 'HEAD^']) === s.head, 'PARENT_MISMATCH', 'Unexpected commit parent.');
        git(cfg, ['push', 'origin', `HEAD:${ref}`]);
        must(remoteHead(cfg, ref) === sha, 'PUSH_UNCONFIRMED', 'Remote SHA did not match; reconcile before further writes.', 20);
        const result = { sha, parent: s.head, remoteRef: ref, bugId: contract.bugId, status: 'PUSHED_CI_PENDING' };
        store.completeOperation(id, result);
        return result;
    }
    finally {
        release();
    }
}

/** .git/objects 下被硬链接的普通文件数量。clone 必须为 0。 */
function countHardlinkedObjects(objectsDir) {
    if (!fs.existsSync(objectsDir)) return 0;
    let count = 0;
    const walk = dir => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else {
                try { if (fs.lstatSync(full).nlink > 1) count++; } catch { }
            }
        }
    };
    walk(objectsDir);
    return count;
}

/**
 * 隔离 clone 的自证结果。
 * 这些检查是可执行事实，不是声明：任何一项为 false 都阻断执行。
 */
function verifyClone(cfg) {
    const root = fs.realpathSync(cfg.repoRoot);
    const branch = git(cfg, ['branch', '--show-current']);
    const origin = git(cfg, ['remote', 'get-url', 'origin']);
    const sha = head(cfg);
    const remoteMain = remoteHead(cfg, 'refs/heads/' + mainBranch(cfg));
    const status = git(cfg, ['status', '--porcelain=v1', '--untracked-files=all']);
    const branches = git(cfg, ['branch', '--format=%(refname:short)']).split('\n').map(s => s.trim()).filter(Boolean);
    const hardlinked = countHardlinkedObjects(path.join(cfg.repoRoot, '.git', 'objects'));
    const sourceOrigin = git({ ...cfg, repoRoot: cfg.sourceRoot }, ['remote', 'get-url', 'origin']);
    const checks = {
        originExact: allowedOrigin(origin, cfg.githubRepo, cfg.originAllowlist),
        originMatchesSource: origin === sourceOrigin,
        onMain: branch === mainBranch(cfg),
        headMatchesRemoteMain: remoteMain === sha,
        worktreeClean: status.trim() === '',
        distinctFromSource: root !== fs.realpathSync(cfg.sourceRoot),
        noHardlinkedObjects: hardlinked === 0,
        onlyMainBranch: branches.length === 1 && branches[0] === mainBranch(cfg)
    };
    return { root, head: sha, branch, origin, remoteMain, status, branches, hardlinkedObjects: hardlinked, checks, ok: Object.values(checks).every(Boolean) };
}

/**
 * 创建（或复用）隔离 clone。
 * 约束：不使用本地硬链接克隆；origin 设为精确仓库；只克隆 main；不创建任何额外分支。
 */
function prepareClone(cfg, options = {}) {
    const runtime = path.join(cfg.qaRoot, '.runtime');
    const rel = path.relative(runtime, cfg.repoRoot);
    must(path.resolve(cfg.repoRoot) !== path.resolve(cfg.sourceRoot), 'SOURCE_WRITE_FORBIDDEN', 'The work checkout must not be the user worktree.');
    must(rel.startsWith('workspaces' + path.sep) && !rel.includes('..'), 'WORKROOT_ESCAPE', 'The work checkout must live under QA .runtime/workspaces.');
    const exists = fs.existsSync(cfg.repoRoot);
    if (exists) {
        must(fs.existsSync(path.join(cfg.repoRoot, '.git')), 'WORKROOT_INVALID', 'An existing work root is not a Git checkout; inspect it instead of overwriting.', 20);
    }
    else {
        fs.mkdirSync(runtime, { recursive: true });
        noLinks(cfg.qaRoot, runtime);
        fs.mkdirSync(path.dirname(cfg.repoRoot), { recursive: true });
        const env = isolatedEnv(path.join(runtime, 'bootstrap'));
        const src = { ...cfg, repoRoot: cfg.sourceRoot };
        const origin = git(src, ['remote', 'get-url', 'origin']);
        commandSync(cfg.tools?.git || 'git',
            ['clone', '--no-local', '--no-hardlinks', '--single-branch', '--branch', mainBranch(cfg), cfg.sourceRoot, cfg.repoRoot],
            { cwd: runtime, env, timeout: 300000 });
        git(cfg, ['remote', 'set-url', 'origin', origin]);
    }
    const verified = verifyClone(cfg);
    must(verified.ok, 'CLONE_NOT_VERIFIED', 'Isolated clone failed its own checks: ' + Object.entries(verified.checks).filter(([, v]) => !v).map(([k]) => k).join(','), 20);
    return verified;
}

/**
 * 基准：可审计的 SHA/receipt。
 * 不创建基准 tag，不创建 qa/* 分支，不推送任何远程 ref。
 */
function baseline(cfg, apply = false) {
    const a = audit(cfg);
    const intent = {
        schema: 'qa-autopilot/baseline/v1',
        mode: 'sha-receipt',
        branch: mainBranch(cfg),
        baseSha: a.head,
        remoteMain: a.remoteMain,
        sourceMatchesRemote: a.sourceMatchesRemote,
        // 未提交改动如实记录：基准不得假称已经“冻结”用户工作区。
        sourceUncommitted: a.statusPorcelain,
        workRoot: cfg.repoRoot,
        note: '基准是本地可审计记录（SHA + 收据）。不创建 qa/* 分支，不创建基准 tag，不推送远程。'
    };
    if (!apply) return { dryRun: true, ...intent };
    must(a.statusPorcelain.trim() === '', 'SOURCE_DIRTY', 'The user worktree has uncommitted changes. Baseline reports and blocks; it never resets or stashes.', 20);
    must(a.sourceMatchesRemote, 'SOURCE_AHEAD', 'The user worktree is ahead of remote main. Reconcile before baselining; the controller never rewrites the user history.', 20);
    must(cfg.authorization?.localCloneEnabled === true, 'CLONE_NOT_AUTHORIZED', 'Isolated clone creation needs a reviewed local authorization.', 20);
    const clone = prepareClone(cfg);
    const receipt = { ...intent, clone, verifiedAt: new Date().toISOString(), status: 'LOCAL_BASELINE_CONFIRMED' };
    atomicJSON(path.join(cfg.qaRoot, 'state', 'baseline.json'), receipt);
    return receipt;
}
module.exports = { git, branchName, mainBranch, allowedOrigin, head, assertSource, assertClone, assertRepo, snapshot, changedFiles, validateChanges, parseRemoteRefs, remoteHead, audit, verifyReceipt, patchFingerprint, assertPatchUnderTest, verifyRunnerReceipt, commitPush, baseline, prepareClone, verifyClone, countHardlinkedObjects, detectSecret };
