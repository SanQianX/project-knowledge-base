# @claude-ai-workbench/server

版本化 REST/SSE Server SDK，同时提供 `claude-workbench-server` 命令。

```js
const { createWorkbenchServer } = require("@claude-ai-workbench/server");
const app = createWorkbenchServer({ dataDir: "./workbench-data", serveHost: false });
app.server.listen(5760, "127.0.0.1");
```

命令行启动：

```bash
claude-workbench-server
```

默认只应监听本机地址。若要跨机器部署，应在外层增加 HTTPS、身份认证和访问控制。
