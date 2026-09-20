# @claude-ai-workbench/client

浏览器和 Node.js 使用的 HTTP/SSE Client SDK。

```js
const { createClaudeWorkbenchClient } = require("@claude-ai-workbench/client");
const client = createClaudeWorkbenchClient({ apiBase: "http://127.0.0.1:5760/api/claude-workbench/v1" });
const profiles = await client.listProfiles();
```

浏览器也可直接加载 `index.js`，然后使用全局函数 `createClaudeWorkbenchClient`。
