# RELEASE 5.0.25 PUBLISH 通道（2026-10-24）

状态：发布通道源码与离线验证已交付，**未执行任何发布动作**。本页属于
P-RELEASE-PUBLISH-5025 独占路径；未 publish、未 trigger、未打 tag、未改版本。
版本推进、tag、workflow_dispatch、正式替换全部由 Leader 决定与执行
（执行序仍按 docs/plans/RELEASE-5.0.25-PREFLIGHT-2026-10-23.md 的 D1–D7 DAG）。

## 1. 身份结论（PUB-A 审计结果，本设计的依据）

- registry 全量历史：core 5.0.18/5.0.21/5.0.24 与 desktop 5.0.18/5.0.18-rc.1
  的**所有** stable 发布都是手工 npm publish（_npmUser = yinglongxu），无 attestation。
- 唯一的 CI OIDC 身份 = `.github/workflows/publish.yml` + GitHub environment
  `npm-rc-gate`（2026-09-20/21 绿跑，v4.5.0–4.7.0 候选期）。
- npm trusted publisher 的绑定三元组是 仓库 + workflow 文件路径 + environment，
  **与触发方式无关** → 在同一文件里加 `workflow_dispatch` stable 入口即可复用
  core 包的既有可信身份，不需要任何新 secret / 新凭据 / 新付费。
- 仓库 SanQianX/project-knowledge-base 是 public → `--provenance` 可用。
- npm 11（`npm install -g npm@11`）承载 OIDC publish；setup-node 不设
  registry-url（默认 npmrc 是 OIDC 必需，空 _authToken 会压制 OIDC）。

## 2. 交付的最小 diff（全部只动本 lane 独占路径）

`.github/workflows/publish.yml`（+104/−4）：

- RC 通道原样保留（qa-rc/* push → next），仅 job `if` 增加
  `github.event_name == 'push'`，使 dispatch 不再误入 RC job。
- 新增 `workflow_dispatch` inputs：`version`（精确 x.y.z）、`sha`（40 位十六进制）。
- 新增 `stable-core` job：checkout 精确 `inputs.sha`（fetch-depth 0）→
  guard `core-pre` → npm ci → release:verify → sync-release-version `--check`
  （全量口径，非 RC 的 --web-only）→ npm test → npm@11 → pack 一次 →
  guard `core-pack` 审计 tarball → `npm publish <tarball> --tag latest
  --access public --provenance` → guard `core-post` 回执对照 → 工件上传。
- 新增 `stable-desktop` job（needs stable-core 成功才跑）：checkout 同 SHA →
  guard `desktop-pre` → `npm ci --prefix desktop`（**不带** --omit=optional，
  预检 §4 结论）→ `npm test --prefix desktop` → npm@11 → guard
  `desktop-pack`（先暂存薄壳再 pack，desktop/ 目录本身含 out/ 等 GB 级
  构建产物且无 files 白名单，绝不能直接 pack）→ 同一 tarball
  `--tag latest --provenance` → guard `desktop-post` 回执。
- 两个 stable job：environment 仍是 `npm-rc-gate`（身份复用）、permissions
  contents:read + id-token:write、独立 concurrency
  `npm-project-knowledge-stable`（不阻塞 RC 线）。
- registry.cjs tagCandidate 的四项文件断言全部保持：含 `qa-rc/*`、含
  `--tag next`、含 `RC_ONLY_DURING_QA`、不含版本 tag push 触发字面量
  （stable 入口是 dispatch-only，不是 tag 触发）。

`qa-autopilot/tools/release-stable-5025-guard.cjs`（新增）：
决策核心全部是纯函数（离线可测），CLI 包装只采集输入（git / registry fetch /
文件）后调用；与 ci-rc-guard 同构的 pre/pack/post 三段 + core/desktop 两包。

- `checkCoreCandidate`：CI_IDENTITY（仅本仓 workflow_dispatch）、VERSION_SEMVER
  （拒绝 rc）、SHA_FORMAT、PACKAGE_NAME、VERSION_INPUT、SHA_MATCH（HEAD==
  输入 SHA）、TAG_MISSING / TAG_MOVED（refs/tags/vX 必须已指向该 SHA，之后
  不得移动）、NOT_ON_MAIN、DIRTY_TREE、THREE_SYNC（root/desktop/pin 三同步）、
  VERSION_EXISTS（registry 不可变性）。
- `checkDesktopCandidate`：CI_IDENTITY、VERSION_SEMVER、PACKAGE_NAME、
  VERSION_INPUT、DESKTOP_PIN、CORE_MISSING（core 同版本必须先 live）、
  VERSION_EXISTS。
- `checkPack`：PACK_ID、TARBALL_NAME、TARBALL_MISSING、TARBALL_INTEGRITY
  （磁盘 tarball sha512 与 pack 清单一致）、PACK_REQUIRED（desktop 薄壳文件下限）、
  PACK_FORBIDDEN（out/、node_modules/、test/、scripts/、lockfile、
  qa-autopilot/、.git、.env、ai-profiles、credentials）。
- `checkReceipt`：NO_RECEIPT、RECEIPT_NAME、RECEIPT_VERSION、INTEGRITY
  （registry 回执 sha512 == 已审计 tarball）、LATEST_NOT_MOVED（latest 必须
  变成本版）、NEXT_CHANGED（stable 发布不得动 next）。
- core-pack 复用 registry.cjs `validatePack`（核心包运行时文件契约与 RC 同源）。

`publish-desktop-npm.yml` **未创建**：desktop npm 发布以 stable-desktop job
链在同一 publish.yml 内完成，少一个身份面；确需拆分时再立项。

## 3. 离线验证（本机 Windows 10 + Node 24.13.0，2026-10-24 实跑）

| 命令 | 退出 | 结果 |
|---|---|---|
| `node qa-autopilot/tools/release-stable-5025-guard-test.cjs` | 0 | 25/25：正例 + 全部契约负例（错 channel/repo、rc 版本、版本错位、短 SHA、HEAD 错位、tag 缺失/移动、不在 main、脏树、三同步失配、pin 失配、core 未 live、版本已存在、错包、多包/空包、坏文件名、tarball 缺失/摘要不符、必备文件缺失、out/node_modules/test/lockfile/qa-autopilot/.git/.env/ai-profiles/credentials 泄漏、无回执、回结名/版本/integrity 不符、latest 未移动、next 被动过；外加 CLI 在无 GITHUB_REPOSITORY/RUNNER_TEMP 环境下拒跑，exit 2 + CI_IDENTITY） |
| `python -c "yaml.safe_load(publish.yml)"` + 结构断言 | 0 | 双触发、双输入、三 job、if/environment/needs、step 序列全部符合设计 |
| registry.cjs 四项文件断言模拟 | 0 | qa-rc/* ✔、--tag next ✔、RC_ONLY_DURING_QA ✔、版本 tag 字面量不存在 ✔；`--tag latest` 恰好 2 处（core+desktop） |
| `node --check` 两工具 | 0 | 语法通过 |

测试写法说明：`firstProblem` 会急切求值所有 `when`，shape（PACK_ID/
TARBALL_NAME、NO_RECEIPT）先单独成段再解引用——这本身是被负例先抓出来的
真实缺陷（空 pack 列表 / 无回执曾抛 TypeError），已修并由负例锁死。

## 4. 唯一需要人类操作的具体项

**@sanqianx/project-knowledge-desktop 在 npm 上没有 trusted publisher 记录**
（历史上从未 CI 发布过，全是手工）。stable-desktop job 的 OIDC publish 要
成功，需要包 owner（yinglongxu）在 npmjs.com → desktop 包 → Settings →
Trusted Publisher 增加一条：

- Repository: `SanQianX/project-knowledge-base`
- Workflow filename: `.github/workflows/publish.yml`
- Environment: `npm-rc-gate`

（core 包的同等绑定已因 9 月绿跑存在，无需动作。）若 Leader 不愿登记，
替代方案是 desktop 仍走手工 `npm publish`（用 guard 的 desktop-pre/pack/post
做本地同口径校验），core 走 CI——二选一，都是策略决策，本 lane 不代答。

除此之外没有任何需要配置的 secret / token / 付费项：环境 `npm-rc-gate` 与
其保护规则维持原样，不新增、不绕过。

## 5. 未执行（如实）

- 任何 npm publish / dist-tag 变更 / git tag / workflow_dispatch 触发。
- desktop-release.yml 的运行（前序预检已交付未触发，本 lane 未动它）。
- registry.cjs tagCandidate 的完整 RC 现场流程（本 lane 只静态核对了它对
  publish.yml 的四项断言；RC 流程本身没变，不需要重跑）。
- GitHub Actions 对新 YAML 的真实解析（本机 yaml.safe_load + 结构断言通过；
  首次 dispatch 前建议 Leader 在 Actions 页确认三个 job 都出现且 RC job
  在 dispatch 下显示 skipped）。
- 离线测试未覆盖网络路径（meta/distTag 的 registry fetch、core-post 12×10s
  轮询）：这些只在 CI 里走到，失败即 fail-closed 退出。

## 6. Leader 执行序（发布日）

1. 按 PREFLIGHT 文档完成 D1–D4（engine/workbench/console 发布 + core 5.0.25
   三同步 commit 上 main，CI 绿）。
2. `git tag v5.0.25 <SHA> && git push origin v5.0.25`（tag 先行，guard 要求
   tag 已指向该 SHA；tag 一经推送不得移动）。
3. 决定 §4 的 desktop 身份问题（登记 trusted publisher 或选手工路径）。
4. Actions → “Publish QA candidate or approved stable” → Run workflow →
   输入 version=5.0.25、sha=<40 位>。
5. 验收 stable-core-receipt / stable-desktop-receipt 工件：
   PUBLISHED_VERIFIED + integrity；`npm view` 双包 latest=5.0.25。
6. 之后接 PREFLIGHT §6 的桌面正式替换（D7）。
