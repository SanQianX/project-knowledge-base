<p align="center">
  <img src="../assets/logo.svg" alt="project-knowledge" width="540">
</p>

<p align="center">
  <strong>面向 Git 项目的本地知识库管理器。</strong><br>
  扫描历史、生成可审查的 AI 草稿、沉淀中英双语知识库。
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/project-knowledge"><img src="https://img.shields.io/npm/v/project-knowledge.svg?style=flat-square" alt="npm"></a>
  <img src="https://img.shields.io/node/v/project-knowledge.svg?style=flat-square" alt="Node 18+">
  <img src="https://img.shields.io/github/license/SanQianX/project-knowledge-base?style=flat-square" alt="Apache-2.0">
  <a href="https://github.com/SanQianX/project-knowledge-base/actions"><img src="https://img.shields.io/badge/tests-52%20passed-2f7d64?style=flat-square" alt="Tests"></a>
  <a href="#star-history"><img src="https://img.shields.io/badge/star_history-⬇-7492a5?style=flat-square" alt="Star history"></a>
</p>

<p align="center">
  <a href="../README.md">English</a> · <a href="README.zh-CN.md">简体中文</a>
</p>

---

## 安装

```bash
npm install -g project-knowledge
project-knowledge
```

## v4.0.4 Markdown 知识库体检与安全优化

打开“设置 → Markdown 知识库体检与优化”，可以一次扫描全部已注册的个人和团队
知识库。页面会分别显示可确定性修复的问题，以及需要理解内容后才能处理的语义问题。
点击“安全优化全部”后，每个被修改的文件都会先备份到
`<知识库根目录>/.project-knowledge/_backup/markdown-maintenance/`，随后原子写入规范
格式、修复可恢复的 frontmatter 和代码围栏，并根据原始模块与变更文档从零重建两个
`00-index.md`；已经迁移的项目会自动刷新对应 LanceDB 向量空间。

系统不会猜测重复内容中哪一段更新。重复标题、多行 `Updated:` 元数据和超大正文会
继续列为“需要语义审查”。后台 AI 此后不能直接编辑 `00-index.md`，每次成功自动更新
后由系统完整重建紧凑索引；模块文档必须就地替换过时描述，历史信息写入 `changes/`。

## v4.0.3 模型下载与迁移失败提示

“设置 → 一键迁移全部向量知识库”中新增“嵌入模型设置”。迁移前先点击“下载并验证
模型”；程序会实际加载模型并执行一次向量推理，下载残片不会再被误判成安装成功。
如果公共模型无法加载，整个迁移批次会在修改任何项目前停止，并通过弹窗、错误面板
和项目详情明确提醒，不再把同一个模型问题重复记录成多个项目失败。

可以直接在页面中设置 Hugging Face 兼容镜像、本地模型基础目录和离线模式。推荐使用
页面设置；环境变量命令仍保留在页面中的可选说明内。

## v4.0.2 数据库跟随知识库根目录

向量数据库、维护状态和保留的回滚备份现在统一保存在
`<知识库根目录>/.project-knowledge/`。设置页面会直接显示实际数据库路径。
从 v4.0.0 或 v4.0.1 升级后，程序会把旧固定位置的数据库自动搬到你之前已经选择的
知识库根目录。以后修改根目录时，会先搬迁并验证数据库，成功后才保存新设置；目标
位置已有数据库时不会覆盖。跨磁盘修改路径也会先复制并核对文件数量和字节数。

## v4.0.1 数据库空间修复

从 v4.0.0 升级后，打开“设置 → 一键迁移全部向量知识库”，点击一次“压缩数据库”。
系统会从当前有效数据创建独立的新数据库，排除生成的 `00-index.md`，验证向量检索和
关键词检索后再原子切换。验证失败不会修改原数据库。默认在验证成功后删除旧的膨胀
数据库；只有磁盘空间足够且确实需要手动回滚时，才勾选“保留旧数据库用于手动回滚”。

Markdown `00-index.md` 仍会保留，旧功能和团队知识库模式不受影响；它只是不再进入
向量数据库。提交后的知识库更新仍采用增量替换和删除，不会只追加旧内容。

## v4 向量知识库与一键升级

v4 在 `<设置中选择的知识库根目录>/.project-knowledge/knowledge.lancedb` 中同时保存完整自然语言原文、
元数据和 `Xenova/bge-small-zh-v1.5` 的 512 维向量。向量只负责召回，不能反向
“翻译”为文本；`search/get/ask/history` 工具返回的是数据库中保存的原始
`chunk_text`，再由 Claude 根据原文回答。

升级后打开“设置 → 一键迁移全部向量知识库”：

1. 自动发现全部已注册的旧 Markdown 知识库；
2. 先备份到 `_backup/vector-migration/`，不修改、不删除原文件；
3. 按 Markdown 标题分块，在本机生成向量；
4. 校验文件数、条目数、分块数、内容哈希，并执行真实向量检索探针；
5. 只有校验成功的项目才原子切换到 LanceDB，失败项目继续使用 Markdown。

迁移可恢复、可重复执行，并提供“回退到 Markdown”。提交后的自动化采用增量更新：
未变化文件不重新向量化，变化内容替换旧分块，已删除文件对应的旧记录会删除，
不会无限追加重复内容。

首次使用会下载约 100 MB 的本地模型。推荐先在页面中设置下载地址或本地目录，然后
点击“下载并验证模型”。也可以使用持久化环境变量，设置后需要重启服务：

```powershell
[Environment]::SetEnvironmentVariable('KB_EMBEDDING_REMOTE_HOST', 'https://your-model-mirror.example/', 'User')
[Environment]::SetEnvironmentVariable('KB_EMBEDDING_LOCAL_PATH', 'D:\models', 'User')
project-knowledge stop
project-knowledge
```

每个项目只有一个主写入空间。你可以在项目设置中显式勾选关联项目；检索会覆盖
当前、共享及已勾选的空间，但不会传递扩散，提交后的更新也只写当前项目主空间。
团队模式继续以 GitHub/Gitea Markdown v1 作为可审计同步层，每台机器在本地生成
向量，不会把 LanceDB 二进制或模型提交到团队仓库；相同稳定 `kbId` 会映射到相同
`space_id`。

```bash
project-knowledge-kb search --project my-api --query "刷新令牌如何轮换" --json
project-knowledge-kb ask --project my-api --query "登录方案以前怎么决定的"
project-knowledge-kb get --project my-api --entry "modules/auth.md" --json
project-knowledge-kb history --project my-api --json
```

仪表盘自动打开 **http://127.0.0.1:5757**。5757 被占时 CLI 会在
`5757–5776` 内寻找可用端口并打印实际地址。后台守护进程独立于终端，
`project-knowledge stop` 关闭它。

```bash
project-knowledge            # 后台启动（默认），自动打开浏览器
project-knowledge --fg       # 前台运行，Ctrl+C 退出
project-knowledge stop       # 停止后台守护进程
project-knowledge status     # 打印运行中的 PID + 端口
project-knowledge --port 9000   # 指定端口
project-knowledge --no-open     # 不自动打开浏览器
```

需要 **Node.js 18+** 与 **Git（PATH 中可执行）**。可选：任一
Anthropic 兼容 API Profile 用于生成 AI 草稿。

首次启动的预期输出：

```text
project-knowledge  ·  v4.0.4
Local knowledge-base dashboard

  ▸ Resolving data directory …      ~/.project-knowledge/
  ▸ Migrating legacy state …        no legacy data found
  ▸ Loading AI profiles …           3 profiles · default: claude-opus-4-7
  ▸ Starting HTTP server …          listening on 127.0.0.1:5757
  ▸ Watching 4 projects · 12 pending commits · 1 active run
  ▸ Opening dashboard in browser …

  → http://127.0.0.1:5757

Ctrl+C in this window, or run `project-knowledge stop` elsewhere.
```

---

## 它做什么

```
   git commit ──► post-commit 钩子 ──► scanner ──► orchestrator ──► AI
                                                          │            │
                                                          ▼            ▼
                          ~/.project-knowledge/      drafts/      Anthropic 兼容
                                                          │
                                                          ▼
                                              浏览器 diff 审阅
                                                          │
                                                          ▼
                                           KB 只按你的指令增长
```

`project-knowledge` 监听你的本地 Git 项目，调用 Anthropic 兼容的 LLM
从每次提交或分支生成知识条目草稿，所有草稿都以 side-by-side diff 在
浏览器里呈现。你**采纳**、**编辑**或**拒绝**每一条。可信 KB
（`modules/`、`changes/`）只按你的指令增长。

---

## 功能

<table>
  <tr>
    <td width="50%" valign="top">

**本地优先**

- 仪表盘运行在 `127.0.0.1`，不对外暴露。
- 全部状态在 `~/.project-knowledge/`（或 `$KB_DATA_DIR`）。
- 运行时数据在每次 `npm install -g` 升级后保留。
- API Key 保存在本地 `ai-profiles.json`，永不外传。
- 服务只绑定 loopback。

</td>
    <td width="50%" valign="top">

**Git 联动**

- 每个项目从 `git log` 扫描待提交。
- `post-commit` 钩子在每次提交后自动触发。
- Git 历史同时作为持久化待分析队列；实时 Hook 与客户端启动补偿使用同一个项目处理器，严格按照从旧到新的顺序一次分析一个 commit。
- 每个 commit 都生成一份独立的 `changes/` 记录。Claude 先写入临时知识库工作区，Markdown 校验和 LanceDB 增量索引都成功后才推进已分析游标。
- 停止自动化会暂停当前项目并丢弃尚未应用的临时结果；待分析 commit 仍保留在 Git 中，继续后从最早未完成提交恢复。
- 每个项目的 `CLAUDE.md` 只写入一句用户目录相对的中央规则引用；详细规则只在
  `~/.project-knowledge/` 下维护一份。
- 分支、远端、HEAD 元数据、reflog。

</td>
  </tr>
  <tr>
    <td valign="top">

**草稿可审查**

- AI 的每一处变更先进入 `drafts/`，绝不直接写 KB。
- 浏览器 diff 视图，应用 / 编辑 / 拒绝。
- 默认中英双语（zh-CN / en-US）模块与变更文档。
- 厂商中立：Claude、GLM、DeepSeek、Kimi、自建网关。

</td>
    <td valign="top">

**团队知识模式（v3.0.13+）**

- 通过 GitHub 或 Gitea OAuth 共享 KB 仓库（v3.0.12+ 支持 client-secret）。
- sparse-checkout 只拉取 `changes/` 与 `modules/`。
- 自动发现带 `team-store.json` 清单的仓库。
- 个人模式项目可与团队绑定并存。

</td>
  </tr>
</table>

---

## 仪表盘

<p align="center">
  <img src="../assets/dashboard.png" alt="项目监督仪表盘" width="1280">
</p>

项目监督视图一览：跨项目待提交统计、当前项目状态徽标（repo / pending /
goal / KB）、异常中心面板，以及右侧 Claude 工作台，可针对该项目发起对话。

---

## 审完再写入

<p align="center">
  <img src="../assets/runs-drafts.png" alt="Run / Draft" width="1280">
</p>

每次分析产出一组草稿。点击一次运行即可看到其草稿——勾选要写入的条目，
然后 **Apply selected** 把它们写入 KB；**Reject run** 整批丢弃。

<p align="center">
  <img src="../assets/draft-review.png" alt="Draft 审阅" width="1280">
</p>

想看逐条 diff 时，直接在编辑器里打开单条草稿。

---

## 配置

<p align="center">
  <img src="../assets/settings.png" alt="设置抽屉" width="1280">
</p>

设置抽屉集中管理 AI Profile、team-knowledge 仓库绑定、Windows
计划任务、日志保留，以及语言 / 主题。所有操作都在本地完成；除 AI
请求体本身外，没有任何数据离开你的机器。

---

## 架构

<p align="center">
  <img src="../assets/architecture.svg" alt="架构图" width="1180">
</p>

上图四层分别为：面向用户的 UI（浏览器 + CLI + 钩子 + Claude Code）、
本地 Node.js 服务与其专项模块、数据层（`~/.project-knowledge/` +
你的 Git 仓库 + 生成的 KB），以及外部 LLM 端点。

右侧虚线表示 **KB 读取规则**：当 Claude Code（或任何 Anthropic 兼容
代理）打开一个含有本应用 `CLAUDE.md` 块的项目时，会先读 `GOAL.md` 和
模块 / 变更索引，再按相关性打开详情文件。这让上下文窗口占用随任务
规模线性增长，而非随 KB 规模增长。

---

## CLI 命令

| 命令 | 行为 |
|---|---|
| `project-knowledge` | 后台启动，自动打开浏览器 |
| `project-knowledge --fg` | 前台运行，Ctrl+C 退出 |
| `project-knowledge stop` | 停止后台守护进程 |
| `project-knowledge status` | 打印运行中的 PID + 端口（或 `not running`） |
| `project-knowledge --port <p>` | 绑定 `<p>`；被占时 `<p>+1…+19` 自动 fallback |
| `project-knowledge --host <h>` | 绑定主机 `<h>`（默认 `127.0.0.1`） |
| `project-knowledge --no-open` | 不自动打开浏览器 |
| `project-knowledge -v` / `--version` | 打印版本并退出 |
| `project-knowledge -h` / `--help` | 打印完整帮助 |

CLI 在 `os.tmpdir()/.project-knowledge.pid` 写入 PID 文件。**关闭终端
不会停掉仪表盘**——用 `project-knowledge stop`。

---

## CLAUDE.md 读取规则

导入后的每个项目只在 `CLAUDE.md` 托管块中保留一行导入：

```markdown
<!-- KB-MANAGED:CLAUDE-MD:START — managed by project-knowledge -->
@~/.project-knowledge/claude-code-rules.md
<!-- KB-MANAGED:CLAUDE-MD:END -->
```

完整的“开发期只读、索引优先、成功提交后才允许自动化写入”规则统一保存在
`~/.project-knowledge/claude-code-rules.md`。中央规则根据当前 Git 根目录匹配
`~/.project-knowledge/projects.json`，项目的 `kbPath` 仍以该注册表为准。以后升级规则
只更新这一份中央文件，不需要再逐个改项目。

应用启动时会只读检测全部注册项目，不会静默修改项目文件。在“设置 → CLAUDE.md
集中规则”中可一键刷新所有旧托管块。批量刷新只替换完整、唯一的托管块；纯用户内容、
文件缺失、标记畸形、符号链接和不可用目录都会报告并跳过，也不会重装或改动 Git Hook。
卸载仍只删除托管块并保留你自己的内容。

这意味着 **Claude Code（或任何 Anthropic 兼容代理）会先读 KB 索引，
再按相关性打开模块**，大幅减少上下文密集任务的 token 消耗，同时不会把未提交的 WIP
内容写进知识库。

---

## 运行时数据

全部数据保存在 npm 包**之外**的单一目录里，`npm install -g
project-knowledge` 升级绝不触碰：项目注册、AI Profile、KB、草稿、日志
全部安全。

**默认：** `~/.project-knowledge/` &nbsp;·&nbsp; **覆盖：** `KB_DATA_DIR`

```bash
KB_DATA_DIR=D:/data/project-knowledge project-knowledge
```

从 1.x 升级后首次运行时，旧 npm 包内的运行时文件会被静默拷贝到新数据
目录。迁移只在 `<dataDir>/projects.json` 尚不存在时进行，不会覆盖新
位置任何文件，也无需确认。

```
~/.project-knowledge/
├── projects.json              # 项目注册表
├── projects/<slug>/           # 生成的 KB（每个项目）
│   ├── GOAL.md
│   ├── modules/<area>.md      # 精选模块文档
│   └── changes/release-v*.md  # 精选变更记录
├── _ai/<slug>/drafts/         # 可审查的 AI 草稿（绝不自动应用）
├── ai-profiles.json           # AI Profile 配置 + Key
├── knowledge-store.json       # 外部 / 团队 KB 设置
├── logging.json               # 日志保留
├── logs/                      # 结构化运行日志
└── claude-prompts.json        # 内置 prompt 注册表
```

---

## 仓库结构

```
_site/
├── index.html                # 仪表盘 UI（Vue + Tailwind，单文件）
├── server.js                 # 本地 HTTP 服务（REST + WebSocket）
└── lib/
    ├── scanner.js              # git 状态扫描
    ├── analysis-orchestrator.js  # 初始 / 提交分析
    ├── context-pack-builder.js   # AI prompt 装配
    ├── kb-framework.js          # KB 布局 / 写入 / 校验
    ├── draft-apply.js           # 草稿应用 / 拒绝
    ├── knowledge-store.js       # 外部 KB 配置
    ├── github-team-store.js     # 团队模式 · Gitea OAuth · sparse checkout
    ├── hook-manager.js          # post-commit 钩子安装 / 卸载
    ├── claude-md-manager.js     # CLAUDE.md 托管块写入
    ├── ai-adapter.js            # Anthropic 兼容 LLM 客户端
    └── supervision.js           # issue / 告警聚合

bin/project-knowledge.js       # CLI 入口
templates/                    # KB Markdown 模板
docs/                         # 公开 schema、规划、截图
```

公开边界见 [`INDEX.md`](../INDEX.md) 与 [`CHANGELOG.md`](../CHANGELOG.md)。

---

## 团队知识模式

v3.0.13 起提供**团队 Store** 流程：把 GitHub（或自建 Gitea）当作
共享知识层，无需我们再额外维护一套云服务。

- 一个 Git 仓库可存放多个项目的 KB，每个项目一个子目录。
- `team-store.json` 清单声明仓库内有哪些 KB。
- 每个用户的本地克隆使用 **sparse-checkout**，只物化 `changes/` 与
  `modules/`，全量历史不会下载到本机。
- v3.0.12 新增对 Gitea 的 **client-secret OAuth** 支持（同样适用于
  其他 GitHub 兼容 OAuth 提供方），免去手动生成个人 Token。

设计：[`docs/team-knowledge-mode-a-plan.md`](team-knowledge-mode-a-plan.md) ·
Schema：[`docs/project-registry-schema.md`](project-registry-schema.md)

---

## 测试

```bash
npm test
```

回归套件位于 `_site/_test/`，覆盖：

- AI Profile 校验、scanner 行为、context pack 生成
- 初始与提交分析
- 草稿应用 / 拒绝、知识库、结构化日志
- 项目控制台流程、Run / Draft UI 流程
- CLI 启动 / 停止 / 状态
- Gitea OAuth + sparse checkout
- 36 个用例，0 失败，冷启动约 110s

---

## 发布

由 tag 触发。推送 `v*` tag 后 `.github/workflows/publish.yml` 执行：

```bash
npm publish --provenance --access public
```

工作流需要仓库 secret `NPM_TOKEN`。发布前请完成 checklist，并确认
运行时数据、KB、草稿、日志、凭据都不在 Git 树或 npm 包内：

```bash
npm test
npm pack --dry-run
git status --short
git commit -m "Release vX.Y.Z"
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin main
git push origin vX.Y.Z
npm view project-knowledge version dist-tags
```

---

## 系统要求

- **Node.js 18+**——使用原生 `fetch` 与 ES2022 特性
- **Git** 在 `PATH` 中——所有扫描都通过它执行
- **Windows / macOS / Linux**——只有 Windows 计划任务部分依赖平台
- **可选**——Claude Code CLI 或任一 Anthropic 兼容 API Profile。
  没有也不影响仪表盘与扫描，只是无法生成 AI 草稿

服务默认仅绑定 `127.0.0.1`，**不要**对外暴露。

---

## 贡献

欢迎在 [github.com/SanQianX/project-knowledge-base](https://github.com/SanQianX/project-knowledge-base)
提 Issue 或 PR。提交前请运行 `npm test`。较大改动请先开 Issue 对齐方向。

## 许可证

[Apache-2.0](../LICENSE) — 另见 [NOTICE](../NOTICE)。

## Star 趋势

<p align="center">
  <a href="https://star-history.com/#SanQianX/project-knowledge-base">
    <img src="https://api.star-history.com/svg?repos=SanQianX/project-knowledge-base&type=Date" alt="Star history">
  </a>
</p>
