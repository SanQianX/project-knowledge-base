# Repository maintenance

- Develop on `main`. Do not create persistent feature, QA, release, or backup branches unless the user explicitly requests one. The same rule applies to the Workbench, Event Bridge, vector-hub, and knowledge-engine source repositories.
- Keep canonical regression tests and reusable QA tools in Git. Put local configuration, test data, logs, screenshots, installation prefixes, and temporary clones in their ignored locations.
- Before removing a branch with unique history or uncommitted work, preserve and verify a Git bundle and a separate file backup outside the source repository.
- Preserve the pinned module dependencies, vendored knowledge-engine runtime, runtime manifests, and real project/knowledge data during cleanup.
- Branch consolidation does not authorize publishing packages or changing release tags.

The 2026-10-22 consolidation record is in `docs/repository-consolidation-20261022.md`.
