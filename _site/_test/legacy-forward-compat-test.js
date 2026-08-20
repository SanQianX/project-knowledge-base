// _site/_test/legacy-forward-compat-test.js
//
// T08: v4.1.22 -> main forward-compatibility migration. Builds a realistic
// two-project legacy fixture with team binding + legacy hook + tracking
// state, runs MigrationService, and asserts every required field is
// preserved or deterministically derived. Also runs migrateManagedHooks
// to confirm the T03 hook state machine is the post-migration reality.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { StorageLayout } = require('../lib/storage-layout');
const { MigrationService } = require('../lib/migration-service');
const { ProjectStore } = require('../lib/project-store');
const { ProjectRegistryStore } = require('../lib/project-registry-store');
const { Logger } = require('../lib/structured-logger');
const { migrateManagedHooks } = require('../lib/server-app');
const { LEGACY_HOOK_MARKER, readHookStatus } = require('../lib/hook-manager');

const ROOT = path.resolve(__dirname, '..', '..');
const TRIGGER = path.join(ROOT, '_site', 'scripts', 'hook-trigger.js');

function git(repo, args) {
  const result = spawnSync('git', ['-C', repo, ...args], {
    encoding: 'utf8', windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed: ${result.status}`);
  return String(result.stdout || '').trim();
}

function fixture({ withTeamBinding, withLegacyHook, knowledgeLanguage, aiProfileId, enabled, repoPath: customRepoPath } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-legacy-forward-compat-'));
  const repoPath = customRepoPath || path.join(dataDir, 'repos', 'legacy-team');
  fs.mkdirSync(repoPath, { recursive: true });
  git(repoPath, ['init', '-q', '-b', 'main']);
  git(repoPath, ['config', 'user.email', 'legacy-fc@example.local']);
  git(repoPath, ['config', 'user.name', 'Legacy FC']);
  fs.writeFileSync(path.join(repoPath, 'README.md'), '# legacy\n');
  git(repoPath, ['add', 'README.md']);
  git(repoPath, ['commit', '-q', '-m', 'initial']);
  const initialSha = git(repoPath, ['rev-parse', 'HEAD']);

  if (withLegacyHook) {
    const gitDir = git(repoPath, ['rev-parse', '--path-format=absolute', '--git-dir']);
    const hooksDir = path.join(path.resolve(gitDir), 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(path.join(hooksDir, 'post-commit'), (
      `#!/bin/sh\n${LEGACY_HOOK_MARKER} — auto-installed by KB manager (legacy)\n` +
      `node 'C:/legacy/site/_site/scripts/hook-trigger.js' \\\n` +
      `  --kb-root 'C:/legacy/site' --repo "${repoPath.replace(/\\/g, '/')}" >/dev/null 2>&1 || true\n` +
      `exit 0\n`
    ), { mode: 0o755 });
  }

  // Knowledge path
  const kbPath = path.join(dataDir, 'knowledge', 'legacy-team');
  fs.mkdirSync(kbPath, { recursive: true });

  // Team binding
  const teamBinding = withTeamBinding ? {
    teamKbId: 'team-store/team-a',
    provider: 'github',
  } : null;

  const projectEntry = {
    schema: 'kb-project/v1',
    displayName: 'Legacy Team',
    localPath: repoPath,
    gitPath: repoPath,
    kbPath,
    trackingStartCommit: initialSha,
    lastAnalyzedCommit: initialSha,
    enabled: enabled !== false,
    aiProfileId: aiProfileId !== undefined ? aiProfileId : 'primary',
    knowledgeLanguage: knowledgeLanguage || 'zh-CN',
    teamBinding,
  };

  fs.writeFileSync(path.join(dataDir, 'projects.json'), JSON.stringify({
    'legacy-team': projectEntry,
  }, null, 2));
  fs.writeFileSync(path.join(dataDir, 'knowledge-store.json'), JSON.stringify({
    schema: 'knowledge-store/v1',
    rootPath: path.join(dataDir, 'knowledge'),
    configured: true,
  }));
  fs.writeFileSync(path.join(dataDir, 'ai-profiles.json'), JSON.stringify({
    schema: 'ai-profiles/v1',
    profiles: [{ id: 'primary', name: 'Primary', enabled: true, vendor: 'anthropic', model: 'claude-sonnet' }],
    defaultProfileId: 'primary',
  }));
  return { dataDir, repoPath, kbPath, initialSha };
}

async function run() {
  // Case 1: deterministic projectId + repoPath + knowledgePath + tracking
  {
    const { dataDir, repoPath, kbPath, initialSha } = fixture();
    const layout = new StorageLayout({ dataDir });
    const migration = new MigrationService({ layout, legacyDataDir: dataDir });
    const result = await migration.migrateIfNeeded({ migrationRunId: 'fc-det' });
    assert.strictEqual(result.ok, true);
    const projectId = result.projectMap['legacy-team'];
    assert(projectId, 'deterministic projectId must be produced');
    const config = JSON.parse(fs.readFileSync(layout.getProjectConfigPath(projectId), 'utf8'));
    const state = JSON.parse(fs.readFileSync(layout.getProjectStatePath(projectId), 'utf8'));
    assert.strictEqual(config.repoPath, path.resolve(repoPath), 'repoPath must be preserved (not data-dir fallback)');
    assert.strictEqual(config.knowledgePath, path.resolve(kbPath), 'knowledgePath must be preserved');
    assert.strictEqual(config.enabled, true, 'enabled must be preserved');
    assert.strictEqual(state.trackingStartCommit, initialSha, 'trackingStartCommit must be preserved');
    assert.strictEqual(state.lastAnalyzedCommit, initialSha, 'lastAnalyzedCommit must be preserved');
    // Idempotence: second migration must not re-migrate
    const second = await migration.migrateIfNeeded();
    assert.strictEqual(second.completed, true);
    assert.strictEqual(second.migrated, false);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  // Case 2: knowledgeLanguage + aiProfileId + teamBinding preservation
  {
    const { dataDir, repoPath, kbPath } = fixture({
      withTeamBinding: true, knowledgeLanguage: 'en-US', aiProfileId: 'primary',
    });
    const layout = new StorageLayout({ dataDir });
    const migration = new MigrationService({ layout, legacyDataDir: dataDir });
    const result = await migration.migrateIfNeeded({ migrationRunId: 'fc-team' });
    assert.strictEqual(result.ok, true);
    const projectId = result.projectMap['legacy-team'];
    const config = JSON.parse(fs.readFileSync(layout.getProjectConfigPath(projectId), 'utf8'));
    assert.strictEqual(config.knowledgeLanguage, 'en-US', 'knowledgeLanguage must be preserved');
    assert.strictEqual(config.aiProfileId, 'primary', 'aiProfileId must be preserved');
    assert(config.teamBinding && config.teamBinding.teamKbId === 'team-store/team-a', 'teamBinding must be preserved');
    assert.strictEqual(config.teamBinding.provider, 'github');
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  // Case 3: AI profile semantics via T01 — stale project aiProfileId
  // falls back to default or first-usable. Here legacy has aiProfileId='stale'
  // but the global default is 'primary'; the resolver must surface 'primary'
  // when CommitReconciler runs. (The migration itself preserves the stale
  // id; the resolver is what fixes it at runtime.)
  {
    const { dataDir, repoPath } = fixture({ aiProfileId: 'stale-deleted-profile' });
    const layout = new StorageLayout({ dataDir });
    const migration = new MigrationService({ layout, legacyDataDir: dataDir });
    const result = await migration.migrateIfNeeded({ migrationRunId: 'fc-stale-profile' });
    const projectId = result.projectMap['legacy-team'];
    const config = JSON.parse(fs.readFileSync(layout.getProjectConfigPath(projectId), 'utf8'));
    assert.strictEqual(config.aiProfileId, 'stale-deleted-profile', 'migration preserves whatever was in the legacy record; resolver handles fallback at runtime');
    const { resolveEffectiveAiProfile } = require('../lib/ai-profile-resolver');
    const settings = JSON.parse(fs.readFileSync(layout.getSettingsPath(), 'utf8'));
    const resolved = resolveEffectiveAiProfile(settings, config);
    assert.strictEqual(resolved.profileId, 'primary', 'T01 resolver must fall back to default when project id is stale');
    assert.strictEqual(resolved.source, 'default');
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  // Case 4: hook migration via T03 — legacy v1 hook present, must be replaced
  // and project state must report verified v2 after migrateManagedHooks.
  {
    const { dataDir, repoPath } = fixture({ withLegacyHook: true });
    const layout = new StorageLayout({ dataDir });
    const migration = new MigrationService({ layout, legacyDataDir: dataDir });
    const result = await migration.migrateIfNeeded({ migrationRunId: 'fc-hook' });
    const projectId = result.projectMap['legacy-team'];
    const projectStore = new ProjectStore({ layout });
    const registryStore = new ProjectRegistryStore({ layout });
    await registryStore.initialize();
    const logger = new Logger({ layout, settingsProvider: () => ({ levels: [] }), context: { component: 'fc' } });
    const runtime = { registryStore, projectStore, logger, layout };
    const hooks = await migrateManagedHooks(runtime);
    const entry = hooks.find(item => item.projectId === projectId);
    assert(entry, 'migrateManagedHooks must process the migrated project');
    assert.strictEqual(entry.status, 'verified');
    assert.strictEqual(entry.reason, 'v1-migrated');
    const status = readHookStatus({ repoPath, projectId });
    assert.strictEqual(status.kbManaged, true);
    assert.strictEqual(status.managedVersion, 2);
    const finalState = projectStore.readState(projectId);
    assert.strictEqual(finalState.hook.migrationVersion, 2);
    await logger.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  // Case 5: disabled=false preservation
  {
    const { dataDir } = fixture({ enabled: false });
    const layout = new StorageLayout({ dataDir });
    const migration = new MigrationService({ layout, legacyDataDir: dataDir });
    const result = await migration.migrateIfNeeded({ migrationRunId: 'fc-disabled' });
    const projectId = result.projectMap['legacy-team'];
    const config = JSON.parse(fs.readFileSync(layout.getProjectConfigPath(projectId), 'utf8'));
    assert.strictEqual(config.enabled, false, 'enabled=false must be preserved');
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  // Case 6: repoPath MUST NOT be replaced with a data-dir fallback when a
  // valid legacy repoPath exists. (RC-style protection: a buggy migration
  // would substitute knowledgeDir/projects/<id> for repoPath.)
  {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-legacy-no-repo-fallback-'));
    const repoPath = path.join(dataDir, 'real', 'project');
    fs.mkdirSync(repoPath, { recursive: true });
    git(repoPath, ['init', '-q', '-b', 'main']);
    git(repoPath, ['config', 'user.email', 'legacy-fc@example.local']);
    git(repoPath, ['config', 'user.name', 'Legacy FC']);
    fs.writeFileSync(path.join(repoPath, 'README.md'), '# legacy\n');
    git(repoPath, ['add', 'README.md']);
    git(repoPath, ['commit', '-q', '-m', 'initial']);
    const initialSha = git(repoPath, ['rev-parse', 'HEAD']);
    const kbPath = path.join(dataDir, 'knowledge', 'legacy-team');
    fs.mkdirSync(kbPath, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'projects.json'), JSON.stringify({
      'legacy-team': {
        schema: 'kb-project/v1',
        displayName: 'Legacy Team',
        localPath: repoPath,
        gitPath: repoPath,
        kbPath,
        trackingStartCommit: initialSha,
        lastAnalyzedCommit: initialSha,
        enabled: true,
        aiProfileId: 'primary',
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
      profiles: [{ id: 'primary', name: 'Primary', enabled: true, vendor: 'anthropic', model: 'claude-sonnet' }],
      defaultProfileId: 'primary',
    }));
    const layout = new StorageLayout({ dataDir });
    const migration = new MigrationService({ layout, legacyDataDir: dataDir });
    const result = await migration.migrateIfNeeded({ migrationRunId: 'fc-no-fallback' });
    assert(result.projectMap && result.projectMap['legacy-team'], 'migration must produce projectMap');
    const projectId = result.projectMap['legacy-team'];
    const config = JSON.parse(fs.readFileSync(layout.getProjectConfigPath(projectId), 'utf8'));
    assert.strictEqual(config.repoPath, path.resolve(repoPath), 'repoPath must NOT be silently rewritten to a data-dir fallback');
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  console.log('legacy-forward-compat-test PASS');
}

run().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
