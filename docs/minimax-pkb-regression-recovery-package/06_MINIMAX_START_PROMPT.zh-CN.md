# MiniMax Agent 开工提示词（中文版）

你现在要修改仓库 `SanQianX/project-knowledge-base`。本次工作的目标是：**以 `v4.1.22` 为产品功能基线，把最近大重构过程中丢失/断开的用户功能恢复到当前 `4.2.x` 新架构上。**

你不是本次工作的架构设计者。附件施工包已经规定了架构边界、任务顺序、测试方法和通过条件。你必须机械执行，不得自由发挥。

## 开工前必须执行

1. 阅读施工包目录中的全部文件。
2. `README_FIRST.md` 和 `00_AGENT_OPERATING_RULES.md` 必须完整阅读两遍。
3. 执行并记录：
   - `git rev-parse HEAD`
   - `git status --short`
   - `git tag --list v4.1.22`
   - `git rev-parse v4.1.22`
4. 确认 `v4.1.22` 对应基线 commit。
5. 在 T00 的回归测试/复现测试建立之前，不允许直接开始修改核心生产代码。

## 唯一允许的任务顺序

严格执行：

`T00 -> T01 -> T02 -> T03 -> T04 -> T05 -> T06 -> T07 -> T08 -> T09 -> T10 -> T11 -> T12 -> T13 -> T14 -> T15 -> T16 -> T17 -> T18 -> T19 -> T20 -> T21 -> T22 -> T23 -> T24 -> G00 -> G01 -> ... -> G08`

禁止跳任务。禁止把几个 Task 混在一次大修改中。禁止“先全部改完最后再测试”。

## 你必须始终记住的产品意图

- v4.1.22 已经导入的老项目升级后必须继续可用，不能要求用户删除项目重新导入。
- Git commit 后必须重新触发知识库更新。
- 即使 Hook 通知丢失，Project-Knowledge 重启后也必须通过 startup reconciliation 补分析漏掉的 commit。
- 新项目导入必须恢复成完整可用流程：文件夹选择、preflight、Git 状态、知识库根目录、AI Profile、知识输出语言等都要正确处理。
- UI 中英文切换必须恢复。
- GitHub/Gitea 登录/连接状态、Team Knowledge 能力按当前架构恢复。
- 提示词设置必须恢复，但只能进入当前唯一的 canonical commit prompt/analyzer 链路，不能新建第二套分析链路。
- Project Goal 编辑必须恢复。
- Claude Workbench 的 Permission Allow/Deny 和 permission mode UI 必须恢复。
- Integration Setup 必须在 UI 可见，并区分 Knowledge Integration 与 Development Capture。

## 绝对禁止

- 禁止回滚整个仓库到 v4.1.22。
- 禁止恢复 Project-Knowledge 自动管理 `CLAUDE.md`。
- 禁止恢复旧 `automation-queue` 作为第二套 commit 分析系统。
- 禁止绕过 `CommitReconciler` 新建另一套分析入口。
- 禁止绕过 `IndexService` 直接写 LanceDB。
- 禁止把 Project-Knowledge Workbench 对话写入 Development Conversation。
- 禁止把 Knowledge Analyzer 自己的内部对话写入 Development Conversation。
- 禁止修改/删除旧的 immutable `CommitConversationSnapshot` 来让测试通过。
- 禁止弱化、删除、skip 测试来制造绿色结果。
- 禁止顺手做无关重构、全局重命名、格式化整个仓库或升级无关依赖。

## 每个 Task 的固定施工流程

每执行一个 Task，都必须按下面顺序：

1. 输出当前 Task 编号和名称。
2. 阅读 Task 指定的当前 `main` 文件。
3. 阅读 `v4.1.22` 对应文件，确认旧功能真实行为。
4. 用 5～10 行说明：当前为什么坏、旧版怎么工作、本 Task 最小修改是什么。
5. 只修改本 Task 范围。
6. 添加/修改 Task 明确要求的测试。
7. 先运行 Task 专项测试。
8. 再运行受影响的既有测试。
9. 执行 `git diff --check`。
10. 执行 `git status --short`，确认没有超范围文件。
11. 按 `07_TASK_REPORT_TEMPLATE.md` 输出完整 Task Report。
12. 所有通过条件都是 PASS 后，才允许进入下一个 Task。

如果测试失败：继续停留在当前 Task 修复。禁止跳到下一个 Task，禁止说“最后一起修”。

## 本次最高优先级 P0

优先确保以下链路完全恢复：

`旧项目/新项目 -> Git commit -> post-commit hook -> hook-trigger -> CommitReconciler -> analyzer -> promotion -> Markdown knowledge -> IndexService`

其中重点核对施工包中的已知风险：

1. Desktop 下 Hook 不能错误地把 Electron/Project-Knowledge.exe 当成普通 Node executable。
2. Hook 文件 missing 时不能错误标记为 migration completed。
3. AI Profile 必须统一使用一个 effective resolver：
   `project profile -> default profile -> first usable profile -> explicit error`。
4. startup reconciliation 必须独立于 Hook 通知可靠工作。

## 你什么时候才可以说“完成”

必须同时满足：

- 根目录 `npm test` PASS；
- `cd desktop && npm test` PASS；
- Fresh project E2E PASS；
- v4.1.22 legacy project upgrade E2E PASS；
- Backend offline -> commit -> restart recovery E2E PASS；
- UI regression Gate PASS；
- Protected architecture Gate PASS；
- `G08` 验收表所有 required 项目没有 FAIL。

只要有一个 required Gate 失败，你的最终结论必须是 `INCOMPLETE`，不能说“基本完成”“应该可以”“主要功能完成”。
