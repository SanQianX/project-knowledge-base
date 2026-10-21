# T03 / T11 · 门禁与能力阻断状态

- 日期：2026-10-21　基线：`c7d5b2bc86b7e51fe6e322999294bb497af1808c`（5.0.24）
- 依据：`plans/03…` 之外的 `plans/06_QUOTA_WATCHDOG.md`、`plans/08_NPM_RC_RELEASE.md`、`plans/13_TOOLING_AND_LOCAL_ADAPTER.md`

## 1. T03 · 实际 Agent 与额度通道 —— BLOCKED

### 1.1 现场事实

| 项 | 实测结果 |
|---|---|
| MiniMax CLI（`mmx` / `minimax` / `minimax-cli`） | **未安装**（PATH 与 `npm ls -g` 均无） |
| `MINIMAX_API_KEY` | **未设置** |
| `QA_GATEWAY_TOKEN` | **未设置** |
| `config.quota.executable` | **空字符串** |
| `config.quota.weeklyPercentField` / `weeklyEntitlementEvidence` | **null**（须来自真实账户脱敏 schema 回执） |
| `config.worker.executable` / `args` | **空** |
| `config.worker.adapterValidated` | **false** |
| 实际执行 `node scripts/qa.cjs quota --config config/local.json` | `{"status":"BLOCKED","code":"EXECUTABLE_MISSING","message":"An existing absolute executable path is required."}` |

### 1.2 判定

**`BLOCKED_QUOTA` + `BLOCKED_ADAPTER`。**

- `lib/quota.cjs` 要求 `mode` 为 `cli` 或 `http`；`cli` 模式要求一个**已存在的绝对可执行路径**（`executable()` 校验），且周额度字段必须由**真实账户的脱敏 schema 回执**选定，不允许猜测字段名
- `tools/supervisor.cjs` 入口强制 `worker.adapterValidated === true && controllerIsolationVerified === true`，否则 `ADAPTER_UNVERIFIED`
- 计划 `00_README_FIRST.md` 要求：模型进程应由**受控 broker 在独立低权限 Windows 账户/沙箱**中运行，"不可把普通同权限 node 进程标为安全"。本机不存在这样的 broker；`config._isolationNote.notVerified` 已如实记录

### 1.3 已经完成的部分

**假额度闭环已通过**（QA 包自检覆盖，106/106）：
- `gateway exhaustion blocks actual next upstream call` —— 额度耗尽后真正阻断下一次上游调用
- `gateway recovery requires consecutive fresh samples` —— 恢复需连续两次新鲜采样
- `gateway authorized request proxies` / `unauthorized blocked` / `model mismatch blocked` / `output bound blocked`

**真实单次调用无本地回执** → T03 出口条件（"真实单次调用有本地回执"）**未满足**。

### 1.4 后果

| 依赖项 | 状态 |
|---|---|
| T08 逐 Bug 修复的**无人值守 Agent 循环** | **不可开**。工具自身会在入口以 `ADAPTER_UNVERIFIED` 阻断 |
| T06 真实浏览器验收 | 已闭合（浏览器可见性已修，156/156 通过） |
| 额度守护 | `BLOCKED_QUOTA` —— 无法声称"无人值守可靠" |

## 2. T11 · RC 候选发布 —— 前置门禁未齐备

### 2.1 已完成

- RC-only 工作流已装为同名 `.github/workflows/publish.yml`（提交 `eb2f879`），26/26 反例测试通过
- 7 项门禁条件逐条核验：`qa-rc/*` 触发 ✓、`--tag next` ✓、`RC_ONLY_DURING_QA` ✓、不含 `- 'v*'` ✓、受保护环境 `npm-rc-gate` ✓（**声明存在，但环境本身未创建，见 2.2**）、`--provenance` ✓、无 stable/latest 写命令 ✓
- 候选版本号 `5.0.25-rc.1` **尚未被占用**，可用

### 2.2 未齐备的硬前置

| # | 前置 | 实测 | 影响 |
|---|---|---|---|
| 1 | GitHub 受保护环境 `npm-rc-gate` | `gh api repos/SanQianX/project-knowledge-base/environments` → **`total_count: 0`** | **若直接跑工作流，GitHub 会隐式创建该环境且不带任何保护规则** —— 计划 08 要求的"管理员设置独立 reviewer、禁止自行审批"就落空了，门禁变成摆设 |
| 2 | npm Trusted Publisher（OIDC）配置 | 包的 `publishConfig` 未声明；已发布 5.0.24 的 `gitHead` 为 `undefined` | 需管理员在 npm 包设置中核对仓库/工作流文件/环境三者匹配，模型无法自行验证或修改 |
| 3 | 本机 npm registry 指向 | `npm config get registry` → **`https://registry.npmmirror.com`**（镜像，非官方源） | QA 隔离环境已把 `npm_config_registry` 钉死为 `https://registry.npmjs.org`（`lib/safety.cjs`），因此 QA 工具链本身安全；但**任何在隔离环境之外执行的 npm 命令都会落到镜像**。T12 的"从官方源独立安装"必须确认走官方 registry |
| 4 | 候选版本号与 dist-tag 现状 | `latest=5.0.24`、`next=5.0.24`（两者相同） | 发布 RC 到 `next` 会把 `next` 从 5.0.24 移开，`latest` 保持 5.0.24 —— 符合"latest 整个测试周期不由 QA 自动修改" |

### 2.3 判定

**`PENDING_ADMIN_SETUP`**：受保护环境与 npm Trusted Publisher 属**管理员配置**，模型不得自行创建、不得修改工作流以绕过审批、不得在缺保护规则的情况下触发发布。

在门禁 #1、#2 齐备前，T11 只允许做 **dry-run**（`rc-plan` 生成固定 version/SHA/tag/next/latestBefore 计划）并核对 pack 文件清单，**不得推候选 tag、不得 publish**。

## 3. 待你处理的两件事

| # | 事项 | 谁来做 | 阻断什么 |
|---|---|---|---|
| A | 创建 GitHub 受保护环境 `npm-rc-gate`，设置独立 reviewer / 禁止自行审批 / 受保护 tag 与工作流权限 | **仓库管理员**（GitHub 设置页） | T11 实际发布、T12 独立安装验收 |
| B | 装 MiniMax CLI 并配置订阅凭据，或指定一个**已验证的受限 broker/适配器**入口 | **你 / 控制端** | T03 真实额度回执、T08 无人值守修复循环 |

在 A、B 到位前，计划能继续推进的只有：T08 的**人工/受控**修复（当前无已确证产品缺陷，故无 Bug 合同）、T09 清理候选分析（`cleanupEnabled` 仍为 false，需单独窗口批准）、T13 收敛报告草稿。
