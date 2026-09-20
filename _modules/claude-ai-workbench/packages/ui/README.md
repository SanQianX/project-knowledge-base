# @claude-ai-workbench/ui

可嵌入任意 Web 系统的产品级 Web Components。两个 UI 模块彼此独立：

- 默认入口 `@claude-ai-workbench/ui`：`<ai-profile-list>`、`<ai-profile-editor>`、`<ai-profile-settings>`
- 终端入口 `@claude-ai-workbench/ui/claude-terminal`：`<claude-workbench-pane>`

```js
import "@claude-ai-workbench/ui/theme.css";
import "@claude-ai-workbench/ui/claude-terminal";
import { createClaudeWorkbenchClient } from "@claude-ai-workbench/client";

const terminal = document.querySelector("claude-workbench-pane");
terminal.client = createClaudeWorkbenchClient();
terminal.context = {
  contextId: "project-42",
  workspaceRef: "registered-workspace-42",
  aiProfileId: "my-claude-profile",
};
```

终端组件只呈现状态标题、消息、工具调用、权限确认、输入框、权限模式和 Token 用量。项目导航、Profile 设置入口、会话管理和调试日志属于宿主应用，不会混入组件。

宿主可监听 `terminal-state-change`、`running-change` 和 `terminal-error`，也可调用 `newSession()`、`restoreSession()`、`focusInput()`、`destroy()`。

底部工具栏与知识库项目保持同一结构。权限模式和 Token 用量由终端直接管理。快捷命令通过 Client 从当前 Claude Code 环境动态发现，包含当前环境可用的内置命令、Skills、Plugins 和 MCP 命令，不在 UI 中写死。

图片链路内置文件选择、粘贴、拖放、发送前预览、移除、服务端持久化和会话回显。支持 JPEG、PNG、GIF、WebP；单张不超过 10 MiB，一条消息最多 20 张且合计不超过 20 MiB。宿主仍可通过可取消的 `terminal-attach-request` 接管文件选择，并调用事件中的 `addFiles(files)` 把文件交回组件；`terminal-attachments-change` 可用于同步宿主状态。`terminal-command` 可用于拦截需要由宿主处理的特定命令。

组件移出 DOM 时默认释放会话订阅；需要在短暂移除期间保留连接时，可添加 `preserve-controller` 属性，并由宿主在最终销毁时调用 `destroy()`。
