# project-knowledge index

`project-knowledge` is a local Git-triggered knowledge service. Authoritative
knowledge is Markdown; LanceDB is one internal, rebuildable derived index.

## Public entry points

| Area | Files |
| --- | --- |
| Local server | `_site/server.js`, `_site/lib/server-app.js` |
| Browser UI | `ui/index.html` |
| CLI | `bin/project-knowledge.js`, `bin/project-knowledge-kb.js` |
| MCP | `bin/project-knowledge-mcp.js` |
| Git Hook notifier | `_site/scripts/hook-trigger.js` |
| Core services | `_site/lib/` |
| Windows desktop | `desktop/` |
| Tests | `_site/_test/`, `desktop/test/` |

## Runtime data

Runtime data is outside the package under `~/.project-knowledge/` or
`KB_DATA_DIR`:

- `settings.json`
- `projects.json`
- `projects/<projectId>/{config.json,state.json,requirements.jsonl}`
- `index/knowledge.lancedb`
- `cache/`, `runtime/`, `logs/`, and `recovery/`

The separately configured user knowledge root contains project Markdown only.
See [README.md](README.md) for lifecycle, migration, security, and storage
contracts.
