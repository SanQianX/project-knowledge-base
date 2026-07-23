# Testing Strategy

Status: current
Date: 2026-07-23

## Framework Tests

- New initialization creates the minimal KB structure.
- Generated `00-index.md` files remain protected from AI writes.
- Validation rejects legacy framework artifacts and KB-local AI workspaces.

## Commit Automation Tests

- One source Git commit renders one exact prompt.
- A project processes commits oldest-to-newest through a FIFO queue.
- Repeated Hook and startup reconciliation cannot create duplicate tasks.
- A completed commit is never automatically dispatched again.
- `queued` and `running` records recover after a restart.
- Failed tasks remain retryable and do not become silently completed.
- Different projects may run independently.

## Write-boundary Tests

- Automation can write only inside the selected project's KB.
- The source repository and other project KBs remain read-only.
- Bash is restricted to the read-only allowlist.
- There is no draft apply/reject or human-review API.

## Consumer Tests

- `buildPrContextPack` reads the final KB layout directly.
- The pack includes goal, architecture, indexes, and trusted Markdown files.
- The pack never includes AI workspace state.
