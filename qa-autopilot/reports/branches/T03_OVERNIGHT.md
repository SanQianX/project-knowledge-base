# T03-OVERNIGHT · 真实 Worker / 额度通道 / 独立 Supervisor 交付记录

- 日期：2026-10-21
- 目标：今晚只启动一次 QA Autopilot 即可自动推进；额度不足自动保存并暂停，恢复后自动继续，全程无需人工消息
- 状态：**已实现并通过 A–H 故障注入验收（总判定 READY）；通宵 Supervisor 已启动运行**

## 1. 真实 ZCode Worker（非模拟、非提示词）

### 1.1 现场勘察结论

本机 ZCode 桌面程序 `D:\Program Files (x86)\ZCode\ZCode.exe`（版本 **3.15.3**）内置 CLI 入口 `resources/glm/zcode.cjs`（CLI 版本 **0.16.9**）。**该 CLI 可脱离 Electron 用纯 node 运行**：

```bash
node "D:/Program Files (x86)/ZCode/resources/glm/zcode.cjs" \
  --prompt "<任务>" --cwd <隔离目录> --surface terminal \
  --mode yolo --disallowed-tools "Bash" --no-color --json [--resume <sessionId>]
```

| 要求 | 实测结果 |
|---|---|
| 非交互 CLI | ✅ `--prompt` 单次执行，无 TTY 依赖（**输出必须重定向到文件，管道会导致挂起**） |
| `--prompt` 执行任务 | ✅ 实测创建文件并返回结构化结果 |
| `--resume <sessionId>` | ✅ 同一 `sessionId` 续跑，新 `traceId`/`turnId`，上下文保留 |
| `--cwd` 指定工作目录 | ✅ 任务在指定隔离目录内完成 |
| 结构化结果与退出码 | ✅ `--json` 输出 `sessionId/traceId/turnId/response/usage/projection`；退出码 0 成功、9 崩溃、75 额度暂停、124 超时 |
| MiniMax 模型与订阅身份 | ✅ rollout 里的 **provider 真实流量**显示 `model: MiniMax-M3.1-Flash`（不采信 agent 自述） |

### 1.2 Worker 适配器（`tools/zcode-worker.cjs`）

- 输入：QA 包既有的 `pkb-qa-task/v1` 协议（stdin）；输出：写 `QA_RESULT_FILE`
- **安全属性**：
  - `--disallowed-tools "Bash"` → Agent 只能读写文件，不能执行 shell/git
  - **影子 HOME**：只放 MiniMax provider 配置（`v2/provider_config.json`）与**剥离 hook** 的 `cli/config.json`；不带 `UserPromptSubmit` hook ⇒ **QA 合成对话绝不进入开发知识库**（实测开发库 journal 字节与 mtime 全程未变）
  - 订阅 Key 运行时从 ZCode provider 配置注入子进程环境，**不落盘、不写日志**
- **踩过的坑（都已定位并修复）**：
  1. `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` / `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` 被 `isolatedEnv` 丢掉 → CLI 找不到 provider 配置直接失败 → 改由 config 提供并重映射到影子副本
  2. 影子 HOME 里若存在 Z.AI 的 `credentials.json`，CLI 会转而解析内建 provider 而失败 → 不复制该文件
  3. 影子 HOME 里存在 `.zcode/v2/` 同样触发内建 provider 解析 → 影子只保留 `v2/provider_config.json` 与 `cli/config.json`

## 2. 真实 MiniMax 额度通道

- `mmx` CLI **未安装**；改用**官方 Token Plan 额度接口**（计划 08 认可的另一条路径）
- 端点：`https://api.minimax.cn/v1/token_plan/remains`
  - **`api.minimax.io` 拒绝这把区域 Key**（返回 `status_code 2049 invalid api key`）→ 端点必须是 `api.minimax.cn`（QA 包白名单内）
- 响应结构（真实账户脱敏 schema 回执：`artifacts/minimax-quota-schema-receipt-20261022.json`）：

| 字段 | 含义 |
|---|---|
| `model_remains[].model_name` | 额度池名（实测 `general` / `video`） |
| `current_interval_remaining_percent` | **五小时窗口**剩余百分比 |
| `current_weekly_remaining_percent` | **周额度**剩余百分比 |
| `current_interval_status` / `current_weekly_status` | 窗口状态码 |
| `current_*_total_count` / `usage_count` | 实测为 0，**不可用于推算百分比**，只采用显式 percent 字段 |

- **与 Worker 同一订阅**：额度查询与 Worker 都读**同一个 ZCode provider 配置**里的同一把 `sk-cp-` 订阅 Key ⇒ 天然同账户同池
- **实证**：适配器跑完 1 次真实任务后，额度从 **85% → 73%**；后续多次实测降到 10% ⇒ 通道测的确实是 Worker 在消耗的那个池
- **按量付费被自动拒绝**：`lib/quota.cjs` 对 `sk-api-` 前缀直接 `SUBSCRIPTION_KEY_REQUIRED`

### 2.1 阈值执行（与授权一致）

| 剩余 | 状态 | 行为 |
|---|---|---|
| > 20% | RUNNING | 正常派发 |
| ≤ 20% | **DRAINING** | 不再领取新任务（已验证） |
| ≤ 10% | **PAUSED** | 禁止发起新模型调用 |
| ≥ 35% 且连续两次有效采样 | 恢复 | 允许继续（已验证） |

## 3. 独立 Windows Supervisor（`tools/overnight-supervisor.cjs`）

| 要求 | 实现 |
|---|---|
| 独立于模型会话 | 独立 node 进程，`cmd /c` + `<NUL` 启动，不继承父进程任何句柄（Windows 管道继承问题已修） |
| 载入台账与持久化队列 | `build-queue` 从 `T07B_LEDGER.json` 生成 **11 个任务 / 71 项规格** |
| 派发下一项 | 每轮领取一个任务，提交→推送→CI→下一项 |
| 创建与恢复 Worker | `--resume` 续跑；失败任务回到 PENDING |
| 额度检查与安全暂停 | 每轮检查；≤10% 停止发起模型调用 |
| 等待恢复并自动继续 | 轮询重查，恢复后自动继续，**不结束进程** |
| 检测 Agent 退出与超时 | 退出码 9 → FAILED；超时 → `AGENT_TIMEOUT` |
| 保存状态与证据 | 原子写 `state.json` + 追加 `journal.jsonl` + 证据落 `artifacts/overnight/` |
| 防止重复提交 | 提交前校验 allowlist；已推送的不重推；恢复时对账远程 SHA |
| 全部完成即停 | `ALL_EXECUTABLE_TASKS_DONE` 后停调度并出最终报告 |
| 单实例锁 | `state/overnight/supervisor.lock`；持有者**存活**时拒绝，**已死**时接管（不按年龄偷锁） |

### 3.1 断点续跑

每项任务持久化：Test ID、阶段、Git SHA、sessionId、状态、测试收据、提交 SHA、CI 状态、额度状态、下一步动作。恢复时先核对实际工作区、远程 Git、CI 与既有证据，确认此前动作是否已完成；**已推送的提交不重推**；未确认的半成品（`AGENT_RUNNING`/`VERIFYING` 中断）**退回 PENDING 不前进**。

## 4. 故障注入验收 A–H（`tools/overnight-acceptance.cjs`）

**模拟项（用模拟额度与假 Worker，结果确定、不烧真实额度）**

| 项 | 结果 | 证据 |
|---|---|---|
| A Worker 完成后自动领取下一项 | **PASS** | 任务1=COMMITTING（已提交 `12c94c39`），随即领取任务2 |
| B 模拟额度耗尽暂停、恢复后继续 | **PASS** | 15% → DRAINING（不领新任务）；恢复到 50% → 任务1 继续 |
| C Supervisor 重启恢复检查点 | **PASS** | revision 10→12 单调递增，任务状态保留 |
| D Agent 意外退出后不重复 Git 提交 | **PASS** | 远程提交数 3→崩溃后 3→重启后 3（无重复、无半成品提交） |

**真实项（真实订阅额度、真实 ZCode CLI、真实开发知识库）**

| 项 | 结果 | 证据 |
|---|---|---|
| E 实际订阅额度可查询且与 Worker 同一订阅 | **PASS** | 五小时 38% / 周 100%，池 `general`，来源 `explicit_percent` |
| F ZCode 无人工输入完成真实 CLI 任务 | **PASS** | 退出码 0，sessionId `sess_a3ff8d75…`，模型 `["MiniMax-M3.1-Flash"]`，产物内容 `REAL_CLI_NO_HUMAN` |
| G 开发知识库始终正常运行且不被 QA 写入 | **PASS** | 健康 10/10 → 10/10；开发库 journal 字节与 mtime 未变（396955 B） |
| H 锁屏后非交互测试仍可执行 | **PASS** | 非交互套件实跑 exit=0；已标注 6 个需交互桌面的浏览器用例 |

**总判定：READY**（模拟 4/4，真实 4/4）

## 5. 隔离与保护

| 对象 | 措施 |
|---|---|
| 源码 | 独立 clone `.runtime/workspaces/repair`（基线 `c7d5b2b`） |
| 数据目录 / 知识根 | 子进程 `KB_DATA_DIR` / `KB_KNOWLEDGE_DATA_DIR` → 每次运行独立目录；隔离数据目录无 settings → 知识根解析 409 拒绝，**不可能落到 `D:\SanQian.Xu\knowledge`** |
| 浏览器 profile | 每次新建 profile 目录 |
| 端口 | 测试一律显式端口；产品默认 5757 被占用时自动后移 |
| 模拟对话 | 影子 HOME 无 UserPromptSubmit hook ⇒ 不进入开发知识库 |
| 开发知识库 | `PROTECTED_DEV_KB`：不关闭/重启/升级/卸载/改数据；`tools/protected-dev-kb.cjs` 只读健康检查 10 项 |
| QA 提交 | QA 临时 clone **无受管 Hook** ⇒ 其提交结构上不可能进入开发知识库 |

## 6. 启动入口

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-overnight.ps1          # 启动
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-overnight.ps1 -Status  # 只看状态
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-overnight.ps1 -Stop    # 停调度（不碰开发知识库）
```

启动前强制检查：故障注入验收必须 READY、控制包自检必须 PASS、开发知识库健康必须 OK，任一不过就拒绝启动。

打印项：Supervisor 状态/PID、Worker 状态、当前阶段与 Test ID、**可验证的剩余额度**、已完成/未完成/阻断的测试数、Git SHA 与 QA 分支、开发知识库保护状态、日志与检查点路径。

## 7. 当前运行态（2026-10-21 18:15Z）

| 项 | 值 |
|---|---|
| Supervisor | **运行中**，node PID 38656，单实例锁持有者一致 |
| 真实额度 | 五小时 **10%**（窗口 **21:00Z / 本地约 03:00 重置**），周 100% |
| 状态 | **PAUSED_QUOTA** —— 五小时窗口 ≤10%，按规则禁止发起新模型调用；**窗口重置后自动恢复**（≥35% 且连续两次采样确认） |
| 队列 | 11 个任务 / 71 项规格，0 完成（额度恢复后开始） |
| 开发知识库 | PROTECTED / RUNNING（10/10） |

> 额度从 85% 降到 10% 是**本轮真实调试消耗**（每次真实 Worker 任务 1 次模型请求、8 次 provider 往返、约 14 万 token）。系统按设计进入暂停并等待窗口重置 —— 这正是"额度不足自动保存并暂停、恢复后自动继续"的实际演练。

## 8. 仍未解决（不阻断通宵跑）

| 项 | 状态 |
|---|---|
| T11 实际发布 | 仍被管理员门禁阻断：受保护环境 `npm-rc-gate` 未创建（`environments` 为空），npm Trusted Publisher 未核对 |
| WB-003 真实模型抽测 | 随 T03 一并 BLOCKED（额度窗口未恢复） |
| 6 个浏览器用例需交互桌面 | 锁屏时会失败 → 标为需交互桌面（验收 H 已标注） |
| 旧版 v4 数据 1.3 GB | 保留为迁移回滚资产，禁写禁删 |
