# T07B · 全面测试执行状态（第一轮）

- 日期：2026-10-21
- 规格来源：`config/test-cases.json`（**130 项**，14 模块，P0 44 / P1 86）
- 覆盖登记：`config/specs-coverage.json`（逐条登记实施文件与覆盖判定）
- 台账：`reports/branches/T07B_LEDGER.json` / `T07B_LEDGER.md`
- 隔离：全部在独立 QA 实例内执行，开发知识库零变化（见 §5）

## 1. 结论摘要

| 判定 | 数量 | 占比 | 含义 |
|---|---|---|---|
| **COVERED** | **42** | 32% | 有真实跑过并通过的实施测试，且该测试断言了规格的全部期望 |
| **PARTIAL** | **75** | 58% | 实施测试真实通过，但**未断言规格的全部期望**（逐条写明缺口） |
| **BLOCKED** | **13** | 10% | 被真实账户/管理员配置阻断，未执行，不得声称通过 |
| UNMAPPED / NOT_EXECUTED | **0** | 0% | 无悬空规格 |

**已确证的产品缺陷：0 个。** 本轮发现并修复的是 **QA 控制包自身 1 个缺陷**（见 §3）。

**必须说清的一点**：156/156 的回归全绿**不等于** 130 项规格完成。当前真实覆盖是 **42/130 全覆盖 + 75/130 部分覆盖**。剩余 75 项 PARTIAL 是 T07B 的主体工作量 —— 它们的实施测试都通过了，但规格里还有一条到数条期望没有被任何断言守住。

## 2. 按模块

| 模块 | 规格 | COVERED | PARTIAL | BLOCKED |
|---|---|---|---|---|
| 产品外壳 | 8 | 3 | 5 | 0 |
| 项目与领域 | 12 | 8 | 4 | 0 |
| 知识引擎与Git维护 | 12 | 2 | 10 | 0 |
| Workbench真实对话 | 12 | 2 | 9 | 1 |
| 右侧工作区 | 10 | 4 | 6 | 0 |
| 知识检索与范围 | 8 | 1 | 7 | 0 |
| 长期记忆 | 8 | 0 | 8 | 0 |
| 外部Agent集成 | 10 | 2 | 8 | 0 |
| 活动与诊断 | 8 | 0 | 8 | 0 |
| 设置与生命周期 | 10 | 1 | 9 | 0 |
| 额度与恢复 | 8 | 0 | 0 | **8** |
| 版本和远程门禁 | 8 | **8** | 0 | 0 |
| 候选发布和安装 | 8 | 4 | 0 | 4 |
| 工程清理 | 8 | 7 | 1 | 0 |
| **合计** | **130** | **42** | **75** | **13** |

### 2.1 覆盖最弱的三个模块（下一轮重点）

| 模块 | 问题 |
|---|---|
| **长期记忆 8/8 全部 PARTIAL** | 现有 `knowledge-scopes-test.js` 只覆盖范围隔离，规格要求的"手动添加记忆""候选与已确认分离""确认后生效""项目间不泄漏""指纹去重""删除与来源标记"**全部无断言** |
| **活动与诊断 8/8 全部 PARTIAL** | 现有测试覆盖脱敏与 SSE 无缺口，但"游标分页""操作流与结构化错误详情""错误栈凭据""容量与保留策略""查看器与筛选"未断言 |
| **知识引擎与Git维护 10/12 PARTIAL** | 提交证据、边界冻结、孤儿 claim、晋升恢复都有测试，但"A成功B失败C等待不越序""跨项目并发无文件串写""离线提交补偿且已完成SHA不重跑""staging越界拒绝""同一意图不重复派发"未断言 |

## 3. 本轮发现并修复的缺陷（QA 控制包，非产品）

### DEF-001 · browser-shell 过度隔离导致真实浏览器无法启动

| 阶段 | 证据 |
|---|---|
| 复现 | `artifacts/browser-1792597364501/`、`artifacts/browser-1792597443202/`（两次失败运行，失败现场保留） |
| 症状 | `Failed to launch CDP browser: Timed out waiting for DevToolsActivePort file`；Chrome stderr：`DevTools remote debugging requires a non-default data directory` + `Can't retrieve app data directory` |
| 根因 | `tools/browser-shell.cjs` 给子进程用了 `isolatedEnv(run, browserEnv(cfg))`。`isolatedEnv` 会重写 `HOME`/`USERPROFILE`/`APPDATA`/`LOCALAPPDATA`；Chrome 在 Windows 上据此判断默认用户数据目录，于是认为传入的 `--user-data-dir` 就是默认目录并**拒绝开启远程调试**。这与 `lib/runner.cjs` 先前修过的缺陷是同一类，**但 browser-shell 从未被修过** —— 它此前从未被成功执行过。 |
| 最小修复 | `tools/browser-shell.cjs` 改用 `browserCapableEnv(cfg, run)`（与 runner 同一实现）：仅对浏览器用例归还真实 `HOME`/`USERPROFILE`/`APPDATA`/`LOCALAPPDATA`，其余隔离（数据目录、知识根、向量根、临时根、模块开关）照旧；浏览器 profile 仍为每次新建 |
| 回归 | `node tools/browser-shell.cjs <abs config>` → **PASS**；`artifacts/browser-1792597601145/`：**48 个真实浏览器用例**（4 分辨率 × 2 主题 × 6 视图）、**49 张截图**、`importVerified: true`；QA 包 `npm test` **106/106 通过** |
| 影响 | 修复前该仓库唯一的真实浏览器 E2E 工具**完全不可用**；修复后 NAV-006（真实输入事件、不用 DOM.click）、NAV-007（分辨率矩阵）、PRJ-001/002/004/005/006/007、ENG-001 获得真实浏览器证据 |

> 顺带记录：首次调用 `tools/browser-shell.cjs` 传相对路径 `config/local.json` 会失败（子进程 `cwd` 是 repair clone）。工具需要**绝对路径**。这是调用约定，不是缺陷。

## 4. 本轮取得的真实执行证据

| 证据 | 位置 | 结果 |
|---|---|---|
| 浏览器 E2E 收据 | `artifacts/browser-1792597601145/receipt.json` | **PASS**，mode `REAL_BROWSER_SHELL_MOCK_MODULES`，exitCode 0 |
| 浏览器用例明细 | `artifacts/browser-1792597601145/browser-result.json` | 48 用例，4 分辨率 × 2 主题 × 6 视图全覆盖 |
| 截图 | 同目录 `*.png` | 49 张（48 视图 + import-result） |
| QA 包自检收据 | `artifacts/qa-selftest-2026-10-21T15-48-25-017Z/receipt.json` | **PASS**，106/106，0 跳过 |
| 产品套件收据 | `artifacts/test-all-1792592987036/receipt.json` | **PASS**，156/156，0 跳过，0 超时，exit 0（开发库占用 5757 条件下） |
| 失败现场 | `artifacts/browser-1792597364501/`、`browser-1792597443202/` | 保留，未清理 |

## 5. 开发知识库在 T07B 期间零变化

| 指标 | T07B 开始前 | T07B 期间 | 判定 |
|---|---|---|---|
| `events/journal/events.jsonl` | 396,955 B / mtime 14:14:02.014Z | **396,955 B / mtime 14:14:02.014Z** | **字节与时间戳完全未变** |
| knowledge-engine runs | 323 | 323 | 未变 |
| 记忆 | 49 | 49 | 未变 |
| 知识根 Markdown | 467 | 467 | 未变 |
| 旧版 v4 遗留目录 mtime | 2026-10-09 03:46:30 | 2026-10-09 03:46:30 | 未变 |
| 健康检查 | 10/10 | 10/10 | 全绿 |
| 隔离断言 | OK | OK | 通过 |

## 6. 13 项 BLOCKED（不得声称通过）

| 规格 | 阻断原因 | 需要什么 |
|---|---|---|
| QTA-001…008（8） | 无 MiniMax CLI、无 API Key、无已验证 worker 适配器 | **T03**：真实订阅账户 schema 回执 + 周权益核对 + 真实 worker 适配器。自检已用合成数据覆盖门禁逻辑（见台账 note），但**不构成通过** |
| WB-003 真实模型抽测 | 同上 | 同上；不得以替身冒充 MiniMax-M3.1-Flash |
| REL-003 / 004 / 005 / 008（4） | 受保护环境 `npm-rc-gate` 实测 `total_count=0`；npm Trusted Publisher 未核对 | **管理员配置**受保护环境与 Trusted Publisher；T11 独立阻断，不影响其他测试 |

## 7. 下一轮（按优先级）

1. **补 75 项 PARTIAL 的缺失期望** —— 优先：长期记忆 8、活动与诊断 8、知识引擎 10（这三块 26 项全部或几乎全部 PARTIAL，且缺口最集中）
2. **视觉回归补齐** —— NAV-007 已有 49 张截图但 `visualApproval: false`、无像素基线；需建立已批准的视觉基线（`templates/visual-baseline.example.json`）
3. **性能/并发/压力** —— T10 的 `tools/performance.cjs` 需要已批准基线；与本轮 130 项规格的对应关系待补
4. **CLN-005** —— 超容量报警与停止新大任务的自检用例缺失（唯一 1 项 ENG/CLN 侧的用例级缺口）
5. 保持每次跑测试后执行 `node tools/protected-dev-kb.cjs health` 并把结果记入台账
