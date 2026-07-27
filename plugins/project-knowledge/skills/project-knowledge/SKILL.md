---
name: project-knowledge
description: Query durable Project Knowledge records for prior decisions, implementation history, known constraints, and related-project context. Use when starting non-trivial work in a registered repository, investigating why code was designed a certain way, checking whether a problem was solved before, or answering questions about earlier commits and project history.
---

# Project Knowledge

Use Project Knowledge as a read-only source of durable project context. Verify returned knowledge against the current source whenever the repository may have changed since the knowledge entry was produced.

## Workflow

1. Call `project_knowledge_resolve` with the current Git root before substantial implementation, diagnosis, or design work. Do not guess the project slug.
2. Call `project_knowledge_search` for focused matching records, or `project_knowledge_ask` when a compact cited synthesis is more useful.
3. Review titles and summaries before loading complete entries.
4. Call `project_knowledge_get` only for the most relevant entries. Call `project_knowledge_history` when sequence or recent change history matters.
5. Cite the returned project, entry, and commit information when it materially supports an answer or decision.

Client integrations may prefix MCP tool names with the server name. Match the tools by their final names: `project_knowledge_resolve`, `project_knowledge_search`, `project_knowledge_ask`, `project_knowledge_get`, and `project_knowledge_history`.

## Boundaries

- Treat every Project Knowledge tool as read-only.
- Do not write directly to the knowledge database or knowledge files.
- Do not substitute remembered conversation context for a knowledge lookup when prior project work is relevant.
- Do not treat old knowledge as stronger evidence than current code, tests, or explicit user direction.
- If the repository is not registered, continue using the source tree and tell the user that no matching Project Knowledge project was found.
