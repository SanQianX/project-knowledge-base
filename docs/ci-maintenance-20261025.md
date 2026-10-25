# CI 维护记录 2026-10-25

背景：`_site/_test/glm-ui-refresh-review-test.js` 最初是 2026-10-15 前后为
docs/plans/ui-refresh-electron-plan-2026-10-13.md 做的「基线 vs 当前」对比实验：
它用 `git show 55e1627…` 读历史版本的 `ui/product.js`，在独立 VM loader 里跑
9 个 baseline gate，并汇总首失败证据。该实验已结束，不应继续混在日常回归里。

## 变更 1：glm-ui-refresh-review-test.js 转为 current-only 回归

移除（均已随 Git 9ddf0db 保留，可复原）：

- `BASELINE_COMMIT`（55e1627…）、全历史 `git show` 基线源读取、VM head loader
  （`headSource` / `headModuleCache` / `loadHeadModule`）。
- 9 个 baseline gate：A1、B1、C1、C2、C3、C7、C8、D1、D2，及其首失败汇总输出。
- 退出谓词陷阱：原 `regressions.length || baseline.some(g => g.ok) ? 1 : 0`
  在基线「预期失败却通过」时会把整场判负——只在全历史 clone 上生效，CI 浅克隆
  （fetch-depth=1）根本不跑 baseline，属双输逻辑。现改为
  `process.exitCode = failed.length ? 1 : 0;`（仅 current 失败判负）。
- 临时数据落点：原 `TEMP_DATA` 改为 `os.tmpdir()` 下本用例独占的
  `fs.mkdtempSync(..., 'glm-ui-refresh-current-')`，不再写仓库目录或真实 home。

保留（逐项，gate 名/断言/阈值逐字未动）：全部 14 个 current gate 与原 CI 浅克隆
实际执行的那组完全一致——

| 分组 | 保留 gate | 阈值/要点 |
| --- | --- | --- |
| A 首屏 | A2（projects 读取挂起时健康区仍渲染）、A3（全快控制场景 `系统连接正常`） | 2.5s 观察 |
| B 慢模块 | B2（aggregatedProjects ≤3500ms）、B3（registry 脊柱保留）、B4（modulesHealth ≤2500ms） | 3500 / 2500ms |
| C 引擎接管 | C4（坏项目不阻塞好项目接线）、C5（ownership 不全局 pending）、C6（engine control 已发） | — |
| C 重复接管 | C9（健康项目不重复注册）、C10（未变配置不重推） | 计数 === 1 |
| D 配置同步 | D3（并发同步合并为一次推送）、D4（未变配置不重推） | 计数 === 1 |
| E SSE | E1（8 客户端 3s 内首事件）、E2（中止 4 客户端恰好释放 4 条上游连接） | 3s / 8→4 |

用于 current 页面部分的 `vm` 沙箱（sectionA）原样保留。

可复原途径：

- Git：`git show 9ddf0db:_site/_test/glm-ui-refresh-review-test.js`（404 行原文件）。
- 仓库外备份：`D:/SanQian.Xu/.project-knowledge-test-temp/ci-cleanup-20261025/glm-ui-refresh-review-test.9ddf0db.bak.js`，
  SHA256 `01dca3f5608c91d5faa05afcf96835dee349fa7bd85b5404266a231876626436`
  （伴随 `.bak.sha256`，`sha256sum -c` 通过；含原首失败 logs/history 输出逻辑的字节级原样副本）。

验证：`node --check` 通过；隔离 env 单次运行 `14/14 gates passed`、exit 0，
gate 数量与原浅克隆 CI 执行的 current 组完全一致；临时目录落在仓库外
temp 根（如 `glm-ui-refresh-current-EkhwZr`）。

## 变更 2：ci.yml push 触发分支 `**` → `main`

`.github/workflows/ci.yml` 仅改 1 行：`push.branches` 由 `'**'` 收窄为 `main`。
此前每个 PR 分支的每次 push 会同时触发 branch-push 与 pull_request 两条完整
矩阵。保留 `pull_request` 触发与全部 job 名（core / core-windows /
qa-controller / qa-controller-windows）、矩阵与功能命令不变。

明确不采用 paths-ignore：文档/README 也可能是包字节，exact-SHA 发布门禁仍需
CI 必跑，不能让 required checks 因路径过滤而永远 pending。

验证：`_site/_test/non-release-ci-test.js` PASS（该 guard 只断言 `push:` 与
`pull_request:` 键存在，不锁定分支列表）。
