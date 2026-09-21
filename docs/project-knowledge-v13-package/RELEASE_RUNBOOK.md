# RELEASE_RUNBOOK.md

## Release invariants

- Development commits are pushed without tags.
- Because Bridge is an independent npm dependency, publication is dependency-ordered, but **this run creates only one Git tag total**.
- Bridge packages publish from a protected GitHub Actions `workflow_dispatch` bound to an exact verified commit SHA/version; no Bridge tag and no Bridge GitHub Release.
- DevTask-Radar receives no tag.
- The single Project Knowledge final tag is the final action and triggers both npm publish and Windows Desktop Release.

## Wave A — Bridge package publication (NO TAG)

Preflight:
1. Clean fresh checkout at BR10 parent/final commit.
2. `npm whoami`; verify `@sanqianx` scope control.
3. Verify intended package names/versions are not owned by another publisher.
4. Node 18 and 24 tests; Windows CI green.
5. `npm pack` both packages and inspect tarball file lists; install both tarballs into clean temp consumer fixtures.
6. No private DevTask path/credentials/HTTP 8787 hardcoding in package output.
7. Release commit changes only version/changelog/publish metadata.
8. Push release commit; remote CI green. Re-fetch `main`; if unchanged from reviewed integration base, fast-forward push the verified Bridge release SHA to `main` (no force). If it advanced, stop and integrate/retest.
9. Invoke the protected Bridge publish `workflow_dispatch` with `expected_sha=<verified main SHA>` and the package version. The workflow must refuse if SHA/version/package manifests differ, and must use npm provenance.
10. **Do not create a Git tag or GitHub Release for Bridge in this run.** Verify `npm view`, provenance/source SHA manifest, and clean `npm install @sanqianx/ai-coding-event-bridge@<version>` plus UI package install. If publish fails after a version is consumed, never republish the same npm version; fix and publish a new semver from another reviewed commit.

## Wave B — consumer exact pins

Project Knowledge PK20:
- exact-pin the now-published Bridge package versions (no git URL/file path/caret unless v13 release policy explicitly changes).
- regenerate lockfile only through package manager.
- fresh `npm ci`, full tests, desktop tests, npm pack and clean temp install.

DevTask DR02/DR03:
- pin same Bridge core/ui version.
- smoke + integration tests for Claude/Codex/OpenCode install/status/uninstall, two-consumer cursor ownership, task analysis/calendar regression and shared Explorer.
- push; default this project has no tag in this run unless a separate DevTask release is explicitly requested.

## Wave C — Project Knowledge final release

Recommended semantic direction is a minor release (new Bridge/conversation/retrieval capabilities), e.g. 4.2.0, but the actual version must be chosen at the release gate from current remote version history. Never blindly hardcode if main advanced.

Before release commit:
1. clean checkout of exact candidate remote SHA.
2. root/desktop existing versions equal or intentionally update together.
3. `npm ci`.
4. complete `npm test -- --no-report` including canonical TS-01..TS-52.
5. `npm pack --dry-run --json` and package contents audit.
6. `npm test --prefix desktop`.
7. desktop prepare-core/package/make and packaged LanceDB/model smoke as current workflow requires.
8. migration: fresh install, upgrade from v4.1.23 fixture, legacy config/logs/index, failure/restart recovery.
9. lifecycle: import/delete, Hook install/repair/uninstall, path spaces/core.hooksPath/worktree policy.
10. Bridge: real fixture capture Claude/Codex/OpenCode; offline consumer catch-up; duplicate/reordered; Codex concurrent sessions; boundary atomic race; late assistant before/after claim; capture gap.
11. knowledge: >2MiB exact patch; dirty-index Delta Overlay; large KB retrieval relevance; crash promotion/index recovery.
12. logging: permanent files, reverse query, SSE no-gap, redaction, operation chains, ENOSPC fallback.
13. UI: every state in UI_VISUAL_ACCEPTANCE.md at mandated viewports/themes.
14. security: origin/auth/profile secret regression; conversation text absent from logs/export/SSE.
15. `git status --short` empty.

Release commit must contain only version/changelog/release metadata. Push it on the working branch. Re-fetch Project Knowledge `main`; if it has not advanced beyond the reviewed base, fast-forward the verified release SHA to `main` without force. If it advanced, stop, integrate the drift and rerun affected/full gates. Verify remote `main` equals the release SHA and non-release CI is green.

Validate:
- root package version == desktop package version.
- intended tag is exactly `v<root-version>`.
- no other business diff in release commit.

Create/push the single final Project Knowledge tag. Observe both tag workflows. Verify npm registry version/provenance and Windows GitHub Release/installer artifacts. Do not declare success until both workflows are green.

## Failure policy after tag

Do not force-delete/rewrite the final Project Knowledge release tag or republish any consumed npm version. Preserve artifacts/logs, classify whether Bridge npm, Project Knowledge npm, or desktop failed, fix on a new reviewed commit/version, rerun the full release gate, and create a new Project Knowledge semver tag only after explicit recovery approval.
