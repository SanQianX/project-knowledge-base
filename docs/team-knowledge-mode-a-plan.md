# Team Knowledge Mode A Plan

## Goal

Support a team knowledge base without a project-knowledge cloud server by using GitHub as the identity, permission, discovery, and Git transport layer.

Mode A assumes one GitHub repository stores multiple project knowledge bases:

```text
knowledge.git
  .project-knowledge/team-store.json
  acc/
  project-knowledge-pro/
  devtask-radar/
```

Each developer may name their local source project differently. The local project slug no longer determines the shared knowledge-base directory.

## Manifest

The GitHub knowledge repository should contain `.project-knowledge/team-store.json`:

```json
{
  "schema": "project-knowledge/team-store/v1",
  "storeId": "team-store-sanqian",
  "displayName": "SanQian Knowledge",
  "knowledgeBases": [
    {
      "kbId": "kb-acc",
      "slug": "acc",
      "path": "acc",
      "displayName": "ACC"
    }
  ]
}
```

## User Flow

1. Owner pushes the shared `knowledge` repository to GitHub.
2. Owner grants a teammate access to that repository through GitHub.
3. Teammate opens Project Knowledge locally.
4. Teammate saves a GitHub token in the import view.
5. The app lists accessible GitHub repositories that contain a team-store manifest.
6. Teammate selects `knowledge.git`, syncs it to a local path, and selects `acc`.
7. Teammate imports their local source project, for example `BCC`, and binds it to `knowledge/acc`.

The resulting project config persists:

```json
{
  "knowledgeMode": "team",
  "teamProvider": "github",
  "kbStoreRemoteUrl": "https://github.com/org/knowledge.git",
  "kbStorePath": "D:/SanQian.Xu/knowledge",
  "kbSubdir": "acc",
  "kbId": "kb-acc",
  "kbPath": "D:/SanQian.Xu/knowledge/acc"
}
```

## Permission Boundary

GitHub repository permissions are repository-level. If a teammate can access `knowledge.git`, they can technically access every subdirectory in that repository. The UI can present only selected knowledge bases, but strict per-project isolation requires separate GitHub repositories per knowledge base.

## Implemented Scope

- Store GitHub auth locally in the user data directory.
- Discover accessible GitHub repositories that contain a team-store manifest.
- Clone or pull a selected knowledge repository to a local path.
- Import a local project while binding it to a selected knowledge-base subdirectory.
- Preserve personal-mode import behavior when no team binding is selected.
