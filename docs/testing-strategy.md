# Testing Strategy

Status: current
Date: 2026-06-21

The regression suite should verify the final minimal KB framework rather than older saved layouts.

## Framework Tests

- New initialization creates only `README.md`, `GOAL.md`, `ARCHITECTURE.md`, `modules/`, and `changes/`.
- `modules/00-index.md` and `changes/00-index.md` are regenerated after draft apply.
- Validation rejects old framework artifacts such as `kb-manifest.json`, `features/`, `commits/`, and KB-local `_ai/`.
- Migration consolidates legacy commit notes into `changes/legacy-change-*.md` and moves AI artifacts to `_site/_ai/<slug>/`.

## Analysis Tests

- Initial analysis produces drafts for `GOAL.md`, `ARCHITECTURE.md`, and `modules/<module>.md`.
- Commit analysis produces `changes/<change>.md` drafts only.
- Change drafts contain `## Development Intent`, `## Implementation Result`, and `## Evidence`.
- AI output stores summarized intent and does not require raw prompt logs.

## Apply Tests

- `GOAL.md` and `ARCHITECTURE.md` require explicit review.
- `modules/` and `changes/` drafts can be applied when they pass path validation.
- Draft apply refuses `_ai/`, old framework paths, absolute paths, and traversal.

## Consumer Tests

- `buildPrContextPack` reads the final layout directly.
- The pack includes goal, architecture, indexes, and trusted markdown files.
- The pack never includes AI workspace files.
