# 开发知识库架构调整 · PROTECTED_DEV_KB 登记与隔离验证

- 日期：2026-10-21
- 方案：开发知识库 = 已安装的桌面客户端常驻系统托盘；QA 测试 = 独立浏览器 + 隔离测试实例
- 约束：全程只读勘察优先；不重装/升级/降级/迁移；不关闭桌面客户端；不结束其后台进程；不改其数据文件

## 1. 安装勘察（只读）

本机存在**两个** Project Knowledge 桌面程序，它们不是同一个东西：

| # | 安装 | 位置 | 版本 | 内核 | 数据目录 | 判定 |
|---|---|---|---|---|---|---|
| A | **Squirrel 桌面安装** | `C:\Users\SanQian\AppData\Local\project_knowledge`（`app-4.1.11\`） | 安装名 **4.1.11**；`resources/app.asar` 内实际代码版本 **4.1.7** | v4 时代 | `~/.project-knowledge` | **v4 旧血脉，不启用** |
| B | **npm 全局桌面壳** | `C:\Users\SanQian\AppData\Roaming\npm\node_modules\@sanqianx\project-knowledge-desktop` | **5.0.18** | `@sanqianx/project-knowledge@5.0.18`（薄壳引用同版本内核，`versionState = match`） | `~/.project-knowledge-v5` | **采用** |

### 1.1 为什么 A 必须排除（这是真实的版本冲突，不是保守）

- A 的 asar 内**完全没有** `.project-knowledge-v5` 字样，只有 v4 时期的 `.project-knowledge`
- 你的真实知识库在 `~/.project-knowledge-v5`（174 MB，7 个项目，knowledge-engine 运行态、events journal）；A 指向的是 v4 遗留目录（1.3 GB）
- 仓库 README 明确：**「Version 5 is a fresh start, not a data upgrade」**、**「Desktop version 5.0.0 delivers the web product through npm. A new Windows installer and desktop auto-update are not part of this release.」**
- 若启动 A，它拉起的是 v4 后端，**读不到你的 7 个项目**，并会向 v4 遗留目录写入 —— 违反「原有知识库配置、项目、知识和记忆保持完整」

**结论：启动 A = 版本冲突 → 按授权条款 11 停止启动尝试并报告；改用已全局安装的 B。** 这不是重装、升级或降级：B 本来就在你机器上，且其内置内核 5.0.18 与你的 v5 数据 schema 逐项吻合。

### 1.2 B 与你的数据的兼容性（启动前逐项核对）

| 检查 | 5.0.18 期望 | 你的实际 | 结果 |
|---|---|---|---|
| `settings.json` | `settings/v2` schemaVersion **2** | `settings/v2` schemaVersion **2** | ✅ |
| `projects.json` | `project-registry/v2` schemaVersion **2** | `project-registry/v2` schemaVersion **2** | ✅ |
| 项目 config | `project-config/v2` schemaVersion **2** | `project-config/v2` schemaVersion **2** | ✅ |
| 数据目录 | `getDataDir()` = `C:\Users\SanQian\.project-knowledge-v5` | 同一路径 | ✅ |
| 知识根 | 由 `settings.knowledge.rootPath` 决定 | `D:\SanQian.Xu\knowledge` | ✅ |
| v4→v5 迁移 | 仅在旧布局时触发 | 已是 v5；`recovery/` 不存在 → **未触发任何迁移** | ✅ |

## 2. 启动与托盘隐藏

| 步骤 | 结果 |
|---|---|
| 启动 | `node <global>/@sanqianx/project-knowledge-desktop/bin/project-knowledge-desktop.cjs start`（隐藏控制台窗口） |
| 后端就绪 | 桌面壳自行拉起 v5 内核并发布运行端点；`/api/health` 返回 `{"ok":true,...,"projects":7}` |
| 隐藏到托盘 | 向 Electron 主窗口（PID 16060，标题 `Project Knowledge · 我的智脑`）投递 **WM_CLOSE**；应用自身的 `close` 处理器 `preventDefault()` + `hide()`，窗口隐藏而进程与托盘图标存活 |
| 验证 | 隐藏前 `visible=was-visible` → 隐藏后 `visible=False`；**11 个 Electron 进程仍在**；5 个后端端口全部 LISTENING |

> 工具：`qa-autopilot/tools/hide-desktop-window.ps1`。它只投递窗口消息，**不结束任何进程、不写任何文件**。

### 2.1 托盘存活语义（来自应用源码 `desktop/main.cjs`）

```js
app.on('window-all-closed', () => {
  // Tray keeps the app alive; knowledge maintenance continues.
});
app.on('before-quit', (event) => { ... stopOwnedBackend().finally(() => app.quit()); });
```

即：关窗即入托盘、后台知识库继续运行；只有「退出」菜单项或 `before-quit` 才会停掉后台。**本方案不触碰这两个路径。**

### 2.2 启动后的运行态

| 组件 | 端口 | PID | 版本 / 路径 |
|---|---|---|---|
| 知识库后端 | 5757 | 32544 | 5.0.18，`C:\Users\SanQian\.project-knowledge-v5` |
| Agent Terminal (Workbench) | 5760 | 12128 | 数据目录同上 |
| knowledge-engine | 5790 | 39088 | 0.2.7-rc.10，dataDir = v5 |
| vector-hub | 8787 | 45424 | 根 = `D:\SanQian.Xu\knowledge\.indexes` |
| event-bridge console | 8790 | 27956 | home = `C:\Users\SanQian\.project-knowledge-v5\events` |

## 3. PROTECTED_DEV_KB 登记

登记文件：`qa-autopilot/state/protected-dev-kb.json`（`state/` 已 gitignore，纯本地）。工具：`tools/protected-dev-kb.cjs`。

| 字段 | 值 |
|---|---|
| id | `PROTECTED_DEV_KB` |
| 桌面壳 | `@sanqianx/project-knowledge-desktop@5.0.18`，npm 全局安装，窗口状态 `HIDDEN_TO_TRAY` |
| 内核 | `@sanqianx/project-knowledge@5.0.18`，`versionState = match` |
| 端点 | `127.0.0.1:5757`，PID 32544，存活 |
| 数据目录 | `C:\Users\SanQian\.project-knowledge-v5` |
| 知识根 | `D:\SanQian.Xu\knowledge` |
| 项目数 | **7** |
| 禁写路径 | v5 数据目录、v4 遗留目录、知识根（三者） |
| 禁停对象 | 桌面客户端进程、其拥有的后台进程、系统托盘程序 |

与 QA 基线 5.0.24 的关系：**不同实例、不同数据目录、不同端口**，互不影响。开发库 5.0.18 与 QA 基线 5.0.24 的版本差是**已知的、可接受的**（开发库用你已装且已配置好的版本，符合「不得自动升级」）。

## 4. 旧版 v4 数据清查（1.3 GB）

`C:\Users\SanQian\.project-knowledge` —— **它不是残留垃圾，而是迁移回滚资产**。

| 内容 | 体积 | 性质 |
|---|---|---|
| `_ai/` | 1.2 G | v4 时代 10 个项目的 AI 工作区数据（`project-knowledge-base`、`claude-ai-workbench`、`devtask-radar` 等） |
| `vectorhub/` | 31 M | v4 向量库 |
| `logs/` | 19 M | v4 日志 |
| `runtime/` | 15 M | v4 运行期状态 |
| `_backup/vector-migration/` | 5.2 M | **2 个迁移批次的向量回滚备份** |
| `recovery/` | 484 K | v4 恢复资产 |
| `projects/` | 256 K | v4 项目元数据 |
| `index/`、`knowledge.lancedb/` | 各 15 K | v4 索引 |
| 根级 JSON | — | `settings.json`、`projects.json`、`knowledge-scopes.json`、`ai-profiles.json`、`embedding-config.json`、`github-team.json` 等 |

### 4.1 关键发现：它是向量迁移的**唯一回滚副本**

`knowledge-migration.json`（schema `project-knowledge/vector-migration/v1`，**status: completed**，2026-07-15）记录了 6 个项目的向量迁移，每个都带 `backupPath` 指向 `~/.project-knowledge/_backup/vector-migration/<batchId>/<slug>`，且 `verified: true`：

| 项目 | 文件 | 分块 | 备份路径 |
|---|---|---|---|
| token-consumption-leaderboard | 13 | 148 | `_backup/vector-migration/2026-07-15T16-25-19-570Z/…` |
| kb-postcheck-agent | 4 | 23 | 同上 |
| sanqian-tool | 3 | 10 | 同上 |
| devtask-radar | 33 | 664 | 同上 |
| project-knowledge-base | 62 | 1995 | 同上 |
| claude-ai-workbench | 5 | 17 | 同上 |

另有一个更早的批次 `2026-07-15T14-55-06-368Z`。记录里还带 `legacyKbPath: D:\SanQian.Xu\knowledge\<slug>`，说明迁移源是知识根下的旧目录。

**若删除该目录，迁移前的向量数据将不可恢复。** 因此本方案把它登记为**禁写、禁删**资产。

### 4.2 风险向量与处置

| 风险 | 处置 | 验证 |
|---|---|---|
| 启动 Squirrel 4.1.11 → 写 v4 遗留目录 | **不启动**；登记表中显式注明「不使用、不启动」 | 已在 `protected-dev-kb.json` 的 `desktop.note` 中固定 |
| 本次启动误触 v4 目录 | 未发生 | 目录 mtime 启动前后均为 **2026-10-09 03:46:30**；体积 1.3 G 不变 |
| v5 客户端触发 layout-v2 迁移改写数据 | 未触发 | v5 数据目录 `recovery/` **不存在**（迁移会产生它） |
| QA 流程清理旧目录 | 禁止 | `tools/protected-dev-kb.cjs` 的 `FORBIDDEN_WRITE_PREFIXES` 含该目录；QA 清理工具走白名单，不含它 |
| 无进程/配置引用它 | 已确认 | 无环境变量、无 .npmrc、无进程命令行引用该路径 |

## 5. 采集能力实证（授权条款 8/9）

### 5.1 集成状态

`integration-intent.json`：`{"claude":"connected","opencode":"connected","codex":"connected","zcode":"connected"}` —— **四个客户端全部接通**，含本会话所用的 **zcode**。
`integration-runtime.json`：包根指向桌面壳内置内核 5.0.18，更新时间 2026-10-21T14:21:50Z。

### 5.2 真实开发会话采集 —— **已实证**

`~/.project-knowledge-v5/events/journal/events.jsonl` 共 **237 条**：

| 来源 | 条数 |
|---|---|
| **zcode** | **179** |
| claude-code | 20 |
| codex | 19 |
| 无来源 | 19 |

事件类型：`user_prompt` 115、`assistant_response` 103、**`git_commit_boundary` 19**。

**本会话自身已被采集**，journal 最后一条即其 user_prompt：

```
capturedAt: 2026-10-21T14:14:02.012Z | source: zcode | eventType: user_prompt
sessionId:  sess_908904b7-a1d7-42d0-…   ← 与本次会话 ID 一致
turnId:     turn_1f62300e-2d51-4980-…   | role: user | content 长度: 997
repoIdentity.workspaceId: sha256:9f8dcce9f0771f475f6237f41692457f45ea5e36b3981e6401fa8c6f949ce1a2
```

→ **当前 MiniMax/ZCode 客户端支持开发对话采集，且采集真实发生。** 不存在「尚不支持」的缺口需要记录。

### 5.3 真实开发 Git 提交触发分析 —— **已实证**

**链路一：受管 Hook 已安装**（`project-knowledge/hook/v2`，`managedVersion: 2`），5 个开发仓库全部就位并绑定到正确的 projectId：

| 仓库 | projectId |
|---|---|
| project-knowledge-base | `project-5856695b-…` |
| claude-ai-workbench | `project-20e45beb-…` |
| vector-hub | `project-05a64e06-…` |
| knowledge-engine | `project-35196698-…` |
| ai-coding-event-bridge | `project-bb16737b-…` |

**链路二：真实提交产生了边界事件** —— journal 中 19 条 `git_commit_boundary`，最近 4 条的 SHA 是真实存在的提交：

| 时间 | SHA | 对应提交 |
|---|---|---|
| 2026-10-20T00:16:55Z | `5a0e440085d9` | Workbench `chore(release): 0.13.3 …` |
| 2026-10-20T02:23:43Z | `0cf7245b0e49` | Workbench `fix(release): 0.13.4 …` |
| 2026-10-20T05:20:56Z | `e707334cded2` | Workbench `fix(release): 0.13.5 …` |
| 2026-10-20T08:47:45Z | `423cc0a8957e` | **Workbench `fix(release): 0.13.6 …`** —— 正是 B00 审计锁定的 0.13.6 来源 |

**链路三：分析产物已晋升到知识根** —— 知识根共 **467 篇 Markdown**（`project-knowledge-base` 173、`knowledge-engine` 200、`claude-ai-workbench` 63、`vector-hub` 24、其余 4）。最近 6 篇写于 **2026-10-21 14:24–14:27**（即本次启动期间），文件名直接对应真实提交：

| 知识文件 | 对应提交 |
|---|---|
| `knowledge-engine-8ce6c0\changes\1bfa9a5a7be2.md` | knowledge-engine `origin/main` = `1bfa9a5a7be2` |
| `claude-ai-workbench-a40cb2\changes\731465687fdb.md` | Workbench `fix: keep delayed attachment reads …` |
| `claude-ai-workbench-a40cb2\changes\edecba6e730e.md` | Workbench `fix: scope pending session creation to its project` |
| `knowledge-engine-8ce6c0\changes\8a078c8dca5a.md` + `modules\analysis-failure-classification.md` | 失败分类相关改动（对应 `85c618f` 一线） |

→ **真实开发 Git 提交确实触发了知识分析并晋升为 Markdown。**

### 5.4 采集缺口的诚实记录

`capture-gaps.jsonl` 共 **15 条**缺口，全部是：

```
{"schema":"bridge-capture-gap/v1","source":"codex","reason":"session-file-not-found",…}
```

即 **codex 客户端有采集缺口**（找不到会话文件），ZCode 无缺口。这属于既有事实，记录在案，不影响本方案结论。

### 5.5 原有数据完整性

| 项 | 隔离验证前 | 说明 |
|---|---|---|
| 项目注册 | 7 | 保持 |
| engine-state | 7 projects / **323 runs** / **49 memories** | 记忆在，未被清空 |
| 知识根 Markdown | 467 | 保持并持续增长 |
| 事件 journal | 396,955 B | 持续追加 |
| settings / projects / 项目 config | schema 全部匹配 | 未被改写 |

## 6. QA 隔离（授权条款 5/6/10/11）

### 6.1 隔离面逐项落实

| 面 | 隔离方式 | 证据 |
|---|---|---|
| 源码 | 独立 clone | `.runtime/workspaces/repair`（基线 `c7d5b2b`）、`.runtime/workspaces/baseline-source` |
| 数据目录 | `KB_DATA_DIR` → 每次运行的独立目录 | `lib/safety.cjs` `isolatedEnv` |
| 知识根 | `KB_KNOWLEDGE_DATA_DIR` → 独立目录 | 同上；**且**隔离数据目录没有 settings → 知识根解析直接 409 `INVALID_ARGUMENT`，**不可能落到 `D:\SanQian.Xu\knowledge`** |
| 浏览器 profile | 每次新建 profile 目录 | CDP helper |
| 端口 | 测试一律显式端口；产品默认 5757 被占时**自动回退** | `_site/_test/helpers/` 内**零处**引用 5757 |
| 向量根 | 隔离时回退到 `<dataDir>/vectorhub` | `getVectorRootPath()` |

### 6.2 5757 的每一处出现均已核实无害

| 出现 | 性质 |
|---|---|
| `bin-cli-test.js:118` | 对 `--help` **文本**的断言，不绑定端口 |
| `bin-cli-test.js:169/172/209/210` | 端口回退循环，**显式跳过已占用端口**（`isPortListening(candidate) \|\| isPortListening(candidate+1)`） |
| `bridge-consumer-service-test.js:82/84` | `svc.start('http://127.0.0.1:5757/…')` —— `notifyUrl` 在服务里**只写不读**（`bridge-consumer-service.js` 全文无 `fetch`/`http.request`），仅存入 consumer meta，**不会发出任何请求** |
| `module-dynamic-port-test.js:97` | 注释 |
| `runtime-endpoint-test.js:49/57` | 往隔离数据目录写**假**端点（`pid: 2147483646`），从不连接 |

→ **没有任何 QA 测试会绑定或连接开发库的 5757。**

### 6.3 隔离实证

在开发库占用 5757/5760/5790/8787/8790 的情况下运行全量 QA 套件，结果见 §7。

## 7. 隔离实证结果

见 `qa-autopilot/reports/branches/ISOLATION_PROOF.md`（本轮隔离运行收据 + 开发库前后对比）。

## 8. 定期只读健康检查

工具：`node tools/protected-dev-kb.cjs health`

| 检查 | 含义 |
|---|---|
| `backend_listening` | 5757-5760 有 server-health 响应 |
| `endpoint_stable` | 端口与 PID 与登记一致（未重启、未漂移） |
| `backend_process_alive` | 后端进程存活 |
| `backend_health_ok` | `/api/health` ok |
| `project_count_preserved` | **项目数与登记一致**（数据未被清空） |
| `knowledge_engine_alive` / `knowledge_engine_ok` | 引擎存活、版本与数据目录正确 |
| `exists:<dataDir>` / `exists:<knowledgeRoot>` | 数据目录与知识根仍在 |
| `legacy_v4_dir_present` | v4 遗留目录仍在（回滚资产完好） |

只读保证：只发起 HTTP GET；写操作只落在 `qa-autopilot/state/` 与 `qa-autopilot/reports/`；**不写开发数据目录、不写知识根、不结束任何进程**。

另一工具：`node tools/protected-dev-kb.cjs assert-isolated` —— 断言 QA 配置的 `sourceRoot`/`repoRoot` 既不指向开发数据目录/知识根，也不与彼此相同。当前结果 **ok**。

## 9. 已知差异与未做事项

| 项 | 说明 |
|---|---|
| 开发库内核 5.0.18 vs QA 基线 5.0.24 | **刻意保留**。开发库用你已装好的版本；两者实例、数据目录、端口全隔离 |
| Squirrel 4.1.11 安装 | **保留未卸载**（不擅自删除你的安装），但已登记为不启动。若要清理需你另行批准 |
| v4 遗留目录 1.3 GB | **保留未动**（迁移回滚资产） |
| 采集缺口 | codex 客户端 15 条 `session-file-not-found`；ZCode 无缺口 |
| 桌面窗口 | 隐藏到托盘；双击托盘图标可正常打开（应用自带行为，未被改动） |
