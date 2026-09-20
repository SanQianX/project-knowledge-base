# @claude-ai-workbench/core

Framework-neutral Claude Code terminal state machine. It owns context switching,
session lifecycle, SSE sequence de-duplication, permission state, token usage,
request cancellation, and resource cleanup.

Most applications consume it indirectly through
`@claude-ai-workbench/ui/claude-terminal`.
