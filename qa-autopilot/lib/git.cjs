'use strict';
// Bind each write to verified source and remote state. / 每次写入绑定已验证源码与远程状态。
const fs = require('node:fs');
const path = require('node:path');
const { must, hash, readJSON, noLinks, atomicJSON, commandSync, acquireLock, isolatedEnv } = require('./safety.cjs');
const SHA = /^[a-f0-9]{40}$/;
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
function allowedOrigin(remote, expectedRepo) {
    return [`https://github.com/${expectedRepo}`, `https://github.com/${expectedRepo}.git`, `git@github.com:${expectedRepo}.git`, `ssh://git@github.com/${expectedRepo}.git`].includes(remote);
}
function branchName(branch) { must(/^qa\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) && !branch.includes('..') && !branch.includes('//') && !branch.endsWith('/'), 'BRANCH_FORBIDDEN', 'Only valid qa/* branches are allowed.'); return branch; }
function head(cfg) { return git(cfg, ['rev-parse', 'HEAD']); }
function assertRepo(cfg, mutate = false) {
    const root = fs.realpathSync(cfg.repoRoot);
    noLinks(cfg.repoRoot, cfg.repoRoot);
    must(fs.realpathSync(git(cfg, ['rev-parse', '--show-toplevel'])) === root, 'REPO_ROOT', 'Repository root mismatch.');
    must(allowedOrigin(git(cfg, ['remote', 'get-url', 'origin']), cfg.githubRepo), 'REMOTE_MISMATCH', 'Unexpected origin repository.');
    if (mutate) {
        must(cfg.authorization?.remoteWriteEnabled === true && cfg.authorization?.controllerIsolationVerified === true, 'WRITE_NOT_AUTHORIZED', 'Remote writes require the reviewed controller configuration.', 20);
        must(root !== fs.realpathSync(cfg.sourceRoot), 'SOURCE_WRITE_FORBIDDEN', 'Mutation in the original user worktree is forbidden.');
        must(git(cfg, ['branch', '--show-current']) === branchName(cfg.qaBranch), 'BRANCH_MISMATCH', 'Not on the reviewed QA branch.');
    }
    return root;
}
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
function remoteHead(cfg, ref) { return parseRemoteRefs(git(cfg, ['ls-remote', 'origin', ref])).get(ref) || null; }
function audit(cfg) {
    const original = cfg.repoRoot;
    cfg = { ...cfg, repoRoot: cfg.sourceRoot };
    assertRepo(cfg);
    const pkg = readJSON(path.join(cfg.sourceRoot, 'package.json'));
    const h = head(cfg), remote = remoteHead(cfg, 'refs/heads/main');
    const workflow = fs.readFileSync(path.join(cfg.sourceRoot, '.github/workflows/publish.yml'), 'utf8');
    return { schema: 1, at: new Date().toISOString(), sourceRoot: cfg.sourceRoot, plannedWorkRoot: original,
        head: h, remoteMain: remote, sourceMatchesRemote: h === remote,
        statusPorcelain: git(cfg, ['status', '--porcelain=v1', '--untracked-files=all']),
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
function commitPush(cfg, contract, receipt, store, apply = false) {
    assertRepo(cfg, apply);
    const files = changedFiles(cfg);
    validateChanges(cfg, contract, files);
    const s = verifyReceipt(cfg, receipt, contract), ref = 'refs/heads/' + branchName(cfg.qaBranch);
    const remote = remoteHead(cfg, ref);
    must(remote === s.head, 'REMOTE_DIVERGED', 'Remote QA HEAD must match the verified parent before a new commit.', 20);
    must(!git(cfg, ['diff', '--cached', '--name-only']), 'STAGED_CHANGES', 'Pre-existing staged changes must be reconciled.');
    const patch = git(cfg, ['diff', '--no-ext-diff', '--no-color', 'HEAD', '--', ...files]);
    must(!/^[+](?![+]).*(?:npm_[A-Za-z0-9]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|sk-[A-Za-z0-9_-]{16,}|BEGIN (?:RSA |OPENSSH )?PRIVATE KEY)/m.test(patch), 'SECRET_DETECTED', 'Possible credential in diff.');
    must(Buffer.byteLength(patch) <= (cfg.limits?.maxPatchBytes || 200000), 'PATCH_TOO_LARGE', 'Split this change or obtain a reviewed larger budget.');
    for (const f of files) {
        const full = path.join(cfg.repoRoot, f);
        if (fs.existsSync(full)) {
            const text = fs.readFileSync(full, 'utf8');
            must(!/(?:npm_[A-Za-z0-9]{24,}|gh[pousr]_[A-Za-z0-9_]{24,}|sk-[A-Za-z0-9_-]{24,}|BEGIN (?:RSA |OPENSSH )?PRIVATE KEY)/.test(text), 'SECRET_DETECTED', 'Possible credential in a changed or newly added file.');
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
function baseline(cfg, apply = false) {
    const a = audit(cfg);
    const tag = cfg.baselineTag;
    must(/^qa-baseline-[A-Za-z0-9._-]+$/.test(tag), 'TAG_FORBIDDEN', 'Baseline tag must start qa-baseline-.');
    const foreignChanges = a.statusPorcelain.split('\n').filter(Boolean).filter(x => !x.slice(3).replace(/^"|"$/g, '').startsWith('qa-autopilot/'));
    must(!foreignChanges.length, 'DIRTY_SOURCE', 'Original worktree has user changes. Choose and approve a baseline without resetting or stashing it.', 20);
    must(a.sourceMatchesRemote, 'BASELINE_DIVERGED', 'Local HEAD and origin/main differ. A baseline decision is required.', 20);
    if (!apply)
        return { dryRun: true, baseSha: a.head, tag, workRoot: cfg.repoRoot, branch: cfg.qaBranch };
    must(cfg.authorization?.remoteWriteEnabled && cfg.authorization?.controllerIsolationVerified, 'WRITE_NOT_AUTHORIZED', 'Baseline remote writes require approval.', 20);
    must(!fs.existsSync(cfg.repoRoot), 'WORKROOT_EXISTS', 'Do not overwrite an existing checkout.');
    const runtime = path.join(cfg.qaRoot, '.runtime');
    fs.mkdirSync(runtime, { recursive: true });
    noLinks(cfg.qaRoot, runtime);
    const rel = path.relative(runtime, cfg.repoRoot);
    must(rel.startsWith('workspaces' + path.sep) && !rel.includes('..'), 'WORKROOT_ESCAPE', 'Work checkout must be under QA .runtime/workspaces.');
    const env = isolatedEnv(path.join(runtime, 'bootstrap'));
    const srcCfg = { ...cfg, repoRoot: cfg.sourceRoot };
    const origin = git(srcCfg, ['remote', 'get-url', 'origin']);
    fs.mkdirSync(path.dirname(cfg.repoRoot), { recursive: true });
    commandSync(cfg.tools?.git || 'git', ['clone', '--no-local', '--no-hardlinks', '--no-checkout', cfg.sourceRoot, cfg.repoRoot], { env, timeout: 120000 });
    git(cfg, ['remote', 'set-url', 'origin', origin]);
    git(cfg, ['checkout', '-b', branchName(cfg.qaBranch), a.head]);
    const refs = parseRemoteRefs(git(cfg, ['ls-remote', 'origin', 'refs/tags/' + tag, 'refs/tags/' + tag + '^{}', 'refs/heads/' + cfg.qaBranch]));
    must(!refs.has('refs/tags/' + tag) && !refs.has('refs/heads/' + cfg.qaBranch), 'BASELINE_EXISTS', 'A prior baseline or QA branch exists; verify and resume instead of overwriting.', 20);
    git(cfg, ['tag', '-a', tag, a.head, '-m', 'QA baseline ' + a.head]);
    git(cfg, ['push', '--atomic', 'origin', `refs/tags/${tag}:refs/tags/${tag}`, `HEAD:refs/heads/${cfg.qaBranch}`]);
    const verified = parseRemoteRefs(git(cfg, ['ls-remote', 'origin', `refs/tags/${tag}^{}`, 'refs/heads/' + cfg.qaBranch]));
    must(verified.get(`refs/tags/${tag}^{}`) === a.head && verified.get('refs/heads/' + cfg.qaBranch) === a.head, 'BASELINE_UNCONFIRMED', 'Remote baseline verification failed.', 20);
    return { baseSha: a.head, tag, branch: cfg.qaBranch, status: 'REMOTE_BASELINE_CONFIRMED', note: 'Uncommitted user changes were not included.' };
}
module.exports = { git, branchName, allowedOrigin, head, assertRepo, snapshot, changedFiles, validateChanges, parseRemoteRefs, remoteHead, audit, verifyReceipt, commitPush, baseline };
