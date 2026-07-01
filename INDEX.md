# project-knowledge Index

`project-knowledge` is a local-first knowledge-base manager for Git projects.
It provides a browser dashboard, CLI, project scanner, AI-assisted analysis,
reviewable drafts, and local automation helpers.

## Public Modules

| Area | Files |
| --- | --- |
| CLI | `bin/project-knowledge.js` |
| Server and dashboard | `_site/server.js`, `_site/index.html` |
| Core libraries | `_site/lib/` |
| Dashboard launch scripts | `_site/start.bat`, `_site/stop.bat` |
| Public templates | `templates/` |
| Public documentation | `README.md`, `docs/`, `CHANGELOG.md` |
| Regression tests | `_site/_test/` |

## Local Runtime Data

The following paths are generated locally and are intentionally excluded from
source control:

- `projects/`
- `projects.json`
- `knowledge-store.json`
- `logging.json`
- `logs/`
- `.jobs-log.json`
- `.jobs-archive/`
- `ai-profiles.json`
- `_backup/`
