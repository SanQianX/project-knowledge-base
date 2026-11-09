# 2026-11-09：私有模块源码与公开 npm 运行包

用户明确授权保留主仓库公开，将 vector-hub、Event Bridge、knowledge-engine 的
源码仓库改为私有，并让知识引擎与 Workbench 一样通过 npm 安装。Workbench 已是私有。
本次不重写 Git 历史，不删除旧 npm 包，不升级或重置用户正在使用的安装与数据。

## 主线分发合同

| 模块 | 公开 npm 包 | 固定版本 |
| --- | --- | --- |
| Workbench | `@sanqianx/claude-ai-workbench`（安装别名 `claude-ai-workbench`） | `0.13.13` |
| vector-hub | `@sanqianx/vector-hub` | `1.0.8-rc.8` |
| Event Bridge | `@sanqianx/ai-coding-event-bridge-console` | `0.7.4` |
| knowledge-engine | `@sanqianx/ai-coding-knowledge-engine` | `0.2.7-rc.12` |

主仓库移除 `_modules/knowledge-engine/`、`vendor-manifest.json` 和
`vendor-modules.js`。引擎进程入口与回归工具从安装树解析 npm 包，支持 npm 的依赖提升。
四模块文件哈希统一保存在 `module-runtime-manifest.json`，精确版本和官方 tarball
完整性由 `package.json` 与 `package-lock.json` 固定。发布门禁同时核对安装版本、
运行文件、引擎语法及 Git 中的分发合同；包边界拒绝把引擎源码重新打入外壳包。

引擎分析、事件认领、晋升、检索、数据目录、鉴权和恢复契约保持原样。迁移前的
42 份引擎文件已在仓库外逐文件验证备份，独立源码仓库的 Git bundle 已通过验证。

## 发布身份

引擎通过自身仓库的 `.github/workflows/publish.yml` 发布。工作流绑定审查的提交
SHA 与 tarball SRI，先运行引擎测试，公开发布到 `next`，不移动 `latest`。
本次源码提交为 `82f0ea1b556db4a78d1d04e9886f75fceb36c68b`，
[发布运行](https://github.com/SanQianX/knowledge-engine/actions/runs/42624497167) 已成功。

官方引擎包 SRI：

```text
sha512-ng8LrJsMiv1zepr34SPFAZNThsTuguhHu/iURR06KLOjHVnJ6g/YqEM1el1NDr1o2e7F3bjpiN/1hg8Vj7x5OQ==
```

三个模块各自绑定自己的 npm OIDC 发布身份，仅允许对应仓库的 `publish.yml`
发布对应公开包。私有源码仓库禁用 provenance。vector-hub 与 Event Bridge 的
手动 auth-probe 只交换短期凭据来验证已有绑定，不发布版本、不移动 dist-tag，
不输出或存储凭据。npm 页面已确认两个连接为 Valid。

本次发布了新的引擎运行包；主包 npm `latest` 保持 `5.0.31`。本迁移进入主线后，
源码安装立即使用新合同；后续主包发版会使用新的 npm 依赖结构，不重新发布已存在版本。

## 验证入口

```bash
npm ci
npm run release:verify
npm test -- --no-report
npm test --prefix qa-autopilot
npm test --prefix desktop
node qa-autopilot/tools/npm-module-install-smoke.cjs <隔离安装的主包绝对路径> <隔离验收目录>
```

独立验收使用空 npm 用户配置，从官方 registry 安装主包候选及所有模块，并核对
四模块哈希。四个真实模块均在独立数据目录和临时端口启动、停止及再次启动成功；
不使用现有项目、用户知识、真实模型凭据或用户正在运行的固定端口。
