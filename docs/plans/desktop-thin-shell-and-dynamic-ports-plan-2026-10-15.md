# 模块动态端口分配与桌面薄壳重构计划

保存日期：2026-10-15。

状态（2026-10-16）：目标 A 与目标 B 均已实施并通过验收——阶段一提交 `c4afa63`（动态端口四场景 + 137 项后端回归全过），阶段二提交 `6ea83d5`（薄壳依赖白名单、CLI/main 重写、生命周期验收：复用/自有后台/单实例/无孤儿进程）。执行前检查点：主仓库 `e9c18f7`、knowledge-engine `b400072`、vector-hub `b6dce20`；ai-coding-event-bridge `0ada7ac` 与 claude-ai-workbench `1b028da`。验收证据在仓库外 `D:\SanQian.Xu\.glm-plan-evidence\`。

## 一、背景与已核实事实

用户动机：多个模块各占一个端口，担心端口被外部程序占用后知识库无法启动，并因此考虑 Electron 桌面化。经代码核查：

- 外壳端口 5757 已有自动回退（`bin/project-knowledge.js` 的 `freePort`，+0..+19）与 `runtime-endpoint.json` 原子发现（`_site/lib/runtime-endpoint.js`），外壳端口被占不会导致启动失败。
- 受管模块使用固定默认端口：terminal 5760、vector-hub 8787、event-bridge 8790、knowledge-engine 5790（`_site/lib/module-bridge.js`）。端口被占时模块崩溃循环 5 次后放弃，外壳仍在但对应功能降级。
- `_probe` 仅以 `/api/health` HTTP 200 判活，外部服务可能被误认为模块已在运行。
- 外壳回退区间 5757-5776 与 terminal 默认端口 5760 重叠，存在自冲突边界。
- 旧 `desktop/package.json` 手抄模块依赖且版本已漂移（workbench 0.12.0 / vector-hub 1.0.6 / bridge-console 0.6.0，对应已验收 5.0.17 实为 0.13.2-rc.17 / 1.0.8-rc.8 / 0.7.2），并使用 `file:..` 兜底，违反 `ui-refresh-electron-plan-2026-10-13.md` 第三节的分发约束；`.core-package/` 残留 4.1.23 tgz，`out/` 残留 4.1.22 构建产物。

结论：Electron 不解决端口问题（端口属于后端模块，与浏览器外壳无关）。端口方案独立先行落地，网页与桌面同时受益；桌面版按薄壳重建，其正当目标是桌面体验与生命周期管理。

## 二、目标 A：模块动态端口分配（核心仓库）

1. `startSupervised` 为每个受管模块解析最终 URL 后再生成 spawn 规格：
   - 显式环境变量（`KB_TERMINAL_URL` / `KB_VECTORHUB_URL` / `KB_EVENTBRIDGE_URL` / `KB_KNOWLEDGE_ENGINE_URL`）→ 视为外部服务模式，行为完全不变。
   - 无环境变量 → 先探测默认端口的健康接口，健康则复用（支持独立运行的模块）；否则从默认端口起逐个检查空闲（+0..+19），选中后更新 bridge 的各模块 URL，模块间环境变量（引擎 URL、桥 URL 等）使用最终动态值。
   - 连续 20 个端口全部被占 → 记录明确错误与诊断，不静默降级。
2. 健康探测增加产品身份校验：`/api/health` 响应需匹配模块特征（服务名/schema 字段），HTTP 200 但身份不符视为被外部进程占用，转入换端口逻辑。
3. 消除 5757-5776 与 5760 的重叠风险：模块空闲检查自然避开外壳已绑定端口；补充覆盖用例。
4. `/api/modules/health` 与日志输出实际端口及来源（dynamic / reused / external），便于诊断。
5. 新增 `_site/_test/module-dynamic-port-test.js`：
   - 默认端口被外部 TCP 进程占用 → 模块落到下一空闲端口并健康可用；
   - 默认端口存在健康且身份匹配的服务 → 复用不重复 spawn；
   - 默认端口存在 HTTP 200 但身份不符的服务 → 换端口而非误认；
   - 连续占用超出范围 → 明确错误。
6. 回归：`module-process-lifecycle-test.js`、`module-bridge-eventbridge-test.js` 等既有模块测试必须通过。

## 三、目标 B：桌面薄壳重构（desktop/）

1. 删除过时实现：`lib/app-updater.cjs`、`lib/external-link.cjs`、`lib/folder-picker.cjs`、`scripts/prepare-core.cjs`、`scripts/audit-package.cjs`、`scripts/prune-runtime.cjs`、旧测试与 `.core-package/` 残留（`out/` 已被 gitignore）。保留 `assets/` 图标。
2. `package.json` 重写：
   - 包名 `@sanqianx/project-knowledge-desktop`，版本对齐已验收核心 `5.0.17`；
   - 运行依赖仅 `project-knowledge@5.0.17`（精确）、`electron`（精确版本）、`electron-squirrel-startup`；禁止 `file:..` 与手抄模块依赖；
   - devDependencies 仅 Electron Forge 工具链。
3. 新 CLI `bin/project-knowledge-desktop.cjs`：`start`（默认，启动 Electron 窗口）、`status`、`stop`、`--version`、`--help`、`--data`。status/stop 委托核心包 CLI 与控制协议，不在桌面侧重复实现停止逻辑。
4. `main.cjs` 按原计划第三节重写：
   - Squirrel 安装事件先行处理；单实例锁，二次启动聚焦已有窗口；
   - 通过核心包路径复用 `data-dir` 与 `runtime-endpoint`；已有实例且版本兼容 → 复用不启动第二写入者；版本不匹配 → 明确提示并退出；
   - 无实例 → 以 `ELECTRON_RUN_AS_NODE=1` 运行核心 CLI `--fg --no-open`（不传固定端口，由核心 `freePort` 分配并写 `runtime-endpoint.json`），`KB_RUNTIME_MODE=desktop`，日志写入 `desktop-backend.log`；
   - 启动窗口先行显示并保持可交互，后台就绪后加载页面；连接失败显示诊断与重试，不长期空白；
   - 关闭窗口隐藏到托盘，知识维护继续；托盘“退出”仅停止桌面自启后台（经控制通道安全停止），复用的网页后台不擅自停止；
   - 沙箱、contextIsolation、最小 IPC；外链白名单走 `shell.openExternal`；不向页面暴露 Node 或凭据。
5. 新测试：`thin-package-test.cjs`（运行依赖白名单、无 `file:..`、精确版本）、`backend-runtime-test.cjs`（端口分配、就绪等待、版本兼容判定，使用 mock endpoint）、CLI 参数测试。
6. `forge.config.cjs` 更新为新包名与产物标识。

## 四、实施顺序与回退策略

1. 阶段一：核心动态端口（目标 A）→ 新旧测试通过 → 独立提交；
2. 阶段二：桌面薄壳（目标 B）→ 桌面测试通过 → 独立提交；
3. 每阶段一个提交，问题按提交回退；需要整体重来时回退到第一节的检查点锚点；
4. 全程不修改数据目录、项目、知识、配置与历史，不通过清空数据制造通过结果；
5. 本计划不包含 npm 发布；发布另走候选包 + 独立下载验收流程。

## 五、验收门禁

- 核心：三种端口冲突场景（外部占用 / 健康复用 / 身份不符）全部按预期处理，外壳与模块均可启动且功能不降级；既有回归套件通过。
- 桌面：`npm test` 全绿；重复启动、复用已有实例、托盘隐藏与退出不产生遗留进程或双写；打包冒烟（可选 `forge package`）通过或如实记录未完成。
- 未覆盖环境（macOS、代码签名、窄屏矩阵、真实 npm 安装验收）如实标记为未完成，不宣称通过。

## 六、范围外

macOS 平台适配与公证、Windows/macOS 安装程序签名、应用内自动更新、窄屏矩阵、正式 npm 发版。
