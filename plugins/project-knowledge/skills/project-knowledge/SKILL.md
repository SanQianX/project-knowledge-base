---
name: project-knowledge
description: Record the current user requirement and query durable Project Knowledge records for prior decisions, implementation history, known constraints, and related-project context. Use when starting non-trivial work in a registered repository, investigating why code was designed a certain way, checking whether a problem was solved before, or answering questions about earlier commits and project history.
---

# Project Knowledge

Use Project Knowledge as a read-only source of durable project context. Its one write-capable tool only appends user-requirement metadata and never starts knowledge analysis. Verify returned knowledge against the current source whenever the repository may have changed since the knowledge entry was produced.

## Workflow

1. Call `project_knowledge_resolve` with the current Git root before substantial implementation, diagnosis, or design work. Do not guess the project slug.
2. Before implementing a user request, call `project_knowledge_record_requirement` with the resolved `projectId`, current Git root, exact user request, client name, and a stable session/conversation identifier. Reuse its `requirementId` for the same request; do not record assistant output, system prompts, credentials, or tool transcripts.
3. Call `project_knowledge_search` for focused matching records, or `project_knowledge_ask` when a compact cited synthesis is more useful.
4. Review titles and summaries before loading complete entries.
5. Call `project_knowledge_get` only for the most relevant entries. Call `project_knowledge_history` when sequence or recent change history matters.
6. Cite the returned project, entry, and commit information when it materially supports an answer or decision.

Client integrations may prefix MCP tool names with the server name. Match the tools by their final names: `project_knowledge_resolve`, `project_knowledge_record_requirement`, `project_knowledge_search`, `project_knowledge_ask`, `project_knowledge_get`, and `project_knowledge_history`.

## Boundaries

- Treat knowledge search/get/history results as read-only. The requirement recorder may only append requirement metadata.
- Do not write directly to the knowledge database or knowledge files.
- Recording a requirement must not be used as a signal that analysis already ran or succeeded.
- Do not substitute remembered conversation context for a knowledge lookup when prior project work is relevant.
- Do not treat old knowledge as stronger evidence than current code, tests, or explicit user direction.
- If the repository is not registered, continue using the source tree and tell the user that no matching Project Knowledge project was found.
