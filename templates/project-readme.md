# __PROJECT__ Knowledge Base

Schema: minimal-kb/v1
Created: __DATE__

This knowledge base stores only useful, reviewed project memory. It is not a dump of every prompt, file, or intermediate AI artifact.

## Final Layout

| Path | Purpose | Policy |
|---|---|---|
| `README.md` | Knowledge-base purpose and reading guidance | Updated only through verified promotion |
| `GOAL.md` | Stable project goal, boundaries, and non-goals | Updated conservatively from committed evidence |
| `ARCHITECTURE.md` | Current architecture and key decisions | Updated conservatively from committed evidence |
| `modules/<module>.md` | Durable module facts tied to source paths, routes, symbols, and tests | Verified promotion only |
| `changes/<change>.md` | Accepted change memory with intent, result, and evidence | Verified promotion only |

AI run records, per-commit automation state, backups, and context packs live outside the knowledge base.

## Design Principles

1. Keep the official KB small: store stable intent, architecture, module facts, and accepted change summaries.
2. Search first: use the read-only knowledge tools before opening detail files.
3. Read only relevant memory: choose module and change files by source paths, routes, symbols, and affected modules.
4. Store development intent, not raw prompts: summarize the user's request in `changes/<change>.md` under `## Development Intent`.
5. Update `GOAL.md` and `ARCHITECTURE.md` only when committed evidence clearly changes their current facts.

## Reading Rule

When starting work on a feature or fix:

1. Resolve the current project and search its scoped knowledge.
2. Read `GOAL.md` when the task depends on product boundaries.
3. Open only relevant `modules/<module>.md` and `changes/<change>.md` files.
4. Verify retrieved facts against current source code.
5. Let post-commit reconciliation update knowledge from committed evidence; do not write the final KB directly.

## Change File Example

```md
## Development Intent
Add a branch-aware knowledge update flow so AI records the user's feature intent without storing raw prompts.

## Implementation Result
- Added a frozen per-commit claim and exact Commit evidence.
- Promoted validated Markdown before advancing state.

## Evidence
- `_site/lib/commit-reconciler.js`
- `_site/lib/knowledge-promotion.js`
- `_site/lib/index-service.js`
```
