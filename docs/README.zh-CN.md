# project-knowledge

本地、由 Git Commit 驱动的项目知识服务。Markdown 是知识事实源；LanceDB
只是位于内部数据目录、可随时重建的派生索引。

## 安装与运行

```bash
npm install -g project-knowledge
project-knowledge
```

默认只监听 `127.0.0.1:5757`。CLI 会记录实际 loopback endpoint，托管 Git
Hook 不依赖写死端口。

```bash
project-knowledge
project-knowledge --fg
project-knowledge status
project-knowledge stop
```

需要 Node.js 18+ 与 `PATH` 中的 Git。Windows 桌面安装包与 npm CLI 共享同一
数据目录和 backend owner 记录，不会同时启动两个 LanceDB writer。

## 唯一分析流程

公开分析入口只有两个：

```text
post-commit Hook ----+
                     +--> reconcileProjectCommits(projectId, trigger)
程序 startup --------+      trigger: git-hook | startup
```

导入只建立 Git tracking baseline、创建项目元数据并安装/验证 Hook；不运行 AI、
不扫描全仓推测需求、不生成 TODO 知识。空仓库导入后的第一个 Commit会被处理。

Hook 只向本地主程序发送 `hook-event/v2` 通知。主程序离线时 Hook 仍返回成功，
不阻塞 `git commit`，也不写离线任务 spool；下次启动从当前 Git 历史补查可达
Commit。同项目严格串行、失败即停；不同项目可并行；Hook 与 startup 重叠时复用
同一个 in-flight reconciliation。

## 知识与索引安全

每个 Commit 的 claim 会冻结 Commit SHA、真实 patch、绑定的 requirement IDs、
prompt hash 与固定 knowledgePath。AI 只能写内部 per-run staging，不能写源码或
final knowledgePath。产物 manifest 必须通过路径、UTF-8、Markdown、hash、证据与
操作类型验证。

Promotion 使用 backup、hash 与 durable journal。只有 Markdown promotion 验证
成功后才推进 lastAnalyzedCommit 并把 index 标为 dirty。索引失败不会回滚真实
Markdown，也不会重跑 AI；启动和维护流程会重试 dirty index。

`IndexService` 是唯一生产 LanceDB writer。增量更新和 full rebuild 共用一个全局
FIFO。完整重建先生成独立临时 DB，验证后原子替换，并在 recovery 中保留旧索引。

应用不会创建、修改、刷新或删除 `CLAUDE.md`。

## 需求记录与查询

Claude Code、Codex、OpenCode 集成可在编码前追加用户真实需求元数据。记录写入
项目 `requirements.jsonl`，不会触发分析或写知识。

MCP 提供只读 `resolve/search/ask/get/history`，以及唯一写能力
`record_requirement`。CLI 示例：

```bash
project-knowledge-kb search --project <projectId> --query "令牌轮换" --json
project-knowledge-kb ask --project <projectId> --query "登录方案如何决定？"
project-knowledge-kb get --project <projectId> --entry modules/auth.md --json
project-knowledge-kb history --project <projectId> --json
```

只读查询不会创建或修改配置。索引缺失、dirty 或不可用时，会明确回退到当前项目
以及显式 related projects 的 Markdown。

## 存储合同

内部数据默认在 `~/.project-knowledge/`，可用 `KB_DATA_DIR` 修改。用户必须先设置
global knowledge root，再导入项目；它只影响未来导入。每个项目导入时固化绝对
knowledgePath，修改 global root 不会移动已有项目。

```text
~/.project-knowledge/
├── settings.json
├── projects.json                         # 仅 ID、顺序、最小显示快照
├── projects/<projectId>/
│   ├── config.json                       # 固定 repoPath/knowledgePath
│   ├── state.json                        # tracking/claim/index/Hook 状态
│   └── requirements.jsonl                # 按需创建
├── index/knowledge.lancedb               # 唯一派生索引
├── cache/
├── runtime/
├── logs/{app,projects,hooks}/
└── recovery/

<用户选择的知识根>/
└── <项目 storage name>/
    ├── README.md
    ├── GOAL.md
    ├── ARCHITECTURE.md
    ├── modules/*.md
    └── changes/*.md
```

Team knowledge 是显式例外：项目可绑定已经 checkout 的 team store 子目录。路径
仍必须位于所选 store 内并固化到 config；删除项目注册时不会删除这类外部知识。

## 迁移

`layout-v2` 迁移先只读发现旧资产，创建 journal 和集中 recovery backup，再 staging
settings、per-project config/state、最小 registry 与旧 index。验证路径、secret、
Commit pointer、日志和索引后才激活，completion marker 最后写。任何阶段中断都
保留旧 reader、用户知识、历史日志、配置与 backup，允许安全重试。

## 日志 UI

生产 UI 只保留一套结构化日志控制台，支持：

- trace/debug/info/warn/error/fatal 六级；
- 本地日期、项目、component、event、operation、Commit、全文过滤；
- newest-first cursor 分页、暂停/自动刷新、按当前条件导出；
- operation flow、结构化 error/stack、logger degraded 状态；
- Hook/index/项目只读状态、浅色/深色与窄屏布局。

日志使用 `log/v2` JSONL，按天和 50 MiB segment 轮转；默认保留 365 天，`0`
表示不按时间删除，并受总容量策略约束。写入、查询、error 与 export 全部递归脱敏。
日志根固定在内部数据目录，不能由 API 修改。

## API 安全

默认 loopback + same-origin，不使用 wildcard CORS。非回环绑定必须配置
`KB_SITE_AUTH_TOKEN` 并通过 Origin 校验。AI profile GET 只返回 masked metadata；
通用错误不返回 stack；不存在 raw-file、通用项目覆盖、手动 Hook 或手动分析接口。

## 验证

```bash
npm ci
npm test -- --no-report
npm test --prefix desktop
npm pack --dry-run --json
```

Windows E2E 覆盖真实 Git Hook、空格/非 ASCII 路径、在线 Commit、停服期间多个
Commit、重启顺序补查、crash lock 恢复、promotion/index、查询与完整日志链路。

## 许可证

[Apache-2.0](../LICENSE)，另见 [NOTICE](../NOTICE)。
