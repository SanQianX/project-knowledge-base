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
  <a href="https://github.com/SanQianX/project-knowledge-base/actions"><img src="https://img.shields.io/badge/tests-36%20passed-2f7d64?style=flat-square" alt="Tests"></a>
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

<p align="center">
  <img src="../assets/terminal.svg" alt="project-knowledge CLI 启动" width="1100">
</p>

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
- 把"知识库读取规则"注入到每个项目的 `CLAUDE.md`，让 Claude Code
  先读索引再打开模块。
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
  <img src="../assets/dashboard.svg" alt="仪表盘" width="1280">
</p>

项目监督视图一览：跨项目待提交统计、当前项目状态徽标（repo / pending /
goal / KB）、待提交列表、动作按钮（`Analyze commits`、`Scan repository`、
`Rebuild KB`），以及右侧 Claude 工作台，可针对该项目发起对话。

---

## 审完再写入

<p align="center">
  <img src="../assets/runs-drafts.svg" alt="Run / Draft 审阅" width="1280">
</p>

每次分析产出一组草稿。每条草稿打开 side-by-side diff，显示 AI 想新增
或修改的具体行——在 `modules/` 或 `changes/` 被动之前你看得一清二楚。

---

## 配置

<p align="center">
  <img src="../assets/settings.svg" alt="设置抽屉" width="1280">
</p>

设置抽屉集中管理 AI Profile、每个项目的 `post-commit` 钩子安装、
日志保留、语言 / 主题，以及 GitHub / Gitea team-store 配置。所有
操作都在本地完成；除 AI 请求体本身外，没有任何数据离开你的机器。

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

在你导入的项目上安装 `post-commit` 钩子时，`project-knowledge` 会向
该项目的 `CLAUDE.md` 写入一段托管块：

```markdown
<!-- KB-MANAGED:CLAUDE-MD:START — managed by project-knowledge -->
## Knowledge Base Reading Rule

This project's knowledge base lives at:
  <absolute path registered in projects.json>

Before implementing a non-trivial feature or fix in this repo:

1. Read only the indexes: <kbPath>/GOAL.md, <kbPath>/modules/00-index.md,
   <kbPath>/changes/00-index.md.
2. Compare the request, changed files, API routes, symbols, and keywords
   against the module and change indexes.
3. Open only the top-relevant module and change docs based on the match.
4. No hits? Treat as a new feature area — propose a new module + change
   entry instead of patching unrelated knowledge.
5. Do not load the whole KB unless explicitly asked.
6. After implementation, summarize whether the KB needs an update.
<!-- KB-MANAGED:CLAUDE-MD:END -->
```

重复安装会原位替换该块（HTML 注释定界符保证幂等）；卸载只删除托管块，
保留你自己的内容。给钩子调用传 `updateClaudeMd: false` 可跳过此行为。

这意味着 **Claude Code（或任何 Anthropic 兼容代理）会先读 KB 索引，
再按相关性打开模块**，大幅减少上下文密集任务的 token 消耗。

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