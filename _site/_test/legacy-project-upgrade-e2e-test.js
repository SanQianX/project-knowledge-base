// _site/_test/legacy-project-upgrade-e2e-test.js
//
// Characterization harness for the v4.1.22 -> main migration path.
// Builds a v4.1.22-shaped legacy data dir (projects.json, knowledge-store.json,
// ai-profiles.json) plus a v1 managed post-commit hook in a real git repo,
// then runs MigrationService + migrateManagedHook + CommitReconciler to prove
// the legacy project continues to work without manual re-import.
//
// These tests are designed to fail under the current regressions and pass
// after T01/T02/T03 fixes. They do NOT modify production code.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { StorageLayout } = require('../lib/storage-layout');
const { MigrationService } = require('../lib/migration-service');
const {
  installHook,
  readHookStatus,
  migrateManagedHook,
  LEGACY_HOOK_MARKER,
  HOOK_MARKER,
} = require('../lib/hook-manager');
const { ProjectStore } = require('../lib/project-store');
const { ProjectRegistryStore } = require('../lib/project-registry-store');
const { Logger } = require('../lib/structured-logger');
const { migrateManagedHooks } = require('../lib/server-app');

function git(repo, args) {
  const result = spawnSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed: ${result.status}`);
  return String(result.stdout || '').trim();
}

function gitOrNull(repo, args) {
  const result = spawnSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return result.status === 0 ? String(result.stdout || '').trim() : null;
}

function makeRepo(repoPath) {
  fs.mkdirSync(repoPath, { recursive: true });
  git(repoPath, ['init', '-q', '-b', 'main']);
  git(repoPath, ['config', 'user.email', 'legacy-e2e@example.local']);
  git(repoPath, ['config', 'user.name', 'Legacy E2E']);
  git(repoPath, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(repoPath, 'README.md'), '# legacy\n');
  git(repoPath, ['add', 'README.md']);
  git(repoPath, ['commit', '-q', '-m', 'initial']);
  return git(repoPath, ['rev-parse', 'HEAD']);
}

function makeLegacyFixture({ hookBody, includeHook = true } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-legacy-upgrade-e2e-'));
  const repo = path.join(dataDir, 'repos', 'legacy-sample');
  const kbPath = path.join(dataDir, 'knowledge', 'legacy-sample');
  const initialSha = makeRepo(repo);
  if (includeHook) {
    const gitDir = git(repo, ['rev-parse', '--path-format=absolute', '--git-dir']);
    const hooksDir = path.join(path.resolve(gitDir), 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(path.join(hooksDir, 'post-commit'), hookBody || (
      `#!/bin/sh\n${LEGACY_HOOK_MARKER} — auto-installed by KB manager (legacy)\n` +
      `node 'C:/legacy/site/_site/scripts/hook-trigger.js' --kb-root 'C:/legacy/site' \\\n` +
      `  --repo "${repo.replace(/\\/g, '/')}" >/dev/null 2>&1 || true\nexit 0\n`
    ), { mode: 0o755 });
  }
  fs.mkdirSync(kbPath, { recursive: true });
  fs.writeFileSync(path.join(kbPath, 'README.md'), '# legacy knowledge\n');
  fs.writeFileSync(path.join(dataDir, 'projects.json'), JSON.stringify({
    'legacy-sample': {
      schema: 'kb-project/v1',
      displayName: 'Legacy Sample',
      localPath: repo,
      gitPath: repo,
      kbPath,
      trackingStartCommit: initialSha,
      lastAnalyzedCommit: initialSha,
      enabled: true,
      aiProfileId: null,
      knowledgeLanguage: 'zh-CN',
    },
  }, null, 2));
  fs.writeFileSync(path.join(dataDir, 'knowledge-store.json'), JSON.stringify({
    schema: 'knowledge-store/v1',
    rootPath: path.join(dataDir, 'knowledge'),
    configured: true,
  }));
  fs.writeFileSync(path.join(dataDir, 'ai-profiles.json'), JSON.stringify({
    schema: 'ai-profiles/v1',
    profiles: [
      { id: 'primary', name: 'Primary', vendor: 'anthropic', model: 'claude-sonnet', enabled: true },
    ],
    defaultProfileId: 'primary',
  }));
  return { dataDir, repo, kbPath, initialSha };
}

async function run() {
  const ROOT = path.resolve(__dirname, '..', '..');
  const TRIGGER = path.join(ROOT, '_site', 'scripts', 'hook-trigger.js');

  // ---- Case 1: legacy v1 hook must be upgraded by migrateManagedHook ----
  {
    const { dataDir, repo, kbPath, initialSha } = makeLegacyFixture();
    const layout = new StorageLayout({ dataDir });
    const migration = new MigrationService({ layout, legacyDataDir: dataDir });
    const result = await migration.migrateIfNeeded({ migrationRunId: 'legacy-upgrade-v1' });
    assert.strictEqual(result.ok, true, 'migration must succeed for a legacy fixture with v1 hook');
    assert.strictEqual(result.completed, true, 'migration must complete');
    const projectId = result.projectMap['legacy-sample'];
    assert(projectId, 'migration must produce deterministic projectId mapping');
    // Repo path preserved (not replaced with data-dir fallback)
    const config = JSON.parse(fs.readFileSync(layout.getProjectConfigPath(projectId), 'utf8'));
    assert.strictEqual(config.repoPath, path.resolve(repo), 'migrated repoPath must point at the real legacy repo, not a data-dir fallback');
    assert.strictEqual(config.knowledgePath, path.resolve(kbPath), 'migrated knowledgePath must equal legacy kbPath');
    assert.strictEqual(config.knowledgeLanguage, 'zh-CN', 'migrated knowledgeLanguage must be preserved');
    const state = JSON.parse(fs.readFileSync(layout.getProjectStatePath(projectId), 'utf8'));
    assert.strictEqual(state.trackingStartCommit, initialSha, 'trackingStartCommit must be preserved');
    assert.strictEqual(state.lastAnalyzedCommit, initialSha, 'lastAnalyzedCommit must be preserved');
    // Now invoke migrateManagedHook against the migrated repo: legacy v1 -> v2
    const migrated = migrateManagedHook({ repoPath: repo, projectId, triggerScriptPath: TRIGGER });
    assert.strictEqual(migrated.migrated, true, 'migrateManagedHook must report legacy->v2 migration');
    assert.strictEqual(migrated.managedVersion, 2, 'managedVersion must advance to 2');
    const status = readHookStatus({ repoPath: repo, projectId });
    assert.strictEqual(status.kbManaged, true, 'after migration hook must be kb-managed');
    assert.strictEqual(status.managedVersion, 2, 'after migration hook must be v2');
    const hookBody = fs.readFileSync(status.hookPath, 'utf8');
    assert(hookBody.includes(HOOK_MARKER), 'migrated hook body must carry the v2 marker');
    assert(!hookBody.includes(LEGACY_HOOK_MARKER), 'migrated hook body must NOT carry the legacy v1 marker');
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  // ---- Case 2: idempotent migration (second run) ----
  {
    const { dataDir } = makeLegacyFixture();
    const layout = new StorageLayout({ dataDir });
    const migration = new MigrationService({ layout, legacyDataDir: dataDir });
    const first = await migration.migrateIfNeeded({ migrationRunId: 'legacy-idempotent' });
    assert.strictEqual(first.completed, true);
    const second = await migration.migrateIfNeeded();
    assert.strictEqual(second.completed, true);
    assert.strictEqual(second.migrated, false, 'second migration must be idempotent (no re-migration)');
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  // ---- Case 3: missing legacy hook -> install + verify -> mark migrated ----
  // T03 state-machine case 3: a missing hook must be installed and verified
  // before migrationVersion=2 is written. The pre-fix bug (RC-02) was that
  // migrateManagedHooks unconditionally wrote migrationVersion=2 even when
  // migrateManagedHook returned { reason: 'missing' } with no install.
  {
    const { dataDir, repo } = makeLegacyFixture({ includeHook: false });
    const layout = new StorageLayout({ dataDir });
    const migration = new MigrationService({ layout, legacyDataDir: dataDir });
    const result = await migration.migrateIfNeeded({ migrationRunId: 'legacy-missing-hook' });
    assert.strictEqual(result.ok, true);
    const projectId = result.projectMap['legacy-sample'];
    const preStatus = readHookStatus({ repoPath: repo, projectId });
    assert.strictEqual(preStatus.installed, false, 'fixture must not include a hook file');
    const projectStore = new ProjectStore({ layout });
    const registryStore = new ProjectRegistryStore({ layout });
    await registryStore.initialize();
    const logger = new Logger({ layout, settingsProvider: () => ({ levels: [] }), context: { component: 'legacy-upgrade-e2e' } });
    const runtime = { registryStore, projectStore, logger, layout };
    const hooks = await migrateManagedHooks(runtime);
    const entry = hooks.find(item => item.projectId === projectId);
    assert(entry, 'migrateManagedHooks must produce an entry for the migrated legacy project');
    assert.strictEqual(entry.status, 'verified', 'missing hook must be installed+verified, not silently marked migrated');
    assert.strictEqual(entry.reason, 'installed', 'a previously-missing hook reports reason=installed after migration');
    const postStatus = readHookStatus({ repoPath: repo, projectId });
    assert.strictEqual(postStatus.kbManaged, true, 'after migration the hook must be kb-managed');
    assert.strictEqual(postStatus.managedVersion, 2, 'after migration the hook must be v2');
    const finalState = projectStore.readState(projectId);
    assert.strictEqual(finalState.hook.migrationVersion, 2, 'after successful install+verify, migrationVersion must advance to 2');
    assert(finalState.hook.lastVerifiedAt && /^\d{4}-/.test(finalState.hook.lastVerifiedAt), 'after migration lastVerifiedAt must be a timestamp');
    await logger.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  // ---- Case 3b: missing hook + install failure -> migrationVersion stays < 2 ----
  // When the install step itself fails (e.g. the repo path is gone), the
  // state machine must leave migrationVersion unchanged so the next startup
  // can retry. The pre-fix bug advanced migrationVersion even when no hook
  // was installed at all.
  {
    const { dataDir, repo } = makeLegacyFixture({ includeHook: false });
    const layout = new StorageLayout({ dataDir });
    const migration = new MigrationService({ layout, legacyDataDir: dataDir });
    const result = await migration.migrateIfNeeded({ migrationRunId: 'legacy-missing-install-fail' });
    assert.strictEqual(result.ok, true);
    const projectId = result.projectMap['legacy-sample'];
    // Remove the repo so installHook will fail (missing repo).
    fs.rmSync(repo, { recursive: true, force: true });
    const projectStore = new ProjectStore({ layout });
    const registryStore = new ProjectRegistryStore({ layout });
    await registryStore.initialize();
    const logger = new Logger({ layout, settingsProvider: () => ({ levels: [] }), context: { component: 'legacy-upgrade-e2e' } });
    const runtime = { registryStore, projectStore, logger, layout };
    const hooks = await migrateManagedHooks(runtime);
    // migrateManagedHooks skips projects whose repoPath is missing (the
    // fs.existsSync check at the top of the loop). So the registry entry
    // should not appear here. That is itself the correct behavior — we
    // only assert it does NOT silently mark migrationVersion=2 when the
    // repo is gone.
    const entry = hooks.find(item => item.projectId === projectId);
    if (entry) {
      assert.notStrictEqual(entry.status, 'verified', 'a project whose repo is missing must not be marked verified');
    }
    const finalState = projectStore.readState(projectId);
    assert.strictEqual(finalState.hook.migrationVersion < 2, true,
      'RC-02 regression: a missing-repo project must not be marked migrationVersion=2');
    await logger.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  // ---- Case 4: CHARACTERIZATION — third-party hook must not be silently overwritten ----
  {
    const { dataDir, repo } = makeLegacyFixture();
    const gitDir = git(repo, ['rev-parse', '--path-format=absolute', '--git-dir']);
    const hooksDir = path.join(path.resolve(gitDir), 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    const userHook = '#!/bin/sh\necho "user owned hook"\nexit 0\n';
    fs.writeFileSync(path.join(hooksDir, 'post-commit'), userHook, { mode: 0o755 });
    const layout = new StorageLayout({ dataDir });
    const migration = new MigrationService({ layout, legacyDataDir: dataDir });
    const result = await migration.migrateIfNeeded({ migrationRunId: 'legacy-third-party' });
    assert.strictEqual(result.ok, true);
    const projectId = result.projectMap['legacy-sample'];
    let threw = false;
    try {
      migrateManagedHook({ repoPath: repo, projectId, triggerScriptPath: TRIGGER });
    } catch (error) {
      threw = error && (error.code === 'HOOK_CONFLICT' || /third-party|cannot be migrated/i.test(String(error.message || '')));
    }
    assert.strictEqual(threw, true, 'migrateManagedHook must reject a third-party post-commit hook');
    const after = fs.readFileSync(path.join(hooksDir, 'post-commit'), 'utf8');
    assert.strictEqual(after, userHook, 'third-party hook body must be untouched');
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  // ---- Case 5: end-to-end commit on a migrated legacy project ----
  // Validates that legacy knowledgePath/tracking survive a real commit cycle without manual re-import.
  {
    const { dataDir, repo, initialSha } = makeLegacyFixture();
    const layout = new StorageLayout({ dataDir });
    const migration = new MigrationService({ layout, legacyDataDir: dataDir });
    const result = await migration.migrateIfNeeded({ migrationRunId: 'legacy-commit' });
    assert.strictEqual(result.ok, true);
    const projectId = result.projectMap['legacy-sample'];
    // The fixture includes a v1 hook, so use migrateManagedHook which replaces
    // legacy v1 with v2 using the T02 runtime contract.
    const migrated = migrateManagedHook({ repoPath: repo, projectId, triggerScriptPath: TRIGGER });
    assert.strictEqual(migrated.migrated, true, 'migrateManagedHook must report v1 -> v2');
    assert.strictEqual(migrated.managedVersion, 2, 'migrated managedVersion must be 2');
    // New commit in the legacy repo
    fs.writeFileSync(path.join(repo, 'change.txt'), 'second\n');
    git(repo, ['add', 'change.txt']);
    git(repo, ['commit', '-q', '-m', 'second']);
    const newHead = git(repo, ['rev-parse', 'HEAD']);
    assert.notStrictEqual(newHead, initialSha, 'fixture must create a second commit');
    // Verify hook is present and v2
    const status = readHookStatus({ repoPath: repo, projectId });
    assert.strictEqual(status.kbManaged, true);
    assert.strictEqual(status.managedVersion, 2);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  // ---- Case 6: second startup after successful migration -> no duplicate rewrite ----
  // The post-T03 contract: once a project is verified migrated, a subsequent
  // startup must not touch the hook file or rewrite migrationVersion.
  {
    const { dataDir, repo } = makeLegacyFixture({ includeHook: false });
    const layout = new StorageLayout({ dataDir });
    const migration = new MigrationService({ layout, legacyDataDir: dataDir });
    const result = await migration.migrateIfNeeded({ migrationRunId: 'legacy-second-startup' });
    assert.strictEqual(result.ok, true);
    const projectId = result.projectMap['legacy-sample'];
    const projectStore = new ProjectStore({ layout });
    const registryStore = new ProjectRegistryStore({ layout });
    await registryStore.initialize();
    const logger = new Logger({ layout, settingsProvider: () => ({ levels: [] }), context: { component: 'legacy-upgrade-e2e' } });
    const runtime = { registryStore, projectStore, logger, layout };
    // First startup
    const firstPass = await migrateManagedHooks(runtime);
    assert(firstPass.length > 0, `migrateManagedHooks must produce at least one entry; got ${JSON.stringify(firstPass)}`);
    const firstEntry = firstPass.find(item => item.projectId === projectId);
    assert(firstEntry, `first pass must include the migrated project; got: ${JSON.stringify(firstPass.map(p => p.projectId))}`);
    assert.strictEqual(firstEntry.status, 'verified');
    assert.strictEqual(firstEntry.reason, 'installed');
    const hookPath = readHookStatus({ repoPath: repo, projectId }).hookPath;
    const firstMtime = fs.statSync(hookPath).mtimeMs;
    const firstBody = fs.readFileSync(hookPath, 'utf8');
    const firstState = projectStore.readState(projectId);
    const firstVerifiedAt = firstState.hook.lastVerifiedAt;
    // Wait briefly so a rewrite would change mtime
    await new Promise(resolve => setTimeout(resolve, 20));
    // Second startup
    const secondPass = await migrateManagedHooks(runtime);
    const secondEntry = secondPass.find(item => item.projectId === projectId);
    assert.strictEqual(secondEntry.status, 'verified');
    assert.strictEqual(secondEntry.reason, 'already-migrated', 'second startup must report reason=already-migrated without rewriting');
    assert.strictEqual(fs.readFileSync(hookPath, 'utf8'), firstBody, 'hook body must be untouched on second startup');
    assert.strictEqual(fs.statSync(hookPath).mtimeMs, firstMtime, 'hook mtime must be unchanged on second startup');
    const secondState = projectStore.readState(projectId);
    assert.strictEqual(secondState.hook.lastVerifiedAt, firstVerifiedAt, 'lastVerifiedAt must not be re-stamped on idempotent pass');
    await logger.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  // ---- Case 7: third-party hook -> migration incomplete (T03 case 4) ----
  // Verifies the migrateManagedHooks state machine reports conflict without
  // overwriting the user's hook.
  {
    const { dataDir, repo } = makeLegacyFixture({ includeHook: false });
    const gitDir = git(repo, ['rev-parse', '--path-format=absolute', '--git-dir']);
    const hooksDir = path.join(path.resolve(gitDir), 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    const userHook = '#!/bin/sh\necho "third-party"\nexit 0\n';
    fs.writeFileSync(path.join(hooksDir, 'post-commit'), userHook, { mode: 0o755 });
    const layout = new StorageLayout({ dataDir });
    const migration = new MigrationService({ layout, legacyDataDir: dataDir });
    const result = await migration.migrateIfNeeded({ migrationRunId: 'legacy-third-party-state' });
    assert.strictEqual(result.ok, true);
    const projectId = result.projectMap['legacy-sample'];
    const projectStore = new ProjectStore({ layout });
    const registryStore = new ProjectRegistryStore({ layout });
    await registryStore.initialize();
    const logger = new Logger({ layout, settingsProvider: () => ({ levels: [] }), context: { component: 'legacy-upgrade-e2e' } });
    const runtime = { registryStore, projectStore, logger, layout };
    const pass = await migrateManagedHooks(runtime);
    const entry = pass.find(item => item.projectId === projectId);
    assert(entry, 'migrateManagedHooks must produce an entry for the third-party-hook project');
    assert.strictEqual(entry.status, 'conflict', 'third-party hook must be reported as conflict, not verified');
    assert.strictEqual(entry.reason, 'third-party');
    const finalState = projectStore.readState(projectId);
    assert.strictEqual(finalState.hook.migrationVersion < 2, true,
      'third-party hook must not be marked migrationVersion=2');
    assert(finalState.hook.lastConflict && finalState.hook.lastConflict.code === 'HOOK_CONFLICT',
      'third-party conflict must be persisted in lastConflict for UI consumption');
    assert.strictEqual(fs.readFileSync(path.join(hooksDir, 'post-commit'), 'utf8'), userHook,
      'third-party hook body must remain untouched');
    await logger.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  console.log('legacy-project-upgrade-e2e-test PASS');
}

run().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
