# Repository maintenance

- Develop on `main`. Do not create persistent feature, QA, release, or backup branches unless the user explicitly requests one. The same rule applies to the Workbench, Event Bridge, vector-hub, and knowledge-engine source repositories.
- Keep canonical regression tests and reusable QA tools in Git. Put local configuration, test data, logs, screenshots, installation prefixes, and temporary clones in their ignored locations.
- Before removing a branch with unique history or uncommitted work, preserve and verify a Git bundle and a separate file backup outside the source repository.
- Preserve the four pinned npm module dependencies, runtime manifests, and real project/knowledge data during cleanup. Since the user-authorized 2026-11-09 migration, knowledge-engine is an npm dependency; do not vendor its source back into this repository.
- Branch consolidation does not authorize publishing packages or changing release tags.

The 2026-10-22 consolidation record is in `docs/repository-consolidation-20261022.md`.

## Keep the user's knowledge base running

- Development, testing, cleanup, and release verification must leave the user's everyday knowledge-base instance and its Workbench, Event Bridge, vector-hub, and knowledge-engine services running. Stopping, restarting, upgrading, or replacing that installation requires an explicit user request for that action; permission to develop, test, or publish is not permission to interrupt it.
- Run test instances from a separate installation prefix with their own data, knowledge, module state, home/config directories, browser profile, and ports. Use synthetic fixtures; do not write test state into real project or knowledge data or attach test modules to the live services.
- Test start/status/stop commands must explicitly select the test data directory. Never issue an unscoped `project-knowledge stop`, use the live instance's port to control it, or kill processes by a shared executable name such as `node.exe`.
- Clean up only processes created by the current test whose ownership is verified. A port conflict is a reason to choose another test port or fail, never to stop its existing listener. Discover and protect the live instance's actual ports and process identities, including its modules, rather than relying only on default port numbers.
- Do not install globally over the user's active installation during development or verification. Check the protected instance's health and process identities read-only before and after tests that exercise service lifecycles; if isolation cannot be established, leave it running and report the test as blocked.
