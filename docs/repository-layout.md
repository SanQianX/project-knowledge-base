# 仓库布局说明 / Repository layout

本文记录 2026-11 布局迁移（Phase 1–4）后的目录约定，及其与通用仓库结构约定的对应关系。
This document records the directory conventions after the 2026-11 layout
migration (Phases 1–4) and how they map onto the general repository rules.

## 布局 / Layout

```
src/            产品源码，按域组织（全部保持根下第二层，__dirname 根锚点依赖此不变式）
  server.js     HTTP 入口（package main / npm start）
  common/       跨域共享：contracts、atomic-file、runtime-endpoint、cli-instances、data-dir 等
  server/       HTTP/运行时外壳：server-app、live-gateway、storage-layout 等
  projects/     项目域：project-*-store、scanner、github-team-store 等
  knowledge/    知识流水线：knowledge-*、index-*、embedding、kb-* 等
  automation/   提交自动化：commit-*、hook-manager、post-commit-automation 等
  conversations/ 会话采集：conversation-*、bridge-*、codex-notify-config 等
  integrations/ Agent 接入：integration-*、claude-cli-runner、ai-*、llm-client 等
  module_bridge/ 外部模块代理：module-bridge、engine-connection、engine-knowledge-client
  tools/        CLI/MCP 工具运行时：knowledge/workflow-tool-runtime、requirement-* 等
  scripts/      运行时钉路径脚本（hook-trigger、codex-notify-fanout）与发布/校验工具
resources/ui/   被服务的浏览器静态资产（index.html、product.js 等 8 个文件）
tests/          自动化回归套件 + helpers + 版本化 fixtures（tests/paths.js 为中央路径锚点）
fixtures/       本地测试数据（根锚定忽略；生成型数据走 os.tmpdir）
docs/           按主题组织；配图在 docs/images/，事故报告在 docs/incident-reports/
bin/            4 个 CLI/MCP 入口
plugins/        agent 插件（见下）
desktop/        Windows Electron 包（独立 npm 包，见下）
qa-autopilot/   私有 QA/发布运维包（见下）
```

## 顶层例外及理由 / Top-level exceptions and why

- **`plugins/project-knowledge`**：顶层路径被 5 处钉死——根级 `.claude-plugin/marketplace.json`
  与 `.agents/plugins/marketplace.json` 的 source 指针、`.mcp.json` 引导串、
  `src/integrations/integration-installer.js` 的安装器常量、module-runtime-manifest 的
  productFiles 键。Claude/Codex 插件工具链要求该内部布局，属于工具链必需命名。
- **`desktop/`**：独立 npm 包 `@sanqianx/project-knowledge-desktop`，拥有自己的
  package.json/锁文件与发布节奏；它通过自身依赖树钉版本消费核心包（升级核心布局
  需与 desktop 的下一次发布协调）。非根包的模块，不收进 src/。
- **`qa-autopilot/`**：私有零依赖 QA 工具链（AGENTS.md 要求保留），CI 发布门禁
  （validatePack、ci-rc-guard、stable-next/promote）从它调用；其 config 基线与历史
  报告引用大量内部路径，作为包边界保持独立。

## 兼容性 / Compatibility

- 已装机用户配置（Codex notify、git post-commit 钩子、integration-runtime.json）中
  持久化的 `_site/scripts/...` 绝对路径仍被所有权正则识别（`src/conversations/
  codex-notify-config.js` 等处的 `(?:_site|src)` 双形态），升级后由既有的启动修复
  机制重绑到新路径。
- desktop 对核心包的深层 require 已指向 `src/common/*`；已发布的旧 desktop 版本
  继续搭配其锁定的旧核心包工作。
- `qa-autopilot/lib/git.cjs` 的受保护路径正则同时匹配 `tests/` 与历史 `_site/_test/`
  形态，历史 worktree 不受影响。

## 迁移记录 / Migration record

- Phase 1（0e35250）：docs 资产归位、休眠资产删除。
- Phase 2（9516e4d）：测试迁 `tests/`、测试退出发布包、`fixtures/` 根目录。
- Phase 3（d82f6d9）：`_site` → `src/` 按域重组、common 去重、所有权正则双形态。
- Phase 4：`ui/` → `resources/ui/`，运行时清单 productFiles 键随迁。
