# project-knowledge

本地、由 Git Commit 驱动的智脑知识服务。Markdown 是知识事实源；vector-hub
提供可重建的派生索引。外壳只负责导航、归属、接线与状态投影。

## 安装与运行

v5 不再兼容或迁移旧知识库数据。停止旧版后重新设置模型、知识根目录并导入
项目；默认新数据目录为 `~/.project-knowledge-v5`。旧文件保留但不读取。
详见 [从头开始](fresh-v5-start.md)。

新机器完整安装只需三条命令：

```bash
npm install -g @sanqianx/project-knowledge@latest
project-knowledge-integrations install
project-knowledge
```

1. `npm install -g @sanqianx/project-knowledge@latest` 安装外壳、固定版本的
   工作台、vector-hub、event-bridge，以及包内 knowledge-engine。
2. `project-knowledge-integrations install` 是一次性的 Integration Setup,
   对检测到的每个客户端(Claude Code / Codex / OpenCode)同时安装两类
   相互独立、分别上报状态的能力:
   - **Knowledge Integration**:插件 / MCP / Skill,让外部 Agent 能查询知识库;
   - **Development Capture**:托管的 Bridge hooks / notify / plugin,把真实
     Git 工作区里的 Agent 对话捕捉进已导入项目的「开发对话」。
   同时注册 host 级 `project-knowledge` Bridge consumer。全程无需打开任何
   客户端 UI;第三方 hooks 与配置完整保留;Codex notify 冲突只上报不覆盖。
3. `project-knowledge` 启动全新的 v5 本地服务。重新配置模型、知识根目录并导入
   项目，不迁移旧登记、会话、知识、索引或未完成任务。

注意事项:

- 装完 Development Capture 后,已在运行的 Claude Code 会话需重启一次
  (hooks 在会话启动时加载)。只捕捉配置之后的对话,历史不回填。
- 按需收窄安装范围:`--ide claude` / `--capture-only` / `--knowledge-only`;
  按客户端移除捕捉:`uninstall --capture-only`;全局禁用捕捉(含注销 Bridge
  consumer):`disable-capture`。

默认只监听 `127.0.0.1:5757`。CLI 会记录实际 loopback endpoint，托管 Git
Hook 不依赖写死端口。

```bash
project-knowledge
project-knowledge --fg
project-knowledge status
project-knowledge stop
```

需要 Node.js 22+ 与 `PATH` 中的 Git。4.8.0 仅交付 npm 网页版本，不提供新版
Windows 安装包或桌面自动更新。

## 唯一分析流程

知识引擎是唯一分析执行者：

```text
Git Hook → event-bridge journal → 引擎持久化认领 → 隔离 Agent 分析
         → staging 校验 → 知识晋升 → vector-hub 索引 → 检索
```

导入只建立 Git tracking baseline、创建项目元数据并安装/验证 Hook；不运行 AI、
不扫描全仓推测需求、不生成 TODO 知识。空仓库导入后的第一个 Commit会被处理。

Hook 向 bridge journal 写入提交证据，通知只负责唤醒。通知丢失仍由 journal
消费及启动对账恢复；Hook 故障不阻塞提交。同项目严格串行、失败即停；不同项目
最多两个并发分析，重复事件不会重做已完成提交。关闭浏览器不停止后台维护。

## 知识与索引安全

每个 Commit 的 claim 会冻结 Commit SHA、真实 patch、绑定的 requirement IDs、
prompt hash 与固定 knowledgePath。AI 只能写内部 per-run staging，不能写源码或
final knowledgePath。产物 manifest 必须通过路径、UTF-8、Markdown、hash、证据与
操作类型验证。

Promotion 使用 backup、hash 与 durable journal。只有 Markdown promotion 验证
成功后才推进 lastAnalyzedCommit 并把 index 标为 dirty。索引失败不会回滚真实
Markdown，也不会重跑 AI；启动和维护流程会重试 dirty index。

vector-hub 是唯一派生索引服务，外壳不再执行第二套索引写入。索引失败独立显示
“知识已更新，索引待修复”，修复索引不重跑模型、不撤销有效知识。

应用不会创建、修改、刷新或删除 `CLAUDE.md`。

## 需求记录与查询

### 外部 Agent 会话采集

在网页左下角打开“系统状态 → 外部 Agent 采集”，对使用的工具点击“接入”或
“修复”；“移除采集”只移除托管 Hook，不删除历史记录或第三方配置。
“检测到命令/检测到配置”与“已配置采集”是不同状态，未检测到不等于没有安装。
配置完成后重新打开外部 Agent 会话，再到活动记录验证新会话是否出现。

```powershell
project-knowledge-integrations status --all
project-knowledge-integrations install --ide zcode --capture-only
project-knowledge-integrations uninstall --ide zcode --capture-only
```

ZCode 接入当前仅包含会话采集，不会冒充已安装 MCP/知识检索插件。
接入失败会显示操作 ID，并写入数据目录 `logs/system/YYYY-MM-DD.jsonl`；
网页“系统诊断记录”可查看和导出。注册消费者本身不能代替安装 Agent Hook。

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

只读查询不会创建或修改配置。索引不可用时回退到真实 Markdown。项目、所属领域、
整个智脑是包含范围；未确认记忆不能作为长期偏好注入任务。

## 存储合同

内部数据默认在 `~/.project-knowledge-v5/`，可用 `KB_DATA_DIR` 修改。用户必须先设置
global knowledge root，再导入项目；它只影响未来导入。每个项目导入时固化绝对
knowledgePath，修改 global root 不会移动已有项目。

```text
~/.project-knowledge-v5/
├── settings.json
├── projects.json                         # 仅 ID、顺序、最小显示快照
├── projects/<projectId>/
│   ├── config.json                       # 固定 repoPath/knowledgePath
│   ├── state.json                        # tracking/claim/index/Hook 状态
│   └── requirements.jsonl                # 按需创建
├── knowledge-engine/                    # 持久化 claim、run、journal 游标
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

## 产品 UI

一级导航为智脑首页、开始工作、知识检索、长期记忆、领域与项目、活动记录。
开始工作嵌入真实工作台，保留消息流、中止、权限和会话恢复，不重复实现聊天。
在“领域与项目”点击“导入项目”，确认代码目录、知识目录及领域；部分接线失败
保留项目，只重试失败模块。系统状态集中展示四模块健康、模型配置与诊断。

加入智脑不会搬动已有项目知识。领域共享知识及已确认记忆与项目知识并存。
凭据由 Workbench 统一管理；维护默认模型独立于聊天临时切换，运行凭据不进
引擎状态、日志或浏览器消息。

活动记录保留结构化日志能力：

- trace/debug/info/warn/error/fatal 六级；
- 本地日期、项目、component、event、operation、Commit、全文过滤；
- newest-first cursor 分页、暂停/自动刷新、按当前条件导出；
- operation flow、结构化 error/stack、logger degraded 状态；
- Hook/索引/项目状态、统一的浅深主题。

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

自动回归覆盖真实 Git Hook、空格/中文路径、提交证据、promotion/index、查询、
恢复与日志。产品浏览器验收只检查 1920×1080 桌面视口，模型和 embedding 为
可控替身；真实模型与真实索引抽测分别报告。完整故障组合和用户已有数据的最终
切换另行验收，不用可点击页面代替真实链路通过。

## 许可证

[Apache-2.0](../LICENSE)，另见 [NOTICE](../NOTICE)。
