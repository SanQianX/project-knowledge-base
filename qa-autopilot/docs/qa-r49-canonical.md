# R49 canonical 工具使用说明（SYS-003 真实留空补证）

> P-PROFILE-CANONICAL-SAFETY-R49B 交付。本工具是 R49 SYS-003 证据线的唯一
> 受认可入口。产品语义证据（5/5 expected PASS、逐制品 SHA256）见
> `qa-autopilot/artifacts/parallel-20261023/profile-blank-real-r49/report.json`
> （已冻结，勿覆写）；本文件只描述工具本身。

## 组成

| 文件 | 角色 |
| --- | --- |
| `qa-autopilot/tools/product-probes/qa-r49-run.cjs` | wrapper：`--check` / `--run` |
| `_site/_test/qa-r49-sys003-real-blank-probe.js` | driver（hash 冻结：`2834a455…`，`--check` 校验） |
| `_site/_test/helpers/qa-r49-wb-host.js` | 真实 WB host（hash 冻结：`6bcb6d63…`） |
| `desktop/test/slow-startup-env.cjs`（tracked） | 完整隔离 harness（createHarness） |
| `_site/_test/helpers/cdp-browser.js`、`find-chrome.js`（tracked） | 真实表单驱动 |

依赖闭包全部为 tracked 文件或上述 lane 自有文件；`--check` 会逐项核验。

## 用法

```bash
# 默认模式：零服务/零浏览器/零模型，纯静态核验（16 项）
node qa-autopilot/tools/product-probes/qa-r49-run.cjs --check

# 显式运行（虚构 Key 的真实表单测试；每次写入唯一 run 子目录，不覆盖历史）
node qa-autopilot/tools/product-probes/qa-r49-run.cjs --run \
  [--driver <probe.js>] [--runs-root <dir>] [--child-timeout-ms <n>]
```

`--check` 核验：四文件存在与语法、三源码无进程表扫描/广杀 token、probe/host
hash 与冻结值一致、require 闭包 tracked/lane-owned。运行期 pin 的模块文件
（`path.join(moduleRoot, …)`）由 driver 自身 identity 段在执行时逐文件 hash
核验，不属静态闭包。

`--run` 每次生成 `runs/run-<UTC时间戳>-<随机>/`（含 `run-log.json`、
`driver-stdout.txt`、`driver-stderr.txt`、`evidence/`）；lane 根部的旧
`run-log.json` 与 `evidence/sys003-real-blank/` 是冻结历史，永不写入。

## 进程安全契约

- wrapper 内**不存在任何进程表扫描或按名称/前缀的批量杀进程**（`--check`
  safety-scan 强制为 0 命中）。
- 正常路径只等待自己 spawn 的 child 自然退出；超时强停**仅限该精确 PID**
  （`child.kill()`），run-log 记录完整归属证据：pid / parentPid / argv /
  spawnAt / runRoot。
- 平台事实（Windows + Node 24，R49B 实证）：对该 PID 的单点 kill 会经 OS
  job 对象连带终止其**非 detached** 后代——影响范围仍严格限于 wrapper 自己
  spawn 的子树；detached 后代与子树外任何进程不受影响（R49B 控制测试以
  detached grandchild + 子树外旁观进程双负例证明）。
- 残留进程/未删目录**只报告不强清**：`cleanup.status` 逐值区分
  `removed` / `blocked-residue-reported` / `retained-failure-evidence` /
  `retained-blocked-cleanup`；产品断言（`product.driverExitZero`）与
  cleanup 状态是**分开的门**，runRoot 删除不是用例通过的前提；失败证据
  永不强删。

## 边界（fake-only）

- 测试内全部 profile/credential 为**虚构值**（`r49-fake-*` / `.invalid`
  保留域端点）；绝不打开真实 profiles / 真实 Key / 真实 HOME。
- 模型 / embedding / quota / 公网请求恒为 0；不点测试连接/额度；不触达
  真实端口 5757/5760/5790/8787/8790（host 仅监听 127.0.0.1 临时端口）。
- 真实 home 面仅做 stat-only 快照（不读内容）。
- 产品源码（node_modules 内 WB 0.13.9 字节）只读，不补丁、不重装。
- 路径全部由 `__dirname` / 参数推导，可移植，无本机盘符硬编码。

## 入口纪律

driver/控制入口均带 `-probe` / 显式 run 后缀，不会被默认 CI
（`run-all-tests.js` 只收 `*-test.js`）自动拉起。R49B 控制测试位于
`qa-autopilot/artifacts/parallel-20261023/profile-canonical-safety-r49b/tooling/`
（ignored，不属于产品测试套件）。
