# 发布运行手册与故障排查(Release Runbook)

> 依据 2026-09-20 发布 v4.2.18 时的排障实录整理。目标:今后发版按「一、正常流程」执行;
> 出问题时按「三、速查表」定位,不再重复当天的长时间排查。

## 一、正常发版流程

前提:所有改动已合并到 `main`,CHANGELOG 的 `[Unreleased]` 段落已写好,
本地 `npm test` 全绿(当前 115 例)。

1. **定格 CHANGELOG**:把 `## [Unreleased] - <日期>` 改成 `## [x.y.z] - <今天日期>`。
2. **版本同步**(仓库钩子自动跑 `release:verify` 校验,并同步 6 个清单文件:
   desktop/package*.json、两个 plugin.json、marketplace.json、.mcp.json):

   ```
   npm version patch --no-git-tag-version
   ```

   ⚠️ **已踩过的坑**:此模式只暂存同步脚本管理的 6 个文件,`package.json` 和根
   `package-lock.json` 不会进提交,必须手动补:

   ```
   git add CHANGELOG.md package.json package-lock.json
   ```

   漏掉的后果:release 提交里版本号不一致,CI 在 `release:verify` 直接失败
   (症状:`Release version x.y.z is out of sync`)。

3. **提交 + 打 annotated tag**(与历史格式一致):

   ```
   git commit -m "chore(release): x.y.z — <一句话摘要>"
   git tag -a vx.y.z -m "Project Knowledge x.y.z"
   ```

4. **推送**:`git push origin main vx.y.z`
5. `publish.yml` 自动触发:全量校验 → OIDC 认证 → `npm publish --provenance`。
6. **验证**(注意 PUT 返回 202 后 registry 异步处理 1~3 分钟,`latest` 变更会延迟):

   ```
   gh run watch <run-id> --repo SanQianX/project-knowledge-base
   curl -s https://registry.npmjs.org/project-knowledge | jq '."dist-tags"'
   ```

   本机 npm 源是 npmmirror 镜像的话,看到新版本还要再晚几分钟,不是故障。

**全程不需要任何 npm token** —— 认证走 GitHub OIDC(见下节)。

## 二、发布认证架构(2026-09-20 起)

`publish.yml` 使用 npm **Trusted Publishing(OIDC)**:GitHub Actions 每次运行铸造
短时身份,npm registry 用它交换一次性发布凭证,没有可泄露的长期令牌。

依赖三件事,缺一不可:

| # | 依赖 | 现状 |
|---|---|---|
| 1 | workflow 有 `permissions: id-token: write` | ✅ 已配置 |
| 2 | npm **11.x** CLI(工作流里 `npm install -g npm@11` 显式钉住) | ✅ 已配置;npm 12.0.2 实测删掉了 OIDC 流程,不要改成 npm@latest |
| 3 | npmjs.com 包设置里有匹配的 Trusted Publisher 记录 | ✅ 已登记:`SanQianX` / `project-knowledge-base` / `publish.yml` / environment 留空 / 允许 direct publish |

注意:
- **`NPM_TOKEN` secret 已于 2026-09-20 删除**,工作流不再引用任何 secret,不要再加回去。
- workflow 里**不要**给 setup-node 配 `registry-url` —— 它会往 `~/.npmrc` 写一行空的
  `_authToken=${NODE_AUTH_TOKEN}` 占位符,导致 npm 认为已有令牌配置而**跳过 OIDC 自动检测**。
- Trusted Publisher 连接在 npm 网页上**不能编辑,只能删除重建**;保存时 npm 不做校验,
  填错只在发布时暴露(报 "package not found")。

## 三、症状 → 根因 → 处置 速查表

| 症状(CI 日志) | 根因 | 处置 |
|---|---|---|
| `E404 ... could not be found or you do not have permission` | token 无该包写权限;或 OIDC 交换失败被静默吞掉 | 先加 verbose 看真实原因(见「四」) |
| `EOTP This operation requires a one-time password` | npm 2026-07 政策:未开 2FA 绕过的 token 在 CI 直推被要求验证码 | 不要走 token 路线;确认 OIDC 三依赖齐备 |
| `ENEEDAUTH ... requires you to be logged in` | OIDC 交换静默失败,最终无任何凭证(npm 按设计吞掉所有 OIDC 错误) | `--loglevel verbose` 看 `Failed token exchange` 的具体消息 |
| `OIDC token exchange error - package not found` | 包上没有(匹配的)Trusted Publisher 记录 —— 最常见是网页上**根本没保存成功**,或字段不符 | npmjs.com → 包(不是账号)Settings → Trusted publishing → 核对/重建记录,然后 `gh run rerun` |
| `npm login --auth-type=oidc` 报 `invalid config ... Must be one of: legacy, web` 然后挂 5 分钟超时 | 当前 npm(11.19+/12.x)**没有这个命令**,旧教程误导;OIDC 是 `npm publish` 自动做的 | 删掉这个步骤 |
| `PUT 202` + `Your package is being processed` / tarball 短暂 404 / `latest` 未变 | registry 异步处理带 provenance 的包,1~3 分钟延迟 | 等待后重查,不是故障 |
| CI 全量测试 1 例失败(如 `embed protocol wiring must cover sessions and fold`) | 契约测试断言与代码脱节(典型:revert 提交改了行为、漏改测试) | 改测试使其与当前设计一致(本次案例:壳层只读会话投影,archive/restore 只属 terminal 模块);本地 `npm test` 全绿再发 |
| `Release version x.y.z is out of sync` | release 提交漏了 package.json / package-lock.json | 按流程第 2 步的 ⚠️ 补齐重做提交 |
| 改了 workflow 后 rerun 旧运行,行为没变 | tag 触发的工作流用的是 **tag 指向提交里的工作流文件**,rerun 不会用 main 上的新版本 | 移动 tag 到新提交重推(仅在该版本尚未发布到 npm 时安全!):`git tag -d vx.y.z && git tag -a vx.y.z -m "..." && git push origin vx.y.z --force` |

## 四、排障关键手段

- **`npm publish --loglevel verbose`(工作流里已常驻)** —— npm 会静默吞掉所有 OIDC
  失败,只有 verbose 级别能看到真实原因,三种典型输出:
  - `Skipped because incorrect permissions for id-token` → workflow 缺 `id-token: write`
  - `Failed token exchange request with body message: <真实原因>` → npm 侧匹配问题
  - `Successfully retrieved and set token` → 认证已通过,后面再失败就是别的原因
- `gh run view <id> --log-failed | grep "npm error"`:快速取 CI 报错。
- `gh run rerun <id>`:只改了 npm 网页配置(trusted publisher / publishing access)
  时,不需要动代码和 tag,直接 rerun 失败的运行即可。
- 判断 OIDC 链路哪一环断了,看 verbose 里这行的状态码:
  `POST https://registry.npmjs.org/-/npm/v1/oidc/token/exchange/package/project-knowledge`
  - `201` = 交换成功;`404` = 包上没有匹配的 trusted publisher。

## 五、2026-09-20 事故时间线(供追溯)

背景:发 v4.2.18。代码侧先修了一个过期契约测试(revert 5a7a43e 漏改,曾致 CI 1 例失败),
并重做了首个不完整的 release 提交(漏 package.json/package-lock.json 版本号)。

| 尝试 | 结果 | 结论 |
|---|---|---|
| 旧 NPM_TOKEN(6 月设的) | E404 无权限 | 8 月还发过 v4.2.17,变的是 npm 政策不是 token |
| 新建 granular token | EOTP 要验证码 | 新 token 没开 2FA 绕过;CI 无法输验证码 |
| 官方公告 | — | 2026-07-31 起 bypass-2FA token 收紧,2027-01 全面禁直推;官方推荐 Trusted Publishing(OIDC) |
| OIDC + npm 12.0.2 | E404/EOTP/ENEEDAUTH 反复 | npm 12 删了 OIDC 流程 → 钉回 `npm@11` |
| `npm login --auth-type=oidc` | invalid config + 挂起超时 | 此命令不存在于 11.19/12.x,旧教程误导 |
| setup-node 带 `registry-url` | 空 token 占位符抑制 OIDC | 移除 `registry-url` |
| `--loglevel verbose` | 现出真错误 `package not found` | npm 网页上 trusted publisher 记录没保存成功 |
| 用户重建 trusted publisher 记录后 rerun | ✅ 201 → PUT 202 → `+ project-knowledge@4.2.18` | 发布成功,provenance 已上透明日志 |

共消耗约 10 次 CI 运行;根因收敛为三件:npm 12 的 CLI 回归、npmrc 空令牌占位符、
npm 网页配置未保存。三者均已固化进本手册和工作流。

## 六、未来注意事项

1. **npm@11 钉版**:若未来 npm 12+ 恢复 OIDC 支持(验证方式:去掉钉版,观察 verbose
   日志是否出现 `Successfully retrieved and set token`),可移除钉版步骤。
2. **2027-01 政策节点**:bypass-2FA token 彻底失去直推能力 —— 本仓库已提前迁移
   OIDC,不受影响;届时也无需任何动作。
3. **发版前自查清单**:
   - [ ] CHANGELOG `[Unreleased]` 已定格为版本号
   - [ ] `npm version patch --no-git-tag-version` 后手动 `git add CHANGELOG.md package.json package-lock.json`
   - [ ] 提交里 10 个文件齐全(对照上一条 release 提交的 `--stat`)
   - [ ] 本地 `npm test` 全绿
   - [ ] tag 是 annotated,消息格式 `Project Knowledge x.y.z`
4. **移动已推送 tag 的前提**:该版本尚未发布到 npm 且无人消费 —— 一旦 npm 上可安装,
   绝不能再移动 tag,只能发下一个补丁版本。
