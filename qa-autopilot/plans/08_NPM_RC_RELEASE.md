# 08 · 真实next候选、制品证据与稳定版保护

## 发布通道

当前工作流v*无明确候选隔离，T04之前禁止推v/rc发布标签。包内 `templates/publish.rc-only.yml` 是待审核替换模板，安装为 `.github/workflows/publish.yml`，整个QA期间只接收 `qa-rc/x.y.z-rc.n`。无stable触发、无latest写命令。基准tag `qa-baseline-*`不触发。

选择同文件名是减少OIDC身份变化，不代表不需要核对：模板加入受保护环境 `npm-rc-gate`，npm Trusted Publisher配置必须匹配仓库/文件/环境。管理员设置独立reviewer、禁止自行审批、受保护tag/工作流权限后再用；不能让模型自己修改workflow解除审批。OIDC身份本身不自动限制dist-tag，因此“next-only”必须由代码保护及独立审批共同保证。

模板沿用现有Node24及npm11大版本，运行记录确切CLI版本；现场选择审查过的确切版本以获得更强可复现性。旧runbook关于npm12或registry-url的经验不是永久官方合同，按现行官方文档和真实身份探针验证。

## 准备候选

读官方Registry现有版本，选择尚未存在且递增RC。每Bug都push，但不是每Bug都publish。阶段性修复/清理通过L4后，版本元数据、锁文件、插件清单、runtime/vendor manifest同步，独立release准备提交；针对这个最终SHA重新验收，避免测试发生在改版本前。

`qa rc-plan`要求源码clean、remoteQA HEAD匹配、CI通过、六类发布证据（unitIntegration、realE2E、visual、performance、faultRecovery、pack）都属于同HEAD/fingerprint，且有独立reviewedBy和文件hash。模板 `rc-acceptance.example.json`没有通过凭证，不能直接改几个PASS使用。

真实E2E凭证须mode=REAL_PRODUCT、realModel=true。browser-shell的REAL_BROWSER_SHELL_MOCK_MODULES明确不能满足。证据可信性靠控制端权限和独立复核，手工JSON字段本身不具有可信执行证明。

## 发布事务

1. dry-run生成固定version/SHA/tag/next/latestBefore计划。
2. 控制端核对门禁及Publisher授权后，只推精确候选tag；记录INTENT与解引用SHA。
3. GitHub受保护环境审查：本次SHA、证据、latestBefore、模块版本。
4. CI再跑release:verify、原生全suite；pack一次生成tgz并审查文件列表，发布**同一tgz**，显式 `--tag next --provenance --access public`。
5. 查询官方Registry核对固定version、integrity与tgz一致、next指向候选、latest未被本轮改变。存在传播延迟时有界读取重试，不重复publish。
6. 发布完成状态为PUBLISHED_NOT_INSTALLED；继续安装验收后才能标候选通过。

发布未知、同版已存在、tag存在不移动也不重新覆盖；查工作流、Registry和intent对账。候选失败发新rc，必要时经过批准将next指向先前通过候选；本包没有自动dist-tag回退按钮。

## 真正的隔离安装

`rc-install`工具从官方源读**固定RC版本**而非移动next。新建owned目录、全新npm缓存、本地prefix：
```text
node <实际npm-cli.js> install --prefix <owned-prefix> --registry=https://registry.npmjs.org --save-exact @sanqianx/project-knowledge@<固定RC> --no-audit --no-fund
```
不执行global安装，不改用户默认registry，不复用本地TGZ/兄弟源码。安装生命周期可能运行代码，必须在受限QA环境批准后进行，不能因“官方源”就无限制信任依赖脚本。

读取prefix package-lock的resolved、integrity、version及已安装package.json；运行时从**这个安装目录**启动，并保存源SHA/模块manifest/真实PID和dataRoot身份。检查runtime:verify/release:verify适用于安装制品的真实命令，不能要求包中未发布的开发脚本存在而误判产品。

随后：CLI→四模块health→实际浏览器→真实模型→Git提交知识闭环→检索→恢复→既定性能。固定安装版没有的源测试工具由中央QA在外部调用，而不是拷入安装目录改制品。安装工具输出INSTALLED_NOT_RUNTIME_VALIDATED正是提醒还有后续验收。

## 最终稳定发布

latest在整个测试周期保持不由QA自动修改。两轮同RC验收通过，P0/P1归零、P2/P3签收、证据完整后只READY_FOR_STABLE_APPROVAL。用户明确授权后另建稳定发布合同：正式版本不是rc重新标latest，版本转换影响的制品仍需最终核验。此包故意不提供stable命令。
