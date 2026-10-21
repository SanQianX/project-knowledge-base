# 11 · 检查点、事务恢复与副作用幂等

## 存储原语

Store使用文件锁、revision CAS、先追加journal后原子checkpoint；journal记录前状态hash。state.lock不按年龄自动删除。恢复只按连续revision/hash重放**本地状态**，不会重做Git/npm外部副作用：
```powershell
node scripts/qa.cjs recover-state --config config/local.json
```
进程/断电可能发生在journal与checkpoint之间，该命令可恢复已落盘状态；journal缺口或hash不符拒绝。Windows文件替换/持久性必须本机验证，Linux自检不是Windows断电保证。

## 状态字段

source：原基准SHA、当前QA parent、fingerprint；task：ID、合同hash、阶段、attempt、allowedFiles；test：首失败/复测路径、退出码、fixture/environment；remote：目标ref、已确认SHA、CI run/job；release：固定version、tag、tgz integrity、latestBefore、registry receipt；quota：采样时刻、字段来源、恢复计数；process：broker身份/PID/创建时刻/工作目录；恢复动作只有一个明确的nextStep。

核心状态INITIALIZING、BASELINE_VERIFYING、DISCOVERING、REPRODUCING、TRIAGING、FIXING、VERIFYING、COMMITTING、PUSHING、CI_VERIFYING、REGRESSION_TESTING、CODE_CLEANUP、CLEANUP_VERIFYING、RC_PREPARING、RC_PUBLISHING、RC_VALIDATING、PAUSING、PAUSED_QUOTA、RESUMING、BLOCKED、READY_FOR_STABLE_APPROVAL。图中没有自动stable状态。

Store和supervisor的任务状态采用不同职责文件，不能人工把phase改DONE跳过实际gate。operator恢复动作也需要记录原因、原值和实际证据。

## 恢复矩阵

| 中断点 | 必查事实 | 下一步 |
|---|---|---|
| Agent正在改代码 | broker/PID身份、实际diff、测试文件是否变动 | 能证明安全pause则用同task checkpoint继续；否则BLOCKED_AGENT |
| 配额安全退出75 | taskID、protocol、safe boundary、parent、fingerprint | 新鲜额度达门限后继续同任务，不重新造Bug |
| 本地commit返回丢失 | HEAD/parent/footer和INTENT | 确认已commit则只补远程操作 |
| push返回丢失 | ls-remote完整SHA与local HEAD | 相同则查CI，不再commit/push盲重试 |
| CI尚运行/取消 | 本次SHA+branch+workflow+所有jobs | 等待或失败处理；旧绿job不可代替 |
| RC tag已推发布未知 | tag解引用、workflow和Registry版本 | 查到相同integrity才确认；否则阻断不移动tag |
| npm install中断 | prefix归属、npm进程、package-lock及runtime文件 | 不复用不完整receipt；保留首次失败，新run新prefix |
| 清理中断 | 已删除清单、剩余文件、owner和活跃进程 | 重新dry-run并审批；不沿用旧清单无限删除 |
| 机器重启残留锁 | PID可能复用，必须核对创建时刻/broker与目录 | 由OS监督证明旧进程结束后恢复，不按mtime删锁 |

## 并发与退出

控制器单实例、Git写锁、测试锁、RC发布GitHub concurrency不取消在途发布。清理窗口与worker/test/commit互斥。工作时间长不代表失控；根据心跳、进程、工具活动和批准任务期限判断。

runLogged有超时与有界输出，超时先停止其直接子进程；无法确认孙进程结束时返回未确认进程树，不自动清理该run。完整Windows Job Object/broker生命周期须T03现场实现/验收。缺该能力时安全停止比冒称全自动恢复更重要。

## 恢复测试的真实等级

本包已用本地fixture验证journal缺口恢复及受控假worker两次quota暂停续跑；没有真实Windows重启、真实MiniMax CLI session恢复或GitHub/npm断线写入实验。后者按本章矩阵在本机专用fixture验证，不能转写成已通过。
