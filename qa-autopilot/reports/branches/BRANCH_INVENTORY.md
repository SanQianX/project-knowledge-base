# B00-A · 多仓库分支清单（只读审计）

- 阶段：**B00-A（只读）**　模式：`READ_ONLY`　日期：2026-10-20
- 主机：Windows 10.0.19045 x64，Node v24.13.0，git for Windows，GitHub CLI 2.96.0（账号 SanQianX，scope `repo,workflow`）
- 机读数据：[`BRANCH_INVENTORY.json`](./BRANCH_INVENTORY.json)（由 `node tools/branch-audit.cjs` 生成）
- 模块来源校验：[`MODULE_SOURCE_MATCH.json`](./MODULE_SOURCE_MATCH.json)（由 `node tools/module-source-match.cjs` 生成）

## 0. 本次只读保证

工具 `qa-autopilot/tools/branch-audit.cjs` 只允许调用以下 git 子命令：`rev-parse, status, remote, branch, worktree, ls-remote, merge-base, rev-list, log, diff, for-each-ref, show, cat-file, ls-tree, symbolic-ref, describe`；任何其他子命令会抛 `READONLY_VIOLATION` 直接失败。

**本次未执行、且本阶段无权执行**：`fetch`（含 `--prune`）、`merge`、`push`、`branch -d/-D`、`checkout`、`reset`、`tag`、`update-ref`，以及任何 GitHub 默认分支或仓库设置修改。所有远程事实来自 `git ls-remote` 与 `gh api` 只读查询；本地 `remote-tracking` 引用**未执行 prune**，仅作为差异报告列出。

用户工作区的未提交修改未被触碰、未被暂存、未被提交。

## 1. 执行摘要

1. **五个独立仓库全部在本机找到并确认 origin 归属**；主项目的 `_modules/knowledge-engine` 是**内嵌副本而非独立 Git 仓库**（无 `.git`），符合 B00 计划“不得仅凭目录名认定”的警告。
2. **Workbench 的 0.13.6 来源已用哈希证明**：`origin/agent/sdk-productization` @ `423cc0a` 的 124 个文件与主项目 `module-runtime-manifest.json` 的 124 个哈希**逐字节全部相等**。GitHub `main`（`be654e2`）是 **0.3.0 的未加 scope 旧血脉**，绝不可作为 0.13.6 的修复源。
3. **Event Bridge 的默认分支就是 feature 分支**（GitHub 默认分支 = `feat/ai-coding-event-bridge`），且该分支 head 的 CI **处于失败状态**，失败根因已定位为**过期 CI 工作流**引用了已被删除的 workspace。
4. **发布可追溯性存在真实缺口**：主项目远程**没有任何 v5.x tag**，Workbench 远程**没有任何 v0.13.x tag**，但 npm 上已发布 5.0.24 / 0.13.6；这些 tag 只存在于本机。
5. **三个仓库的本地 `main` 与远程 `main` 不一致**，其中两个本地领先远程（未推送提交），必须先保护再谈收敛。

## 2. 仓库清单

| 仓库 | 本地路径 | origin | 可见性 | GitHub 默认分支 | 分支保护 | 本地 HEAD | 远程 HEAD |
|---|---|---|---|---|---|---|---|
| project-knowledge-base | `D:/SanQian.Xu/project-knowledge-base` | `SanQianX/project-knowledge-base` | public | `main` | 无 | `81a2362` (qa/continuous-repair-20261020) | `c7d5b2b` |
| Claude-Ai-Workbench | `D:/SanQian.Xu/claude-ai-workbench` | `SanQianX/Claude-Ai-Workbench` | **private** | `main` | 无（免费版不支持） | `1c52bb8` (agent/sdk-productization) | `423cc0a` |
| vector-hub | `D:/SanQian.Xu/vector-hub` | `SanQianX/vector-hub` | public | `main` | 无 | `b6dce20` (main) | `b6dce20` |
| ai-coding-event-bridge | `D:/SanQian.Xu/ai-coding-event-bridge` | `SanQianX/ai-coding-event-bridge` | public | **`feat/ai-coding-event-bridge`** | 无 | `0ada7ac` (feat/…) | `0ada7ac` / `8717068` |
| knowledge-engine | `D:/SanQian.Xu/knowledge-engine` | `SanQianX/knowledge-engine` | public | `main` | 无 | `85c618f` (main，**未推送**) | `1bfa9a5` |

所有仓库均**无未完成 PR**（open PR 数量为 0），因此没有分支被 PR 引用。

## 3. 逐仓库分支清单

分类口径：`ALREADY_INCLUDED` = head 是 `origin/main` 的祖先；`FAST_FORWARD_CANDIDATE` = `origin/main` 是 head 的祖先；`DIVERGED` = 双向都有独有提交。基准一律为**远程跟踪引用 `origin/main`**，不使用可能陈旧的本地 `main`。

### 3.1 project-knowledge-base（主项目）

远程分支只有两个：`main` @ `c7d5b2b`、`codex/native-agent-context` @ `5bbcb52`。本地 `main` @ `5f243e1` **落后 83 个提交**。

| 本地分支 | headSHA | 上游 | 相对 origin/main | 独有提交 | 变更文件 | worktree | 分类 | 处置候选 |
|---|---|---|---|---|---|---|---|---|
| `main` | `5f243e1` | origin/main **[behind 83]** | — | 0 | 0 | 否 | STALE_LOCAL | 可 `git merge --ff-only origin/main` 推进（仅本地，无远程写） |
| `qa/continuous-repair-20261020` | `81a2362` | 无 | behind 9 / **ahead 1** | 1 | 66 | **是（主工作区）** | DIVERGED | **保留**：QA 修复分支，合并需用户批准 |
| `codex/native-agent-context` | `ff7a89b` | origin/… **[ahead 1]** | behind 9 / ahead 0 | 0 | 0 | 否 | ALREADY_INCLUDED | 远程分支已可归档；本地分支含 1 个已并入 main 的提交 |
| `codex/fix-knowledge-panel-product-ui` | `c7d5b2b` | 无 | 0 / 0 | 0 | 0 | **是** | ALREADY_INCLUDED | 与 `origin/main` 同 SHA，本地别名；占用 worktree |
| `codex/right-dock-k1-knowledge-panel` | `e7204fb` | 无 | behind 5 / ahead 0 | 0 | 0 | **是** | ALREADY_INCLUDED | 同上；`v5.0.20` 指向此 SHA |
| `codex/p0-data-migration-and-hook-events` | `cc76263` | 无 | behind 198 / ahead 0 | 0 | 0 | 否 | ALREADY_INCLUDED | 已归档候选 |
| `codex/v4.1.3` … `codex/v4.1.7` (5 个) | `9c98f3e`…`736a469` | origin/… **[gone]** | behind 279…266 / ahead 0 | 0 | 0 | 否 | ALREADY_INCLUDED | 上游已删除，本地仅存；需 bundle 验证后清理 |
| `refactor/project-knowledge-v13` | `9b503d5` | origin/… **[gone]** | behind 236 / ahead 0 | 0 | 0 | 否 | ALREADY_INCLUDED | 同上；另有一个 detached worktree 占用 |
| `backup/pre-clean-history-20260701-221430` | `752faf3` | 无 | behind 332 / **ahead 50** | **50** | **无法计算** | 否 | **DIVERGED（无共同祖先）** | **禁止删除**：历史重写前的唯一备份 |

`backup/pre-clean-history-20260701-221430` 与 `origin/main` **没有 merge-base**（`git merge-base` 为空），因此 `git diff main...branch` 无法计算变更文件数。这是历史重写前的独立历史线，50 个提交只存在于此处 —— **这是整个主项目最重要的不可再生资产**。

远程分支状态：

| 远程分支 | SHA | 相对 origin/main | 分类 | 备注 |
|---|---|---|---|---|
| `main` | `c7d5b2b` | — | 收敛目标 | CI `39396770653` success |
| `codex/native-agent-context` | `5bbcb52` | behind 9 / ahead 0 | ALREADY_INCLUDED | 无独有提交；远程归档后删除候选 |

活跃开发证据：该分支的历史 CI（`2026-10-15`）有多次 `Non-release validation` 失败，但对应的是**旧 SHA**（`d88fe527`、`d8f490f6` 等）；当前远程 head `5bbcb52` 无失败运行记录。

### 3.2 Claude-Ai-Workbench

**本仓库没有本地 `main` 分支**，`origin/main` = `be654e20`，其 `package.json` 为 **未加 scope 的 `claude-ai-workbench` 0.3.0** —— 与主线血脉完全不同。11 个 worktree 全部被占用。

| 本地分支 | headSHA | 上游 | 相对 origin/main | 独有提交 | 变更文件 | worktree | 分类 |
|---|---|---|---|---|---|---|---|
| `agent/sdk-productization` | `1c52bb8` | origin/… **[behind 37]** | ahead 81 | 81 | 122 | **是（主工作区）** | FAST_FORWARD_CANDIDATE |
| `codex/fix-dock-product-ui` | `423cc0a` | 无 | ahead **118** | 118 | 186 | **是** | FAST_FORWARD_CANDIDATE（= 远程 `agent/sdk-productization`） |
| `codex/release-0.13.2-rc.21` | `2fa60ca` | origin/… | ahead 82 | 82 | 122 | **是** | FAST_FORWARD_CANDIDATE（是 `423cc0a` 的祖先） |
| `codex/right-dock-w4-matrix` | `284a589` | 无 | ahead 114 | 114 | 178 | **是** | FAST_FORWARD_CANDIDATE |
| `codex/right-dock-w3-panel` | `d50cd6d` | 无 | ahead 111 | 111 | 175 | **是** | FAST_FORWARD_CANDIDATE |
| `codex/right-dock-w2-ui` | `c231b30` | 无 | ahead 109 | 109 | 170 | **是** | FAST_FORWARD_CANDIDATE |
| `codex/right-dock-w1-integration` | `51fb69a` | 无 | ahead 108 | 108 | 166 | **是** | FAST_FORWARD_CANDIDATE |
| `codex/right-dock-w1` | `3ae62fc` | 无 | ahead 105 | 105 | 162 | **是** | FAST_FORWARD_CANDIDATE |
| `codex/right-dock-delegation-api` | `53d0ad5` | 无 | ahead 105 | 105 | 164 | **是** | FAST_FORWARD_CANDIDATE |
| `codex/right-dock-native-trace` | `5ae42d2` | 无 | ahead 101 | 101 | 152 | 否 | FAST_FORWARD_CANDIDATE |
| `codex/right-dock-history` | `e196021` | 无 | ahead 100 | 100 | 151 | **是** | FAST_FORWARD_CANDIDATE |
| `codex/right-dock-delegations` | `88c0edc` | 无 | ahead 96 | 96 | 149 | **是** | FAST_FORWARD_CANDIDATE |

**全部 12 个本地分支都是 `origin/main` 的后代**，且彼此成链：`origin/main` → … → `2fa60ca`(0.13.2-rc.21) → `1c52bb8`(0.13.2-rc.20) → … → `423cc0a`(0.13.6)。因此 **`origin/main` 可以一次性 fast-forward 到 `423cc0a`**，从而同时包含所有开发分支的内容；`codex/release-0.13.2-rc.21` 的 82 个提交全部包含在 `423cc0a` 的 118 个提交之内（`2fa60ca` 是 `423cc0a` 的祖先）。

**未提交修改（必须保留）**：`D:/SanQian.Xu/claude-ai-workbench` 工作区有 7 处改动 —— `docs/sdk/openapi.yaml`、`packages/{client,contracts,core,server,ui}/package.json`（M），以及未跟踪目录 `docs/plans/`。这些是本地活跃开发内容，本阶段不得清理、不得 stash 覆盖、不得 checkout。

远程分支：

| 远程分支 | SHA | 相对 origin/main | 分类 | 备注 |
|---|---|---|---|---|
| `main` | `be654e2` | — | 收敛目标 | 0.3.0 旧血脉 |
| `agent/sdk-productization` | `423cc0a` | behind 0 / ahead **118** | FAST_FORWARD_CANDIDATE | **0.13.6**，即主项目锁定的模块来源 |
| `codex/release-0.13.2-rc.21` | `2fa60ca` | behind 0 / ahead 82 | FAST_FORWARD_CANDIDATE | 已包含在 `423cc0a` 中 |

### 3.3 vector-hub

单一分支，干净，无 worktree 占用，无未提交修改。本地 `main` = `origin/main` = `b6dce20`。

| 远程分支 | SHA | 相对 origin/main | 分类 | 备注 |
|---|---|---|---|---|
| `main` | `b6dce20` | — | 收敛目标 | `package.json` 版本 `1.0.8-rc.8` |

**该仓库无需任何分支变更。** 注意 `npm view` 显示 `latest=1.0.7`、`next=1.0.8-rc.8`，而 Git 端唯一 tag 是 `v1.0.3` —— 发布版本与 Git tag 不同步。

### 3.4 ai-coding-event-bridge

GitHub 默认分支 = feature 分支。远程 `main` @ `8717068` 是 `feat/ai-coding-event-bridge` @ `0ada7ac` 的**严格祖先**。

| 远程分支 | SHA | 相对 origin/main | 分类 | 备注 |
|---|---|---|---|---|
| `main` | `8717068` | — | 收敛目标 | 上次 CI success（`35516650220`，2026-09-20） |
| `feat/ai-coding-event-bridge` | `0ada7ac` | behind 0 / ahead **8** | FAST_FORWARD_CANDIDATE | 91 个文件变更；**也是 GitHub 默认分支** |

本地仅有 `feat/ai-coding-event-bridge` @ `0ada7ac`（= 远程），工作区干净。

### 3.5 knowledge-engine

| 本地/远程分支 | SHA | 相对 origin/main | 分类 | 备注 |
|---|---|---|---|---|
| 本地 `main` | `85c618f` | **ahead 1** | 未推送提交 | `fix: preserve quota failure reasons and expose pre-queue journal faults` |
| 远程 `main` | `1bfa9a5` | — | 收敛目标 | 无任何 tag |

**该仓库完全没有任何 release tag**（本地与远程均为 0 个）。

## 4. 模块源码来源校验（差异 C02）

工具：`node tools/module-source-match.cjs`。判据是主项目 `module-runtime-manifest.json` / `vendor-manifest.json` 里的 sha256 与独立仓库对应 commit 的 blob 字节。

| 模块 | 主项目锁定版本 | 匹配到的仓库 commit | 判定 | 计数 |
|---|---|---|---|---|
| terminal (`@sanqianx/claude-ai-workbench`) | **0.13.6** | `origin/agent/sdk-productization` @ `423cc0a` | **ALL_BYTES_MATCH** | exact 124 / mismatch 0 / missing 0 |
| vectorHub (`@sanqianx/vector-hub`) | 1.0.8-rc.8 | 无 | **NO_EXACT_REV_MATCH** | exact 2 / crlf-eq 2 / **missing 55** |
| eventBridge (`@sanqianx/ai-coding-event-bridge-console`) | 0.7.2 | `feat/ai-coding-event-bridge` @ `0ada7ac` | **ALL_BYTES_MATCH** | exact 37 + crlf-eq 1 / mismatch 0 |
| knowledge-engine (`_modules/` 内嵌) | 0.2.7-rc.10 | 本地 `main` @ `85c618f` | **CONTENT_MATCH_EOL_ONLY** | exact 29 + crlf 7 + eol-mixed 6 / mismatch 0 / missing 0 |

补充证据：

- **Workbench**：以**本地**分支名 `agent/sdk-productization`（即陈旧的 `1c52bb8`）比对时只有 70/124 命中并缺 23 个文件；只有以**远程 SHA `423cc0a`** 比对才是 124/124 逐字节相等。npm `@sanqianx/claude-ai-workbench@0.13.6` 的 `gitHead` 为空，但哈希链已证明来源。
- **vector-hub**：55 个缺失文件全部位于 `dist/`（构建产物），仓库中 `dist/` 文件数为 **0**，因此无法从 Git 字节级复原。npm `@sanqianx/vector-hub@1.0.8-rc.8` 的 `gitHead` = `ebf6f586a534c4b851c919c53a5536671cc8bd12`，该 commit **确实存在于仓库且是 `main` 的祖先**（落后 main 1 个提交）—— 即源码可定位，但制品字节需用 npm tarball 比对。
- **event-bridge**：唯一不一致的 `src/pick-folder.js` 经确认为 **CRLF 行尾差异**（仓库 blob 为 LF，npm 制品为 CRLF），CRLF 化后哈希完全相等。npm `@sanqianx/ai-coding-event-bridge-console@0.7.2` 的 `gitHead` = `0ada7acc1332ac475680acdd33d41af7dc6a7897`，与默认分支 head **完全一致**。
- **knowledge-engine**：在 `origin/main`（`1bfa9a5`）上比对为 exact 23 / crlf 7 / **mismatch 11 / missing 1**（`src/analysis-failures.js` 在远程不存在）；在**本地未推送的 `main`**（`85c618f`）上则为 **0 mismatch / 0 missing**。即：主项目内嵌的 knowledge-engine 对应的是 **尚未推送的本地提交**。

## 5. CI、PR 与发布依赖

| 仓库 | 当前默认分支 CI | 观察 |
|---|---|---|
| project-knowledge-base | `main` @ `c7d5b2b` → `39396770653` **success** | `ci.yml` 触发条件为 branches（push），不触发 tag |
| Claude-Ai-Workbench | 无分支级 CI 运行记录 | 历史 CI 运行全部挂在 release tag（v0.x），最近一次 success；3 次 `v0.4.1` Publish 失败为 2026-09-21 旧记录 |
| vector-hub | 无分支级 CI 运行记录 | 仅 1 次 `v1.0.3` **Publish to npm failure**（2026-09-21） |
| ai-coding-event-bridge | `feat/ai-coding-event-bridge` @ `0ada7ac` → `38064016412` **failure** | 见下方根因 |
| knowledge-engine | **无任何 CI 运行记录** | 仓库无工作流或从未触发 |

### 5.1 Event Bridge CI 失败的根因（已定位，非猜测）

失败运行 `38064016412`（2026-10-10，sha `0ada7ac`）：

- `Core / Node 18.x / Linux` 与 `Core / Node 24.x / Linux`：失败于 `npm pack --workspace packages/core --dry-run`
- `Core / Node 24.x / Windows`：失败于 `npm test`

根因：提交 `13f7950`（*refactor!: consolidate into one self-contained package — core folded into console (0.6.0)*）**删除了 `packages/core` 与 `packages/ui`**，并同步更新了 `publish.yml`，**但没有同步更新 `.github/workflows/ci.yml`**。当前 `ci.yml` 仍执行：

```yaml
- run: npm pack --workspace packages/core --dry-run
- run: npm pack --workspace packages/ui --dry-run
- run: npm pack --workspace packages/console --dry-run
```

而 `0ada7ac` 的 `packages/` 下**只剩 `console` 一个目录**。即：**CI 失败是过期工作流引用已删除 workspace，不是 0.7.2 代码回归**。`main`（`8717068`）的 CI 是 success。

Windows 上的 `npm test` 失败是**独立于上述工作流问题的第二个失败**，根因尚未定位，列为待查项。

### 5.2 发布触发与 dist-tag 现状

- 主项目 `publish.yml`：`on: tags:` 触发，执行 `npm publish --provenance --access public --loglevel verbose` —— **没有 `--tag next`**。按 npm 默认行为，v\* tag 会发布到 `latest`。这是差异 C03 的**实测确认**（静态发布风险，非已发生事故）。
- 当前 npm dist-tags：`@sanqianx/project-knowledge` **`latest=5.0.24` 且 `next=5.0.24`（两者相同）**；`@sanqianx/vector-hub` `latest=1.0.7`、`next=1.0.8-rc.8`；`@sanqianx/claude-ai-workbench` `latest=next=0.13.6`。
  → **`next` 与 `latest` 指向同一版本，意味着今天 `npm install --tag next` 拿到的就是正式版**。T04/T11 的 RC 隔离必须在发布前先把 `next` 与 `latest` 解耦，否则候选验证无法证明自己装的是候选包。

## 6. Tag 与发布可追溯性

| 仓库 | 远程 tag | 本地独有 tag（远程没有） | 已发布但远程无 tag 的版本 |
|---|---|---|---|
| project-knowledge-base | 72 个，止于 `v4.7.0` | **8 个**：`v5.0.18`、`v5.0.18-rc.1`…`rc.4`、`v5.0.20`、`v5.0.20-rc.1`、`v5.0.21` | npm 已发布 5.0.19 / 5.0.20 / 5.0.21 / 5.0.22 / 5.0.23 / **5.0.24**，远程无任何 v5\* tag |
| Claude-Ai-Workbench | 12 个，止于 `v0.11.0` | **6 个**：`v0.13.2`、`v0.13.2-rc.18`…`rc.20`、`v0.13.2-rc.22`、`v0.13.3` | npm 已发布 **0.13.6**，远程无任何 v0.13\* tag |
| vector-hub | 1 个 `v1.0.3` | 无 | npm 已发布 1.0.7 / 1.0.8-rc.8，无对应 tag |
| ai-coding-event-bridge | 1 个 `v0.1.2` | 无 | npm 已发布 0.7.2，无对应 tag |
| knowledge-engine | **0 个** | 无 | npm 最高 0.2.7-rc.9，内嵌副本为 0.2.7-rc.10 |

缓解事实：本地 tag 指向的 commit **本身都在远程历史里**（例：`v5.0.21` = `459ae9d`，是 `origin/main` 的祖先；`v5.0.20` = `e7204fb`，同在历史中）。因此**内容可按 SHA 追溯**，但 `git describe` / 基于 tag 的版本解析不可用 —— 任何依赖 tag 的发布校验脚本在远程都会失效。

主项目与 Workbench 已发布版本的 npm `gitHead` 字段**为空**，缺少包到 commit 的机器可读链接；event-bridge 与 vector-hub 的 `gitHead` 则有效。

## 7. 风险矩阵

| ID | 仓库 | 风险 | 证据 | 等级 |
|---|---|---|---|---|
| R1 | project-knowledge-base | `backup/pre-clean-history-20260701-221430` 无 merge-base，50 个独有提交只此一份 | `git merge-base origin/main backup/…` 为空 | **高（不可再生）** |
| R2 | Claude-Ai-Workbench | 本地工作区有 7 处未提交修改，且本地分支落后远程 37 | `git status --porcelain=v1` | **高（用户数据）** |
| R3 | Claude-Ai-Workbench | 本地**没有** `main` 分支；`origin/main` 是 0.3.0 旧血脉，118 个提交不在 main 上 | `git branch -a`、`package.json` 版本 0.3.0 | **高（易误用旧 main 修 0.13.6）** |
| R4 | ai-coding-event-bridge | 默认分支是 feature 分支，且其 head CI 失败 | `gh api repos/...` default_branch、`38064016412` failure | **高** |
| R5 | knowledge-engine | 本地 main 有 1 个未推送提交；主项目内嵌副本正对应这个未推送状态 | `git rev-list --left-right --count origin/main...main` = `0 1` | **中高** |
| R6 | 全部 | 远程缺 v5\*/v0.13\* tag，已发布版本无远程 release tag | `git ls-remote --tags origin` | **中（可追溯性）** |
| R7 | 主项目 | `publish.yml` 无 `--tag next`；当前 `next`==`latest`==5.0.24 | workflow 内容 + `npm view dist-tags` | **中（影响 T11/T12）** |
| R8 | 全部 | 无分支保护、无必需评审；`main` 可被直接推送 | `gh api …/branches/main/protection` → 404 | **中** |
| R9 | vector-hub | `dist/` 不入库，1.0.8-rc.8 制品无法字节级复核 | `git ls-tree` 中 dist/ 计数 = 0 | **中** |
| R10 | knowledge-engine | 仓库无任何 CI 运行记录 | `gh run list` 为空 | **中** |
| R11 | event-bridge | Windows Node 24 上 `npm test` 失败（根因未定位） | run `38064016412` | **中** |

## 8. 分类汇总与处置候选

| 分类 | 数量 | 涉及 ref |
|---|---|---|
| ALREADY_INCLUDED | 12 | 主项目 11 个本地 `codex/*` + `refactor/*`；Workbench 远程 `codex/release-0.13.2-rc.21` 的内容已被 `423cc0a` 包含 |
| FAST_FORWARD_CANDIDATE | 3 仓库 | Workbench `origin/agent/sdk-productization`(+118)、Event Bridge `feat/ai-coding-event-bridge`(+8)、主项目 `qa/continuous-repair-20261020`（相对其分叉点） |
| DIVERGED | 2 | 主项目 `backup/pre-clean-history-20260701-221430`（无 merge-base）、主项目 `qa/continuous-repair-20261020`（ahead 1 / behind 9） |
| ACTIVE_OR_EXTERNAL_DEPENDENCY | 16 worktree 占用 | Workbench 11 个 + 主项目 5 个（含 2 个 detached） |
| EXPERIMENTAL_OR_OBSOLETE | 待人工判定 | Workbench `codex/right-dock-*` 9 条 —— 全部是 `423cc0a` 的祖先，**技术上可删，但它们各自被一个 worktree 占用**，且无法从 CI/PR 判断哪条仍在演进 → 现阶段归 UNKNOWN |
| UNKNOWN / BLOCKED | 6 | 见第 9 节 |

## 9. 不确定项与 BLOCKED

| 编号 | 状态 | 说明 |
|---|---|---|
| B1 | `BLOCKED_SOURCE_MATCH` | vector-hub 1.0.8-rc.8 制品的 55 个 `dist/` 文件不在 Git 中，需下载 npm tarball 做字节比对才能闭合 |
| B2 | `BLOCKED_UNPUSHED_COMMIT` | knowledge-engine `85c618f` 未推送；主项目内嵌副本依赖它。需先备份并推送，否则内嵌源码在远端无对应历史 |
| B3 | `BLOCKED_CI_FAILURE` | Event Bridge head `0ada7ac` 的 CI 失败。已定位 stale workflow 部分，Windows `npm test` 部分根因未定位 |
| B4 | `BLOCKED_RELEASE_TRACE` | 主项目 v5\* 与 Workbench v0.13\* tag 不在远程；已发布版本缺远程 tag 与 gitHead |
| B5 | `BLOCKED_DEFAULT_BRANCH_PERMISSION` | Event Bridge 默认分支迁移需具备仓库设置权限的操作者；`gh` 当前账号有 `repo` scope，但本阶段无授权，且默认分支变更**不是普通 Git 命令** |
| B6 | `BLOCKED_WORKTREE_OCCUPANCY` | 16 个 worktree 处于占用状态，其中 9 个 Workbench `codex/right-dock-*` 分支无法判定是否仍在演进 |
| B7 | `UNKNOWN` | 主项目 `codex/v4.1.3`…`v4.1.7`、`refactor/project-knowledge-v13` 的上游远程引用已 `gone`，无法从远程确认它们是否仍被任何外部流程引用 |
| B8 | `UNKNOWN` | Event Bridge Windows `npm test` 失败的具体用例未定位 |

## 10. 复现命令

```bash
cd qa-autopilot
node tools/branch-audit.cjs            # → reports/branches/BRANCH_INVENTORY.json
node tools/module-source-match.cjs     # → reports/branches/MODULE_SOURCE_MATCH.json

# 单仓库手动复核（全部只读）
git -C <repo> rev-parse --show-toplevel
git -C <repo> status --porcelain=v1
git -C <repo> branch -vv
git -C <repo> branch -r
git -C <repo> worktree list --porcelain
git -C <repo> ls-remote --heads origin
git -C <repo> ls-remote --tags origin
git -C <repo> rev-list --left-right --count origin/main...<branch>
git -C <repo> merge-base --is-ancestor <branch> origin/main
gh api repos/<slug> --jq .default_branch
gh run list --repo <slug> --limit 25 --json headSha,conclusion
```

## 11. 下一动作

进入 **B00-B（需逐仓库、逐步骤的人工批准）**。具体实施步骤、备份与回退方案见 [`CONSOLIDATION_PLAN.md`](./CONSOLIDATION_PLAN.md)。

**当前授权范围内无任何远程写操作。**
