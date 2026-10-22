# 本次交付验证记录

日期：2026-10-20。制作环境：Linux，Node.js v22.16.0，npm 10.9.2。

## 已经实际完成

| 验证 | 结果 | 证据 |
|---|---|---|
| 工具行为自检最终轮 | **104通过，0失败，0跳过** | FINAL_SELFTEST.log |
| Windows本机链接兼容性修复 | **106通过，0失败，0跳过**；self-check PASS，退出码0 | WINDOWS_SYMLINK_COMPATIBILITY.md |
| 首轮/增补回归 | 98→103→104，均无失败/跳过 | FIRST/SECOND/THIRD_SELFTEST.log |
| JavaScript语法 | 19个.cjs文件全部通过node --check | 本次命令实际运行 |
| 配置JSON | self-check通过 | CONFIG_CHECK.json |
| CLI命令入口 | help可运行 | CLI_HELP.json |
| 130case规格 | ID唯一、结构完整、初始全部NOT_RUN | STATIC_CHECK.json |
| RC YAML | 语法及只触发qa-rc/*通过 | STATIC_CHECK.json |
| 默认权限 | 写仓库/发布/安装/删除/worker接线均关闭 | config/local.example.json |
| npm控制工具锁文件 | 离线生成，无第三方运行依赖 | package-lock.json |
| 代码格式 | 作者环境使用TypeScript 5.8.3 AST printer，格式化后重跑全部104测试 | FINAL_SELFTEST.log |

额度相关自检使用本地合成JSON与上游HTTP替身；“配额保护测试通过”不代表读到了你的真实余额。假worker按pause75协议两次恢复，真实本地Git HEAD保持不变，证明该原语避免额外提交；不等于已经验收真实Agent会话和Windows重启。

2026-10-20 在 Windows 本机补做控制包自检：原始 104 用例中 `symlink rejected` 因 Windows 创建符号链接缺少特权而返回 EPERM 失败 1 项，改用目录联接验证同一拒绝机制后 106 用例全部通过、self-check 通过。该结果只覆盖控制工具自检，不覆盖产品功能，详见 `WINDOWS_SYMLINK_COMPATIBILITY.md`。

Git测试实际使用临时本地仓验证指纹和隔离Hook，未向你的GitHub写入。PNG测试对合成图验证编解码/像素差异，未为产品生成批准截图。

制作时一次语法检查因命令工作目录错误返回MODULE_NOT_FOUND；切回正确QA目录后对全部19个文件重检通过。此环境错误不计为产品缺陷，也没有被写成产品测试成功。

## 没有执行，必须在你本机验证

- Windows `D:\SanQian.Xu\project-knowledge-base`及未提交改动。
- 完整主项目npm测试、真实浏览器产品测试、四模块E2E。
- 0.13.6同版本Workbench完整源码匹配与独立宿主。
- 真实MiniMax订阅quota/schema/周权益、真实worker调用与自动恢复。
- 原生Claude/Codex/OpenCode/ZCode、权限弹窗、Windows文件夹选择。
- 机器重启、受限Windows账户/Job/broker/网络隔离。
- GitHub基准tag、QA分支、逐Bugpush、CI与断线副作用对账。
- npm publisher授权、RC发布、真实官方候选下载与运行。
- 真实UI截图基线、性能/压力/soak及内存泄漏指标。
- 删除任何业务源码、用户数据或生产中间文件。

## 交付结论

**允许开始T00只读审计和T01–T06分阶段实施；不能直接宣称无人值守已就绪或130个产品用例已通过。**

完整计划、控制原语、可运行工具、模板及本包自检已交付。现场适配与真实验收是开发包明确要求MiniMax执行的任务，不隐瞒为已完成。任何缺失能力必须保持BLOCKED，不能把配置true、Agent回答或模板PASS当作真实证据。

没有对远程main/QA分支、npm next/latest、你的原工作区或真实账户执行写操作。
