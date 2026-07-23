# KB Management Site

本地知识库管理界面，默认监听 `http://127.0.0.1:5757`。

## 启动

```bash
node _site/server.js
```

也可以运行项目根目录的 `npm start`，或使用 `_site/start.bat`。

## Commit 自动化

- Git `post-commit` Hook 在应用运行时立即通知服务端。
- 应用启动时会扫描关闭期间新增的 commit。
- 每个 commit 生成一个独立 Claude Code 后台任务。
- 同一项目按提交时间串行执行，不同项目可以并行。
- 任务直接更新当前项目知识库，没有草稿审核、`autoApply` 或人工批准阶段。
- 每个 commit 的 `discovered / queued / running / completed / failed` 状态持久化在项目 AI 工作目录中，完成的 commit 不会重复派发。

## 主要接口

- `GET /api/state`：项目与知识库状态。
- `POST /api/hooks/post-commit`：接收 Hook 事件并执行 commit 对账。
- `POST /api/projects/:slug/scan`：只读扫描 Git 状态。
- `GET /api/projects/:slug/automation/runs`：查看自动化运行记录。
- `GET /api/claude/sessions-stream`：订阅 Claude Code 会话状态。

服务只绑定回环地址。不要将端口直接暴露到公网。
