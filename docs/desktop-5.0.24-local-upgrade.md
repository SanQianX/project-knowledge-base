# 本机桌面端升级到 5.0.24

2026-10-22 核对时，本机桌面壳、内置核心、全局 CLI 和 5757 服务均为 5.0.18。正在提供的 `product.js` 与 5.0.18 安装包字节一致，与 5.0.24 主线不同；因此旧桌面窗口显示的也是旧版内容。

## 修正

- 桌面核心依赖从 5.0.18 精确更新为 5.0.24，并更新 lockfile。移除 lockfile 中无效的 5.0.17 父目录 extraneous 记录。
- 桌面包测试改为检查桌面版本与核心依赖一致，替代写死的 5.0.18 断言。运行时测试同时验证真正解析到的核心版本，避免只改外壳版本号。
- 从已验收的本地 desktop tgz 更新本机桌面，同时将全局 web CLI 更新到官方核心 5.0.24。本次没有执行 npm 发布或 release tag 推送。

## 验证

- 桌面 manifest、后端运行时、CLI 参数三个测试通过。
- release-version-sync、desktop-browser-compat、desktop-hook-runtime 三个相关回归测试和根项目 release:verify 通过。
- 独立数据目录下用 Electron 启动候选核心，验证服务版本、空项目状态和实际前端文件，再经受控通道停止。
- 正式实例经受控通道停机，备份停机后的完整 v5 数据，更新并重新启动桌面。
- 实测桌面壳、解析到的核心、全局 CLI、5757 服务均为 5.0.24；线上前端文件与主线 5.0.24 字节一致。
- 原数据目录保持 `C:/Users/SanQian/.project-knowledge-v5`；原有 7 个项目标识保持一致，知识引擎仍有 333 条运行记录；Workbench 已运行 0.13.6。

## 恢复材料

`D:/SanQian.Xu/.project-knowledge-backups/desktop-upgrade-20261022/` 保存旧/新桌面 tgz、正式数据的停机备份及 SHA-256、升级前后快照、候选启动验收和启动日志。需要回退时应先安全停止当前实例，再安装保存的旧桌面包及 5.0.18 核心；数据只在确认需要回退时从停机备份恢复。

旧 MCP 连接仍持有的 Windows 原生库从 npm 的临时目录移至 `C:/Users/SanQian/.codex/backups/desktop-upgrade-20261022/retired-5.0.18/` 保留，没有为清理文件而中断当前连接。
