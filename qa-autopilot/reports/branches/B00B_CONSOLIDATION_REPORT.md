# B00-B · 多仓库分支整合报告（准备与演练完成，远程写操作待批准）

- 阶段：**B00-B（准备与演练）**　日期：2026-10-21
- 授权范围：分支审计、提交差异分析、只读版本核验、安全备份与备份验证、隔离工作区合并演练、非破坏性测试、生成逐仓库分支整合报告
- **未授权且未执行**：修改远程 main、修改 GitHub 默认分支、删除本地/远程遗留分支、删除被占用 worktree、推送发布 Tag、执行 npm 发布
- 输入：[`BRANCH_INVENTORY.md`](./BRANCH_INVENTORY.md) / [`BRANCH_INVENTORY.json`](./BRANCH_INVENTORY.json) / [`MODULE_SOURCE_MATCH.json`](./MODULE_SOURCE_MATCH.json)
- 证据目录：`qa-autopilot/artifacts/branch-archives/`（已 gitignore，不进公开仓库）

## 0. 隔离与安全措施

| 措施 | 实现 |
|---|---|
| 隔离工作区 | 5 个独立 clone：`qa-autopilot/.runtime/workspaces/repair`（主项目）+ `qa-autopilot/.runtime/workspaces/modules/*`（4 个模块） |
| 误推送防护 | 每个 clone 的 `origin` 指向**本地源仓库**；另加 `github` remote 但其 **push URL 设为 `DISABLED-NO-PUSH-TO-GITHUB`** —— 实测 `git push --dry-run` 直接失败，证明防护有效 |
| clone ↔ 远程一致性 | 每个 clone 的 `github` remote head 与实时 `git ls-remote` **逐一比对相等**；`git fsck` 无错误 |
| 演练对象 | 每次快进演练都推入**本地 bare 仓库模拟远程**（从真实远程 SHA 构造），不用真实 GitHub |
| 用户工作区 | 全程只读。5 个用户仓库的 `git status`、worktree 数量与本轮开始时一致 |

## 1. 逐仓库结果总览

| # | 仓库 | 分支审计结论 | 备份 | 演练 | 测试 | 远程动作 |
|---|---|---|---|---|---|---|
| 1 | knowledge-engine | 仅 `main`；本地领先 1 个未推送提交 | ✅ bundle 已验证 | ✅ 快进演练成功 | ✅ 204/201 通过，基线对比 +3 用例无回归 | **无**（PENDING_APPROVAL） |
| 2 | vector-hub | 仅 `main`，干净，与远程完全一致 | ✅ bundle 已验证 | ✅ 无需合并（无独有分支） | ✅ 73 通过 | **无**（无需分支动作） |
| 3 | Claude-Ai-Workbench | 12 本地分支 / 3 远程分支 / 11 worktree | ✅ bundle 已验证 + 9 个未提交文件单独备份 | ✅ 快进演练成功（+118） | ✅ 966/963 通过（同盘 TEMP 下 0 失败） | **无**（PENDING_APPROVAL） |
| 4 | ai-coding-event-bridge | 默认分支是 feature 分支 | ✅ bundle 已验证 | ✅ 快进演练成功（+8） | ✅ npm test 30 通过；CI 根因已定位并修复演练 | **无**（PENDING_APPROVAL） |
| 5 | project-knowledge-base | 13 本地分支 / 2 远程分支 / 5 worktree；QA 分支 DIVERGED | ✅ bundle 已验证（含 R1 备份分支）+ 9 个未提交文件备份 | ✅ 受控 merge 演练成功，0 冲突 | ✅ 产品 156 通过 + QA 包 106 通过 + release:verify 通过 | **无**（PENDING_APPROVAL） |

**本轮远程写操作总数：0。** 结束时复核：5 个仓库的远程 head、5 个默认分支、4 个 npm dist-tag 全部与 B00-A 审计时一致。

---

## 2. knowledge-engine

### 2.1 分支审计

| 项 | 值 |
|---|---|
| 本地分支 | 仅 `main` |
| 远程分支 | 仅 `main` |
| `origin/main` | `1bfa9a5a7be2719935295bd243d994ebf6c51226` |
| 本地 `main` | `85c618f4f0bc94c67e16a544c9f20d5c796cfa15` |
| 关系 | **ahead 1 / behind 0** —— 可 fast-forward |
| worktree | 无额外占用 |

### 2.2 独有提交的内容与作用

`85c618f fix: preserve quota failure reasons and expose pre-queue journal faults`（2026-10-16，10 文件 +166/-4）：

| 文件 | 作用 |
|---|---|
| `src/analysis-failures.js`（新增 39 行） | 把模型/供应商失败分类为受控错误码，保留额度失败原因 |
| `src/analysis-worker.js` | 捕获 provider 的具体失败原因，取代笼统的 `MODEL_FAILED` |
| `src/headless-analyzer.js` | 使用同一分类器 |
| `src/coordinator.js` | 新增 `maintenanceStatus()`，并在提交事件消费受阻/恢复时发出进度事件 |
| `src/server.js` | 接入 maintenance status |
| `test/analysis-failures.test.js`、`test/maintenance-status.test.js`（新增）、`test/engine.test.js`、`test/fixtures/worker-lifecycle.cjs` | 配套测试 |

**关键事实**：这份代码**已经在主产品里发��**。主项目 `_modules/knowledge-engine`（vendor-manifest 版本 `0.2.7-rc.10`）与 knowledge-engine 本地 `main` 的比对为 exact 29 + crlf 7 + eol-mixed 6 = **42/42，0 mismatch、0 missing**；而与 `origin/main`（`1bfa9a5`）比对则是 **11 mismatch + 1 missing**（`src/analysis-failures.js` 在远程不存在）。即：**远程 knowledge-engine 落后于产品实际内嵌的代码**。

### 2.3 备份与验证

- `artifacts/branch-archives/knowledge-engine-20261021.bundle`，566,917 B，sha256 `9bd8154f…`
- `git bundle verify` → `okay`，`The bundle records a complete history`
- 独立 clone 还原测试：unique commit `85c618f` 与 remote baseline `1bfa9a5` 均可读

### 2.4 快进演练

- 快进可行性：`git merge-base --is-ancestor github/main main` → **true**
- 演练目标：本地 bare 仓库模拟远程（初始 `main` = `1bfa9a5`）
- 演练推送结果：`1bfa9a5..85c618f  main -> main`（**非 force**）
- 独立验证：新 clone 该模拟远程，HEAD = `85c618f`，`src/analysis-failures.js` 存在
- 真实 GitHub `main` 复核：仍为 `1bfa9a5` —— **未改变**

### 2.5 测试

| 位置 | 测试数 | 通过 | 失败 | 跳过 | 退出码 |
|---|---|---|---|---|---|
| `main` (85c618f, 未推送提交) | 204 | 201 | **0** | 3 | 0 |
| `github/main` (1bfa9a5, 基线) | 201 | 198 | **0** | 3 | 0 |

未推送提交**净增 3 个测试且全部通过**，无回归。

3 个跳过项为环境限制，基线同样跳过，**不计为 PASS**：
- `real Git hooks → real project journals → durable engine → real vector index and retrieval`（integration runtime fixtures unavailable）
- `system-suite reports the Node runtime it executes, not the harness that launched it`（no second Node runtime available）
- `a symlink escaping the knowledge root never reaches results when the platform allows symlinks`（platform does not allow unprivileged symlinks）

### 2.6 判定

**分支审计完成，可 fast-forward。** 但推送远程 `main` 属未授权写操作。

> **PENDING_APPROVAL-1**：把 `85c618f` 推送到 `origin/main`（fast-forward，非 force）。
> 前提提示：该仓库**无任何 CI 工作流**（`gh run list` 为空），推送后无自动校验，仅依赖上述 204 项本地测试。

---

## 3. vector-hub

### 3.1 分支审计

| 项 | 值 |
|---|---|
| 本地分支 | 仅 `main`，工作区干净，单 worktree |
| `main` | `b6dce2018577ae21b20d7ff0e9ce356a44688b4f` |
| `origin/main` | `b6dce2018577ae21b20d7ff0e9ce356a44688b4f` —— **完全一致** |
| 独有分支 / 独有提交 | **无** |

按授权 ① ：**确认只有 main 且无其他本地独有分支，分支审计直接完成，未创建任何合并提交。**

### 3.2 制品字节级闭环（关闭 B1）

B00-A 记录的 `BLOCKED_SOURCE_MATCH`（55 个 `dist/` 文件不在 Git 中）已闭合：

| 校验 | 结果 |
|---|---|
| npm tarball `@sanqianx/vector-hub@1.0.8-rc.8` 文件数 | 59 |
| tarball 字节 vs 主项目 `module-runtime-manifest.json` | **59/59 逐字节相等，0 多余文件** |
| 从 `gitHead` `ebf6f586…` 现场重建 `dist/` | 55/55 文件重建成功 |
| 重建产物 vs 已发布 tarball | 51 逐字节相等；4 个（`dist/cjs|esm/bin.js`、`dist/cjs|esm/server/folder-picker.js`）**仅行尾差异**（Windows CRLF vs 发布端 LF），归一化后完全相等 |
| `package.json`、`ui/vendor/marked.min.js` | 同样**仅行尾差异**，内容相等 |
| `README.md`、`ui/index.html` | 逐字节相等 |

结论：`1.0.8-rc.8` 制品**可由 Git 源码复现**，主项目锁定的就是这一份。

### 3.3 测试

在 `gitHead` `ebf6f586` 现场构建后运行 `npm test`：**73 passing，0 failing，退出码 0**。
`ebf6f586..b6dce20` 之间唯一提交为 `chore: add zcode ignore rules`（仅新增 `.zcodeignore`，不触及代码）。

### 3.4 判定

**分支审计完成，无需任何分支动作。** 制品可追溯性缺口已闭合。

> **PENDING_APPROVAL-2（可选，低优先）**：补推 `v1.0.8-rc.8` tag 使 Git 端与 npm 版本对应。
> 注意：该仓库远端唯一 tag 是 `v1.0.3`，其 `Publish to npm` 运行曾失败；且用户已明确**不同意推送任何 `v*` tag**。此项在 T04 完成前**不执行**。

---

## 4. Claude-Ai-Workbench

### 4.1 快进可行性

| 项 | 值 |
|---|---|
| `origin/main` | `be654e20b413ec839c37cc2d367a9674d34c9176`（`package.json` = **0.3.0**，未加 scope 的旧血脉） |
| `origin/agent/sdk-productization` | `423cc0a8957e2a0dee9593119b62107d6412197a`（**0.13.6**） |
| 关系 | ahead **118** / behind **0** → `origin/main` 是其祖先，**fast-forward 可行** |
| `origin/codex/release-0.13.2-rc.21` | `2fa60cac…`（0.13.2-rc.21），ahead 82 / behind 0，且是 `423cc0a` 的**祖先** |

因此一次 fast-forward 即可让 `main` 同时包含全部开发分支内容。

### 4.2 备份

- `artifacts/branch-archives/claude-ai-workbench-20261021.bundle`，1,836,684 B，sha256 `f0699f4d…`
- `git bundle verify` → `okay`，`complete history`
- bundle 覆盖 12 个本地分支、3 个远程分支 head、18 个 tag
- 独立 clone 还原测试通过

### 4.3 未提交修改备份（bundle 不覆盖，必须单独备份）

`artifacts/branch-archives/workbench-uncommitted-20261021/`，**9 个文件全部逐字节校验通过**：

| 文件 | 性质 |
|---|---|
| `main-worktree/docs/sdk/openapi.yaml` | 已修改（1 行） |
| `main-worktree/packages/{client,contracts,core,server,ui}/package.json` | 已修改（版本 0.13.2-rc.19 → 0.13.2-rc.20 的发布版本推进） |
| `main-worktree/docs/plans/Claude AI Workbench 右侧多标签工作区与子代理控制台开发 Plan.md` | 未跟踪 —— **右侧 Dock 项目的唯一权威执行计划** |
| `main-worktree/docs/plans/DEVELOPMENT-HANDOFF-2026-10-18.md` | 未跟踪 —— 历史状态快照 |
| `release-worktree/packages/server/bin/claude-workbench-server.js` | 已修改 —— 经核验为**纯行尾差异**（该 worktree `core.autocrlf=false`，文件为 53 CRLF + 1 LF；LF 归一化后与其 blob 完全相等），**无内容改动** |

### 4.4 逐分支审计表（授权 ③ 要求）

**判定口径**：`SHA祖先` = 分支 head 是 `423cc0a`（0.13.6）的祖先；`补丁等价` = `git cherry` 判定提交在 0.13.6 中有等价补丁；`源码齐备` = 该分支引入的每个 `src/` 文件在 0.13.6 中都存在；`功能契约` = 该分支的测试文件对 0.13.6 实现运行的结果。

| 分支 | headSHA | worktree 路径 | 工作区状态 | SHA祖先 | 补丁等价 | 源码齐备 | 功能契约 | 判定 |
|---|---|---|---|---|---|---|---|---|
| `agent/sdk-productization` | `1c52bb8ca7` | `D:/SanQian.Xu/claude-ai-workbench` | **7 处改动**（已备份） | 是 | 0 unique | 齐备 | — | **ALREADY_INCLUDED**（落后远程 37） |
| `codex/fix-dock-product-ui` | `423cc0a895` | `C:/Users/SanQian/.codex/worktrees/dock-product-ui-review/claude-ai-workbench` | clean | 是 | 0 unique | 齐备 | — | **ALREADY_INCLUDED**（= 远程开发分支同一 SHA） |
| `codex/release-0.13.2-rc.21` | `2fa60cac5a` | `D:/SanQian.Xu/.glm-plan-evidence/release-2026-10-16/workbench` | **1 处改动**（纯行尾，已备份） | 是 | 0 unique | 齐备 | — | **ALREADY_INCLUDED**（是 423cc0a 的祖先） |
| `codex/right-dock-w1` | `3ae62fc1c3` | `C:/Users/SanQian/.codex/worktrees/dock-w0-sdk-proof/claude-ai-workbench` | clean | 是 | 0 unique | 齐备 | — | **ALREADY_INCLUDED** |
| `codex/right-dock-w1-integration` | `51fb69af31` | `C:/Users/SanQian/.codex/worktrees/dock-w1-integration/claude-ai-workbench` | clean | 是 | 0 unique | 齐备 | — | **ALREADY_INCLUDED** |
| `codex/right-dock-delegation-api` | `53d0ad530a` | `C:/Users/SanQian/.codex/worktrees/dock-w1-native-trace/claude-ai-workbench` | clean | 是 | 0 unique | 齐备 | — | **ALREADY_INCLUDED** |
| `codex/right-dock-w2-ui` | `c231b3091f` | `C:/Users/SanQian/.codex/worktrees/dock-w2-ui/claude-ai-workbench` | clean | 是 | 0 unique | 齐备 | — | **ALREADY_INCLUDED** |
| `codex/right-dock-w3-panel` | `d50cd6dc80` | `C:/Users/SanQian/.codex/worktrees/dock-w3-panel/claude-ai-workbench` | clean | 是 | 0 unique | 齐备 | — | **ALREADY_INCLUDED** |
| `codex/right-dock-w4-matrix` | `284a589d9e` | `C:/Users/SanQian/.codex/worktrees/dock-w4-matrix/claude-ai-workbench` | clean | 是 | 0 unique | 齐备 | — | **ALREADY_INCLUDED** |
| `codex/right-dock-delegations` | `88c0edcea5` | `C:/Users/SanQian/.codex/worktrees/dock-sdk-global-proof/claude-ai-workbench` | clean | **否** | 0 unique（3 等价） | 齐备 | 旧规格在 0.13.6 实现下 159 用例 158 通过 / 0 失败 | **ALREADY_INCLUDED（内容已整合）** |
| `codex/right-dock-history` | `e19602169f` | `C:/Users/SanQian/.codex/worktrees/dock-w1-task-history/claude-ai-workbench` | clean | **否** | 1 个补丁不等价 | 齐备（4/4 源文件存在） | 旧规格在 0.13.6 实现下 170 用例 169 通过 / 0 失败 | **内容已整合，规格已演进** |
| `codex/right-dock-native-trace` | `5ae42d29c2` | （无 worktree 占用） | — | **否** | 3 个补丁不等价 | 齐备（5/5 源文件存在） | 同上 | **内容已整合，规格已演进** |

**关于 `git cherry` 的 4 个「不等价」补丁**：`git cherry` 报告 `codex/right-dock-history` 有 1 个、`codex/right-dock-native-trace` 有 3 个提交在 0.13.6 中无等价补丁。逐条比对后确认这是**误报**：

| 不等价提交 | 0.13.6 线对应提交 | 补丁内容比对 | 结论 |
|---|---|---|---|
| `5b848d9 feat: index native tasks by verified SDK launch facts` | `2d67431`（同名） | 补丁 diff **完全相同**（+731 行，2 文件） | 内容相同，仅上下文不同 |
| `71a7f13 feat: collect bounded native SDK task traces` | `a388b91`（同名） | 补丁 diff **完全相同** | 同上 |
| `0f1dca2 fix(packaging): ship the native task runtime closure in SDK artifacts` | `c78da9d`（同名） | 补丁 diff **完全相同** | 同上 |
| `f57a13c fix(server): bind runtime loading to the owning distribution` | `a69e82d`（同名） | 补丁 diff **完全相同** | 同上 |

blob 级复核进一步确认：这些分支引入的**每一个 `src/` 文件在 0.13.6 中都存在**；个别文件在两边的 blob 不同，是 0.13.6 线在这些文件上**继续演进**的结果（行级双向差异，如 `native-task-runtime.js` -9/+118），并非功能缺失。

**功能是否仍然有效**（授权 ③ 第 4 项）——权威依据是未跟踪的 `docs/plans/Claude AI Workbench 右侧多标签工作区与子代理控制台开发 Plan.md`（2026-10-18 状态写回）：

- W1 核心链路、W2 右侧 Dock 首个真实 UI 垂直切片、W3 Panel SDK 与最小可信宿主、K1 知识引用宿主集成 —— **均已 PASSED**，且各自对应上表中的提交（`c231b30`/`d50cd6d`/`51fb69a`/`53d0ad5`）
- **W4/K2 真实链路与故障矩阵、R1/R2 候选发布与官方安装、正式发布授权与复验 —— NOT_STARTED**
- 当前整体状态：**开发推进中，发布 NO-GO**
- 该计划自述：`codex/right-dock-delegations`（`88c0edc`）是**「验证资产，不是产品实现基线」**；`codex/right-dock-w1`（`3ae62fc`）是**「新集成分支的首选基线」**
- 该计划自述的权威优先级：**「当前本机 git status / HEAD / 实际文件 / 运行服务身份 / Registry 数据 > 经过审计的原始日志和哈希 > 交接记录 > 代理摘要」**，冲突时标 `NEEDS_RECONCILIATION`，不得自动择一

**一处与交接文档的冲突（按其自身规则标记 NEEDS_RECONCILIATION）**：交接文档称 `codex/right-dock-delegation-api`「16 个已改/新增文件，未提交」，但本轮实测该 worktree **clean**。以本机实际状态为准（该规则由计划文档本身规定），其提交已进入 `53d0ad5`。

**是否有活动任务或进程使用这些 worktree**（授权 ③ 第 5 项）：用 `Get-CimInstance Win32_Process` 扫描全部 `node.exe` / `git` / `npm` / `pwsh` / `python` / `code` 进程的 CommandLine，**没有任何进程引用任何 Workbench worktree 路径**。机器上仅有的 3 个 `node.exe` 属于 `D:\SanQian.Xu\Server Project`（Next.js dev server），与 Workbench 无关。

**结论**：12 个分支的内容**全部已在 0.13.6 中整合**；但右侧 Dock 项目本身**仍在开发（W4/K2 未开始，发布 NO-GO）**。因此**不删除任何分支、不删除任何 worktree**——保留它们正是当前开发状态的正确表达。

### 4.5 快进演练与测试

演练：本地 bare 仓库模拟远程（初始 `main` = `be654e2`），推送 `423cc0a` → 结果 `be654e2..423cc0a  main -> main`（**非 force**），`git merge-base --is-ancestor be654e2 main` 成立。新 clone 模拟远程验证 HEAD = `423cc0a`、`version=0.13.6`。真实 GitHub `main` 复核仍为 `be654e2` —— **未改变**。

测试（在 `423cc0a` 的隔离 worktree，`npm ci` 后）：

| 条件 | 测试数 | 通过 | 失败 | 跳过 | 退出码 |
|---|---|---|---|---|---|
| 默认 TEMP（`C:\Users\...\Temp`，与仓库**不同盘**） | 966 | 961 | **2** | 3 | 1 |
| TEMP 指向与仓库同盘（`D:\...`） | 966 | **963** | **0** | 3 | **0** |

两个失败用例（`tests/integration/sdk-native-runtime-pack.test.js`）的断言是
`assert.ok(path.relative(root, libDir).startsWith(".."), "the packaged runtime loads outside this repository")`。
在 Windows 上，当仓库在 `D:` 而 `os.tmpdir()` 在 `C:` 时，`path.relative()` 对跨盘路径返回**绝对路径**而非 `..` 开头，断言因此失败。已实测确认：`path.relative("D:\\...", "C:\\Users\\...\\Temp")` = `"C:\\Users\\SanQian\\AppData\\Local\\Temp"`，`startsWith("..")` 为 `false`。

**这是测试用例的环境判定缺陷，不是产品缺陷** —— 同盘 TEMP 下 0 失败、退出码 0。GitHub runner 为单盘环境，故 CI 从未暴露该问题。

模块来源复验（演练后重跑）：terminal 仍为 **ALL_BYTES_MATCH 124/124 @ `origin/agent/sdk-productization`**。

### 4.6 判定

**快进可行且已演练成功，测试在同盘环境下全绿。**

> **PENDING_APPROVAL-3**：把 `origin/main` 从 `be654e2` fast-forward 到 `423cc0a`（+118 提交，非 force）。
> **PENDING_APPROVAL-4**：后续单独批准删除远程 `codex/release-0.13.2-rc.21`（其 82 个提交已包含在 `423cc0a` 内）。
> **未提出、也不会提出**：删除 9 条 `codex/right-dock-*` 分支或对应 worktree —— 项目仍在开发（W4/K2 NOT_STARTED、发布 NO-GO）。
> **附带提示（非本轮授权）**：本地 `agent/sdk-productization` 落后远程 37 个提交；快进 main 后该本地分支可再单独快进。其工作区 7 处改动含 `0.13.2-rc.19 → rc.20` 的版本推进，属**落后于 0.13.6 的旧状态**，需用户确认是否保留。

---

## 5. ai-coding-event-bridge

### 5.1 分支审计

| 项 | 值 |
|---|---|
| GitHub 默认分支 | **`feat/ai-coding-event-bridge`** ← 需迁移 |
| `origin/main` | `8717068b0d92a04a1212ec13a2974199e16e8b64` |
| `origin/feat/ai-coding-event-bridge` | `0ada7acc1332ac475680acdd33d41af7dc6a7897`（console 0.7.2） |
| 关系 | ahead **8** / behind **0** → **fast-forward 可行** |
| 本地 | 仅 `feat/ai-coding-event-bridge`，工作区干净，单 worktree |

8 个独有提交：`0ada7ac` ZCode 采集接线、`f0826f8` 兼容 pre-2.31 Git 的仓库元数据、`d1cbd43` 0.7.0 每 journal 消费者、`13f7950` 0.6.0 合并为单包（core 折入 console）、`1a1c79c` 0.5.1 turns 倒序分页、`fb75c63` 0.5.0 CLI 包名、`3acad7a` kb:sidebar 内嵌协议、`5d5a17b` 0.3.0 提交封存。

### 5.2 备份

`artifacts/branch-archives/ai-coding-event-bridge-20261021.bundle`，203,853 B，sha256 `ee6f72e8…`；`git bundle verify` → `okay`；独立 clone 还原后 `0ada7ac` 与 `8717068` 均可读。

### 5.3 CI 失败根因（已现场复现并修复演练）

B00-A 定位到默认分支 head 的 CI 失败（run `38064016412`）。本轮在隔离 worktree **完整复现**：

```
$ npm pack --workspace packages/core --dry-run
npm error No workspaces found:
npm error   --workspace=packages/core
  EXIT=1
$ npm pack --workspace packages/ui --dry-run
npm error No workspaces found:  EXIT=1
$ npm pack --workspace packages/console --dry-run
  EXIT=0  (38 files)
```

**根因确认**：提交 `13f7950`（*refactor!: consolidate into one self-contained package — core folded into console (0.6.0)*）删除了 `packages/core` 与 `packages/ui`，并同步更新了 `publish.yml`，**但没有更新 `.github/workflows/ci.yml`** —— 该文件在两个 job 里各保留了两行对已删除 workspace 的 pack 步骤。当前 `packages/` 下只剩 `console`。这是**过期 CI 工作流**，不是 0.7.2 代码回归。

**修复演练**：在隔离 worktree 删除那 4 行（精确 4 行删除，CRLF 行尾保持不变），随后按 CI 等价顺序本地验证：`npm ci` → `npm test`（30 passed, 0 failed, exit 0）→ `npm pack --workspace packages/console --dry-run`（exit 0）。工作流中 `packages/core|ui` 引用数 = 0。

补丁已导出为可评审工件：`artifacts/branch-archives/event-bridge-ci-workflow-fix-20261021.patch`（1,421 B），在 `0ada7ac` 的纯净 checkout 上 `git apply --check` 通过。该修复以**本地演练提交** `8244ddac43fea96c4f6b9cea9999e08e806d4607` 存在于隔离 clone，**未推送任何远程**。

### 5.4 Windows `npm test` 失败 —— 未闭合

CI 的 Windows Node 24 job 另有一个**独立**失败：`packages/console/test/workbench-capture-test.js:24` —— 期望 `captured.status === 'captured'`，实得 `undefined`。

源码定位（`packages/console/src/bridge/core/bridge.js` 的 `captureWorkbenchEvent`）：捕获失败会抛错，HTTP 层统一转成 **409 + `{error:{code}}`**，而测试未先断言 HTTP 状态码，直接读 `.status`，故 `undefined`。失败条件只有两种：`findProject(home, repo.repoIdentity)` 未命中，或 `fs.realpathSync(project.path) !== fs.realpathSync(input.projectPath)`。

本机复现尝试（均**未复现**，退出码 0）：同 commit、同 Windows、同 Node v24.13.0；TEMP 含空格；TEMP 含非 ASCII；`git rev-parse --show-toplevel` 输出经核验为正确 UTF-8。

**判定：`BLOCKED_UNREPRODUCED`。根因未确立**，必须在与 GitHub windows-latest 等价的环境上复现后才能接受快进。此项不可当作已解决。

### 5.5 快进演练

本地 bare 仓库模拟远程（初始 `main` = `8717068`），推送 `0ada7ac` → `8717068..0ada7ac  main -> main`（**非 force**），`merge-base --is-ancestor 8717068 main` 成立。新 clone 模拟远程验证 HEAD = `0ada7ac`、console 版本 = 0.7.2。真实 GitHub 复核：`main` 仍为 `8717068`、默认分支仍为 `feat/ai-coding-event-bridge` —— **均未改变**。

### 5.6 判定

内容收敛可行且已演练；但**默认分支迁移必须在 CI 修复落地并转绿之后**。

> **PENDING_APPROVAL-5**：把 `ci.yml` 修复经 QA 分支推上远程并取得 CI 全绿（补丁已备好）。
> **PENDING_APPROVAL-6**：在 `main` 达到 `0ada7ac` 且验收通过后，把 GitHub 默认分支由 `feat/ai-coding-event-bridge` 改为 `main`（需具备仓库设置权限的操作者；`gh` 当前账号有 `repo` scope）。
> **PENDING_APPROVAL-7**：默认分支迁移并验证后，删除远程 `feat/ai-coding-event-bridge`。
> **BLOCKED-1**：Windows `npm test` 中 `workbench-capture-test.js:24` 的失败根因未确立（见 5.4）。**在等价环境复现并修复前，不接受 `main` 的快进验收。**

---

## 6. project-knowledge-base

### 6.1 分支审计

| 项 | 值 |
|---|---|
| 远程分支 | `main` @ `c7d5b2b`（5.0.24）、`codex/native-agent-context` @ `5bbcb52` |
| 本地 `main` | `5f243e1`（落后 83） |
| 当前分支 | `qa/continuous-repair-20261020` @ `81a2362`（**ahead 1 / behind 9**，DIVERGED） |
| worktree | 5 个（含 2 个 detached） |
| 独有分支 | `backup/pre-clean-history-20260701-221430` @ `752faf3` —— **与 main 无 merge-base，50 个独有提交不可再生** |

### 6.2 QA 分支独有提交（授权 ② 要求）

`81a2362 test(qa-autopilot): add QA control package and fix Windows link rejection self-test`（2026-10-20）

- **内容**：新增整个 `qa-autopilot/` 控制包（**66 个文件，+13,915 行，全部为新文件**），并修复 Windows 符号链接拒绝自检（`SeCreateSymbolicLinkPrivilege` 缺失时改用目录联接，断言保留）
- **提交元数据**：含 `QA-Task` / `QA-Evidence` / `QA-Self-Test` / `QA-Artifact`（含 sha256）
- **来源**：作者 SanQianX，2026-10-20，与 B00-A 之前的提交 `ff7a89b` 同源工作流
- **作用**：这是本轮 QA 执行的控制面本身，不是产品功能改动
- **是否触碰产品代码**：**完全没有**。`git diff --name-only github/main...qa/continuous-repair-20261020 | grep -v '^qa-autopilot/'` 结果为空

### 6.3 落后的 9 个提交（授权 ② 要求列出）

| # | SHA | 主题 | 触及区域 |
|---|---|---|---|
| 1 | `c7d5b2b` | fix(release): 5.0.24 restore reply order and completed task history | 产品修复 |
| 2 | `ecfdd7d` | fix(release): 5.0.23 wait for explicit user choices in workbench | 产品修复 |
| 3 | `cd35ba8` | fix(release): 5.0.22 isolate startup integration checks from launcher and HTTP | 产品修复 |
| 4 | `459ae9d` (tag `v5.0.21`) | test: stop capture status workers before asynchronous fixture cleanup | 测试 |
| 5 | `f63c58d` | chore(release): 5.0.21 parallel workspace with Workbench 0.13.3 | 依赖锁定 |
| 6 | `e7204fb` (tag `v5.0.20`) | 5.0.20 | 发布 |
| 7 | `337da5f` (tag `v5.0.20-rc.1`) | 5.0.20-rc.1 | 发布 |
| 8 | `2101806` | chore(modules): pin claude-ai-workbench 0.13.2-rc.22 from the official registry | 依赖锁定 |
| 9 | `6ce99f9` | feat(ui): open knowledge references in workbench panels | UI 功能 |

### 6.4 功能冲突分析

| 检查 | 结果 |
|---|---|
| `github/main` 是否含 `qa-autopilot/` 文件 | **0 个**（main 从未有过 QA 控制包） |
| QA 分支独有提交是否触及 `qa-autopilot/` 之外 | **否**（66/66 文件全在 `qa-autopilot/` 下） |
| 双方自合并点 `ff7a89b` 以来**都修改过**的文件 | QA 侧 66 个，main 侧 37 个，**交集 = 0** |
| 文件级冲突 | **0** |
| 语义冲突 | 9 个提交全部是产品侧（`_site/_test` 13 个文件、`ui` 4、`_site/lib` 4、`_site/scripts` 3、`desktop` 2、`package.json`、`package-lock.json`、`module-runtime-manifest.json` 等）；QA 侧只新增控制包目录。**两侧无共享文件 → 无语义冲突面** |
| 依赖锁定影响 | main 把 Workbench 钉到 **0.13.6**（`423cc0a`）；QA 分支的父提交 `ff7a89b` 钉的是 0.13.2-rc.21。合并后以 main 的 0.13.6 为准 —— 与 Workbench 仓库的快进目标一致，无矛盾 |

### 6.5 受控 merge 演练（授权 ② 要求）

在隔离 clone（`.runtime/workspaces/repair`）中：

```
git checkout -b qa/rehearsal-merge-main-20261021 github/main   # 基线 c7d5b2b
git merge --no-ff --no-commit qa/continuous-repair-20261020
```

结果：

| 项 | 结果 |
|---|---|
| 冲突数 | **0**（`Automatic merge went well`） |
| 暂存文件 | 66（全部在 `qa-autopilot/` 下） |
| 触及产品文件 | **0** |
| 合并提交 | `25e20f50f246abeb0fb6c034fed5be86d5a2d7af`，双亲 `c7d5b2b` + `81a2362` |
| 产品树 vs main | `git diff --stat github/main HEAD -- . ':(exclude)qa-autopilot'` **为空** → 产品代码与 main **逐字节相同** |
| 历史是否被改写 | **否** —— `git merge-base --is-ancestor github/main HEAD` 成立；未 rebase、未 reset、未 force |

### 6.6 合并后测试

| 套件 | 结果 | 退出码 |
|---|---|---|
| 产品回归套件 `npm test`（`node _site/_test/run-all-tests.js`） | **156 passed, 0 failed** | 0 |
| QA 控制包 `npm test`（合并树内已提交版本） | **106 passed, 0 failed, 0 skipped** | 0 |
| QA 控制包 `npm test`（叠加当前工作区版本，含 B00 工具） | **106 passed, 0 failed, 0 skipped** | 0 |
| `node scripts/qa.cjs self-check`（两种版本） | **PASS** | 0 |
| `npm run release:verify` | `release version 5.0.24 is synchronized` / `Vendored runtime release gate passed.` / `All product module versions and contents verified.` / `integration-adapters-test PASS` | 0 |
| B00 工具在合并树上 | `branch-audit` PASS；`module-source-match` terminal 仍 **ALL_BYTES_MATCH** | 0 |

### 6.7 备份

- `artifacts/branch-archives/project-knowledge-base-20261021.bundle`，14,573,673 B，sha256 `5f200ef9…`，`git bundle verify` → `okay`，`complete history`
- bundle 覆盖 13 个本地分支（含 **R1 备份分支**）、2 个远程分支 head 与全部 tag
- **R1 备份分支独立还原验证**：从 bundle 重新 clone 后，`752faf3` 可读，`git rev-list --count 752faf3` = **50**，`git log` 正常显示其独有历史，与 main 的 merge-base **仍为空** —— 不可再生历史已可完整恢复
- `artifacts/branch-archives/pkb-uncommitted-20261021/`：9 个未提交文件全部逐字节校验通过

### 6.8 判定

**受控 merge 演练成功，0 冲突，产品代码零影响，全部测试通过。** 按授权 ②，本轮**未**执行 rebase / merge / reset / force push / 分支删除。

> **PENDING_APPROVAL-8**：把 `qa/continuous-repair-20261020` 合入 `main`（合并提交，非 rebase、非 force）。证据已齐：0 冲突、产品树零差异、156+106 测试通过、release:verify 通过、bundle 与未提交文件已备份。
> **PENDING_APPROVAL-9（可选）**：删除远程 `codex/native-agent-context`（behind 9、0 独有提交，ALREADY_INCLUDED）。
> **PENDING_APPROVAL-10（可选，低优先）**：清理本地已归档分支 `codex/v4.1.3`…`v4.1.7`、`refactor/project-knowledge-v13`、`codex/p0-data-migration-and-hook-events`、`codex/native-agent-context`、`codex/fix-knowledge-panel-product-ui`、`codex/right-dock-k1-knowledge-panel`。其中后两条**被 worktree 占用**，需先解除占用。
> **绝对禁止**：`backup/pre-clean-history-20260701-221430` 的任何删除操作 —— 其 50 个独有提交与 main 无共同祖先，是不可再生资产（已由 bundle 备份，但备份不等于授权删除）。

---

## 7. 汇总：待批准事项

| 编号 | 仓库 | 事项 | 证据齐备度 | 阻塞条件 |
|---|---|---|---|---|
| PENDING_APPROVAL-1 | knowledge-engine | fast-forward `main` → `85c618f` | 齐（bundle + 204 测试 + FF 演练） | 该仓库无 CI，推送后无自动校验 |
| PENDING_APPROVAL-2 | vector-hub | 可选补推 `v1.0.8-rc.8` tag | 齐（制品 59/59 + 可复现） | **用户已明确不同意推 tag**；且 T04 未完成 |
| PENDING_APPROVAL-3 | Workbench | fast-forward `main` → `423cc0a`（+118） | 齐（bundle + 966 测试同盘全绿 + FF 演练） | 无 |
| PENDING_APPROVAL-4 | Workbench | 删除远程 `codex/release-0.13.2-rc.21` | 齐（内容已含于 `423cc0a`） | 依赖 PENDING_APPROVAL-3 |
| PENDING_APPROVAL-5 | Event Bridge | 推 `ci.yml` 修复到 QA 分支并取得 CI 绿 | 齐（补丁 1,421 B，apply --check 通过，本地等价序列通过） | 需远程 QA 分支 + CI |
| PENDING_APPROVAL-6 | Event Bridge | 默认分支 `feat/…` → `main` | 齐（FF 演练 + 内容验收） | 依赖 P-5；需仓库设置权限 |
| PENDING_APPROVAL-7 | Event Bridge | 删除远程 `feat/ai-coding-event-bridge` | 齐 | 依赖 P-6 |
| PENDING_APPROVAL-8 | 主项目 | merge `qa/continuous-repair-20261020` → `main` | 齐（0 冲突 + 156/106 测试 + release:verify + bundle） | 无 |
| PENDING_APPROVAL-9 | 主项目 | 删除远程 `codex/native-agent-context` | 齐（ALREADY_INCLUDED） | 依赖 P-8 |
| PENDING_APPROVAL-10 | 主项目 | 清理 6 条已归档本地分支 | 齐（全部 ALREADY_INCLUDED + bundle） | 2 条被 worktree 占用，需先解除 |
| **BLOCKED-1** | Event Bridge | Windows `workbench-capture-test.js:24` 失败根因 | **未闭合** | 需等价环境复现 |
| **BLOCKED-2** | 控制包 | `DELIVERY_MANIFEST.json` 与工作区不同步，T02 会以 `DELIVERY_CHANGED` 阻断 | 已定位 | 需控制端/用户决定是否刷新清单（其中 3 个文件非本轮审阅） |
| **BLOCKED-3** | Workbench | 本地 `agent/sdk-productization` 落后远程 37 提交且有 7 处未提交改动（含 0.13.2-rc.19→rc.20 版本推进，属旧状态） | 已定位 | 需用户决定是否保留/推进 |

## 8. 本轮明确未做的事

- 未修改任何远程 `main`；未修改任何 GitHub 默认分支；未删除任何本地或远程分支；未删除任何 worktree
- 未推送任何 `v*` tag；未执行 `npm publish`；未触发任何可能发布 npm 包的工作流；未修改任何 npm dist-tag
- 未对用户工作区执行 rebase / merge / reset / force push / stash / checkout / 清理
- 未把未执行的步骤报告为完成：所有演练均发生在隔离 clone 或本地 bare 模拟远程中，**演练提交与演练分支均未推送**
- 未删除 `backup/pre-clean-history-20260701-221430`
