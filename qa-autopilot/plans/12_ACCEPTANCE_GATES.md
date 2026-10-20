# 12 · 门禁、证据和完成定义

## 证据等级

SOURCE_OBSERVED：读到源码/文档，不是执行。
SELFTEST_PASS：本包工具在当前Linux/Node环境测试通过。
REAL_BROWSER_SHELL_MOCK_MODULES：实际浏览器与外壳、模块替身。
REAL_PRODUCT：四模块/真实模型等定义范围实跑。
RC_INSTALL：官方固定制品安装receipt。
RC_RUNTIME：该安装制品的实际业务验收。
NOT_RUN/BLOCKED/FAIL/FLAKY：均不是PASS，也不折算通过率。

状态/结果只能由控制端真实进程与断言产生。保存raw exit code、时间、环境、完整SHA/fingerprint/模块版本、测试数量、skip、首失败与复测。不是Agent回答“完成”后写PASS。避免把日志中的正常字符串skip误归为环境跳过：初版runner保守匹配，若误报需要审查实际test协议并改解析器/补反例，不删除业务测试。

## 分层门禁

G0 基准和数据安全：原目录不变、隔离目录身份和远程基准确认。
G1 单问题：真实反例、task合同、最小diff、目标测试非空且通过。
G2 影响域：模块+上下游测试，相关真实UI路径/数据状态通过。
G3 远程：精确QA push已确认，同SHA必需CI全部成功。
G4 全产品：130矩阵适用项逐case证据、四模块/原生客户端必要矩阵、没有未解释flaky。
G5 候选：版本与manifest、pack、发布身份、完整gate、官方固定RC下载和运行。
G6 收敛：最终相同制品两轮重要路径无新可复现缺陷；P0/P1零；P2/P3风险明确签收；性能/视觉已批准；无隐藏未测高风险。
G7 稳定审批：仅READY_FOR_STABLE_APPROVAL，由用户另行授权。

已证明非本版功能可N/A，但必须附同版本源码/合同理由和独立审核。不能用“很难测”“没有工具”“模型额度不足”作为N/A；这些是BLOCKED。

## 候选证据集合

模板rc-acceptance中的6项分别引用真实控制端JSON文件和SHA256。每个文件都需包含status PASS、head、fingerprint；realE2E还需mode REAL_PRODUCT和realModel true。其它质量项应增加实际sample/cases/environment/thresholdReviewedBy，不能仅凭这些最小字段获取可信性。OS与独立reviewer保证文件没有被测试模型篡改。

源码或版本元数据变化使旧fingerprint失效；不要为了重用旧通过记录从fingerprint中随意排除变化文件。可对纯发布说明使用明确版本化证据映射，但必须独立批准，不由模型自动判断“没影响”。

## 最终报告结构

基准与最终SHA/RC/SRI；真实执行case数；每种mode通过/失败/阻断/未测数；按P0–P3问题及对应远程commit/CI；UI差异与批准者；原始性能样本和阈值；原生客户端/真实模型覆盖；清理项与保留理由；额度暂停/恢复次数与异常；数据保护验证；可回退步骤；未完成项；稳定版是否获用户明确授权。

`qa report`目前仅汇总本地suite receipts并提醒它不证明全部case，不生成虚假READY。最终矩阵审核由T13完成，证据不足则NOT_READY。
