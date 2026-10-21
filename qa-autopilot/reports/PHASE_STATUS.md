# 执行状态 · 阶段编号与子阶段登记

本文件是 `config/phases.json` 的**执行状态读取器**。`config/phases.json` 本身**未被修改**，
原 T00–T14 的阶段 ID、动作与出口合同一字未动（原因见第 3 节）。

阶段总览：

| 阶段 | 状态 | 说明 |
|---|---|---|
| **T00** | 已完成（子阶段 T00-A） | 环境与只读审计 |
| ├ T00-A | **PASS** | 测试、自检、只读环境审计 |
| **B00** | 进行中（子阶段 B00-A 完成，B00-B 准备与演练完成） | 多仓库分支治理门禁 |
| ├ **B00-A** | **PASS（只读）** | 多仓库只读分支审计 |
| └ **B00-B** | **PENDING_APPROVAL**（10 项待批 / 3 项 BLOCKED） | 准备与演练完成，远程写操作待批准 |
| T01 | **PASS** | 基准已冻结：`c7d5b2b`（5.0.24），QA 分支 + 非 v tag `qa-baseline-20261020`，远程解引用核对通过 |
| T02 | **PASS** | QA 控制包 69 文件已 bootstrap 并推送（`dd652d5`），脚注更正 `f3206ac` |
| T03 | **BLOCKED** | 无 MiniMax CLI、无 API Key、无已验证 worker 适配器 → `EXECUTABLE_MISSING` / `ADAPTER_UNVERIFIED` |
| T04 | **PASS** | RC-only 发布工作流已装为同名 `publish.yml`（`eb2f879`），26/26 反例通过，7 项门禁条件全绿 |
| T05 | **PASS** | inventory：439 文件 / 169 测试 / 124 定位点 / 99 API 引用 |
| T06 | **PASS** | 浏览器接线已通：Chrome 可见性（`f1f6574`/`432659d`）+ git 标准模板（`432659d`）修复后，7 个浏览器/视觉用例全部转 PASS |
| T07 | **PASS** | 156 个测试文件全量实跑。首轮 12 FAIL + 1 误判 → **全部确证为 QA 控制包环境缺陷并已修复**（跳过判定误判、临时路径超 MAX_PATH、模块注册被短路、Chrome 与 git 模板不可见）；修正后全部转 PASS，**已确证产品缺陷 = 0** |
| T08 | 未开始 | 无已确证产品缺陷 → 不建立 Bug 合同、不改产品源码（计划要求不伪造 Bug） |
| T09–T14 | 未开始 | 等待 T03 额度通道与 T08 输入 |

> **T00 与 B00 的关系**：B00 是插入在 T00 与 T01 之间的独立治理门禁，**不替换** T00–T14 任何阶段。
> T00-A 的只读审计已覆盖环境事实；B00-A 的只读审计补充了多仓库分支与模块来源事实。
> 两者都为 T01 的基准冻结提供输入，但**都不构成 T01 的执行授权**。

## 1. T00-A · 环境与只读审计 —— PASS

| 项 | 命令 | 结果 |
|---|---|---|
| 控制包行为自检 | `npm test`（qa-autopilot） | **PASS**：106 通过 / 0 失败 / 0 跳过 / 退出码 0 |
| 配置 JSON 自检 | `node scripts/qa.cjs self-check` | **PASS**，退出码 0 |
| 只读环境审计 | `node scripts/qa.cjs audit --config config/local.json` | **PASS**，退出码 0，报告写入 `reports/runs/audit-*.json` |
| Windows 符号链接兼容性 | 已包含在上方 106 项内 | PASS —— 目录联接与真符号链接的拒绝机制分别验证，断言未被删除，未运行项未被计为 PASS |

只读审计要点（`reports/runs/audit-1792504987191.json`）：

- 本地 HEAD `81a2362a45294289602700bb56838dc235f2f067`（分支 `qa/continuous-repair-20261020`）
- 远程 main `c7d5b2bc86b7e51fe6e322999294bb497af1808c` → `sourceMatchesRemote: false`
- 本地包版本 `5.0.19`，Node `v24.13.0`
- 用户工作区未提交修改：`M qa-autopilot/MINIMAX_START_PROMPT.md`、`?? qa-autopilot/plans/00_BRANCH_CONSOLIDATION.md`（**本阶段未触碰**）

`config/local.json` 已在首轮 `init` 生成，状态为 `CONFIGURATION_REQUIRED`（待配置），属正常前置状态。
所有授权开关仍为 `false`：`remoteWriteEnabled` / `candidatePublishEnabled` / `publisherGateVerified` /
`installRcEnabled` / `cleanupEnabled` / `bootstrapCopyEnabled` / `controllerIsolationVerified`。

## 2. B00-A · 多仓库只读分支审计 —— PASS（只读）

| 项 | 结果 |
|---|---|
| 审计工具 | `qa-autopilot/tools/branch-audit.cjs`（只读子命令白名单，越界抛 `READONLY_VIOLATION`） |
| 模块来源校验工具 | `qa-autopilot/tools/module-source-match.cjs` |
| 覆盖仓库 | 5 个独立仓库，全部在本机确认 origin 归属 |
| 机读清单 | `reports/branches/BRANCH_INVENTORY.json` |
| 人类可读清单 | `reports/branches/BRANCH_INVENTORY.md` |
| 实施计划 | `reports/branches/CONSOLIDATION_PLAN.md` |
| 模块来源证据 | `reports/branches/MODULE_SOURCE_MATCH.json` |
| 远程写操作 | **0 次**（无 fetch / merge / push / delete / 默认分支修改） |

结论摘要：Workbench 0.13.6 来源已用 124/124 字节哈希锁定于 `origin/agent/sdk-productization` @ `423cc0a`；
Event Bridge 默认分支为 feature 分支且其 head CI 失败（根因：过期 CI 工作流引用已删除的 workspace）；
主项目远程无任何 v5\* tag 而 npm 已发布 5.0.24；knowledge-engine 有 1 个未推送提交且主项目内嵌副本正对应它。

详见 `reports/branches/BRANCH_INVENTORY.md`。

## 3. 为什么没有把 B00 写进 `config/phases.json`

按 `plans/00_BRANCH_CONSOLIDATION.md` §3 的要求，先检查了工具是否假定阶段 ID 必为连续 T00–T14：

1. **没有任何脚本依赖固定阶段 ID**。全包检索 `phases` 只命中 `scripts/qa.cjs:30`（`self-check` 里把
   `config/phases.json` 当 JSON 解析做语法校验）。不存在假定连续 T00–T14 的执行状态读取器。
2. **但存在一条哈希耦合**。`config/phases.json` 在 `DELIVERY_MANIFEST.json` 中有 sha256
   （`699705a11ecbf8e18e3e5e7bd7745064701649685a2cca18a646d55b480d571f`），
   而 `tools/install-control-copy.cjs` 会对清单内每个文件校验
   `hash(file) === x.sha256`，不等即以 `DELIVERY_CHANGED` 阻断 T02。
   → 修改 `config/phases.json` 必须**同时**修改 `DELIVERY_MANIFEST.json`（第二个控制合同文件）。
3. **而该清单当前已经与工作区不同步**（非本次改动造成）：

   | 文件 | 清单记录 | 实际 | 差异来源 |
   |---|---|---|---|
   | `MINIMAX_START_PROMPT.md` | 2361 B | 4985 B | 用户加入 B00 章节 |
   | `reports/delivery/VALIDATION.md` | 3020 B | 3527 B | 补记 Windows 链接兼容性 |
   | `tests/core.test.cjs` | 12065 B | 15064 B | Windows 链接拒绝自检修复 |
   | `plans/00_BRANCH_CONSOLIDATION.md` | 不在清单 | 新文件 | 本轮新增计划 |

   校验结果：68 项中 **65 项一致、3 项哈希过期、1 项缺失**。
   即 **T02 的交付哈希校验当前会以 `DELIVERY_CHANGED` 失败**，这是 B00 之前就存在的问题。

**因此本轮采取计划 §3 明列的最小安全替代**：不改动 `config/phases.json`，把 B00 作为 T00 的
**已编号子阶段（T00-A → B00-A → B00-B）** 写入本报告；B00 的阶段 ID、门禁语义与状态机保留在
`plans/00_BRANCH_CONSOLIDATION.md` 与本文件中。不重排已有 ID，不改变 T01 的 `baseline` 安全执行合同。

**同时列为待决项（不在本轮授权内）**：由控制端或用户决定是否刷新 `DELIVERY_MANIFEST.json`，
使其覆盖上述 3 个已改文件与 1 个新文件，从而解除 T02 的 `DELIVERY_CHANGED` 阻断。
本轮**未**刷新该清单 —— 那 3 个文件中包含并非本轮审阅的内容，由模型代为「背书」会破坏清单的证明语义。

## 4. B00-B · 收敛实施 —— PENDING_APPROVAL

**本轮完成的是准备与演练，远程写操作全部待批准。** 逐仓库证据见
[`reports/branches/B00B_CONSOLIDATION_REPORT.md`](./branches/B00B_CONSOLIDATION_REPORT.md)。

| 仓库 | 备份 | 演练 | 测试 | 远程动作 |
|---|---|---|---|---|
| knowledge-engine | bundle 已验证 | fast-forward 演练成功 | 204/201 通过（基线 201/198，+3 无回归） | 无 |
| vector-hub | bundle 已验证 | 无需合并（无独有分支） | 73 通过；制品 59/59 可复现 | 无 |
| Claude-Ai-Workbench | bundle + 9 个未提交文件已验证 | fast-forward 演练成功（+118） | 966/963 通过（同盘 TEMP 下 0 失败） | 无 |
| ai-coding-event-bridge | bundle 已验证 | fast-forward 演练成功（+8） | npm test 30 通过；CI 根因已复现并修复演练 | 无 |
| project-knowledge-base | bundle（含 R1 备份分支）+ 9 个文件已验证 | 受控 merge 演练成功，**0 冲突** | 产品 156 通过 + QA 106 通过 + release:verify 通过 | 无 |

**远程写操作总数 0。** 结束时复核：5 个仓库远程 head、5 个默认分支、4 个 npm dist-tag 全部与 B00-A 审计一致；5 个用户工作区状态与 worktree 数量不变。

待批准事项见 B00-B 报告 §7（10 项 PENDING_APPROVAL + 3 项 BLOCKED）。执行顺序建议：
knowledge-engine → Workbench → Event Bridge → 主项目；vector-hub 无分支动作。

## 5. 仍然阻塞 T01 的事项

T01 基准冻结按 `plans/00_BRANCH_CONSOLIDATION.md` §3 依赖 B00-B 结束，或用户明确暂缓并选定安全基准。

- 若走 B00-B：需先获批 PENDING_APPROVAL-3（Workbench fast-forward）与 -8（主项目 merge），二者决定被测源码版本
- 若暂缓：knowledge-engine 的未推送提交 `85c618f` 已进入产品内嵌副本，Workbench 的 0.13.6 位于 `origin/agent/sdk-productization` @ `423cc0a`（可作为主项目 5.0.24 的模块来源），两者都可作为只读基准
- `BLOCKED-2`（`DELIVERY_MANIFEST.json` 不同步）会直接阻断 T02 的交付哈希校验，需控制端先行处理
