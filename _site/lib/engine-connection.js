const { DomainError } = require('./contracts');
const { execGit } = require('./git-runner');

function connectEngine(runtime) {
  if (runtime.analysisOwner === 'legacy') return Promise.resolve();
  if (runtime.engineConnecting) { runtime.engineReconnectRequested = true; return runtime.engineConnecting; }
  const job = connectEngineOnce(runtime).finally(() => {
    runtime.engineConnecting = null;
    if (runtime.engineReconnectRequested && !runtime.engineConnectionClosed) { runtime.engineReconnectRequested = false; void connectEngine(runtime); }
  });
  runtime.engineConnecting = job;
  return job;
}
async function connectEngineOnce(runtime) {
  let step = 'engine-health';
  let projectId = '';
  let httpStatus = 0;
  try {
    const bridge = runtime.moduleBridge;
    if (bridge.engineCompatible === undefined) bridge.engineCompatible = false;
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${bridge.runtimeToken}` };
    const health = await bridge._fetch(`${bridge.engineUrl}/api/health`);
    httpStatus = health.status;
    if (!health.ok) throw new Error('ENGINE_UNAVAILABLE');
    const engine = await health.json();
    if (engine.name !== 'knowledge-engine' || engine.dataSchemaVersion !== 3) throw new Error('ENGINE_VERSION_MISMATCH');
    step = 'runtime-authentication';
    const auth = await bridge._fetch(`${bridge.engineUrl}/api/runtime-auth`, { headers });
    httpStatus = auth.status;
    if (!auth.ok) throw new Error('RUNTIME_AUTH_REQUIRED');
    bridge.engineCompatible = true;
    if (engine.executionEnabled === false) { bridge.resetRuntimeConfiguration?.(); runtime.projectConnections?.clear(); }
    step = 'project-wiring';
    const remote = bridge._listEngineProjects ? await bridge._listEngineProjects() : [];
    runtime.projectConnections ||= new Map();
    const enabled = [], pending = [];
    let cursor = 0;
    const ids = runtime.registryStore.listIds();
    const wire = async () => { while (cursor < ids.length) {
      const id = ids[cursor++];
      if (!runtime.registryStore.readDisplaySnapshot(id)) continue;
      let config;
      try { config = runtime.projectStore.readConfig(id); }
      catch { pending.push({ projectId: id, code: 'PROJECT_CONFIG_UNAVAILABLE' }); continue; }
      const fingerprint = JSON.stringify(config);
      if (runtime.projectConnections.get(id) === fingerprint && remote.some(p => p.projectId === id && p.repoPath === config.repoPath && p.knowledgePath === config.knowledgePath)) { enabled.push(id); continue; }
      try {
      const modules = await bridge.registerProjectLinks({ projectId: id, name: config.displayName, workspacePath: config.repoPath, knowledgePath: config.knowledgePath });
      if (!modules.engine.ok || !modules.eventBridge.ok) { pending.push({ projectId: id, code: 'PROJECT_WIRING_PENDING' }); continue; }
      // Engine activation can proceed while the terminal starts, but caching
      // that partial wiring would prevent subsequent readiness passes repairing it.
      if (modules.terminal?.ok !== false) runtime.projectConnections.set(id, fingerprint);
      enabled.push(id);
      } catch { pending.push({ projectId: id, code: 'PROJECT_WIRING_PENDING' }); }
    } };
    await Promise.all([wire(), wire()]);
    projectId = '';
    step = 'runtime-configuration';
    await bridge.syncEngineConfiguration();
    step = 'engine-activation';
    const activated = await bridge._fetch(`${bridge.engineUrl}/api/control`, { method: 'POST', headers, body: JSON.stringify({ enabled: true, projectIds: enabled }) });
    httpStatus = activated.status;
    if (!activated.ok) throw new Error(activated.status === 403 ? 'RUNTIME_AUTH_REQUIRED' : 'ENGINE_ACTIVATION_FAILED');
    runtime.ownership = { owner: 'engine', ready: true, ...(pending.length ? { pendingProjects: pending, message: '部分项目接线待恢复，其他已连接项目可正常维护。' } : {}) };
  } catch (error) {
    const codes = ['ENGINE_UNAVAILABLE', 'ENGINE_VERSION_MISMATCH', 'PROJECT_WIRING_PENDING', 'RUNTIME_AUTH_REQUIRED', 'ENGINE_ACTIVATION_FAILED'];
    const code = codes.includes(error.message) ? error.message : 'ENGINE_CONNECTION_FAILED';
    if (['ENGINE_VERSION_MISMATCH', 'RUNTIME_AUTH_REQUIRED'].includes(code)) runtime.moduleBridge.engineCompatible = false;
    const messages = {
      ENGINE_VERSION_MISMATCH: '检测到旧版知识引擎，请停止旧版服务后重新启动新版。',
      RUNTIME_AUTH_REQUIRED: '引擎服务与外壳鉴权不一致，请停止旧版服务后重新启动新版。',
      PROJECT_WIRING_PENDING: '项目接线未完成，请检查模块连接。',
    };
    const message = messages[code] || '知识引擎连接未完成，服务恢复后自动重试。';
    const previous = runtime.ownership?.error;
    runtime.ownership = { owner: 'engine', ready: false, message, error: { code, step, httpStatus, ...(projectId ? { projectId } : {}) } };
    if (previous?.code !== code || previous?.step !== step || (previous?.projectId || '') !== projectId) await runtime.logger.warn('engine.connection_pending', message, { component: 'engine-connection', phase: step, projectId, context: { code, httpStatus } });
  }
}

async function forwardCommitToBridge(runtime, event) {
  const config = runtime.projectStore.readConfig(event.projectId);
  if (!runtime.layout.pathsEqual(config.repoPath, event.repoRoot) || !/^[a-f0-9]{40}$/i.test(event.head || '')) throw new DomainError('INVALID_ARGUMENT', '提交通知与项目绑定不匹配。');
  const exists = await execGit(config.repoPath, ['cat-file', '-e', `${event.head}^{commit}`]);
  if (!exists.ok) throw new DomainError('INVALID_ARGUMENT', '提交不属于当前仓库。');
  const identity = await runtime.bridgeAdapter.resolveRepoIdentity(config.repoPath);
  const result = await runtime.bridgeAdapter.appendCommitBoundary({ projectId: event.projectId, repoIdentity: identity.repoIdentity, commitSha: event.head, branch: event.branch || null, operationId: event.operationId });
  if (result.status !== 'captured') throw new DomainError('MODULE_UNREACHABLE', '事件记录失败，请恢复事件模块后重试。', { status: 503 });
  runtime.moduleBridge._fetch(`${runtime.moduleBridge.engineUrl}/api/bridge/notify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
  return { journalSequence: result.boundary?.journalSequence || result.boundary?.sequence };
}

module.exports = { connectEngine, forwardCommitToBridge };
