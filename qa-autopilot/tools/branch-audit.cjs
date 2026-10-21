#!/usr/bin/env node
'use strict';
/**
 * B00-A · 多仓库只读分支审计
 *
 * 只读合同：本工具只调用下表 ALLOWED 内的 git 子命令，且永不调用会写远程或改本地引用的命令。
 * 明确不执行：fetch（含 --prune）、merge、push、branch -d/-D、checkout、reset、tag、update-ref、config。
 * 远程事实一律通过 `git ls-remote`（只读查询）与 `gh api`（只读查询）获取。
 *
 * 输出：reports/branches/BRANCH_INVENTORY.json（机读）
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const qaRoot = path.resolve(__dirname, '..');
const OUT = path.join(qaRoot, 'reports', 'branches', 'BRANCH_INVENTORY.json');

const ALLOWED_GIT = new Set([
  'rev-parse', 'status', 'remote', 'branch', 'worktree', 'ls-remote',
  'merge-base', 'rev-list', 'log', 'diff', 'for-each-ref', 'show', 'cat-file',
  'ls-tree', 'symbolic-ref', 'describe', 'rev-parse'
]);

function git(repo, args, allowFail = true) {
  const sub = args[0];
  if (!ALLOWED_GIT.has(sub)) throw new Error('READONLY_VIOLATION: git ' + sub);
  try {
    const out = execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe']
    });
    return { ok: true, out: out.trim() };
  } catch (e) {
    if (!allowFail) throw e;
    return { ok: false, out: '', error: String(e.stderr || e.message).trim().split('\n')[0] };
  }
}

function gh(args) {
  try {
    const out = execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, out: out.trim() };
  } catch (e) {
    return { ok: false, out: '', error: String(e.stderr || e.message).trim().split('\n')[0] };
  }
}

function lines(s) { return s ? s.split('\n').map(x => x.trim()).filter(Boolean) : []; }

/** 目标仓库清单：本地路径必须现场确认，缺失记 BLOCKED_LOCAL_REPO_PATH，不猜路径。 */
const TARGETS = [
  { id: 'project-knowledge-base', slug: 'SanQianX/project-knowledge-base', localPath: 'D:/SanQian.Xu/project-knowledge-base' },
  { id: 'Claude-Ai-Workbench', slug: 'SanQianX/Claude-Ai-Workbench', localPath: 'D:/SanQian.Xu/claude-ai-workbench' },
  { id: 'vector-hub', slug: 'SanQianX/vector-hub', localPath: 'D:/SanQian.Xu/vector-hub' },
  { id: 'ai-coding-event-bridge', slug: 'SanQianX/ai-coding-event-bridge', localPath: 'D:/SanQian.Xu/ai-coding-event-bridge' },
  { id: 'knowledge-engine', slug: 'SanQianX/knowledge-engine', localPath: 'D:/SanQian.Xu/knowledge-engine' }
];

function auditRepo(t) {
  const out = { id: t.id, slug: t.slug, localPath: t.localPath };
  if (!fs.existsSync(t.localPath) || !fs.existsSync(path.join(t.localPath, '.git'))) {
    out.blocked = 'BLOCKED_LOCAL_REPO_PATH';
    out.reason = 'Local source directory is absent or is not a Git repository.';
    return out;
  }
  const R = t.localPath;

  out.toplevel = git(R, ['rev-parse', '--show-toplevel']).out;
  out.head = git(R, ['rev-parse', 'HEAD']).out;
  out.currentBranch = git(R, ['rev-parse', '--abbrev-ref', 'HEAD']).out;
  out.statusPorcelain = git(R, ['status', '--porcelain=v1']).out;
  out.dirtyFiles = lines(out.statusPorcelain);
  out.remotes = lines(git(R, ['remote', '-v']).out);

  // ---- 本地分支 ----
  const branches = [];
  const vv = git(R, ['branch', '-vv', '--format=%(refname:short)|%(objectname)|%(upstream:short)|%(upstream:track)|%(worktreepath)']).out;
  for (const row of lines(vv)) {
    const [name, sha, upstream, track, worktree] = row.split('|');
    branches.push({ name, headSHA: sha, upstream: upstream || null, track: track || null, worktreePath: worktree || null });
  }
  out.localBranches = branches;

  // ---- 远程跟踪引用（本地缓存，可能过期）----
  out.remoteTrackingRefs = lines(git(R, ['branch', '-r']).out).map(s => s.replace(/^origin\//, ''));

  // ---- 远程真实分支（ls-remote，只读）----
  const heads = git(R, ['ls-remote', '--heads', 'origin']).out;
  out.remoteHeads = [];
  for (const l of lines(heads)) {
    const [sha, ref] = l.split(/\s+/);
    out.remoteHeads.push({ ref: ref.replace('refs/heads/', ''), sha });
  }
  const tags = git(R, ['ls-remote', '--tags', 'origin']).out;
  out.remoteTags = lines(tags)
    .filter(l => !l.includes('^{}'))
    .map(l => { const [sha, ref] = l.split(/\s+/); return { tag: ref.replace('refs/tags/', ''), sha }; });

  // ---- 远程跟踪引用与真实远程的差异（不 prune，只报告）----
  const remoteNames = new Set(out.remoteHeads.map(h => h.ref));
  out.staleRemoteTrackingRefs = out.remoteTrackingRefs.filter(r => !remoteNames.has(r));
  out.missingRemoteTrackingRefs = out.remoteHeads.map(h => h.ref).filter(r => !out.remoteTrackingRefs.includes(r));

  // ---- worktree ----
  const wt = git(R, ['worktree', 'list', '--porcelain']).out;
  const worktrees = [];
  let cur = null;
  // porcelain 输出以空行分隔各 worktree 记录；不能用 lines()，它会丢掉分隔空行。
  for (const l of wt.split('\n')) {
    const s = l.trim();
    if (s === '') { if (cur && cur.path) worktrees.push(cur); cur = null; continue; }
    if (s.startsWith('worktree ')) { cur = { path: s.slice(9) }; continue; }
    if (!cur) continue;
    if (s.startsWith('HEAD ')) cur.head = s.slice(5);
    else if (s.startsWith('branch ')) cur.branch = s.slice(7).replace('refs/heads/', '');
    else if (s === 'detached') cur.detached = true;
  }
  if (cur && cur.path) worktrees.push(cur);
  out.worktrees = worktrees;

  // ---- GitHub 事实（只读 API）----
  const meta = gh(['api', `repos/${t.slug}`]);
  if (meta.ok) {
    try {
      const j = JSON.parse(meta.out);
      out.github = { defaultBranch: j.default_branch, visibility: j.visibility, archived: j.archived, pushedAt: j.pushed_at, size: j.size };
    } catch { /* ignore */ }
  } else out.githubError = meta.error;
  const prs = gh(['api', `repos/${t.slug}/pulls?state=open&per_page=50`]);
  out.openPullRequests = prs.ok ? (JSON.parse(prs.out) || []).map(p => ({ number: p.number, head: p.head.label, base: p.base.label, title: p.title, draft: p.draft })) : [];
  const runs = gh(['run', 'list', '--repo', t.slug, '--limit', '25', '--json', 'databaseId,name,headBranch,headSha,status,conclusion,createdAt,event']);
  out.ciRuns = runs.ok ? JSON.parse(runs.out) : [];
  out.ciFailureSummary = out.ciRuns.filter(r => r.conclusion && r.conclusion !== 'success' && r.conclusion !== 'skipped')
    .map(r => ({ id: r.databaseId, workflow: r.name, branch: r.headBranch, sha: r.headSha, conclusion: r.conclusion, status: r.status, createdAt: r.createdAt }));
  const br = gh(['api', `repos/${t.slug}/branches/${(out.github && out.github.defaultBranch) || 'main'}/protection`]);
  out.branchProtection = br.ok ? 'PROTECTED' : 'NONE_OR_UNAVAILABLE';
  out.branchProtectionError = br.ok ? null : br.error;

  // ---- 分支关系（相对远程默认分支）----
  // 比较基准固定使用远程跟踪引用 origin/<base>：本地 main 可能陈旧甚至不存在
  // （Workbench 仓库没有本地 main），用本地分支会得出错误的 ahead/behind。
  const base = out.github && out.github.defaultBranch ? out.github.defaultBranch : 'main';
  const baseRef = `origin/${base}`;
  out.comparisonBase = base;
  out.comparisonBaseRef = baseRef;
  out.comparisonBaseSHA = (out.remoteHeads.find(h => h.ref === base) || {}).sha || null;
  out.comparisonBaseLocalSHA = (git(R, ['rev-parse', '--verify', '--quiet', base]).out || null);
  out.comparisonBaseIsStale = out.comparisonBaseLocalSHA ? out.comparisonBaseLocalSHA !== out.comparisonBaseSHA : null;
  out.branchRelations = [];
  for (const b of branches) {
    const rel = { name: b.name, headSHA: b.headSHA, upstream: b.upstream, track: b.track, worktreePath: b.worktreePath };
    const lr = git(R, ['rev-list', '--left-right', '--count', `${baseRef}...${b.name}`]);
    if (lr.ok) {
      const [behind, ahead] = lr.out.split(/\s+/).map(Number);
      rel.behind = behind; rel.ahead = ahead;
      const mb = git(R, ['merge-base', baseRef, b.name]);
      rel.mergeBaseSHA = mb.ok ? mb.out : null;
      rel.ancestorOfBase = git(R, ['merge-base', '--is-ancestor', b.name, baseRef]).ok;
      rel.baseIsAncestor = git(R, ['merge-base', '--is-ancestor', baseRef, b.name]).ok;
      rel.classification = rel.ancestorOfBase === true ? 'ALREADY_INCLUDED'
        : rel.baseIsAncestor === true ? 'FAST_FORWARD_CANDIDATE' : 'DIVERGED';
      const uniq = git(R, ['log', '--format=%H', `${baseRef}..${b.name}`]);
      rel.uniqueCommitCount = uniq.ok ? lines(uniq.out).length : null;
      const ds = git(R, ['diff', '--name-status', `${baseRef}...${b.name}`]);
      rel.changedFiles = ds.ok ? lines(ds.out).length : null;
      rel.uniqueCommits = uniq.ok ? lines(uniq.out).slice(0, 40).map(sha => {
        const lg = git(R, ['log', '-1', '--format=%h|%s|%cI', sha]);
        const p = lg.ok ? lg.out.split('|') : [sha, '', ''];
        return { sha: p[0], subject: p[1], date: p[2] };
      }) : [];
    } else rel.error = lr.error;
    out.branchRelations.push(rel);
  }

  // ---- 远程分支相对默认分支 ----
  out.remoteBranchRelations = [];
  for (const h of out.remoteHeads) {
    if (h.ref === base) { out.remoteBranchRelations.push({ name: h.ref, sha: h.sha, role: 'DEFAULT_BRANCH' }); continue; }
    out.remoteBranchRelations.push(relation(R, h.ref, h.sha, `origin/${base}`, base));
  }
  // ---- 远程分支相对 origin/main（收敛目标恒为 main，不随默认分支漂移）----
  out.remoteBranchRelationsVsMain = [];
  const hasOriginMain = out.remoteHeads.some(h => h.ref === 'main');
  for (const h of out.remoteHeads) {
    if (!hasOriginMain) break;
    if (h.ref === 'main') { out.remoteBranchRelationsVsMain.push({ name: h.ref, sha: h.sha, role: 'CONSOLIDATION_TARGET' }); continue; }
    out.remoteBranchRelationsVsMain.push(relation(R, h.ref, h.sha, 'origin/main', 'main'));
  }
  // ---- 本地分支相对 origin/main（收敛目标恒为 main）----
  out.localBranchRelationsVsMain = [];
  if (hasOriginMain) {
    for (const b of branches) {
      if (b.name === 'main') { out.localBranchRelationsVsMain.push({ name: b.name, headSHA: b.headSHA, role: 'CONSOLIDATION_TARGET', worktreePath: b.worktreePath }); continue; }
      out.localBranchRelationsVsMain.push(relation(R, b.name, b.headSHA, 'origin/main', 'main'));
    }
  }
  return out;
}

/** 计算 branch 相对 base 的合并关系，只读。 */
function relation(R, name, sha, baseRef, baseLabel) {
  const rel = { name, sha, base: baseLabel };
  const lr = git(R, ['rev-list', '--left-right', '--count', `${baseRef}...${name}`]);
  if (!lr.ok) { rel.error = lr.error; return rel; }
  const [behind, ahead] = lr.out.split(/\s+/).map(Number);
  rel.behind = behind; rel.ahead = ahead;
  rel.mergeBaseSHA = (git(R, ['merge-base', baseRef, name]).out || null);
  rel.ancestorOfBase = git(R, ['merge-base', '--is-ancestor', name, baseRef]).ok;
  rel.baseIsAncestor = git(R, ['merge-base', '--is-ancestor', baseRef, name]).ok;
  rel.fastForwardPossible = rel.baseIsAncestor === true;
  rel.classification = rel.ancestorOfBase === true ? 'ALREADY_INCLUDED'
    : rel.baseIsAncestor === true ? 'FAST_FORWARD_CANDIDATE'
      : 'DIVERGED';
  const uniq = git(R, ['log', '--format=%H', `${baseRef}..${name}`]);
  rel.uniqueCommitCount = uniq.ok ? lines(uniq.out).length : null;
  rel.uniqueCommits = uniq.ok ? lines(uniq.out).slice(0, 40).map(s => {
    const lg = git(R, ['log', '-1', '--format=%h|%s|%cI', s]);
    const p = lg.ok ? lg.out.split('|') : [s, '', ''];
    return { sha: p[0], subject: p[1], date: p[2] };
  }) : [];
  const ds = git(R, ['diff', '--name-status', `${baseRef}...${name}`]);
  rel.changedFiles = ds.ok ? lines(ds.out).length : null;
  return rel;
}

function main() {
  const result = {
    schema: 'qa-autopilot/branch-inventory/v1',
    phase: 'B00-A',
    mode: 'READ_ONLY',
    generatedAt: new Date().toISOString(),
    platform: { platform: process.platform, node: process.version },
    guarantees: {
      readOnlyGitSubcommands: [...ALLOWED_GIT].sort(),
      notExecuted: ['fetch', 'fetch --prune', 'merge', 'push', 'branch -d', 'branch -D', 'checkout', 'reset', 'tag', 'update-ref'],
      remoteWrites: 'NONE',
      defaultBranchChanges: 'NONE',
      note: '远程事实来自 git ls-remote 与 gh api；本地 remote-tracking 引用未被 prune，仅作为差异报告。'
    },
    repos: []
  };
  for (const t of TARGETS) {
    try { result.repos.push(auditRepo(t)); }
    catch (e) { result.repos.push({ id: t.id, slug: t.slug, localPath: t.localPath, blocked: 'AUDIT_ERROR', reason: String(e.message) }); }
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify({
    status: 'PASS', phase: 'B00-A', mode: 'READ_ONLY',
    output: OUT,
    repos: result.repos.map(r => ({
      id: r.id, head: r.head || null, defaultBranch: (r.github && r.github.defaultBranch) || null,
      localBranches: (r.localBranches || []).length, remoteHeads: (r.remoteHeads || []).length,
      staleRemoteTrackingRefs: (r.staleRemoteTrackingRefs || []).length,
      worktrees: (r.worktrees || []).length,
      openPullRequests: (r.openPullRequests || []).length,
      blocked: r.blocked || null
    }))
  }, null, 2));
}
if (require.main === module) main();
module.exports = { auditRepo, TARGETS };
