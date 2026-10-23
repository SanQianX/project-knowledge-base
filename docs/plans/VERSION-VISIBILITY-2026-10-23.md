# VERSION-VISIBILITY 计划 2026-10-23（FEATURE-VERSIONS-01-R2 简化版）

## 0. 需求演变（R1 → R2）

- **R1（已废弃）**：左侧栏「版本与模块」入口 + `<dialog>` 弹窗 + `GET /api/system/versions` 聚合接口（core/desktop/五模块 running/installed/expected/consistency）+ 桌面 IPC `pk:get-versions` + vector-hub/bridge health 补 version 字段。用户随后明确简化，R1 全线撤销。
- **R2（本计划，权威需求）**：知识库主界面只显示整体软件大版本，放左上角商标的小位置，默认隐藏、鼠标悬停展示（focus 也可查看）——「知识库 vX.Y.Z」；移开隐藏。不占常驻空间、不改原导航、浅深色/窄窗可用。不新增侧栏按钮/弹窗/全模块清单/轮询。版本来自当前服务端 Project Knowledge 进程 package；读取失败诚实显示未知。无须聚合模块 health；无须为 tooltip 新增桌面 IPC。
- **R1 撤销清单（已全部落地）**：
  - 侧栏 `#versionInfoButton`、`<dialog id="versionDialog">`、`GET /api/system/versions` 聚合路由 —— 从未进入 R2 交付（served HTML 断言不含这三者）。
  - 桌面 IPC `pk:get-versions` / `window.pkDesktopVersions` —— desktop/main.cjs、desktop/preload.cjs 已恢复 git-clean。
  - vector-hub / bridge console health 补 version 字段 —— 从未实施（四模块仓零改动）。
  - R1 全部工作已在 `qa-autopilot/artifacts/parallel-20261023/version-visibility/handoff/before-human-hover-revision/` 留档（5 仓 .tracked.patch + 关键文件副本，只读）。

## 1. 各模块自身版本显示：审计结论零修改

| 仓 | 现状 | 结论 |
| --- | --- | --- |
| workbench（claude-ai-workbench） | 头部 `#app-version` 显示 `v{health.version}`；设置→关于「Agent Terminal v{version} · API {apiVersion}」；health 自带 status/version/apiVersion | 已满足，零修改 |
| knowledge-engine | 侧栏底部 `v{health.version} · 游标` + 详情「服务版本」；`/api/health` 含 name/version | 已满足，零修改 |
| vector-hub | UI 头部 `v__APP_VERSION__`（serveUi 注入 package 版本）已可见且语义正确 | 已满足，零修改（R1 曾计划 health 加 version 字段，R2 不再需要） |
| bridge console | UI「当前代码版本」= console 自身 package version，已正确 | 已满足，零修改（同上撤销） |

「总版本」= Project Knowledge 软件版本（根 package.json，当前 5.0.24），不是业务仓 Git 标签、兄弟源码版本、npm latest 或桌面壳版本；不硬编码。

## 2. 实现（根仓独占租约文件）

| 文件 | 改动 |
| --- | --- |
| `_site/lib/public-version-info.js`（新增） | `coreVersionSnapshot()`：读当前进程根 package.json（`path.resolve(__dirname,'..','..','package.json')`），返回 `{ok, schema:'system-version/v1', checkedAt, core:{name, version, source:'running-process-package'}}`。无网络、无模块探测、无缓存。 |
| `_site/lib/server-app.js`（1 hunk） | require 上述模块 + 路由 `GET /api/system/version` → `coreVersionSnapshot()`。3+3 行。 |
| `ui/index.html`（1 hunk） | head 加 `/version-info.css`；`.brand` 内加 `<span class="brand-version" id="brandVersion" tabindex="0" role="note" aria-label="知识库版本">知识库 版本读取中…</span>`；body 尾加 `<script src="/version-info.js">`。原导航不动。 |
| `ui/version-info.js`（新增） | 载入后一次性 `fetch('/api/system/version')`：成功 → `知识库 v{core.version}`；失败 → `知识库 版本未知`。无轮询、无重试循环、无模块清单。 |
| `ui/version-info.css`（新增） | 仅 `brand-version` 前缀规则。**关键实现决策：默认隐藏用 `opacity:0 + pointer-events:none`，刻意不用 `visibility:hidden`** —— 后者会把元素从 Tab 焦点序剔除，键盘 focus 查看将永远失效（headless CDP 实测证实：visibility:hidden 下真实 Tab 键会跳过该 span）。`.brand:hover` 或自身 `:focus`/`:focus-visible` 时 `opacity:1`；`:focus` 恢复 `pointer-events:auto` + accent outline。absolute 定位不占布局空间。主题色继承 product.css 变量（浅/深色自动适配）；`prefers-reduced-motion` 关闭过渡。 |
| desktop/main.cjs、preload.cjs | 无改动（R1 IPC 已撤，git clean）。 |

## 3. 测试与验收（全部通过）

- `qa-autopilot/tools/product-probes/version-visibility-run.js`：`--check`（语法 + fixture 模块加载含 Chrome 解析）/ `--run test` / `--run browser`。零模型、不读 quota、不查 npm。
- `_site/_test/version-visibility-test.js`（-test.js，run-all 自动收集，PASS）：单元 coreVersionSnapshot === 根 package.json 版本；真实隔离服务器 `GET /api/system/version` 200 且版本一致；served HTML 含 brandVersion/version-info.css/js、不含 versionInfoButton/versionDialog/`/api/system/versions"`；served 资产与 ui/ 磁盘 sha256 逐字节一致；favicon 不受影响；503 stub 分支（真实 ui/ 资产 + 版本接口失败）。
- `_site/_test/version-visibility-browser-probe.js`（手动重型，run-all 永不收集，PROBE-PASS，10/10）：真实 Chrome CDP 驱动真实产品页 —— default-hidden（opacity 0）、no-reserved-space（absolute）、no-r1-sidebar-or-dialog、hover-shows-version（`知识库 v5.0.24`）、move-away-hides、focus-shows（**真实 Tab 键**，首焦点即 brandVersion，`:focus` 匹配）、blur-hides、no-polling（2500ms 空闲后 performance 资源条目恰 1 次）、dark-theme-hover、narrow-viewport-hover（390×760）、version-unknown-branch（503 → `知识库 版本未知` 且悬停仍可看）。截图 4 张 + browser-probe.json 落 artifacts。
  - headless 下 `document.hasFocus()===false`，需 `Emulation.setFocusEmulationEnabled` 恢复真实聚焦页状态；Chrome crashpad_handler 会短暂存活锁住隔离目录，收尾按命令行匹配清扫 + removeTree 重试。
- 隔离：仓库外临时根；全 env 白名单（双 KB_DATA_DIR/HOME/USERPROFILE/CODEX_HOME/CLAUDE_CONFIG_DIR/APPDATA/LOCALAPPDATA/TEMP/Bridge home/Workbench data）；剥离模块地址与 Anthropic 凭据；FORBIDDEN_PORTS {5757,5760,5789,5790,8787,8790} 拒用；先解析真实 Chrome 再套隔离 env；所有模块地址显式自有随机端口。

## 4. 发布前 Leader 事项（本线未做，按边界留给 Leader）

1. `module-runtime-manifest.json` productFiles 固定 `ui/index.html` sha256，现已过期 → 发布前用 pack-module-candidates / sync-product-content 再生成（本线不改 manifest）。
2. 根 package.json `files` 白名单逐文件列 ui/*，需补 `ui/version-info.js`、`ui/version-info.css` 两行（建议；运行时不受影响）。
3. 版本号 5.0.25 发布时自然由根 package.json 驱动，无硬编码。

## 5. 边界

- 五仓 main 不开分支；不 commit/push/npm/tag；不改版本/pins/vendor/manifest/package.json。
- 不安装/替换/停止/重启真实桌面（5.0.24）或任何已装模块；不读真实 profile/Key/额度。
- 产出：`qa-autopilot/artifacts/parallel-20261023/version-visibility/report.json` + browser-probe.json + 4 截图 + 源/served hash + 未完成项（第 4 节）。
