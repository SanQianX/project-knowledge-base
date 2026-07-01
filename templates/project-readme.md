# __PROJECT__ Knowledge Base

Schema: minimal-kb/v1
Created: __DATE__

This knowledge base stores only useful, reviewed project memory. It is not a dump of every prompt, file, or intermediate AI artifact.

## Final Layout

| Path | Purpose | Policy |
|---|---|---|
| `README.md` | Framework design, reading rules, and examples | Auto-maintained |
| `GOAL.md` | Stable project goal, boundaries, and non-goals | Human review required |
| `ARCHITECTURE.md` | Current architecture and key decisions | Human review required |
| `modules/00-index.md` | Module lookup index for relevant memory search | Auto-maintained |
| `modules/<module>.md` | Useful module knowledge tied to source paths, routes, symbols, and tests | Auto-apply allowed |
| `changes/00-index.md` | Change lookup index for related development history | Auto-maintained |
| `changes/<change>.md` | Accepted change memory with intent, result, and evidence | Auto-apply allowed |

AI run records, drafts, backups, and context packs live outside the knowledge base under `_site/_ai/<project-slug>/`.

## Design Principles

1. Keep the official KB small: store stable intent, architecture, module facts, and accepted change summaries.
2. Use indexes first: Claude Code should read `GOAL.md`, `modules/00-index.md`, and `changes/00-index.md` before opening detail files.
3. Read only relevant memory: choose module and change files by tags, source paths, routes, symbols, and affected modules.
4. Store development intent, not raw prompts: summarize the user's request in `changes/<change>.md` under `## Development Intent`.
5. Treat `GOAL.md` and `ARCHITECTURE.md` as reviewed documents: AI may draft changes, but should not silently overwrite them.

## Claude Code Reading Rule

When starting work on a feature or fix:

1. Read `GOAL.md`.
2. Read `modules/00-index.md` and `changes/00-index.md`.
3. Match the current task against index tags, source paths, routes, symbols, and affected modules.
4. Open only the relevant `modules/<module>.md` and `changes/<change>.md` files.
5. Update the KB only when the final code change creates durable knowledge.

## Change File Example

```md
## Development Intent
Add a branch-aware knowledge update flow so AI records the user's feature intent without storing raw prompts.

## Implementation Result
- Added source branch metadata to generated drafts.
- Kept AI drafts outside the trusted KB.

## Evidence
- `_site/lib/analysis-orchestrator.js`
- `_site/lib/draft-apply.js`
```
