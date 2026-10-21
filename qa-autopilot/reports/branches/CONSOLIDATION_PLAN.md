# B00-B · 多仓库分支收敛实施计划（**尚未授权执行**）

> **状态：WAITING_BRANCH_APPROVAL。**
> 本文件是 B00-A 审计结论的实施方案草案，**每一条命令都尚未执行**。
> 执行需要**按仓库、按步骤的明确人工批准**；本阶段没有远程写授权。
> 批准合并**不等于**批准删除分支；删除是独立授权步骤。
> 输入证据：[`BRANCH_INVENTORY.md`](./BRANCH_INVENTORY.md) / [`BRANCH_INVENTORY.json`](./BRANCH_INVENTORY.json) / [`MODULE_SOURCE_MATCH.json`](./MODULE_SOURCE_MATCH.json)

## 0. 不可协商的前置条件

| # | 前置条件 | 当前状态 |
|---|---|---|
| P1 | 所有待删 ref 的 40 字节 SHA 已记录，且 `git bundle` 通过 `git bundle verify` + 隔离 clone 读取验证 | **未执行** |
| P2 | 用户工作区的未提交修改已单独安全备份（Workbench 7 处、主项目 2 处） | **未执行** |
| P3 | 隔离 clone 位于 `qa-autopilot/.runtime/workspaces/repair`，不在用户原工作区操作 | 目录已规划，未建立 |
| P4 | 每个仓库单独推进，前一个仓库验收完成后再动下一个 | 规则已定 |
| P5 | 全程不使用 `--force`、不使用 `git branch -D`、不改写历史、不移动 release tag | 规则已定 |
| P6 | 每次远程写之前重新读取远程真实 SHA，不使用本文件中的 SHA 快照 | 规则已定 |

若任一前置条件不满足 → `BLOCKED_BACKUP_INVALID` / `BLOCKED`，停止。

## 1. 建议的批准顺序（一次一个仓库）

```
① knowledge-engine   （改动最小，但含唯一的未推送提交，必须最先保护）
② vector-hub         （无分支动作，仅补 tag/可追溯性）
③ Claude-Ai-Workbench（分支最多，需先解 worktree 占用）
④ ai-coding-event-bridge（需修 CI + 改默认分支，权限要求最高）
⑤ project-knowledge-base（最后；含 QA 分支集成决策）
```

## 2. knowledge-engine

**目标**：把唯一的未推送提交 `85c618f` 安全地推上远程 `main`，让主项目内嵌的 `_modules/knowledge-engine`（0.2.7-rc.10）在远端有对应历史。

**当前事实**：`origin/main` = `1bfa9a5`；本地 `main` = `85c618f`（ahead 1，0 behind）。远程**无任何 tag**，远程**无任何 CI 运行记录**。

| 步骤 | 命令（全部在隔离 clone 内执行） | 校验 | 回退 |
|---|---|---|---|
| 2.1 备份 | `git bundle create artifacts/branch-archives/knowledge-engine-20261020.bundle --all` | `git bundle verify` 通过；隔离 clone 中 `git rev-parse 85c618f` 可解析 | 无需回退（只新增文件） |
| 2.2 建 QA 分支 | `git switch -c qa/knowledge-engine-push-20261020`（从 `85c618f`） | `git log -1` = `85c618f4f0bc…` | `git branch -d`（本地） |
| 2.3 推送 QA 分支 | `git push origin qa/knowledge-engine-push-20261020` | `git ls-remote --heads origin` 出现该分支且 SHA = `85c618f…` | `git push origin --delete qa/…`（**需单独批准**） |
| 2.4 验证 CI | 观察该分支的 CI 运行 | **注意：该仓库没有 CI 工作流** → 记为 `NO_CI_CONFIGURED`，改以模块自测替代 | — |
| 2.5 推进 main | 批准后：`git push origin 85c618f4f0bc…:main`（fast-forward，非 force） | `git ls-remote --heads origin main` = `85c618f…`；`git merge-base --is-ancestor 1bfa9a5 main` 成立 | `git push origin 1bfa9a5a7be2719935295bd243d994ebf6c51226:main`（**仅在 24 小时内、无新提交时可行**；否则需 `git revert`） |
| 2.6 tag（可选） | `git tag -a v0.2.7-rc.10 85c618f… && git push origin v0.2.7-rc.10` | tag 指向正确 SHA | `git push origin --delete v0.2.7-rc.10`（**需单独批准**；且须先确认 tag 触发的工作流） |

**风险**：该仓库无 CI、无 tag、无保护 —— 推进 main 后无自动校验。因此 2.3 之后必须跑 knowledge-engine 自带测试（`npm test`）并把结果作为证据。

## 3. vector-hub

**目标**：不改动任何分支；只处理可追溯性缺口。

**当前事实**：本地 `main` = `origin/main` = `b6dce20`，工作区干净，单分支。npm 已发布 1.0.7 / 1.0.8-rc.8，但 Git 端只有 `v1.0.3` tag。

| 步骤 | 命令 | 校验 | 回退 |
|---|---|---|---|
| 3.1 制品字节核对（闭合 B1） | 下载 `@sanqianx/vector-hub@1.0.8-rc.8` 的 npm tarball，比对 `dist/` 55 个文件与 `gitHead` = `ebf6f586…` 的构建产物 | 55 个文件 sha256 逐一相等 | 只读，无需回退 |
| 3.2 补 tag（可选） | `git tag -a v1.0.8-rc.8 ebf6f586… && git push origin v1.0.8-rc.8` | tag 指向 `ebf6f586…`；与 `1.0.8-rc.8` 的 `gitHead` 一致 | `git push origin --delete v1.0.8-rc.8`（单独批准） |
| 3.3 分支动作 | **无** | — | — |

**注意**：不要把 `1.0.8-rc.8` 直接设为 `latest`；`latest` 变更属于发布动作，需与 T11/T12 的 RC 流程一并批准。

## 4. Claude-Ai-Workbench

**目标**：把 `origin/main` 从 0.3.0 旧血脉 fast-forward 到 `423cc0a`（0.13.6），随后再逐条处置 `codex/right-dock-*` 等本地分支。

**当前事实**：`origin/main` = `be654e2`（0.3.0，未加 scope）；`origin/agent/sdk-productization` = `423cc0a`（0.13.6），**领先 118 个提交、0 落后**，是 `origin/main` 的直接后代 → 可 `--ff-only`。远程 `codex/release-0.13.2-rc.21` = `2fa60ca` 是 `423cc0a` 的**祖先**，其 82 个提交全部包含在内。

**前置**：11 个 worktree 全部被占用，其中主工作区有 **7 处未提交修改**。

| 步骤 | 命令 | 校验 | 回退 |
|---|---|---|---|
| 4.1 备份未提交修改 | 把 `docs/sdk/openapi.yaml`、`packages/{client,contracts,core,server,ui}/package.json`、`docs/plans/` 复制到 `qa-autopilot/artifacts/branch-archives/workbench-worktree-20261020/`（**不进入公开仓库**） | 7 个路径逐一存在且字节相同 | 删除备份即可 |
| 4.2 全量 bundle | `git bundle create artifacts/branch-archives/workbench-20261020.bundle --all` | `git bundle verify`；隔离 clone 中 12 个本地分支 head 与 3 个远程 head 全部可解析 | 只新增文件 |
| 4.3 建 QA 分支并推送 | `git switch -c qa/workbench-main-ff-20261020 423cc0a…` → `git push origin qa/workbench-main-ff-20261020` | `ls-remote` SHA 一致；CI 结果记录 | `git push origin --delete`（单独批准） |
| 4.4 跑 Workbench 自测 | 在隔离 clone 中 `npm ci && npm test` | 退出码 0、失败用例 0、跳过用例记 0 跳过 | — |
| 4.5 复核 0.13.6 制品 | 重新跑 `node tools/module-source-match.cjs`，确认 terminal 仍为 `ALL_BYTES_MATCH 124/124` | 一致 | — |
| 4.6 fast-forward main | 批准后：`git push origin 423cc0a…:main`（ff，非 force） | `ls-remote --heads origin main` = `423cc0a…`；`git merge-base --is-ancestor be654e2 main` 成立 | `git push origin be654e20b413ec839c37cc2d367a9674d34c9176:main`（**仅当 main 尚未被他人推进**；否则走 revert） |
| 4.7 保留 0.13.6 tag | `git tag -a v0.13.6 423cc0a… && git push origin v0.13.6` | tag 触发 publish 工作流前**必须**确认 `publish.yml` 不会把 0.13.6 重复发到 `latest` | 不推送 tag（保留本地） |

**步骤 4.7 的特别警告**：Workbench 的 `publish.yml` 同样是 `on: tags:` + `npm publish`（**无 `--tag next`**）。在 v0.13.x tag 从未到过远程的情况下推 v0.13.6，会触发一次对 `latest` 的发布写入 —— 与“禁止正式 latest”的安全合同直接冲突。**必须先完成 T04 的 RC-only 发布模板改造**，或把 tag 推送推迟到该改造之后。

| 步骤 | 命令 | 校验 | 回退 |
|---|---|---|---|
| 4.8 处置 `codex/right-dock-*` 9 条本地分支 | **暂不执行**。这 9 条各自被一个 worktree 占用，且无法从 CI/PR 判断是否仍在演进（B6/UNKNOWN）。 | 需用户逐条确认是否废弃 | — |
| 4.9 处置 `codex/release-0.13.2-rc.21` | 远程分支内容已包含在 `423cc0a` 内 → ALREADY_INCLUDED，可在 bundle 验证后删除**远程**引用 | 删除后 `ls-remote` 复核；`main` SHA 未变 | 由 bundle 恢复 `2fa60ca` |
| 4.10 处置 `codex/fix-dock-product-ui` | 本地分支与 `origin/agent/sdk-productization` 同 SHA（`423cc0a`）→ 本地别名，可删本地分支（需先解除 worktree 占用） | `git branch -vv` 复核 | `git branch qa/… 423cc0a…` 重建 |

## 5. ai-coding-event-bridge

**目标**：**(A)** 让 `main` 追上 `feat/ai-coding-event-bridge` 的内容；**(B)** 把 GitHub 默认分支从 `feat/…` 改回 `main`；(C)** 在 A/B 验收后删除 feature 分支。A、B、C 是三个独立步骤，各自需要独立批准。

**当前事实**：`origin/main` = `8717068`；`origin/feat/ai-coding-event-bridge` = `0ada7ac`（ahead 8、behind 0、91 文件变更），**且是 GitHub 默认分支**。其 CI（`38064016412`）**失败**。

**已定位根因**：`13f7950` 删除了 `packages/core` 与 `packages/ui`，但 `.github/workflows/ci.yml` 仍在 `npm pack --workspace packages/core|packages/ui --dry-run`，而当前 `packages/` 下只剩 `console`。

| 步骤 | 命令 | 校验 | 回退 |
|---|---|---|---|
| 5.1 备份 | `git bundle create artifacts/branch-archives/event-bridge-20261020.bundle --all` + `git bundle verify` | 隔离 clone 可解析 `0ada7ac…` 与 `8717068…` | 只新增文件 |
| 5.2 修 CI 工作流 | 在隔离 clone 从 `0ada7ac` 建 `qa/event-bridge-ci-fix-20261020`，删除 `ci.yml` 中 `packages/core` 与 `packages/ui` 两行 pack 步骤；**同时定位并修复 Windows Node 24 的 `npm test` 失败（B11）** | 提交后推送 QA 分支；CI 全绿（Linux Node 18/24 + Windows Node 24） | `git revert` 该提交 |
| 5.3 推进 main | QA 分支验收通过并合入后：`git push origin <qa-merged-sha>:main`（ff，非 force） | `ls-remote --heads origin main` = 新 SHA；该 SHA 的 CI success | `git push origin 8717068b0d92a04a1212ec13a2974199e16e8b64:main`（若 main 未被推进） |
| 5.4 改默认分支 | **不是普通 Git 命令**。由具备仓库设置权限的操作者执行 `gh api -X PATCH repos/SanQianX/ai-coding-event-bridge -f default_branch=main` | `gh api repos/… --jq .default_branch` = `main`；PR / CI / checkout 引用已检查 | `gh api -X PATCH … -f default_branch=feat/ai-coding-event-bridge` 改回 |
| 5.5 改默认分支前检查 | 全仓搜索 `feat/ai-coding-event-bridge` 引用（workflow、docs、CI matrix、部署配置） | 无残留引用 | — |
| 5.6 删除 feature 远程分支 | 确认 main 已含全部内容且 CI 绿、默认分支已改、无 PR/worktree 引用后：`git push origin --delete feat/ai-coding-event-bridge` | 删除后 `ls-remote --heads origin` 只剩 `main`；`main` SHA 与必要 tag 未受影响 | 由 bundle 恢复 `0ada7ac…` |

**顺序不可颠倒**：默认分支必须在 main 内容验收之后改；feature 分支必须在默认分支改完之后删。

## 6. project-knowledge-base

**目标**：把远程 `main` 与本地 `main` 对齐；把 `qa/continuous-repair-20261020` 的唯一独有提交按用户决策集成；处置 8 个已归档的 `codex/*` 本地分支；**保护 `backup/pre-clean-history-20260701-221430`**。

**当前事实**：`origin/main` = `c7d5b2b`（5.0.24）；本地 `main` = `5f243e1`（落后 83）；当前工作区在 `qa/continuous-repair-20261020` @ `81a2362`（相对 `origin/main` ahead 1 / behind 9，分叉点 `ff7a89b`）。远程只有 2 个分支。

| 步骤 | 命令 | 校验 | 回退 |
|---|---|---|---|
| 6.1 备份未提交修改 | 复制 `qa-autopilot/MINIMAX_START_PROMPT.md` 与 `qa-autopilot/plans/00_BRANCH_CONSOLIDATION.md` 的当前内容到 `artifacts/branch-archives/` | 字节相同 | — |
| 6.2 **保护 R1 备份分支** | `git bundle create artifacts/branch-archives/pkb-backup-pre-clean-history-20261020.bundle backup/pre-clean-history-20260701-221430` | `git bundle verify`；隔离 clone 中 `git rev-parse 752faf3` 可解析且 `git log --oneline` 显示 50 个提交 | 只新增文件 |
| 6.3 全量 bundle | `git bundle create artifacts/branch-archives/pkb-20261020.bundle --all` | `git bundle verify`；13 个本地分支 + 2 个远程分支 head 全部可解析 | 只新增文件 |
| 6.4 推进本地 main | `git fetch origin` → `git switch main` → `git merge --ff-only origin/main`（**仅本地**，不推送） | 本地 `main` = `c7d5b2b` | `git reset --hard 5f243e1`（仅在无本地改动时） |
| 6.5 决策 QA 分支 | `qa/continuous-repair-20261020` 相对 `origin/main` **DIVERGED**（ahead 1 / behind 9），无法 fast-forward。选项：(a) merge 进 main → 产生合并提交；(b) rebase 到 `c7d5b2b` 后再合；(c) 保留分支不动继续 QA | 需**用户明确选择**；本阶段不执行 | 未执行即无回退需求 |
| 6.6 推进远程 main | 仅在 6.5 选定方案并验收后执行，且必须是 fast-forward 或经审查的 merge，**禁止 force** | `ls-remote --heads origin main` SHA 与预期一致；该 SHA 的 CI success | 见 6.5 备注 |
| 6.7 处置已归档本地分支 | `codex/v4.1.3`…`v4.1.7`、`refactor/project-knowledge-v13`（上游已 `gone`）、`codex/p0-data-migration-and-hook-events`、`codex/native-agent-context`、`codex/fix-knowledge-panel-product-ui`、`codex/right-dock-k1-knowledge-panel` | 每条先确认 ALREADY_INCLUDED（`merge-base --is-ancestor`）且 bundle 已验证其 SHA 可恢复；**`codex/right-dock-k1-knowledge-panel` 与 `codex/fix-knowledge-panel-product-ui` 被 worktree 占用，需先解除占用** | 由 bundle 按 SHA 恢复 |
| 6.8 处置远程 `codex/native-agent-context` | ALREADY_INCLUDED（behind 9、0 独有提交）→ bundle 验证后 `git push origin --delete codex/native-agent-context` | 删除后 `ls-remote --heads origin` 只剩 `main`；`main` SHA 未变 | 由 bundle 恢复 `5bbcb52…` |
| 6.9 补 v5 tag（可选） | `v5.0.18`、`v5.0.20`、`v5.0.21` 的 SHA 已在 `origin/main` 历史中，但 tag 本身不在远程。推送会触发 `publish.yml`（无 `--tag next`）→ **会写 latest** | **必须**先完成 T04 的 RC-only 模板改造，否则不推 | `git push origin --delete v5.0.x`（单独批准） |

**绝对禁止**：删除 `backup/pre-clean-history-20260701-221430`；修改任何 v\* 已发布 tag；force push。

## 7. 全局收尾（仅在全部仓库完成后）

| 步骤 | 内容 | 校验 |
|---|---|---|
| 7.1 写 `BACKUP_VERIFICATION.md` | 记录每个 bundle 的 SHA256、`git bundle verify` 输出、隔离 clone 中读取到的待删 SHA 列表 | 每个 bundle 独立可解析 |
| 7.2 写 `FINAL_BRANCH_AUDIT.md` | 每个仓库收敛后的 `ls-remote --heads`、`branch -vv`、默认分支、CI、tag 快照 | 逐仓库独立记录 |
| 7.3 恢复说明 | 为每个被删 ref 写明原 SHA 与恢复命令 | 可照抄执行 |
| 7.4 未批准项留档 | 未获批准而保持原状的仓库明确写“保持原状”，**不得把单个仓库成功推广为全部成功** | — |

## 8. 当前状态

**所有步骤均为 WAITING_BRANCH_APPROVAL。本轮没有执行任何远程写操作、没有合并、没有删除分支、没有修改默认分支。**

需要用户逐项决定的事项：

1. 是否批准按 §1 的顺序（knowledge-engine → vector-hub → Workbench → Event Bridge → 主项目）推进？
2. 主项目 §6.5 的 QA 分支集成方式选 (a) merge / (b) rebase / (c) 暂不动？
3. Workbench §4.8 的 9 条 `codex/right-dock-*` 分支是否已废弃（各自被 worktree 占用，无法自动判定）？
4. 是否批准推送到远程的 v5\* / v0.13.x release tag（在 T04 完成前推送会写入 `latest`，不建议）？
