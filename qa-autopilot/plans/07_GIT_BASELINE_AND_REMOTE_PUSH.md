# 07 · 基准、隔离clone、远程提交及回退

## 初始基准

T00审计原项目HEAD、origin/main、工作区diff。当前参考SHA只是审查锚点，执行前重新比较；不能偷偷更新用户代码或冻结错误目录。

本包baseline默认只生成dry-run。有原生用户未提交修改或本地/远程不同则阻断，保存只读差异并决定要测哪个已提交版本。不能reset/stash；tag不含未提交内容，此项明确告知。

批准后在中央QA `.runtime/workspaces/repair` 创建本地非硬链接clone，Git模板/用户目录隔离，origin设回精确仓库。原生产Hook不复制；控制端自身commit/tag/push使用该clone的空Hook目录覆盖全局core.hooksPath，防止误触生产维护；产品Hook测试只在独立Git fixture真实安装运行，不能因此被全局禁用；不建立指向原node_modules的junction。创建QA分支、非v基准annotated tag，并一次atomic push后ls-remote核对tag解引用和branch都等于基准SHA。

已有工作目录或远程refs时不覆盖，进入恢复核对。remote不支持atomic时此工具报错；需经审查单独执行并补双ref核对，不默认降级。

## Bootstrap例外

QA工具拷贝、发布工作流保护、最初测试接线属于独立chore/test任务，不是假Bug。先用 `install-control-copy.cjs` dry-run，校验交付manifest，只拷脚本/计划/例子，排除delivery日志/本地状态。人工/控制端审查精确文件清单后提交并push；CI只从审查后的远程QA分支读取。

中央控制器本身不随修复模型任意升级；修改中央工具要先独立评审、跑自检、重新建立信任和hash。单纯在源码副本里修改控制文件并不应该影响正在运行的中央门禁。

## 单Bug事务

工具 `commit-push`要求：QA分支/精确origin；实际工作文件全在合同allowlist；无预先暂存；无secret/生成数据；非空、大小有界；受保护文件额外审批；真实suite receipt PASS/非零测试/无skip/flaky/timeout，HEAD、fingerprint、contractHash完全一致。

先记录INTENT→精确git add→diffcheck及暂存集合核对→commit（附QA证据footer）→非force指定QA ref push→ls-remote验证→记录PUSHED_CI_PENDING→同SHA CI必需Linux22/24和Windowsjob成功才DONE。

命令：
```powershell
node scripts/qa.cjs commit-push --contract config/tasks/QA-001.json --receipt artifacts/<真实run>/receipt.json
```
先审查dry-run；本地配置权限完整才可加--apply。路径中的<真实run>必须从实际返回receiptPath获取，不是字面值。

门禁不会只检查已追踪git diff；新增untracked允许文件也要扫描凭据。启用凭据安全扫描只能降低风险，不能自动证明没有所有秘密。对二进制/公共API/存储变化提高审批等级，不把大文件移出allowlist绕过。

## Push/CI中断

INTENT已存在时不得重试commit。读取本地HEAD/parent/footer、remote QA head、原fingerprint和操作日志。
- 本地无提交且工作区保持原状态：批准后恢复当前事务。
- 已本地提交、远程还是parent：验证该提交后只补push。
- 远程已为本次SHA：标已推，查CI，不再提交。
- 远程其它SHA：阻断，不能自动merge/rebase/force。
- tag已存在：验证解引用，不移动。

CI要匹配本次完整SHA、QA branch、workflow路径、push事件和全部必需job。被新push取消、未运行、skipped、旧SHA绿色都不通过。等待当前CI结束后再推下一任务，避免cancel-in-progress让每个bug没有真实远程验收。

## 回退

已推送问题用独立revert或修复提交保留历史；不可amend+force。恢复用户数据不能仅靠Git，若曾有schema/数据变更，需预先设计独立备份/逆操作，因此本自动循环默认禁止这类变更。

基准tag是最后安全比较点，不意味着要把整仓强制reset回去。可用新隔离clone安装旧固定版本比较，保持原用户工作区和生产服务不动。
