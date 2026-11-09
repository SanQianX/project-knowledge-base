# RELEASE 5.0.25 PREFLIGHT（2026-10-23）

状态：预检完成，未执行任何发布动作。本页属于 P-RELEASE-PREFLIGHT-5025 独占路径；
五仓均停留在各自 main HEAD，未提交、未推送、未打 tag、未发布 npm。
正式发布（版本号推进、npm publish、tag、安装替换）全部由 Leader 决定与执行。

## 0. 验证过的五仓 HEAD（2026-10-23 实际 checkout 核对）

| 仓库 | main HEAD | 说明 |
|---|---|---|
| project-knowledge-base (root) | 44bea66 | 桌面薄壳 + 核心 _site；版本仍 5.0.24 |
| claude-ai-workbench | a5d9283 | WB-QUOTA-01 额度管理；CI 39954073608 通过；未发布 |
| knowledge-engine | b40abf0 | 晚到提交安全 + 重试幂等；未发布 |
| ai-coding-event-bridge | 86d3be6 | Windows canonical/short-path 身份修复；未发布 |
| vector-hub | 3062a85 | CI/publishing 修复；对 rc.8 运行时为 CI/文档性变更 |

## 1. 5.0.25 拟包含清单（待 Leader 确认）

- 模型额度管理（WB-QUOTA-01，Workbench 侧）。
- LOG-SAFETY-R2 已接受的日志安全修复（root _site/lib/server-app.js hook 路由 + README 日志节）。
- memory lane 已接受的 UI/集成修复（ui/product.js、product.css、live-client.js、integration-installer.js）。
- Bridge Windows 身份修复（console 0.7.3：comparisonForm/realpathBestEffort）。
- engine 晚到提交安全 + 重试幂等（需要重新 vendoring，见 §3 D1）。
- 桌面打包链修复（§4 两个真实缺陷）——本预检已修并复测。

## 2. 已发布 vs 已 pin vs 源码差异（以字节/lockfile 核对，非版本字符串推断）

registry 只读核对（2026-10-23，`npm view <pkg> dist-tags`）：

| 模块 | registry latest / next | root 当前 pin | 源码 HEAD 状态 | 差异证据 |
|---|---|---|---|---|
| @sanqianx/claude-ai-workbench | 0.13.6 / 0.13.6 | 0.13.6（package.json:93 别名依赖 + module-runtime-manifest terminal） | a5d9283 未发布 | 已安装 0.13.6 无 profile-quota.js（源码 sha e953f91c…）；quota 功能整包缺失 |
| @sanqianx/ai-coding-event-bridge-console | 0.7.2 / — | 0.7.2（package.json + manifest eventBridge） | 86d3be6 未发布 | 已安装 bridge.js sha 53c16981…（manifest:235）无 comparisonForm/realpathBestEffort；源码 sha 9e298598… |
| @sanqianx/ai-coding-knowledge-engine | 0.2.0 / 0.2.7-rc.9 | vendored 0.2.7-rc.10（vendor-manifest.json，_modules/knowledge-engine） | b40abf0 未发布 | **rc.10 从未发布到 registry（versions 止于 rc.9）**；rc.10(10c940a)→b40abf0 相差 10 个提交（含已验收修复） |
| @sanqianx/vector-hub | 1.0.7 / 1.0.8-rc.8 | 1.0.8-rc.8（package.json + manifest vectorHub） | 3062a85 = rc.8 之后仅 CI/docs 变更 | 无运行时差异，建议保持 rc.8 |
| @sanqianx/project-knowledge (core) | 5.0.24 / 5.0.24 | root 5.0.24；desktop pin 5.0.24 | 44bea66 待发 5.0.25 | 三处必须同步推进（root version、desktop version、desktop 核心依赖精确 pin） |

## 3. 依赖 DAG（每步含可验命令）

前置事实：desktop/package.json 断言 `dependencies['@sanqianx/project-knowledge'] === pkg.version`，
make 包装器同样断言；root 与 desktop 版本错位会让 desktop-release.yml 的版本检查直接失败。

```
D1 engine 发布 → root vendoring
D2 Workbench 0.13.7 发布 → root pin/lock + module-runtime-manifest
D3 console 0.7.3 发布 → root pin/lock + module-runtime-manifest
    (D1–D3 相互独立，可并行；全部先于 D4)
D4 core 5.0.25：五仓集成 + 版本同步 → npm publish → registry 可见
D5 desktop 构建 + 三段验证（本预检已交付的工具链）
D6 tag v5.0.25 + desktop-release.yml workflow_dispatch（资产上传）
D7 正式替换 5.0.24（受控停机 → 备份 → 更新 → 重启验证；见 §6）
```

### D1 knowledge-engine

```bash
cd D:/SanQian.Xu/knowledge-engine
npm ci && npm test                      # 全量绿后才继续
npm version 0.2.7-rc.11                 # 或 0.2.7 正式版（Leader 定）
npm publish --tag next                  # 与 rc 线一致先用 next；正式版再 promote
npm view @sanqianx/ai-coding-knowledge-engine@<ver> version   # registry 确认
# root 侧：按既有 vendoring 流程更新 _modules/knowledge-engine + vendor-manifest.json
```
不重新 vendoring 的后果：vendored rc.10 缺 b40abf0 的晚到提交安全 + 重试幂等（已验收内容），5.0.25 白报包含。

### D2 claude-ai-workbench 0.13.7

```bash
cd D:/SanQian.Xu/claude-ai-workbench
npm ci && npm test                      # CI 39954073608 已绿，本仓全量按惯例重跑一次
npm version 0.13.7 && npm publish       # latest
npm view @sanqianx/claude-ai-workbench@0.13.7 version
# root 侧：package.json:93 别名依赖改 0.13.7，npm install 刷新 lock，
# module-runtime-manifest.json terminal 段哈希按既有流程重生成
node -e "console.log(require('./node_modules/claude-ai-workbench/package.json').version)"  # 0.13.7
```

### D3 ai-coding-event-bridge-console 0.7.3

```bash
cd D:/SanQian.Xu/ai-coding-event-bridge
npm ci && npm test
npm version 0.7.3 && npm publish
npm view @sanqianx/ai-coding-event-bridge-console@0.7.3 version
# root 侧：package.json pin 0.7.2→0.7.3 + lock + manifest eventBridge 哈希
node -e "console.log(require('./node_modules/@sanqianx/ai-coding-event-bridge-console/src/bridge/core/bridge.js').length && require('crypto').createHash('sha256').update(require('fs').readFileSync('./node_modules/@sanqianx/ai-coding-event-bridge-console/src/bridge/core/bridge.js')).digest('hex'))"
# 期望 = 源码 86d3be6 的 9e298598…（不再是 53c16981…）
```

### D4 core 5.0.25

```bash
cd D:/SanQian.Xu/project-knowledge-base
npm ci && npm test -- --no-report       # 与 desktop-release.yml 同口径
# 版本三同步：package.json 5.0.25、desktop/package.json version 5.0.25、
#            desktop 核心依赖 pin 5.0.25，两个 lockfile 同步刷新
npm ci --prefix desktop && npm test --prefix desktop
npm publish                             # core 5.0.24 latest==next；5.0.25 的 tag 策略 Leader 定
npm view @sanqianx/project-knowledge@5.0.25 version
```

### D5 desktop 构建 + 三段验证（预检已实测的命令与退出码）

```bash
node desktop/test/release-preflight-5025-make.cjs                      # 本机实测 EXIT=0
node desktop/test/release-preflight-5025-package-audit.cjs --self-test-negative   # EXIT=0
node desktop/test/release-preflight-5025-packaged-verify.cjs           # 本机实测 10/10 PASS, EXIT=0
node desktop/test/release-preflight-5025-packaged-verify.cjs --expect-core-version 0.0.0   # 反证：FAIL core-version, EXIT=1
```
离线构建支持：`KB_DESKTOP_ELECTRON_ZIP_DIR=<dir>`（须含 electron-v43.1.1-win32-x64.zip）。

### D6 tag + workflow

```bash
git tag v5.0.25 && git push origin v5.0.25
# GitHub → Actions → Publish Windows desktop → workflow_dispatch，tag=v5.0.25
# 工作流内含 D5 三段命令（本预检的最小 diff，见 §5）
```

### D7 正式替换（§6）

## 4. 桌面打包链两个真实缺陷（已修复 + 复测）

### 4.1 apache-arrow 被 packager prune 丢弃（打包后 LanceDB 必挂）

- 根因：apache-arrow 只是 @lancedb/lancedb 的 peerDependency（>=15 <=18.1.0）。
  desktop lockfile 由 npm ci 装配时会自动补 peer（顶层 18.1.0），但
  @electron/packager 打包时的 `npm prune` 重新解析（写 inner node_modules/.package-lock.json，
  728 包）**不自动安装 peer** → asar 内 require('@lancedb/lancedb') 报
  "Cannot find module 'apache-arrow'"。系统性排查确认这是 asar 树里唯一未满足的非可选 peer。
- 修复：make 包装器把 apache-arrow 以精确版本写进 staged manifest（并对已装版本断言落在 peer 区间内）。
- 证据：evidence/build/lancedb-runtime-probe-fixed.log（修复前红 / 修复后 PROBE_PASS）。

### 4.2 asar unpack 模式在 Windows 完全失效（natives 全部封进 asar）

- 根因：@electron/asar 3.4.1 在 Windows 上把 unpack 模式与**绝对反斜杠路径**匹配；
  `/` 分隔的 `**/*.{node,dll,ps1}` 匹配不到任何文件（实测为 no-op）。
  Electron 43.1.1 无法 dlopen asar 内 .node（临时提取产物损坏，"not a valid Win32
  application"；asar 字节读回 sha256 与源一致，证明内容无损、纯 dlopen 路径缺陷）。
  2026-08-18 暂停注释里的 "folder-picker ASAR unpack" 缺陷即同一根因：
  `_site/scripts/folder-picker.ps1` 也从未解包（当前包内该文件已 unpacked=true；
  桌面监督进程对 console 传 BRIDGE_CONSOLE_PICK_FOLDER=0，交互路径本就不走它）。
- 修复：staged forge 配置 unpack 用实测有效的 Windows 形式 `**.{node,dll,ps1}`
  （根与嵌套 .node/.dll/.ps1 均解包；修复包内 28 个 natives 全部 unpacked 且有磁盘镜像）。
- 证据：evidence/build/（pattern 矩阵、dlopen 探针、asar 列表核对）、audit 自测三反例。

### 4.3 预检过程中排除的三个假象（留档避免复发）

- **GUI 0x80000003 崩溃**：Electron 43.1.1 GUI 浏览器进程在 USERPROFILE ≠ Shell
  真实 profile 时启动即 CHECK 失败（任意目标、存在与否、任意盘符、两种斜杠均崩；
  RUN_AS_NODE 模式不受影响）。→ packaged-verify 不重定向 USERPROFILE
  （其影响面 userData/Crashpad 走 APPDATA、缓存走 LOCALAPPDATA、数据走 KB_DATA_DIR，均已隔离）。
- **exe 静默 exit 0**：Electron 经 Shell API 解析 appData，**忽略 APPDATA 环境变量**；
  未加 `--user-data-dir` 时打包 exe 的 Chromium userData 落在真实 profile，
  与运行中的已安装桌面撞单实例锁 → 500ms 内礼貌退出。→ verify 以
  `--user-data-dir=<隔离目录>` 启动（锁可获取、缓存/Crashpad 全隔离）。
- **GUI 在后端停止后不退出**：main.cjs:221 起按设计驻留托盘（"Tray keeps the app
  alive"）并弹重连提示；verify 第 9 项改为断言该设计行为而非自行退出。

## 5. desktop-release.yml 最小 diff（已写入，未触发）

- 移除 `npm ci --prefix desktop --omit=optional` 的 `--omit=optional`
  （@lancedb/lancedb-win32-x64-msvc 是 optionalDependency，omit 会装出永远打不出 LanceDB 的树）。
- `npm run make --prefix desktop` → `node desktop/test/release-preflight-5025-make.cjs`
  （Squirrel 产物回拷 desktop/out/make，资产路径不变）。
- 已删除的 `test:packaged` / `audit:package` 两个失效步骤替换为
  package-audit（含负例自测）与 packaged-verify（真实 EXE 端到端）。
- 顶部暂停注释更新为现状（根因已修、保持 workflow_dispatch 唯一触发；加 tag 触发属发布策略变更，Leader 决定）。
- YAML 结构已解析验证；工作流本身**未运行**（合同禁止触发）。

## 6. 正式替换的备份与恢复（沿用 5.0.24 已验证的模式）

前置事实（docs/desktop-5.0.24-local-upgrade.md）：正式数据目录
`C:/Users/SanQian/.project-knowledge-v5`（7 个项目、engine 333 条运行记录）；
上一轮备份在 `D:/SanQian.Xu/.project-knowledge-backups/desktop-upgrade-20261022/`。

1. 停机：经桌面托盘正常退出（触发 before-quit → 核心 stop 协议），确认 5757 端口与
   runtime-endpoint.json 消失、后端 PID 退出。
2. 备份：完整复制 `C:/Users/SanQian/.project-knowledge-v5` →
   `D:/SanQian.Xu/.project-knowledge-backups/desktop-upgrade-<date>/v5-data/`，
   生成 SHA-256 清单；保留旧/新桌面安装介质与升级前后快照（同 20261022 布局）。
3. 更新：安装 5.0.25（Setup.exe 或既定 tgz 通道），首次启动观察
   desktop-backend.log 与 runtime-endpoint.json。
4. 验证：桌面壳版本、/api/runtime/identity=5.0.25、5757 服务、7 个项目标识不变、
   engine 运行记录数不降、线上 product.js 与 5.0.25 asar 字节一致
   （可复用 packaged-verify 的 sha256 对照思路对正式实例手工执行）。
5. 回退：安全停止 5.0.25 → 重装保留的 5.0.24 介质 → 仅在确认需要时从停机备份恢复数据
   （5.0.25 若已写入新数据，恢复前先另行快照，避免覆盖）。

## 7. 发布通道缺口（Leader 决策项，本预检未改）

- 根 publish.yml 当前是 QA 候选工作流（qa-rc/* + next tag + npm-rc-gate），
  **没有 5.0.25 正式 latest 发布通道**；core/模块的 latest 发布目前靠手工 npm publish。
  建议：要么接受手工发布（DAG 每步有 npm view 验证），要么单独立项改造 publish.yml
  （不在本预检范围）。
- desktop-release.yml 保持 workflow_dispatch；是否加 tag 触发达发布策略变更。

## 8. 本预检未实际执行的项目（未知如实写未知）

- 任何 npm publish / dist-tag 变更 / git tag / workflow 触发。
- desktop-release.yml 在 GitHub windows-latest 上的真实运行（命令已在真机
  Windows 10 + 同版本 Node 24 验证，CI 运行留待 Leader）。
- engine/workbench/console 的 0.2.7-rc.11 / 0.13.7 / 0.7.3 候选构建与发布。
- root 版本推进到 5.0.25 及三同步 lockfile 刷新。
- 正式实例停机/备份/替换（§6 全部）。
- packaged-verify 对 5.0.25 候选的运行（当前绿结果是 5.0.24 staged bundle）。
- 130 条用例只有 54 条已审（前批评审遗留口径），其余未审不得标通过。

## 9. 证据索引

- 构建/审计/验证日志与探针：
  `qa-autopilot/artifacts/parallel-20261023/release-preflight-5025/evidence/{build,verify}/`
- 综合报告：`qa-autopilot/artifacts/parallel-20261023/release-preflight-5025/report.json`
- 工具（待 Leader 审后入库）：`desktop/test/release-preflight-5025-{make,asar,package-audit,packaged-verify}.cjs`
