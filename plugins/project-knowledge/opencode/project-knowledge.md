# Project Knowledge

For non-trivial work in a Git repository, load the `project-knowledge` Skill and resolve the current repository before relying on prior project decisions or implementation history. Before implementation, call `project_knowledge_record_requirement` with client `opencode`, the exact user request, and a stable session ID; reuse the returned requirement ID for that request. This metadata append never starts analysis. Treat knowledge search/get/history results as read-only, retrieve full entries only after focused search, and verify older knowledge against the current code.
