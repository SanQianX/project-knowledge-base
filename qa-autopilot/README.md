# Project Knowledge Base · QA Autopilot 执行开发包

> 2026-10-22 维护更新：已将有效 QA 提交纳入主仓库 `main`。日常直接在 `main` 开发，不自动重建历史 `qa/*` 分支或启动旧的通宵控制器。原始现场、隔离 clone、配置和未提交测试草稿归档于仓库外的 `D:/SanQian.Xu/.project-knowledge-backups/consolidation-20261022/`；下方及 plans 中的阶段状态属于历史执行合同。工具自检仍使用 `npm test` 和 `node scripts/qa.cjs self-check`。
>
> 2026-10-23 执行基座更新（L-QA-01）：本包现在只认 `main`。不再有 QA/backup/release 分支，基准是本地可审计的 SHA+收据而不是 tag。执行发生在 `qa-autopilot/.runtime/workspaces/main` 这份独立 clone 上，受保护目标（运行中的桌面 5.0.24、全局 npm 包、真实数据目录、真实知识根）由 `lib/isolation.cjs` 变成**可执行**的保护规则：执行前筛查、执行中隔离、执行前后比对（静态安装产物用递归清单哈希；真实可变 data/knowledge 目录只做只读观察并写明归因限制）。详见下文“执行基座”。
版本：1.0.0 · 编制：2026-10-20 · 语言：中文 · 目标：MiniMax M3.1 Flash

## 交付定位

本包是**源码定向执行计划＋可运行控制工具＋工具自检＋现场接线合同**，不是已经跑完的产品验收报告。主仓库审查基准为 `c7d5b2bc86b7e51fe6e322999294bb497af1808c`，主包 5.0.24，Workbench 依赖 0.13.6。Windows 工作区、真实订阅Key、真实CLI/浏览器、npm发布身份未在此环境操作。

所有新增文件放在：
`D:\SanQian.Xu\project-knowledge-base\qa-autopilot`

本包不包含账户凭据、生产数据、第三方字体、完整仓库副本或生产安装包。**只在你本机完成 T00–T06 必要能力验收后，才能启用无人值守修改。** 不能仅把配置布尔值改成 true 就声称完成权限隔离。

## 开始

在 PowerShell：
```powershell
Set-Location 'D:\SanQian.Xu\project-knowledge-base\qa-autopilot'
node --version
npm test
node scripts/qa.cjs self-check
node scripts/qa.cjs init
```
Node 必须至少22。`init` 生成本地配置并以退出码20提示需要配置，这是预期行为，不是测试失败。它不推送、不发布、不清理。配置里的 node.exe/npm-cli.js 路径只是例子，须核对本机实际文件。

然后把 `MINIMAX_START_PROMPT.md` 发给执行 Agent。先读 `plans/00_README_FIRST.md`，按阶段推进。额度/worker未接通时仍可执行安全的只读审计和工具自检，不假装已建立自动恢复闭环。

## 执行基座（2026-10-23，main-only + 隔离执行）

| 规则 | 落地方式 | 证据 |
|---|---|---|
| 只允许 `main` | `lib/git.cjs` 的 `branchName()` 只接受 `main`；`qa/*`、`backup/*`、`release/*`、`master` 一律 `BRANCH_FORBIDDEN` | `tests/governance.test.cjs` |
| 不建基准 tag、不推远程 | `baseline` 走 `sha-receipt` 模式：只写本地 `state/baseline.json`，不产生 tag、分支或远程 ref | `tests/governance.test.cjs` |
| 独立 clone | `.runtime/workspaces/main`，`--no-local --no-hardlinks --single-branch --branch main`；`verify-clone` 自证 origin 精确、在 main、干净、无硬链接、与用户工作区不同 | `node scripts/qa.cjs verify-clone` |
| 数据隔离 | 每个产品子进程同时隔离 `KB_DATA_DIR` 与 `KB_KNOWLEDGE_DATA_DIR`，重置真实模块 URL，剥离密钥，用独占端口 | `tests/governance.test.cjs` |
| 受保护目标 | 桌面 5.0.24、全局 npm、真实数据目录、真实知识根：执行前筛查硬编码，执行前后比对身份与哈希。**静态安装产物（全局 npm 安装根）走递归清单哈希，覆盖子目录；真实可变 data/knowledge 目录只做只读观察，其变化本身不构成越界证据（运行中的桌面一直在写自己的事件目录）。不宣称只检查顶层能防住子目录写入。** 真正的保护来自隔离的数据目录、独立模块与端口、重置真实模块 URL，以及对真实写入/真实连接的拒绝 | `protected-snapshot` / `protected-verify` |
| 运行实例身份 | 以 `/api/runtime/identity` 的 version/pid/dataDir 核对；`/api/health` 的 200 只能证明"有东西在应答"，不能证明应答的还是那个 5.0.24 实例 | `verify-isolation` |
| 只读额度 | `quota.mode = published-file`，只读任务网关发布的状态文件，不碰真实 Key | `node scripts/qa.cjs quota` |

常用命令：

```powershell
node scripts/qa.cjs verify-clone        # clone 自证
node scripts/qa.cjs verify-isolation    # clone + 环境隔离 + 受保护目标一次核对
node scripts/qa.cjs protected-snapshot  # 记录受保护目标身份与哈希
node scripts/qa.cjs run-suite --suite smoke --contract <合同.json>
```

授权位默认关闭，**只打开本轮真正验证过的那几个**：`localCloneEnabled`、`controllerIsolationVerified`。
`remoteWriteEnabled`、`candidatePublishEnabled`、`installRcEnabled`、`cleanupEnabled` 保持 false。

## 核心内容

| 内容 | 入口 | 说明 |
|---|---|---|
| 130个测试规格 | config/test-cases.json、plans/03_TEST_CASE_MATRIX.md | 用例不是通过记录；每项初始NOT_RUN |
| 15阶段合同 | config/phases.json、plans/04_AUTONOMOUS_REPAIR_LOOP.md | T00–T14；每阶段输入/动作/出口 |
| 工具与安全自检 | npm test | 本包控制代码测试；详见reports/delivery |
| 原生测试包装器 | scripts/qa.cjs run-suite | 不搬动现有 _site/_test；新产物集中管理 |
| 真实浏览器输入脚本 | tools/browser-shell.cjs | 原生CDP指针/键盘；真实外壳、离线模块替身 |
| 配额与请求保护 | lib/quota.cjs、tools/quota-gateway.cjs | 字段不明/陈旧即拒绝；不输出真实Key |
| 审核任务执行器 | tools/supervisor.cjs | 只执行已批准队列；默认无任务、无worker接线 |
| Git版本保护 | scripts/qa.cjs baseline / commit-push / ci | 写入默认禁用；精确远程SHA及CI核对 |
| RC发布模板 | templates/publish.rc-only.yml | 仅模板，未应用；只next，没有stable出口 |
| 官方RC安装工具 | scripts/qa.cjs rc-install | 固定版本、隔离prefix，不覆盖全局安装 |
| 像素比较/性能 | tools/visual-compare.cjs、tools/performance.cjs | 先批准基线；低层测量不代替全面体验验收 |
| 安全临时清理 | scripts/qa.cjs cleanup-plan / cleanup-apply | 拒绝链接、硬链接、活跃/失败数据；不递归rm |

## 本包没有替你做的事

没有更改本机原项目；没有创建远程基准tag/QA分支；没有发布npm；没有注册Windows计划任务；没有替换或重启已安装的 5.0.24。

2026-10-23 这一轮**执行了真实产品测试**：`smoke` 套件 3 个用例文件全部通过（隔离端口 52425，隔离数据目录，受保护目标零差异），
`lifecycle` 套件 4 个中 2 个通过、2 个因执行前筛查命中受保护端口（5760）被判定为 BLOCKED_CAPABILITY。
额度只读任务网关发布的百分比状态，不查询真实账户。

模块0.13.6同版本源码、原生Agent调用参数以及发布授权需要在本机核对，缺失时返回BLOCKED，而不是猜测。

纯工具自检的成功，不能推导项目130个用例通过。`reports/delivery/VALIDATION.md` 是本次实际验证边界。

## 三个重要差异

**配额字段**：官方CLI对 usage_count 存在不同含义的处理。本包优先明确百分比；缺少语义证据不猜剩余额度。新M Plan的五小时窗口从首次使用开始，到期重置；历史Token Plan权益以你的账户为准，禁止自动升级/取消订阅。

**采集来源**：任务书要求排除内部Workbench维护对话，但当前界面具有Workbench会话采集提示。先按origin、真实用户/委派/维护区分并写反例，不允许一刀切删历史或采集模块。

**发布来源**：主包依赖0.13.6，但独立Workbench默认分支显示0.3.0。修复必须先找到匹配源，不能在node_modules临时改完就当成可发布源码。

## 退出码

0：该工具所声明的动作完成；不等于产品发布获批。
2：输入、配置或安全约束错误。
10：执行的测试/安装/校验失败。
20：能力缺失、授权不足、状态不明或等待中。

最后只允许进入 `READY_FOR_STABLE_APPROVAL`。本包不提供发布latest的命令。
