# Project Registry Schema

Status: current
Date: 2026-06-21

`projects.json` stores local project configuration. The current KB layout marker is:

```json
{
  "kbSchemaVersion": "minimal"
}
```

## Relevant Fields

| Field | Default | Notes |
|---|---|---|
| `slug` | required | Registry key and project identifier |
| `displayName` | slug | UI label |
| `gitPath` | required | Source repository path |
| `kbPath` | generated from knowledge-store root | Final minimal KB location |
| `kbSchemaVersion` | `"minimal"` | Current KB framework marker |
| `goalStatus` | `"not-created"` | Review state of `GOAL.md` |
| `trackingStartCommit` | current `HEAD` on first import | Baseline commit for incremental KB tracking; commits before it are not analyzed |
| `trackingStartedAt` | current timestamp on first import | Time the tracking baseline was established |
| `lastAnalyzedCommit` | `null` | Advanced only after accepted apply |
| `knowledgeLanguage` | `"zh-CN"` | Human-readable output language |

Old values may exist in local runtime files, but initialization and migration now target the final minimal framework.

Soft-removed projects are remembered in runtime state so re-importing the same
repository can restore the original `trackingStartCommit`, `lastAnalyzedCommit`,
and `kbPath`. Hard removal with KB deletion starts fresh.
