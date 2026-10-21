# 00 · 执行入口与禁止捷径

## 控制平面和被测产品分开

原项目路径不变。中央 `qa-autopilot` 由控制端持有，`.runtime/workspaces/repair` 是隔离源码clone；模型只在该clone执行批准任务。使用clone而不是嵌套worktree，避免共享Git配置/Hook影响生产及自嵌套扫描。中央QA目录不是业务模块；其本地 state、artifacts、config/local.json不进入Git或npm。

工具copy在T02复制到clone后提交，供CI读取脚本与文档。原目录里未提交文件不会自动包含在基准tag。基准是可恢复节点，未经初始测试不能叫“已验证稳定版本”。

## 实际的权限边界

模型进程应由受控broker在独立低权限Windows账户/沙箱中运行。它只可写任务文件，不可写中央QA工具/合同/基线/证据，不可读取订阅真实Key、Git写凭据、npm身份。网关和远程写工具由控制端运行。禁止外网直接模型访问，以免绕过逐请求额度门禁。

**代码中的approval布尔值和JSON哈希只能防误操作/过期证据，不是防恶意同权限进程的安全隔离。** 实际OS ACL、进程身份、网络出口和受保护GitHub环境必须现场验证。当前generic worker通过已配置executable启动；该入口必须是已验证的受限broker或符合隔离合同的适配器，不可把普通同权限node进程标为安全。

## 首次执行

运行本包 `npm test`，再 `node scripts/qa.cjs self-check`。首次 `init` 只生成本地配置。审核工具路径、sourceRoot、repoRoot、origin、QA branch和基准tag。既有本地配置不覆盖。

T00审计可在无MiniMax额度、无npm写权限时完成。T01远程基准操作、T02工具导入、T04工作流修改采用独立bootstrap审批，解决“先有门禁才能创建门禁”的循环依赖；只能进行限定元数据/QA工具改动，不开放业务自由修改。

每个写入命令先不带 `--apply` 查看计划；正式执行前保存该计划并确认远程当前SHA。无网络、未授权、版本不匹配、缺浏览器都记录能力阻断，不能转成skip后宣布通过。

## 依赖与文件位置

本控制工具没有第三方npm依赖，Node22+自带test runner即可自检。浏览器脚本复用被测项目的Chrome/CDP助手与 `ws`，需要在隔离clone按原锁文件安装产品依赖。不得为了跑测试升级生产依赖。

Windows `.cmd/.bat` 包装器不用于Node spawn直接入口：配置真实 `node.exe` 及工具JS入口；未知CLI参数先看实际版本帮助与协议。不要把配置示例路径当作本机已存在事实。

运行产物：`.runtime/runs/<runId>`；证据：`artifacts/<runId>`；状态：`state`；汇总：`reports/runs`。GitHub只提交审核后的源码/计划/脱敏摘要，原始trace、凭据、用户文本不默认上传。

## 失败与完成

测试需保存：运行平台/Node、source SHA、文件fingerprint、模块版本、fixture哈希、具体caseID、首失败、复测、退出码。PATCH改变后旧凭证作废。零测试、仅端口在线、仅安装成功、仅Agent退出0都不是验收。

检查 `reports/delivery/VALIDATION.md` 的已测范围，再执行T00。不要把本包Linux单测报告当成Windows或产品功能证明。
