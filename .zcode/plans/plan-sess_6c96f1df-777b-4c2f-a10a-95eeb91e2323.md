# 仓库结构对齐规范：四阶段循序迁移计划

## Context

对照已确认的仓库结构组合约定，当前仓库约 85% 的 tracked 文件位于规范未规定的位置：无 `src/`（源码分散在 `_site/`、`ui/`、`plugins/`、`desktop/`、`bin/`），测试在 `_site/_test/`（353 个文件且随 npm 包发布），无 `resources/`、`tests/`、`fixtures/`，`_site/` 的下划线前缀语义（仅限可重建生成物）与手写核心源码的事实相反。用户已批准按约定重构，并确认四个决策：**分四阶段推进、src/ 按域拆分子目录、测试不再随包发布、删除休眠资产**。

探查确认的关键耦合事实（决定方案形态）：
- **发布包布局是跨版本、跨包契约**：desktop 包深层 require `<coreRoot>/_site/lib/{runtime-endpoint,cli-instances,data-dir}.js`；用户 Codex/ZCode 配置和 git post-commit 钩子里持久化了 `_site/scripts/codex-notify-fanout.cjs` 等绝对路径，配套所有权正则（`_site/lib/codex-notify-config.js:57`、`zcode-context-integration.js:19`）。
- **`plugins/project-knowledge` 顶层路径被 5 处硬编码钉死**（两个 marketplace.json、`.mcp.json` 引导串、`integration-installer.js:34`、运行时清单 productFiles）——Claude/Codex 插件工具链要求。
- **qa-autopilot**（私有 QA 包，CI 接线：`validatePack` 发布门禁、runner 发现根、git.cjs:101 保护路径正则）是 AGENTS.md 要求保留的 QA 工具链。
- **用户日常实例不在本仓库**：运行于全局 npm 前缀（5.3.0，127.0.0.1:5757），源码迁移不触及其文件；风险仅来自误用默认数据目录/端口或全局安装。
- **同深度不变式**：`_site/lib/x.js` 与 `src/<域>/x.js` 都在根下第二层，全部 `__dirname,'..','..'` 根目录锚点保持有效，只需改目录名与兄弟引用。

## 目标布局（迁移后）

```
根: README/AGENTS/CLAUDE(本地)/INDEX/CHANGELOG/LICENSE/NOTICE + package.json/lock、
    eslint.config.mjs、module-runtime-manifest.json、claude-prompts.json、bin/(4 个 CLI)
src/            产品源码（按域一层子目录，深度恒为 2）
  server.js     HTTP 入口（package main）
  server/  common/  projects/  knowledge/  automation/  conversations/
  integrations/  module_bridge/  tools/  scripts/(运行时+发布工具脚本)
resources/ui/   8 个被服务的静态资产（index.html、product.js 等）
tests/          全部自动化测试 + helpers + 版本化 fixtures（不随包发布）
fixtures/       本地测试数据（忽略，替代 .local-test-data/）
docs/           按主题；配图统一 docs/images/
保持顶层不动:    plugins/（工具链钉死）、desktop/、qa-autopilot/（独立 npm 包边界）
```

## 硬约束（每阶段适用）

1. **活实例保护**：任何验证只用隔离 `--data` 目录 + 空闲端口（`tests/helpers/spawn-server.js` 已内建隔离）；绝不运行无作用域 `project-knowledge stop`、绝不运行 `_site/stop.bat`（其硬编码 5757 正是活实例端口）、绝不按进程名杀 node。每阶段验证前后只读记录活实例身份（`~/.project-knowledge/runtime-endpoint.json` 的 pid/端口 + `/api/runtime/identity`）。
2. **所有权正则双形态**：所有匹配旧 `_site/...` 形态的正则改为**新旧并列**（旧形态继续匹配已装机用户的配置，升级时由既有 `migrateManagedHooks`（server-app.js:526-548）等重绑机制切到新路径）。
3. **每阶段独立绿点**：`npm test -- --no-report`、`npm run release:verify`、`npm pack --dry-run --json`（核对包构成）、`npm test --prefix qa-autopilot` 全过才提交；在 main 上开发，每阶段一个或一组提交，不建长期分支。
4. **历史记录不重写**：`qa-autopilot/reports/**`、`config/reviewed-source.json`、历史计划文档中的旧路径字符串保持原样。

## Phase 0 — 前置（半天）

- 落地在途工作：当前 9 个已修改文件（memory-groups UI、context-hook 等）与未跟踪 docs/plans/* 先行提交，工作树清零后再开始迁移。
- 只读快照活实例身份（见硬约束 1），留作各阶段对照基线。
- **版本谱系核对（开放项，需用户澄清）**：全局装机为 5.3.0 而仓库停在 5.1.7，说明 5.2/5.3 发布自别处。切重构版本前必须先把仓库对齐到真实最新谱系，否则会在旧基线上重构。

## Phase 1 — docs 整理与休眠资产清理（低风险，1 天）

- `git mv docs/assets docs/images`；更新引用（README、docs 内 md、本地脚本 `scripts/capture-screenshots.js` 的输出目录）。
- `git mv artifacts/p0-data-incident-report.json docs/incident-reports/`；更新唯一引用 `docs/project-knowledge-v4.2.6-p0-repair-plan.md:548`；删除 `artifacts/`。
- 删除休眠资产：`templates/` 整目录 + `_site/lib/kb-framework.js` 中休眠的 readTemplate/renderTemplate/ensureFile（保留 kb-validator.js:19 用到的三个常量）+ package.json files 中 `templates/` 条目；删除 ui/ 下 5 个无引用原型 HTML。
- 清理陈旧忽略规则：`.gitignore` 的 `_modules`×2 与 `_site/_ai`、`.gitattributes` 的 `/_modules/**`、`eslint.config.mjs` 的 `_modules` 残留。

## Phase 2 — 测试迁移 `_site/_test` → `tests/`（2-3 天，机械化为主）

核心策略：**先集中、后搬运**，让 Phase 3 不再触碰测试内部。

1. 新建 `tests/paths.js` 中央路径助手（导出 ROOT、SRC、各域 LIB 入口、RESOURCES、BIN、PLUGINS、FIXTURES），以 `spawn-server.js`（51 处调用）为锚点，把测试对产品路径的解析全部收口到它。
2. `git mv _site/_test tests`；codemod 三类引用：~90 处 `ROOT = path.resolve(__dirname,'..','..')`（深度 2→1）、~363 处 `require('../lib/…')` 改经 paths 助手指向 `_site/lib`（Phase 3 只改 paths.js 一处）、`../../{package.json,bin,plugins}` 降一级。
3. `tests/run-all-tests.js` 的 ROOT/TEST_DIR/REPORT_PATH 与 `helpers/spawn-server.js:43` 入口路径改经 paths 助手。
4. 测试退出发布包：package.json files 移除 `_test` 三条目、`.npmignore` 同步；更新布局断言测试（package-boundary、packaged-ui-smoke、candidate-release-contract、candidate-product-assets、t07d、release-version-sync、harness-isolation）。
5. 跨树引用同步：`_site/scripts/{verify-retrieval-gold,run-retrieval-gold-isolated,ab-rank-v2-v3}.js` 的 fixtures/helpers 路径；desktop/test 4 个文件（release-browser-5025-smoke、slow-startup-fixture、slow-startup-cli-test）；qa-autopilot `lib/runner.cjs:9,122` 发现根、`lib/git.cjs:101` 保护正则（加 `tests/` 形态、保留旧形态）、`lib/isolation.cjs:445`、tools/inventory、overnight-supervisor、browser-shell、npm-upgrade-preservation、npm-module-install-smoke。
6. 忽略规则搬家：`.gitignore:28-35` 的 `_site/_test` 产物规则改写为 `tests/` 等价规则（screenshots、TEST-REPORT.md、`tests/fixtures/*` 忽略+版本化例外清单）；`.local-test-data/` 更名 `fixtures/`（先 grep 引用）；eslint `TEST_DIRS` 改 `tests/**`；CI 的 `npm test` 经 package.json script 自动生效。
7. 版本化最小样例（make-git-repos.js、fake-browser-*.js、retrieval-gold-queries.json 等 7 个）落 `tests/fixtures/`——生成型数据继续走 os.tmpdir()，不进仓库。

## Phase 3 — `src/` 按域重组（3-5 天，核心阶段）

**域划分（74 个模块，全部保持根下第二层深度）**：

| 域目录 | 收纳模块（代表） |
|---|---|
| `src/common/` | contracts、structured-logger、atomic-file、runtime-endpoint、runtime-control、cli-instances、data-dir、git-runner、git-path、folder-picker-output |
| `src/server/` | server-app、live-gateway、module-port-resolver、storage-layout、product-data、public-version-info、runtime-endpoint 外的 runtime-* |
| `src/projects/` | project-store、project-registry-store、project-lifecycle-service、scanner、github-team-store、settings-store |
| `src/knowledge/` | knowledge-db/schema/promotion/retrieval-service、index-builder/service、embedding-service、markdown-knowledge-indexer、kb-framework、kb-validator、context-pack-builder、evidence-bundle |
| `src/automation/` | commit-*×5、post-commit-automation、automation-config、hook-manager、capture-hook-config |
| `src/conversations/` | conversation-*×3、bridge-adapter、bridge-consumer-service、codex-notify-config、codex-context-status、zcode-context-integration |
| `src/integrations/` | integration-*×7、claude-plugin-status、claude-cli-runner、ai-*×3、llm-client、model-context-windows |
| `src/module_bridge/` | module-bridge、engine-connection、engine-knowledge-client（外部模块代理） |
| `src/tools/` | knowledge/workflow-tool-runtime、requirement-*×3、prompt-registry、registry-events |
| `src/scripts/` | 原 `_site/scripts` 原样（hook-trigger、codex-notify-fanout 为运行时钉路径，发布工具脚本同层） |

实施要点：
1. `git mv _site src` 后按域二次 `git mv`；`src/server.js` 为入口。bin/ 四个文件的 `../_site/lib/*` 改为对应域路径（desktop 三件套落在 `src/common/`）。
2. codemod 全部兄弟引用 `require('./x')` → `require('../<域>/x')`；`__dirname` 根锚点全部不动（同深度不变式）。
3. **去重**（用户已批准的 common 化）：删除 `integration-installer.js:151` 的 writeFileAtomic 与 `runtime-endpoint.js:53` 的 isProcessAlive 重复实现，统一走 `src/common/atomic-file.js`。desktop/bin/qa-autopilot 跨包重复按独立包设计保留，不合并。
4. 所有权正则双形态：`codex-notify-config.js:54,57`、`zcode-context-integration.js:12,19`、hook-manager 相关校验——新路径 `src/...` 与旧 `_site/...` 并列匹配（硬约束 2）。
5. 同步面：package.json（main/start/scripts/files 的 `_site` 15 处）、`start.bat` 同目录检查、`_site/scripts` 五个发布工具脚本的硬编码清单、CI publish.yml 两处路径、eslint、export-open-core.ps1 拷贝清单、README/INDEX/src README、操作型文档（codex-p0-repair-entry-prompt、ci-maintenance-20261025）。module-runtime-manifest.json 的 productFiles 只含 ui/plugins 键，本阶段零改动。
6. **3b desktop 协调（单独提交）**：desktop 代码对已装核心的深层 require 改 `src/common/*`；desktop 当前钉核心 5.0.25 且锁步检查本就已红（5.0.33≠5.0.25），需在核心新版发布后统一升 dep——本轮只改代码路径与仓库内测试引用，dep 升级随 desktop 下次发布。若 desktop 车道在核心发布前无法全绿，明确标注为已知预存漂移，不阻塞 Phase 3 合入。

## Phase 4 — `ui/` → `resources/ui/`（1-2 天）

1. `git mv ui resources/ui`（8 个被服务资产；原型 HTML 已在 Phase 1 删除）。
2. `src/server/server-app.js` 的 `UI_ROOT`（原 :50）指向 `../../resources/ui`。
3. 运行时清单：productFiles 的 8 个 `ui/*` 键手改为 `resources/ui/*`（`refresh-runtime-manifest.js` 只遍历既有键，须先改键再刷新哈希），`verify-product-runtime.js`/`pack-module-candidates.js`/`sync-product-content.js` 的硬编码清单同步。
4. 发布门禁锁步：qa-autopilot `registry.cjs` validatePack 的必需路径（`ui/index.html` 等 4 处）改为新路径——它 gating publish.yml，必须与 files 数组同提交。
5. `.gitattributes` `/ui/**` → `/resources/**`（sha256 内容门禁依赖 -text）；package.json files；tests 经 paths 助手自动生效。

## 统一验证（每阶段结束执行）

1. `npm test -- --no-report`（spawn-server 隔离数据目录+空闲端口）与 `npm run release:verify`。
2. `npm pack --dry-run --json` 核对包构成符合该阶段预期（Phase 2 起包内无测试；Phase 4 起 resources/ui 就位）。
3. `npm test --prefix qa-autopilot`；desktop 车道按 Phase 3b 说明。
4. 活实例对照：只读复核 runtime-endpoint.json 身份未变、`/api/runtime/identity` 正常。
5. `git grep -n '_site'` 清点残留，仅允许历史记录、双形态兼容正则中的旧形态、以及 CHANGELOG。

## 发布与版本策略

布局变更是对外契约变更（深层 import 路径跨包消费）：建议核心包以 **6.0.0** 发布，CHANGELOG 记录新旧布局映射表；升级安全性由双形态所有权正则 + 启动重绑机制保障。发布动作本身不在本计划内授权，需用户届时单独批准。收尾在 AGENTS.md 或 docs 增补一页布局说明，记录 plugins/desktop/qa-autopilot 三个顶层例外及理由（工具链钉死、独立包边界）。

## 明确不做

- `plugins/`、`desktop/`、`qa-autopilot/` 顶层位置不动（工具链与包边界钉死；qa-autopilot 的 795 处 config 基线引用也使更名得不偿失）。
- 不重写历史记录与历史文档中的旧路径；不动活实例与其全局安装；不创建长期分支；不 vendoring knowledge-engine 回仓库。