# B00-B · 备份与恢复验证记录（BACKUP_VERIFICATION）

- 阶段：**B00-B**　日期：2026-10-21
- 依据：`plans/00_BRANCH_CONSOLIDATION.md` §6.1（备份）、§7（输出）
- 机读数据：`qa-autopilot/artifacts/branch-archives/BACKUP_VERIFICATION.json`
- 归档位置：`qa-autopilot/artifacts/branch-archives/`（`.gitignore` 已排除 `artifacts/*`，不进入公开仓库）

## 0. 本文件的状态

计划 §7 把 `BACKUP_VERIFICATION.md` 标注为**「实际实施时」**产出。本轮 B00-B 授权范围包含「安全备份与备份验证」，备份工作已实际执行并通过验证，故本文件成立。

`FINAL_BRANCH_AUDIT.md`（计划 §7 标注**「实际实施后」**）**尚未产出** —— 本轮**未执行任何远程写操作**（未改 main、未改默认分支、未删分支），实施后审计的前提不成立。不得用本文件替代它。

## 1. 备份总览

| 仓库 | bundle 文件 | 字节 | sha256 | `git bundle verify` | 退出码 | 覆盖 ref 数 |
|---|---|---|---|---|---|---|
| project-knowledge-base | `project-knowledge-base-20261021.bundle` | 14,573,673 | `5f200ef9d76109744011296a9c5905ee4187c13d830c3feeced9531f8c296858` | **is okay** | 0 | 99 |
| Claude-Ai-Workbench | `claude-ai-workbench-20261021.bundle` | 1,836,684 | `f0699f4dbcb0411eafdc2e5644ceba0edea0a016998a6996e5bbcc4f96994588` | **is okay** | 0 | 36 |
| ai-coding-event-bridge | `ai-coding-event-bridge-20261021.bundle` | 203,853 | `ee6f72e8e0218569a0566a2f703df47f975fe99020108dd283ffbd1bddfc55dc` | **is okay** | 0 | 7 |
| knowledge-engine | `knowledge-engine-20261021.bundle` | 566,917 | `9bd8154f4595889992e984ee29d6f043edd30e95a3d440c996d50d30ef2ed627` | **is okay** | 0 | 5 |
| vector-hub | `vector-hub-20261021.bundle` | 905,632 | `41706bee68fdab4a5602642287fe0fcc15b80b065da377e5a16b9c0950aea572` | **is okay** | 0 | 7 |

全部 bundle 均满足计划 §6.1 的双重要求：

1. `git bundle verify` 通过，退出码 0，记录完整历史
2. **隔离 clone 独立还原**读取全部待删 SHA（见 §4）

## 2. 每个 ref 的记录

计划 §6.1 要求「记录每个 ref 的 40 字节 Git SHA、remote URL、默认分支、Tag 和变更范围」。

### 2.1 project-knowledge-base

- remote URL：`https://github.com/SanQianX/project-knowledge-base.git`
- 默认分支：`main`　远程 main：`c7d5b2bc86b7e51fe6e322999294bb497af1808c`
- 远程分支：`main` = `c7d5b2bc86b7e51fe6e322999294bb497af1808c`；`codex/native-agent-context` = `5bbcb523a5328e711faab871fd871229955c5252`
- 远程 tag：72 个（v3.0.0 – v4.7.0）；**远程无任何 v5\* tag**
- 本地 tag（远程没有，需单独保全）：`v5.0.18`、`v5.0.18-rc.1`…`rc.4`、`v5.0.20`、`v5.0.20-rc.1`、`v5.0.21`

| 本地 ref | 40 字节 SHA | 相对 origin/main | 独有提交 | 变更文件 | 处置 |
|---|---|---|---|---|---|
| `main` | `5f243e120b44…` | behind 83 / ahead 0 | 0 | 0 | 推进到 origin/main（仅本地） |
| `qa/continuous-repair-20261020` | `81a2362a45294289602700bb56838dc235f2f067` | behind 9 / **ahead 1** | 1 | 66 | **保留**（QA 活跃分支） |
| `codex/native-agent-context` | `ff7a89bdc316ca64b282ead52d4ff327030c317e` | behind 9 / ahead 0 | 0 | 0 | ALREADY_INCLUDED |
| `codex/fix-knowledge-panel-product-ui` | `c7d5b2bc86b7e51fe6e322999294bb497af1808c` | 0 / 0 | 0 | 0 | ALREADY_INCLUDED（**被 worktree 占用**） |
| `codex/right-dock-k1-knowledge-panel` | `e7204fb74aacb80676a3fd4c7b3dc6b80d9878e4` | behind 5 / ahead 0 | 0 | 0 | ALREADY_INCLUDED（**被 worktree 占用**） |
| `codex/p0-data-migration-and-hook-events` | `cc762638c1f9…` | behind 198 / ahead 0 | 0 | 0 | ALREADY_INCLUDED |
| `codex/v4.1.3` | `9c98f3e45058…` | behind 279 / ahead 0 | 0 | 0 | ALREADY_INCLUDED（上游 gone） |
| `codex/v4.1.4` | `25a0975173ae…` | behind 278 / ahead 0 | 0 | 0 | ALREADY_INCLUDED（上游 gone） |
| `codex/v4.1.5` | `97b22e11a8b4…` | behind 277 / ahead 0 | 0 | 0 | ALREADY_INCLUDED（上游 gone） |
| `codex/v4.1.6` | `e543009a9292…` | behind 276 / ahead 0 | 0 | 0 | ALREADY_INCLUDED（上游 gone） |
| `codex/v4.1.7` | `736a469ac89b…` | behind 266 / ahead 0 | 0 | 0 | ALREADY_INCLUDED（上游 gone） |
| `refactor/project-knowledge-v13` | `9b503d556a7bba6ef4b95453156e09f6e4a5cffb` | behind 236 / ahead 0 | 0 | 0 | ALREADY_INCLUDED（上游 gone；**有 detached worktree**） |
| **`backup/pre-clean-history-20260701-221430`** | `752faf3149779e27145476085426f65294c7fa29` | **无 merge-base / ahead 50** | **50** | 无法计算 | **禁止删除：不可再生** |

### 2.2 Claude-Ai-Workbench

- remote URL：`https://github.com/SanQianX/Claude-Ai-Workbench.git`
- 默认分支：`main`　远程 main：`be654e20b413ec839c37cc2d367a9674d34c9176`（0.3.0 旧血脉）
- 远程分支：`main` = `be654e2…`；`agent/sdk-productization` = `423cc0a8957e2a0dee9593119b62107d6412197a`（0.13.6）；`codex/release-0.13.2-rc.21` = `2fa60cac5ac82d1457f6dddfcaccedb113d8b7a2`
- 远程 tag：12 个（v0.0.2 – v0.11.0）；**远程无任何 v0.13\* tag**
- 本地 tag（远程没有）：`v0.13.2`、`v0.13.2-rc.18`、`v0.13.2-rc.19`、`v0.13.2-rc.20`、`v0.13.2-rc.22`、`v0.13.3`

12 个本地分支的 SHA、worktree 占用、补丁等价判定见 [`B00B_CONSOLIDATION_REPORT.md`](./B00B_CONSOLIDATION_REPORT.md) §4.4。全部 12 条内容**已整合进 0.13.6**，故 bundle 覆盖其 head 即可完整恢复。

### 2.3 ai-coding-event-bridge

- remote URL：`https://github.com/SanQianX/ai-coding-event-bridge.git`
- 默认分支：**`feat/ai-coding-event-bridge`**
- 远程分支：`feat/ai-coding-event-bridge` = `0ada7acc1332ac475680acdd33d41af7dc6a7897`；`main` = `8717068b0d92a04a1212ec13a2974199e16e8b64`
- 远程 tag：`v0.1.2`（1 个）

| ref | SHA | 备注 |
|---|---|---|
| `feat/ai-coding-event-bridge` | `0ada7acc1332ac475680acdd33d41af7dc6a7897` | 默认分支；8 提交领先 main |
| `main` | `8717068b0d92a04a1212ec13a2974199e16e8b64` | 是 feature 的严格祖先 |

### 2.4 vector-hub

- remote URL：`https://github.com/SanQianX/vector-hub.git`　默认分支：`main`
- `main` = `b6dce2018577ae21b20d7ff0e9ce356a44688b4f`（本地 = 远程）
- 远程 tag：`v1.0.3`（1 个）

### 2.5 knowledge-engine

- remote URL：`https://github.com/SanQianX/knowledge-engine.git`　默认分支：`main`
- 远程 `main` = `1bfa9a5a7be2719935295bd243d994ebf6c51226`；本地 `main` = `85c618f4f0bc94c67e16a544c9f20d5c796cfa15`（ahead 1）
- **远程与本地均无任何 tag**

## 3. bundle 不覆盖的部分 —— 未提交与未跟踪文件的独立备份

计划 §6.1 明确：「Git bundle 通常不含未提交工作区/未跟踪文件：这些需单独安全备份，且不得混入公开仓库或保存在无权限隔离的环境。」

| 仓库 | 备份目录 | 文件数 | 校验方式 |
|---|---|---|---|
| Claude-Ai-Workbench | `workbench-uncommitted-20261021/` | 9 | 逐文件 sha256 与源文件比对，全部 OK |
| project-knowledge-base | `pkb-uncommitted-20261021/` | 9 | 逐文件 sha256 与源文件比对，全部 OK |

备份位置在 `qa-autopilot/artifacts/branch-archives/`，该目录被 `.gitignore` 的 `artifacts/*` 排除，**不进入 Git、不进入 npm 包**。

Workbench 备份明细（9 个文件）：`main-worktree/` 下 `docs/sdk/openapi.yaml`、`packages/{client,contracts,core,server,ui}/package.json`、`docs/plans/Claude AI Workbench 右侧多标签工作区与子代理控制台开发 Plan.md`、`docs/plans/DEVELOPMENT-HANDOFF-2026-10-18.md`；`release-worktree/` 下 `packages/server/bin/claude-workbench-server.js`。

主项目备份明细（9 个文件）：`qa-autopilot/MINIMAX_START_PROMPT.md`、`qa-autopilot/plans/00_BRANCH_CONSOLIDATION.md`、`qa-autopilot/reports/PHASE_STATUS.md`、`qa-autopilot/reports/branches/`（4 个）、`qa-autopilot/tools/branch-audit.cjs`、`qa-autopilot/tools/module-source-match.cjs`。

## 4. 隔离 clone 独立还原验证

计划 §6.1 要求「用独立安全位置保存 git bundle……完整性必须使用 `git bundle verify` 加隔离 clone 读取/查看全部待删 SHA 验证」。

| 仓库 | 还原目录 | 还原 HEAD | 关键 SHA 读取结果 |
|---|---|---|---|
| project-knowledge-base | `.runtime/verify/pkb-restore` | `25e20f50…`（演练 merge 提交） | **`752faf3`（R1 备份分支）可读，`git rev-list --count` = 50，其 `git log` 正常，与 main 的 merge-base 仍为空** |
| Claude-Ai-Workbench | `.runtime/verify/wb-restore` | `1c52bb8ca70028a6f5ff5981791620963df0374a` | 12 个本地分支 head、3 个远程 head、18 个 tag 全部可读 |
| ai-coding-event-bridge | `.runtime/verify/eb-restore` | `0ada7acc1332ac475680acdd33d41af7dc6a7897` | `0ada7ac` 与 `8717068` 均可读 |
| knowledge-engine | `.runtime/verify/knowledge-engine` | `85c618f4f0bc94c67e16a544c9f20d5c796cfa15` | `85c618f`（唯一提交）与 `1bfa9a5`（远程基线）均可读 |
| vector-hub | `.runtime/verify/vh-restore` | `b6dce2018577ae21b20d7ff0e9ce356a44688b4f` | 可读 |

**R1 备份分支的不可再生性已实证保全**：从 bundle 独立还原后，其 50 个独有提交完整可读，且与 main 的 merge-base 依然为空 —— 证明该历史线与 main 无共同祖先，只能由这份 bundle 恢复。

## 5. 恢复命令

对每个仓库，bundle 位于 `qa-autopilot/artifacts/branch-archives/<仓库>-20261021.bundle`：

```bash
# 1) 校验
git -C <仓库> bundle verify <bundle 路径>

# 2) 独立还原到隔离目录
git clone <bundle 路径> <隔离还原目录>

# 3) 恢复某个具体 ref（示例：主项目的 R1 备份分支）
git -C <隔离还原目录> branch backup/pre-clean-history-20260701-221430 752faf3149779e27145476085426f65294c7fa29

# 4) 确认 commit 可读
git -C <隔离还原目录> log --oneline -5 752faf3149779e27145476085426f65294c7fa29
```

**恢复未提交修改**（bundle 不含）：

```bash
# Workbench
cp -r "qa-autopilot/artifacts/branch-archives/workbench-uncommitted-20261021/main-worktree/." "D:/SanQian.Xu/claude-ai-workbench/"
# 主项目
cp -r "qa-autopilot/artifacts/branch-archives/pkb-uncommitted-20261021/." "D:/SanQian.Xu/project-knowledge-base/"
```

## 6. 未做与禁止事项

- **未删除任何 ref** —— 本文件只是备份与恢复能力证明，不构成删除授权
- **未创建任何远端归档 tag**（计划 §6.1 允许，但本轮未授权；且 v\* tag 会触发 publish 工作流）
- **未移动、未覆盖任何已发布 tag**
- **未把 bundle 提交进 Git 或打进 npm 包**（`artifacts/*` 已 gitignore，`package.json` 的 `files` allowlist 不含 qa-autopilot）
- 计划 §6.1 的阻断条件 `BLOCKED_BACKUP_INVALID` **未触发**：5 个 bundle 全部 verify 通过且独立还原成功

## 7. 尚未产生的计划输出

| 计划 §7 要求 | 状态 |
|---|---|
| `BRANCH_INVENTORY.md` | ✅ 已产出 |
| `BRANCH_INVENTORY.json` | ✅ 已产出 |
| `CONSOLIDATION_PLAN.md` | ✅ 已产出 |
| `BACKUP_VERIFICATION.md` | ✅ **本文件** |
| `FINAL_BRANCH_AUDIT.md` | ⏳ 未产出 —— 需先完成实际实施（远程写操作获批并执行） |
