# Bootstrap 提交记录（更正）

本文件更正 bootstrap 提交 `dd652d5befdc6e41710e1346b1db03c4cb442de2` 的 footer 缺陷。

## 缺陷

该提交 footer 的 `QA-Artifact` 行为空（`sha256` 后无哈希值）。原因是提交时对
`qa-autopilot/DELIVERY_MANIFEST.json` 求哈希失败：**交付清单本身不在清单的 `files`
数组内**，因而不会被 `install-control-copy.cjs` 拷贝进 QA clone。

这不是拷贝缺陷，而是清单设计的必然结果：清单不能包含自身的哈希，否则自指矛盾。
清单因此**仅存于中央控制目录** `qa-autopilot/`，不出现在 QA 分支内。

按 `plans/07_GIT_BASELINE_AND_REMOTE_PUSH.md`「已推送问题用独立revert或修复提交保留历史；
不可amend+force」，本更正以独立提交记录，原提交不被改写。

## 更正后的证据

| 项 | 值 |
|---|---|
| bootstrap 提交 | `dd652d5befdc6e41710e1346b1db03c4cb442de2` |
| 父提交（基线） | `c7d5b2bc86b7e51fe6e322999294bb497af1808c`（5.0.24） |
| 基准 tag | `qa-baseline-20261020`（annotated，非 `v*`，不触发发布工作流） |
| 分支内制品 | `qa-autopilot/reports/branches/BACKUP_VERIFICATION.md` sha256 `a32fa5ef3d4b9afe08481358cfe9fafc62fa9872d0cc705591e58a13df091407` |
| 中央交付清单 | `qa-autopilot/DELIVERY_MANIFEST.json` sha256 `14dea66b55901567b9984a31b21ec58e5eda429a4c1e8a49716d48304321f344`（78/78 项哈希自洽） |
| CI 运行 | `39577352960`（`qa/continuous-repair-20261020` @ `dd652d5`） |

## 提交范围

69 个文件，全部位于 `qa-autopilot/`；**产品源码零改动**。无 release tag、无 npm publish、
无 GitHub 默认分支变更。

## 自检

`qa-autopilot` `npm test`：106 通过 / 0 失败 / 0 跳过（退出码 0）；
`node scripts/qa.cjs self-check`：PASS（退出码 0）。
