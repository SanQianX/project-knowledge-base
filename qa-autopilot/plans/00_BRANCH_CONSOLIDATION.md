# B00 · 多仓库 Git 分支治理与主线归一化（Branch Consolidation）

> 性质：独立、先行的仓库治理任务，不属于普通 QA Bug 修复。**默认只读**。审计不等于获准合并、改默认分支或删除远程引用。本文为增量计划，不替换 `config/phases.json` 中现有 T00–T14 合同。

## 1. 最终目标与范围

长期目标：每个独立源码仓库保留 `main` 作为唯一**长期维护分支**；QA 实施期间仍允许短期 `qa/*` 分支和 PR；已发布版本使用不可变 release tag、Git 历史和经过验证的离线 bundle 追溯。**不是把所有遗留功能不分好坏强制 merge 到 main。**

扫描范围至少包括：

- `SanQianX/project-knowledge-base`：主项目。
- `SanQianX/Claude-Ai-Workbench`：WorkBench 独立源码。
- `SanQianX/vector-hub`：向量检索模块。
- `SanQianX/ai-coding-event-bridge`：外部开发事件模块。
- `SanQianX/knowledge-engine`：知识引擎。
- 从主项目 `package.json`、`module-runtime-manifest.json`、配置及 Git remote 发现的其他真实独立仓库；**不得仅凭目录名认定 `_modules/*` 都是 Git 仓库**。

识别本地实际源码目录后，逐仓库分析本地分支、远程分支、默认分支、remote-tracking refs、tag、worktree、上游跟踪、现有 PR、CI、发布配置和未提交内容。遇到本机未知仓库路径时记录 `BLOCKED_LOCAL_REPO_PATH`，不猜路径、不扫描无关用户目录。

## 2. 已核对的远程事实（仅供 T00/B00 复核）

截至 2026-10-20 远程读取：

| 仓库 | GitHub 远程分支 | 相对 main 的已知关系 | 风险 |
|---|---|---|---|
| project-knowledge-base | `main`, `codex/native-agent-context` | 后者比 main 落后 10 个提交、无独有提交 | 可作为归档后删除候选，先查本地/活跃使用 |
| Claude-Ai-Workbench | `main`, `codex/release-0.13.2-rc.21`, `agent/sdk-productization` | 两个开发分支均比 main 领先；`agent/sdk-productization` 在前一个分支基础上再领先 36 个提交，版本 0.13.6；main 为 0.3.0 | **不能删除最新开发分支**；优先审计 fast-forward main 的可行性 |
| vector-hub | `main` | 只有 main | 无需强行变更 |
| ai-coding-event-bridge | `main`, `feat/ai-coding-event-bridge` | feature 分支领先 main 8 个提交，GitHub 默认分支为 feature | 先收敛、后切默认分支、再考虑删除 feature |
| knowledge-engine | `main` | 只有 main | 无需强行变更 |

这些事实会随提交而变化；执行前以本地/远程现场 SHA、`git merge-base`、`git rev-list`、`git ls-remote` 和 GitHub 默认分支查询重新验证。**不能用本表代替现场审计，也不能用版本号代替代码质量验证。**

## 3. 前置依赖与阶段顺序

- **T00-A**：执行现有 `npm test`、`self-check` 和 `T00` 只读环境审计；Windows Symlink `EPERM` 是测试环境权限问题，必须保留 FAIL 并独立修复测试兼容性，不能把失败当 PASS。
- **B00-A 分支审计**（当前授权）：只读库存、历史关系、风险矩阵、备份/恢复预案。可以生成 `qa-autopilot/reports/branches/` 下的脱敏报告；**禁止任何远程写操作**。
- **B00-B 收敛实施**（须用户明确批准每仓库计划）：完成本机 bundle 及备份校验、一次只操作一个仓库、确认测试和发布保护、更新 main、调整默认分支、逐一清理冗余引用。
- **T01**：只有 B00-B 结束、或用户明确选择暂缓且选定安全的已提交 QA 测试基准后，才冻结实际 `main`/对应测试 SHA。不可冻结错误的 Workbench 源码版本。
- **T02–T14**：保持原有 QA 工具安装、额度接线、Bug 测试修复与 `next` 候选发布合同。QA 分支在正式集成获批准之前不删除。

更新 `config/phases.json` 时，**仅在 T00 与 T01 之间插入一个稳定 ID 为 `B00` 的审计/治理门禁**，并更新 README、执行状态读取器或报告引用。先检查当前脚本是否假定阶段 ID 必为连续 T00–T14；若有假定，不得贸然插入并损坏工具。最小安全替代是将 B00 作为 T00 的已编号子阶段并写入报告，不改变原阶段 JSON。不得直接重排已有 ID 或改变 T01 的既有 `baseline` 安全执行合同。

## 4. B00-A 只读审计步骤

**每个仓库**：

```powershell
# 在经验证的本地 Git 仓库路径下运行；这些是只读命令
Get-Location
git rev-parse --show-toplevel
git status --porcelain=v1
git remote -v
git branch -vv
git branch -r
git worktree list --porcelain
git fetch --dry-run origin
git ls-remote --heads origin
git ls-remote --tags origin
```

远程比较之前，安全地 `git fetch --prune` 是否执行必须由用户认可；**`--prune` 会删除本地过期的远程跟踪引用，所以不属于纯只读审计。** 默认仅用 `git ls-remote` 和 GitHub API 读取最新分支，不自动 prune，不将本地跟踪引用误判为仍存在的远程分支。

对每个候选分支，使用实际引用进行：

```powershell
git merge-base main <branch>
git rev-list --left-right --count main...<branch>
git log --oneline --decorate main..<branch>
git diff --stat main...<branch>
git diff --name-status main...<branch>
```

尖括号是占位，不要逐字执行。必要时用 GitHub compare API 补足远程审计。对不同分支运行 `merge-base --is-ancestor` 判断是否可 fast-forward；`ahead=0` 不说明本地有人未使用、CI/PR 无依赖，所以仍需人工确认。

输出 `reports/branches/BRANCH_INVENTORY.md` 与机读 `BRANCH_INVENTORY.json`，每个分支必须写：repo、localPath、ref、headSHA、mergeBaseSHA、ahead/behind、uniqueCommits、changedFiles、default/protected/worktree/PR/CI/发布依赖、活跃开发证据、处置候选、证据链接和不确定项。

## 5. 每条分支分类与对应策略

| 类别 | 证据条件 | 建议动作 |
|---|---|---|
| ALREADY_INCLUDED | 分支 head 是目标 main 的祖先，无独有提交 | 归档并核验后允许删冗余 ref；不重复合并 |
| FAST_FORWARD_CANDIDATE | main 是分支 head 的祖先，存在独有提交 | 先检验构建与产品版本、发布安全、CI、依赖；审核通过才 fast-forward main |
| DIVERGED | 双向都有独有提交 | 按 commit 和文件评审，使用 PR/选择性 cherry-pick 或经批准 merge；不得自动解决冲突 |
| EXPERIMENTAL_OR_OBSOLETE | 历史实验、失效特性或重构草稿且可证实不再需要 | 完整归档后删除分支引用，**不要为了合并数量把旧功能带回来** |
| ACTIVE_OR_EXTERNAL_DEPENDENCY | 正在开发、worktree 占用、PR/CI/部署/默认分支依赖 | 保留或先迁移依赖，不能直接删 |
| UNKNOWN | 无权限、缺本地代码、无法判断是否已发布 | 阻断删除并列入人工审查 |

对 Workbench 必须单独验证 `agent/sdk-productization` 的 0.13.6 代码与主项目发布清单的精确 hash / npm 0.13.6 制品是否匹配。严禁因为 GitHub `main` 是 0.3.0 就让 MiniMax在其上修复当前 0.13.6 的 Bug。

对 Event Bridge 必须区分 **GitHub 默认分支迁移** 与 **Git 内容合并**：先让 main 达到拟保留代码版本并验收，再通过具有权限的操作者调整默认分支，检查部署、PR、CI workflow 和 checkout 引用后删除 feature。默认分支设置不是普通 Git 命令能完成的，缺权限就停止在 `BLOCKED_DEFAULT_BRANCH_PERMISSION`。

## 6. B00-B 备份、实施与验证（未授权前禁止执行）

### 6.1 备份

- 记录每个 ref 的 40 字节 Git SHA、remote URL、默认分支、Tag 和变更范围。
- 用独立安全位置保存 `git bundle`（可位于 `qa-autopilot/artifacts/branch-archives/`），明确将计划删除的 **本地未发布唯一提交** 及远程分支 head 包含在 bundle 中；完整性必须使用 `git bundle verify` 加隔离 clone 读取/查看全部待删 SHA 验证。
- 为待删除引用记录恢复命令及原 SHA；如需要远端归档 tag，命名不得匹配 `v*`、不得改变历史 release tag、需单独审查 Tag 触发工作流。
- 若 bundle 或远端归档没验证成功：`BLOCKED_BACKUP_INVALID`，禁止删除。
- Git bundle 通常不含未提交工作区/未跟踪文件：这些需单独安全备份，且不得混入公开仓库或保存在无权限隔离的环境。

### 6.2 修改 main

- 在隔离 clone/工作树完成；保持用户原工作区不变。
- 一次只推进一个仓库；更新前读取远端 main 实际 SHA，默认不重写历史。
- 可 fast-forward 时优先 `git merge --ff-only`；有分叉时仅根据已批准计划操作，禁止 `--strategy-option ours/theirs` 一刀切覆盖。
- 必须先通过该模块的原生单测、集成测试、与当前宿主版本匹配测试；影响发布流程时还要检查 workflows、包名、npm tag、package-lock、runtime manifest、CLI/插件入口。没有证据不能把“测试通过”填为 PASS。
- 经授权的 main 更新才可推送，禁止 force push。主仓库的 QA repair 分支只能在合规 PR / 最终验收后集成。

### 6.3 删除分支

- **这是独立人工授权步骤**，不能因为批准合并就自动获得删除所有分支的权限。
- 已远程验证 main 具有该分支所有必须保留的内容，或剩余独有提交被确认废弃且 bundle 恢复已证实。
- 分支不再是默认分支、受保护分支、任何活跃 worktree 或运行中的任务引用；先调整相关CI/PR/docs默认引用。
- 每删除一个远程/本地分支，立即再次 `ls-remote`、`branch -vv` 并校验 main SHA、必要 tag 和版本未受影响。
- 不使用 `git push --force`、`git branch -D` 作为快捷清理手段；有独有提交且确需移除 ref 必须人工对具体 SHA 审批，不允许模型自由推导。

### 6.4 QA 临时分支例外

现有 `plans/07_GIT_BASELINE_AND_REMOTE_PUSH.md` 的 `qa/*` 分支在自动修复期间必须保留，因为每个独立修复都要求先推送远程 QA 分支并获取 CI 验收。最终将 QA 修复集成到 main 必须经过用户批准与最后完整验收，随后再清理 QA ref。**“每仓库只留 main”是阶段性完成后的长期状态，不是禁止测试期间新建 QA 分支。**

## 7. 退出条件、报告和停止规则

**B00-A PASS（只读完成）**：所有可访问仓库分支清单完整、每个 ref 有 SHA 与分类、独有提交可追溯、默认分支与 Workbench/Bridge 依赖明确、备份及实施计划清晰。对未知情况标记 BLOCKED，不能标记“已清理”。

**B00-B PASS（实施完成）**：每个已批准仓库完成备份验证、正确版本收敛、全量必要回归、主线 SHA 核对、默认分支及远程分支验证、恢复说明；未批准的仓库保持原状并报告。不得把某个仓库成功推广为所有仓库成功。

任何未提交工作区覆盖、远端 SHA 变更、默认分支权限不足、发布触发器不明、版本 hash 不匹配、CI 失败、无法恢复的独有提交，都必须 STOP/BLOCKED；不能把失败包装成可删除分支。

输出：
- `qa-autopilot/reports/branches/BRANCH_INVENTORY.md` 和 `.json`
- `qa-autopilot/reports/branches/CONSOLIDATION_PLAN.md`（每仓库逐条实施命令及回退）
- `qa-autopilot/reports/branches/BACKUP_VERIFICATION.md`（实际实施时）
- `qa-autopilot/reports/branches/FINAL_BRANCH_AUDIT.md`（实际实施后）

每轮汇报：阶段 `B00-A/B00-B`、仓库、源 SHA、目标 SHA、证据/测试、风险、GitHub 远程 SHA、是否获得对应人工批准、下一动作。**当前没有授权远程合并、删除或改默认分支。**
