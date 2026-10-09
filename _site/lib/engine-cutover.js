const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const AtomicFile = require('./atomic-file');
const { DomainError } = require('./contracts');
const { execGit } = require('./git-runner');

function engineRegistration(runtime, projectId) {
  const config = runtime.projectStore.readConfig(projectId);
  const state = runtime.projectStore.readState(projectId);
  return { projectId, name: config.displayName || projectId, repoPath: config.repoPath, knowledgePath: config.knowledgePath, knowledgeLanguage: config.knowledgeLanguage || 'zh-CN', brainId: config.brainId || 'brain-default', domainId: config.domainId || null, repoIdentity: config.repoIdentity, trackingStartCommit: state.trackingStartCommit || null, conversationBaselineCursor: state.conversationBaselineCursor || 0, conversationBaselineCursors: state.conversationBaselineCursors || {}, journalId: state.modules?.eventBridge?.projectId || null, vectorProjectId: state.modules?.vectorHub?.projectName || projectId };
}

async function prepareEngineCutover(runtime) {
  const markerPath = runtime.layout.getRuntimePath('engine-cutover.json');
  if (fs.existsSync(markerPath)) return AtomicFile.readJsonStrict(markerPath);
  if (runtime.activeTasks.size || runtime.indexService.pending?.size) throw new DomainError('PROJECT_BUSY', '请等待旧维护任务结束后再升级。', { status: 409 });
  const migrationId = `cutover-${crypto.randomUUID()}`;
  const backup = runtime.layout.getRecoveryPath('engine-cutover', migrationId);
  fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
  function copy(source, target) {
    if (!fs.existsSync(source)) return;
    const stat = fs.lstatSync(source);
    if (stat.isSymbolicLink() || !runtime.layout.isPathInside(runtime.dataPath, source, { realpath: true }) || !runtime.layout.isPathInside(backup, target, { realpath: true })) throw new DomainError('PATH_OUTSIDE_ROOT', '升级备份包含不安全路径。', { status: 409 });
    if (stat.isDirectory()) { for (const name of fs.readdirSync(source)) copy(path.join(source, name), path.join(target, name)); }
    else if (stat.isFile()) AtomicFile.writeFileAtomic(target, fs.readFileSync(source));
  }
  for (const name of ['settings.json', 'projects.json']) copy(path.join(runtime.dataPath, name), path.join(backup, name));
  for (const name of ['runs', 'claims', 'promotions', 'processed-commits']) copy(runtime.layout.getRuntimePath(name), path.join(backup, 'runtime', name));
  copy(runtime.layout.getRecoveryPath('promotions'), path.join(backup, 'recovery', 'promotions'));
  const projects = runtime.registryStore.listIds().map(projectId => {
    const state = runtime.projectStore.readState(projectId);
    copy(runtime.layout.getProjectMetadataDir(projectId), path.join(backup, 'projects', projectId));
    return { registration: engineRegistration(runtime, projectId), runtime: { lastAnalyzedCommit: state.lastAnalyzedCommit, conversationBaselineCursor: state.conversationBaselineCursor, conversationBaselineCursors: state.conversationBaselineCursors || {}, analysis: state.analysis, index: { dirty: state.index.dirty } } };
  });
  const snapshot = { migrationId, sourceDataDir: runtime.dataPath, projects, createdAt: new Date().toISOString() };
  AtomicFile.writeJsonAtomic(path.join(backup, 'snapshot.json'), snapshot);
  const marker = { schema: 'engine-cutover/v1', migrationId, phase: 'prepared', backupPath: backup, createdAt: snapshot.createdAt };
  AtomicFile.writeJsonAtomic(markerPath, marker);
  return marker;
}

async function finishEngineCutover(runtime) {
  if (runtime.analysisOwner === 'legacy' || runtime.cutoverRunning) return;
  runtime.cutoverRunning = true;
  const markerPath = runtime.layout.getRuntimePath('engine-cutover.json');
  try {
    const marker = await prepareEngineCutover(runtime);
    const bridge = runtime.moduleBridge;
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${bridge.runtimeToken}` };
    if (!marker.profilesMigrated) {
      const settings = runtime.settingsStore.read();
      if (settings.ai.profiles.length) {
        const imported = await bridge._fetch(`${bridge.terminalUrl}/api/claude-workbench/v1/internal/import-profiles`, { method: 'POST', headers, body: JSON.stringify({ migrationId: marker.migrationId, profiles: settings.ai.profiles, defaultProfileId: settings.ai.defaultProfileId }) });
        if (!imported.ok) throw new Error('PROFILE_MIGRATION_PENDING');
        // Protected rollback copies retain the old secrets; active settings only
        // retain a reference to the Workbench configuration from this point.
        await runtime.settingsStore.updatePatch({ ai: { profiles: [], defaultProfileId: null }, modelConfigurationRef: 'workbench' });
      }
      marker.profilesMigrated = true; AtomicFile.writeJsonAtomic(markerPath, marker);
    }
    if (marker.phase !== 'complete') {
      const snapshot = AtomicFile.readJsonStrict(path.join(marker.backupPath, 'snapshot.json'));
      const migrated = await bridge._fetch(`${bridge.engineUrl}/api/migrate`, { method: 'POST', headers, body: JSON.stringify(snapshot), timeoutMs: 60000 });
      if (!migrated.ok) throw new Error('MIGRATION_PENDING');
      for (const id of runtime.registryStore.listIds()) {
        const config = runtime.projectStore.readConfig(id);
        const modules = await bridge.registerProjectLinks({ projectId: id, name: config.displayName, workspacePath: config.repoPath, knowledgePath: config.knowledgePath });
        if (!modules.engine.ok || !modules.eventBridge.ok) throw new Error('WIRING_PENDING');
      }
      marker.phase = 'complete'; marker.completedAt = new Date().toISOString();
      AtomicFile.writeJsonAtomic(markerPath, marker);
    }
    await bridge.syncEngineConfiguration();
    const activated = await bridge._fetch(`${bridge.engineUrl}/api/control`, { method: 'POST', headers, body: JSON.stringify({ enabled: true }) });
    if (!activated.ok) throw new Error('ACTIVATION_PENDING');
    runtime.analysisOwner = 'engine';
    runtime.ownership = { owner: 'engine', ready: true, backupPath: marker.backupPath };
  } catch {
    runtime.ownership = { owner: 'engine', ready: false, message: '引擎接管待恢复；旧分析已停用，提交证据与升级备份保留。' };
  } finally { runtime.cutoverRunning = false; }
}

async function forwardCommitToBridge(runtime, event) {
  const config = runtime.projectStore.readConfig(event.projectId);
  if (!runtime.layout.pathsEqual(config.repoPath, event.repoRoot) || !/^[a-f0-9]{40}$/i.test(event.head || '')) throw new DomainError('INVALID_ARGUMENT', '提交通知与项目绑定不匹配。');
  const exists = await execGit(config.repoPath, ['cat-file', '-e', `${event.head}^{commit}`]);
  if (!exists.ok) throw new DomainError('INVALID_ARGUMENT', '提交不属于当前仓库。');
  // Even legacy notifications enter the same journal; they never execute analysis.
  const identity = await runtime.bridgeAdapter.resolveRepoIdentity(config.repoPath);
  const result = await runtime.bridgeAdapter.appendCommitBoundary({ projectId: event.projectId, repoIdentity: identity.repoIdentity, commitSha: event.head, branch: event.branch || null, operationId: event.operationId });
  if (result.status !== 'captured') throw new DomainError('MODULE_UNREACHABLE', '事件记录失败，请恢复事件模块后重试。', { status: 503 });
  runtime.moduleBridge._fetch(`${runtime.moduleBridge.engineUrl}/api/bridge/notify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
  return { journalSequence: result.boundary?.journalSequence || result.boundary?.sequence };
}

module.exports = { prepareEngineCutover, finishEngineCutover, forwardCommitToBridge, engineRegistration };
