# Windows 链接兼容性修复证据

日期：2026-10-20。环境：Windows 10.0.19045 x64（win32/x64），Node.js v24.13.0，npm 11.6.2，Git Bash。
范围：`qa-autopilot` 控制工具包自身的自检；**不是产品验收**，不代表主项目 130 个用例通过。

## 1 · 首失败（修复前）

命令：`npm test`（`qa-autopilot` 包）。原始日志：`WINDOWS_BEFORE_SELFTEST.log`。

| 项 | 值 |
|---|---|
| 用例总数 | 104 |
| 通过 | 103 |
| 失败 | 1（`tests/core.test.cjs` → `symlink rejected`） |
| 跳过 | 0 |
| 退出码 | 1 |

失败堆栈原文：

```
Error: EPERM: operation not permitted, symlink 'C:\Users\SanQian\AppData\Local\Temp\qa-selftest-Kw39oT\real'
  -> 'C:\Users\SanQian\AppData\Local\Temp\qa-selftest-Kw39oT\link'
  errno: -4048, code: 'EPERM', syscall: 'symlink'
```

## 2 · 根因

失败发生在**夹具创建链接**这一步，而不是在安全校验这一步：`lib/safety.cjs` 的 `noLinks()` 从未被执行到。

- Windows 创建真正的符号链接走 `CreateSymbolicLinkW`，需要 `SeCreateSymbolicLinkPrivilege`。普通用户只有在以管理员运行、或系统开启开发者模式时才有该特权。本机两者都不满足，因此 `fs.symlinkSync(target, link, 'dir')` 直接返回 `EPERM`。Linux 上同一调用无条件成功，所以交付时的 104 通过在 Windows 上必然复现失败。
- Windows 目录联接（junction，mount-point reparse point）**不需要任何特权**，普通用户可直接创建。
- Node 的 `fs.lstatSync()` 对 junction 返回 `isSymbolicLink() === true`（本机实测：`isSymbolicLink = true`、`isDirectory = false`）。`noLinks()` 的判据正是 `must(!s.isSymbolicLink(), 'LINK_REJECTED', ...)`，因此**junction 与符号链接走完全相同的安全判定分支**，不存在"联接绕过检查"的可能。

结论：`lib/safety.cjs` 的生产安全逻辑本身没有缺陷，问题只在测试夹具依赖了 Windows 上需要特权的链接类型。**未修改任何生产代码。**

## 3 · 修改内容

唯一修改文件：`qa-autopilot/tests/core.test.cjs`
（修复后 sha256 `77462f8f06fd036274e1423002833f371ae13cc5b17b51d51a51a5a2b0fa01fd`）

新增测试辅助函数 `createLink(link, target, kind)`：先按请求类型创建链接；仅当类型为 `dir`、平台为 Windows、且错误码为 `EPERM`/`EACCES`（即特权缺失）时，改用 `junction` 重试；其他错误照原样抛出。

| 用例 | 行为 |
|---|---|
| `symlink rejected`（保留） | 仍然**优先尝试真正的目录符号链接**。若操作系统拒绝，断言该拒绝必须来自 Windows 特权缺失（`EPERM`/`EACCES`），随后用 junction 等价夹具继续断言链接被拒绝。被拒绝这一结论在任何情况下都被断言，从不跳过。 |
| `link rejected`（新增） | 用当前系统允许的最强链接验证拒绝机制：Windows 用 junction，其他平台用符号链接。断言三件事：链接被 `lstat` 报告为符号链接、`noLinks` 抛 `LINK_REJECTED`、**穿过链接的子路径**同样被拒绝；另外断言**指向根目录之外的链接**也被判为 `LINK_REJECTED`（不会被解析放行）。 |
| `plain directory is not rejected as a link`（新增） | 反向对照：普通目录必须被 `noLinks` 接受。证明 `LINK_REJECTED` 是链接专属判定，而不是"对什么都抛错"。 |

边界声明：本包**没有删除测试、没有弱化断言、没有默认跳过链接安全验证、没有改变生产安全逻辑**；`lib/safety.cjs` 及其余 lib/scripts/tools 逐字节未改。

## 4 · 修复后结果

命令：`npm test` 与 `node scripts/qa.cjs self-check`。原始日志：`WINDOWS_AFTER_SELFTEST.log`。

| 项 | 修复前 | 修复后 |
|---|---|---|
| 用例总数 | 104 | 106 |
| 通过 | 103 | **106** |
| 失败 | 1（EPERM） | **0** |
| 跳过 | 0 | 0 |
| `npm test` 退出码 | 1 | **0** |
| `node scripts/qa.cjs self-check` | 未执行到 | **PASS，退出码 0** |

链接相关用例单独复跑（`--test-name-pattern="link|symlink"`）：`symlink rejected` ✔、`link rejected` ✔、`plain directory is not rejected as a link` ✔，临时目录残留 0。

## 5 · 交付清单校验

`DELIVERY_MANIFEST.json` 68 个条目中 **67 个哈希一致**；唯一不一致的是 `tests/core.test.cjs`，即本次有意修复的文件。工作区无清单外的多余文件（`config/local.json`、`state/`、`artifacts/`、`.runtime/`、`reports/runs/`、`*.log` 均由 `qa-autopilot/.gitignore` 排除）。

## 6 · 与计划矩阵的关系

`plans/03_TEST_CASE_MATRIX.md` 的 **CLN-003 · 链接逃逸** 要求"owned run 嵌入指向项目外目录的 junction/symlink，dry-run 即拒绝，外部目录内容不变"，`plans/15_ARTIFACT_RETENTION_AND_WINDOWS.md` 也要求"在临时 fixture 单独构造 symlink/junction"。本次修复按此方向把链接夹具落在 junction 上，使该类用例在 Windows 上可被执行。

本次**未**实现 CLN-003 的清理层断言（`cleanupPlan` / `applyCleanup` 遇到内嵌 junction 时的 dry-run 拒绝与外部目录不变）。该用例在测试矩阵中仍是 `NOT_RUN`，属于 130 个产品级用例范围，不在本次 T00 兼容性修复内。

## 7 · 本机限制与后续

- 本机不具备 `SeCreateSymbolicLinkPrivilege`，因此真正的目录符号链接无法在此环境创建。专项用例在有该特权的机器上会走真实符号链接分支；本机走 junction 等价分支，且拒绝断言完全相同。
- 修复只覆盖控制工具自身的自检。**主项目的 CI 尚未运行 `qa-autopilot` 的测试**（`.github/workflows/ci.yml` 目前只跑根包 `npm test`），需在 T02 工具导入阶段单独接线。
- 本次未做任何远程写入、发布、清理或产品代码改动。
