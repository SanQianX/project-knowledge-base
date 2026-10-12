(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const all = selector => [...document.querySelectorAll(selector)];
  const titles = { home: '智脑首页', work: '开始工作', search: '知识检索', memory: '长期记忆', projects: '领域与项目', activity: '活动记录' };
  const modules = { terminal: 'Agent 工作台', vectorHub: '知识索引', eventBridge: '开发事件', engine: '知识引擎' };
  const frames = {
    terminal: { id: 'workFrame', url: '/modules/terminal/agent-terminal/?embed=1&apiBase=/api/terminal', view: 'work', ready: false },
    vectorHub: { id: 'vectorFrame', url: '/modules/vectorhub/?embed=1&apiBase=/api/vectorhub&engineBase=/api/engine', view: 'search', ready: false },
    eventBridge: { id: 'bridgeFrame', url: '/modules/eventbridge/?embed=1&apiBase=/api/eventbridge', view: 'activity', ready: false },
    engine: { id: 'engineFrame', url: '/modules/engine/?embed=1&apiBase=/api/engine', ready: false },
  };
  const state = { brain: { id: 'brain-default', name: '我的智脑', domains: [] }, root: '', projects: [], projectId: localStorage.getItem('kb.project') || '', view: 'home', scope: 'project', memoryTab: 'confirmed', activityTab: 'updates', health: {}, snapshot: { projects: [], runs: [], events: [], memories: [] }, engineAvailable: false, epoch: 0, contexts: new Map(), stream: null, refreshing: false, importId: '', preflight: null, preflightEpoch: 0 };
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const activeProject = () => state.projects.find(p => p.projectId === state.projectId);
  const domainName = id => state.brain.domains.find(d => d.id === id)?.name || '未分组';
  const projectName = id => state.projects.find(p => p.projectId === id)?.name || id;
  const time = value => value ? new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
  const label = run => ({ queued: '排队', running: '维护中', succeeded: '已更新 · 可检索', 'index-pending': '知识已更新 · 索引待修复', failed: '维护失败', cancelled: '已取消' })[run.state] || run.state;
  const badge = (text, status = '') => `<span class="status ${esc(status)}">${esc(text)}</span>`;
  let toastTimer, refreshTimer, preflightTimer, editingMemoryId, logStream, logEpoch = 0, referenceEpoch = 0, snapshotEpoch = 0, registryEpoch = 0, registryPromise = null, resumeImport = false, unbindProjectId = '', unbinding = false;
  let captureEpoch = 0, captureBusy = false;
  async function api(url, options = {}) {
    const { allowNotReady, ...init } = options;
    if (init.body && typeof init.body !== 'string') init.body = JSON.stringify(init.body);
    if (init.body) init.headers = { 'Content-Type': 'application/json', ...init.headers };
    const response = await fetch(url, init);
    const data = await response.json();
    if (!response.ok || data.ok === false && !allowNotReady) throw Object.assign(new Error(data.error?.message || data.message || (typeof data.error === 'string' ? data.error : `请求失败 (${response.status})`)), { code: data.error?.code || data.error, operationId: data.error?.operationId || response.headers.get('X-Operation-Id') || '' });
    return data;
  }
  function toast(text) { $('toast').textContent = text; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4000); }
  function on(id, event, callback) { $(id).addEventListener(event, e => Promise.resolve(callback(e)).catch(error => toast(error.message))); }
  function post(key, message) { const frame = frames[key]; if (frame.ready) $(frame.id).contentWindow.postMessage(message, location.origin); }
  function initializeFrame(key) { const frame = frames[key]; if (!frame.initialized) { $(frame.id).src = frame.url; frame.initialized = true; } }
  function frameVisible(key) { return key === 'engine' ? $('engineDialog').open : state.view === frames[key].view && (key !== 'eventBridge' || state.activityTab === 'sessions'); }
  function frameContext(key) {
    const project = activeProject();
    const frame = frames[key];
    const ref = key === 'terminal' ? project?.modules.terminal.projectId || project?.workspacePath : key === 'eventBridge' ? project?.modules.eventBridge.projectId || project?.workspacePath : project?.projectId;
    frame.requestId = `${state.epoch}:${key}`;
    post(key, { type: 'kb:theme', theme: document.documentElement.dataset.theme });
    post(key, { type: 'kb:scope', scope: state.scope });
    post(key, { type: 'kb:sidebar', visible: key === 'terminal' });
    post(key, { type: 'kb:select-project', project: ref || '', projectId: project?.projectId || '', requestId: frame.requestId });
    post(key, { type: 'kb:visibility', visible: frameVisible(key) });
  }
  function setView(view) {
    if (!titles[view]) view = 'home';
    state.view = view;
    history.replaceState(null, '', `#${view}`);
    all('[data-view]').forEach(button => button.classList.toggle('active', button.dataset.view === view));
    all('.view').forEach(section => section.classList.toggle('active', section.id === `view-${view}`));
    $('pageTitle').textContent = titles[view];
    if (view === 'work' && activeProject()) initializeFrame('terminal');
    if (view === 'search' && activeProject()) initializeFrame('vectorHub');
    if (view === 'activity' && state.activityTab === 'sessions' && activeProject()) initializeFrame('eventBridge');
    Object.keys(frames).forEach(key => post(key, { type: 'kb:visibility', visible: frameVisible(key) }));
    render();
  }
  function selectProject(id) {
    if (id === state.projectId && activeProject()) return;
    state.projectId = id; state.epoch++;
    referenceEpoch++; $('referenceDialog').close();
    if ($('logsDialog').open) loadLogs().catch(error => toast(error.message));
    localStorage.setItem('kb.project', id);
    $('projectSelect').value = id;
    Object.keys(frames).forEach(frameContext);
    render(); setView(state.view);
  }
  function renderProjectOptions() {
    $('projectSelect').innerHTML = state.projects.length ? state.projects.map(p => `<option value="${esc(p.projectId)}">${esc(p.name)}</option>`).join('') : '<option value="">尚未导入项目</option>';
    $('projectSelect').disabled = !state.projects.length;
    $('projectSelect').value = state.projectId;
  }
  function render() {
    const project = activeProject();
    $('brainLabel').textContent = state.brain.name; $('homeTitle').textContent = state.brain.name;
    $('breadcrumb').textContent = project ? `${state.brain.name} / ${domainName(project.domainId)} / ${project.name}` : state.brain.name;
    $('workEmpty').hidden = !!project; $('workLayout').hidden = !project;
    $('searchEmpty').hidden = !!project; $('vectorFrame').parentElement.hidden = !project;
    const candidates = state.snapshot.memories.filter(m => m.status === 'candidate');
    $('memoryCount').textContent = candidates.length; $('memoryCount').hidden = !candidates.length; $('candidateCount').textContent = candidates.length || '';
    if (state.view === 'home') renderHome(candidates);
    if (state.view === 'projects') renderProjects();
    if (state.view === 'memory') renderMemories();
    if (state.view === 'activity') renderActivity();
    renderContext();
  }
  function renderHome(candidates) {
    if (!state.projects.length) { $('homeContent').innerHTML = '<div class="empty"><h2>从第一个项目开始</h2><p>选择代码目录和知识目录，保留项目原有文件。</p><button class="primary" data-action="import">导入第一个项目</button></div>'; return; }
    const runs = state.snapshot.runs.filter(r => !state.projectId || r.projectId === state.projectId);
    const issues = runs.filter(r => ['failed', 'index-pending'].includes(r.state));
    const scopeIssues = (state.snapshot.sharedScopes || []).filter(s => s.brainId === state.brain.id && s.index?.status === 'pending');
    const projectRows = state.projects.map(p => `<div class="row"><div><b>${esc(p.name)}</b><small>${esc(domainName(p.domainId))}</small></div>${badge(Object.values(p.modules).every(m => m.registered) ? '已连接' : '接线待恢复', Object.values(p.modules).every(m => m.registered) ? 'up' : 'issue')}<button data-select-project="${esc(p.projectId)}">打开</button></div>`).join('');
    const updates = runs.slice(0, 5).map(r => `<div class="row"><time>${time(r.startedAt)}</time><div><b>${esc(projectName(r.projectId))}</b><small>${esc(r.commitSha.slice(0, 8))} · ${esc(label(r))}</small></div></div>`).join('') || '<p>尚无维护记录。导入时不会分析历史提交。</p>';
    $('homeContent').innerHTML = `<div class="grid2"><div class="stack"><section class="panel"><h2>领域与项目</h2>${projectRows}</section><section class="panel"><h2>最近知识更新</h2>${state.engineAvailable ? updates : '<p>知识引擎暂时不可用，恢复后显示真实记录。</p>'}</section></div><div class="stack"><section class="panel"><h2>待确认记忆</h2>${candidates.length ? candidates.slice(0, 3).map(m => `<div class="row"><div><b>${esc(m.text)}</b><small>${esc(projectName(m.evidence.projectId))} · ${esc(m.evidence.commitSha.slice(0, 8))}</small></div></div>`).join('') + '<button data-go="memory">查看候选箱</button>' : '<p>没有待确认记忆。智脑不会自动把项目行为当作你的偏好。</p>'}</section><section class="panel"><h2>需要处理</h2>${issues.length ? issues.slice(0, 3).map(r => `<div class="row"><div><b>${esc(projectName(r.projectId))}</b><small>${esc(r.error?.message || label(r))}</small></div></div>`).join('') + '<button data-go="activity">查看运行详情</button>' : scopeIssues.length ? '' : '<p>没有待处理的维护异常。</p>'}${scopeIssues.map(s => `<div class="row"><div><b>${esc(s.name)}</b><small>${esc(s.index.message)}</small></div></div>`).join('')}${scopeIssues.length ? '<button data-action="system">检查索引连接</button>' : ''}${!state.engineAvailable ? '<p>知识引擎离线，请检查系统状态。</p>' : ''}</section></div></div>`;
  }
  function renderProjects() {
    const group = (id, name) => `<h3>${esc(name)}</h3>${state.projects.filter(p => (p.domainId || '') === id).map(p => `<button class="${p.projectId === state.projectId ? 'active' : ''}" data-select-project="${esc(p.projectId)}">${esc(p.name)}</button>`).join('') || '<small>暂无项目</small>'}`;
    $('projectTree').innerHTML = `<h2>${esc(state.brain.name)}</h2>${state.brain.domains.map(d => group(d.id, d.name)).join('')}${group('', '未分组')}`;
    const project = activeProject();
    if (!project) { $('projectDetail').innerHTML = '<div class="empty"><h2>尚未导入项目</h2><button class="primary" data-action="import">导入第一个项目</button></div>'; return; }
    $('projectDetail').innerHTML = `<h2>${esc(project.name)}</h2><div class="detail-label">代码目录</div><div class="detail-path">${esc(project.workspacePath)}</div><div class="detail-label">知识目录</div><div class="detail-path">${esc(project.knowledgePath)}</div><label>所属领域<select id="projectDomain"><option value="">未分组</option>${state.brain.domains.map(d => `<option value="${esc(d.id)}" ${d.id === project.domainId ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select></label><h3>项目连接</h3>${Object.entries(modules).map(([key, name]) => `<div class="row"><div>${esc(name)}</div>${badge(project.modules[key]?.registered ? '已连接' : '待恢复', project.modules[key]?.registered ? 'up' : 'issue')}</div>`).join('')}<div class="actions"><button class="primary" data-go="work">开始工作</button><button data-action="repair">修复接线</button><button data-action="unbind">解绑并保留数据</button></div>`;
  }
  function renderMemories() {
    all('[data-memory-tab]').forEach(button => button.classList.toggle('active', button.dataset.memoryTab === state.memoryTab));
    const type = $('memoryScopeFilter').value, target = $('memoryTargetFilter').value;
    const memories = state.snapshot.memories.filter(m => m.status === state.memoryTab && (!type || (m.scopeType || 'global') === type) && (!type || type === 'global' || !target || m.scopeId === target));
    $('memoryContent').innerHTML = !state.engineAvailable ? '<div class="empty">知识引擎暂时不可用。未读取到的记忆不会显示为已确认。</div>' : memories.length ? `<div class="memory-grid">${memories.map(m => `<article class="memory-card" data-memory-card="${esc(m.id)}"><div class="memory-meta">${badge(memoryScopeName(m))}${m.targetAvailable === false ? badge('目标已失效，不会注入', 'issue') : m.status === 'confirmed' && m.syncStatus === 'pending' ? badge('写入待恢复', 'issue') : m.status === 'confirmed' && m.indexStatus === 'failed' ? badge('索引待恢复', 'issue') : m.status === 'confirmed' && m.indexStatus === 'pending' ? badge('索引更新中') : ''}</div><p>${esc(m.text)}</p><small>来源：${esc(projectName(m.evidence.projectId))} · commit ${esc(m.evidence.commitSha.slice(0, 8))}<br>${esc(m.evidence.entryId)}</small><div class="actions"><button data-memory-action="evidence" data-memory-id="${esc(m.id)}">查看依据</button>${m.status === 'candidate' ? `<button class="primary" data-memory-action="confirm" data-memory-id="${esc(m.id)}">审核确认</button><button data-memory-action="ignore" data-memory-id="${esc(m.id)}">忽略</button>` : `<button data-memory-action="edit" data-memory-id="${esc(m.id)}">编辑</button>${badge(m.syncStatus === 'pending' ? '待同步' : '已确认', m.syncStatus === 'pending' ? 'issue' : 'up')}`}</div></article>`).join('')}</div>` : `<div class="empty">${type ? '此范围内没有匹配的记忆。' : state.memoryTab === 'confirmed' ? '还没有已确认的长期记忆。' : '候选箱为空。维护产物中的有据偏好会进入这里，等待你的确认。'}</div>`;
  }
  function memoryScopeName(memory) {
    const type = memory.scopeType || 'global';
    return type === 'global' ? '全局 · 所有领域与项目' : `${type === 'domain' ? '领域' : '项目'} · ${type === 'domain' ? domainName(memory.scopeId) : projectName(memory.scopeId)}`;
  }
  function memoryTargets(type) { return type === 'domain' ? state.brain.domains : type === 'project' ? state.projects.map(p => ({ id: p.projectId, name: p.name })) : []; }
  function updateMemoryTarget(type, selected = '') {
    const options = memoryTargets(type);
    $('memoryTargetLabel').hidden = type === 'global'; $('memoryTarget').required = type !== 'global'; $('memoryTarget').disabled = type === 'global';
    $('memoryTarget').innerHTML = '<option value="">请选择适用目标</option>' + options.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
    $('memoryTarget').value = selected;
    $('memoryScopeHint').textContent = type === 'global' ? '确认后可用于所有领域和项目。' : type === 'domain' ? '只用于所选领域当前所属的项目。可改选其他已有领域。' : '只用于所选项目。可改选其他已有项目。';
  }
  function updateMemoryFilter() {
    const type = $('memoryScopeFilter').value, previous = $('memoryTargetFilter').value;
    $('memoryTargetFilter').hidden = !['domain', 'project'].includes(type);
    $('memoryTargetFilter').innerHTML = '<option value="">全部目标</option>' + memoryTargets(type).map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
    $('memoryTargetFilter').value = memoryTargets(type).some(p => p.id === previous) ? previous : '';
    renderMemories();
  }
  function openMemory(memory) {
    editingMemoryId = memory.id;
    $('memoryDialogTitle').textContent = memory.status === 'candidate' ? '审核并确认记忆' : '编辑已确认记忆';
    $('memoryText').value = memory.text; $('memoryScope').value = memory.scopeType || 'global';
    updateMemoryTarget($('memoryScope').value, memory.scopeId || memory.brainId);
    $('memoryOriginal').textContent = `原始总结：${memory.originalText || memory.text}`;
    $('memoryEvidence').textContent = `${projectName(memory.evidence.projectId)} · ${memory.evidence.commitSha} / ${memory.evidence.entryId}`;
    $('memoryQuote').textContent = memory.evidence.quote;
    $('memoryFeedback').hidden = true; $('saveMemoryCandidate').hidden = memory.status !== 'candidate';
    $('confirmMemory').textContent = memory.status === 'candidate' ? '确认并保存' : '保存修改';
    $('memoryDialog').showModal();
  }
  function renderActivity() {
    all('[data-activity-tab]').forEach(button => button.classList.toggle('active', button.dataset.activityTab === state.activityTab));
    $('activityUpdates').hidden = state.activityTab !== 'updates'; $('activitySessions').hidden = state.activityTab !== 'sessions';
    const runs = state.snapshot.runs.filter(r => r.projectId === state.projectId);
    const open = new Set(all('.run[open]').map(d => d.dataset.runId));
    $('activityUpdates').innerHTML = state.engineAvailable ? runs.map(r => `<details class="run" data-run-id="${esc(r.runId)}" ${open.has(r.runId) ? 'open' : ''}><summary><time>${time(r.startedAt)}</time><strong>${esc(projectName(r.projectId))} · ${esc(r.commitSha.slice(0, 8))}</strong>${badge(label(r), ['failed', 'index-pending'].includes(r.state) ? 'issue' : r.state === 'succeeded' ? 'up' : '')}</summary><div><p>提交：${esc(r.commitSha)}<br>阶段：${esc(r.phase)} · 入口：${esc(r.trigger)}<br>知识晋升：${time(r.promotedAt)} · 索引：${esc(r.indexState)}</p>${r.memoryCapture?.rejected?.length ? `<p>记忆候选：${esc(r.memoryCapture.rejected.length)} 条依据无效，未纳入候选箱；有效知识已保留。可在诊断日志中查看原因。</p>` : ''}${r.error ? `<p class="error">${esc(r.error.message)} (${esc(r.error.code)})</p>${r.error.details ? `<p>失败原因：${esc(r.error.details.upstreamMessage)}<br>类别：${esc(r.error.details.failureKind)} · HTTP：${esc(r.error.details.httpStatus ?? '—')} · 上游代码：${esc(r.error.details.upstreamCode)}<br>请求标识：${esc(r.error.details.requestId || '—')} · 尝试：${esc(r.error.details.attempt)} · 耗时：${esc(r.error.details.durationMs ?? '—')} ms</p>` : ''}` : ''}${(r.staging?.operations || []).map(op => `<div class="operation">${esc(op.operation)} · ${esc(op.path)}<br>${esc(op.reason)}</div>`).join('')}${['failed', 'index-pending'].includes(r.state) ? `<button data-retry-run="${esc(r.runId)}">重试失败阶段</button>` : ''}</div></details>`).join('') || '<div class="empty">当前项目还没有知识维护记录。</div>' : '<div class="empty">知识引擎离线。记录仍保留在本机，连接恢复后自动读取。</div>';
  }
  function renderContext() {
    const saved = state.contexts.get(state.projectId);
    const context = saved?.status === 'not-retrieved' ? null : saved;
    $('contextScope').textContent = context ? ({ ready: '已检索知识', 'file-fallback': '索引暂不可用，已检索原文件', unavailable: '知识服务不可用，未注入上下文', unregistered: '项目尚未登记知识库', disabled: '未启用知识连接' })[context.status] || '本次任务上下文' : '任务发送前自动检索';
    $('contextContent').classList.toggle('small-empty', !context?.references?.length);
    const seen = new Set();
    const references = (context?.references || []).map((r, index) => ({ ...r, index })).filter(r => { const key = `${r.spaceId}:${r.projectId}:${r.entryId}:${r.commitSha || ''}`; if (seen.has(key)) return false; seen.add(key); return true; });
    $('contextContent').classList.toggle('empty', !references.length);
    $('contextContent').innerHTML = references.length ? references.map(r => `<button class="reference" data-context-index="${r.index}"><b>${esc(r.title)}</b><small>${esc(projectName(r.projectId))} / ${esc(r.entryId)}${r.commitSha ? ` · ${esc(r.commitSha.slice(0, 8))}` : ''}</small><p>${esc(r.text.slice(0, 180))}</p></button>`).join('') : context ? '本次任务未找到可引用的知识。' : '发送任务后显示实际检索到的项目事实、领域经验和已确认记忆。';
  }
  async function openReference(reference) {
    const id = state.projectId;
    const epoch = ++referenceEpoch;
    $('referenceTitle').textContent = reference.title || reference.entryId;
    $('referenceMeta').textContent = `${projectName(reference.projectId)} / ${reference.entryId}${reference.commitSha ? ` · commit ${reference.commitSha}` : ''}`;
    $('referenceContent').textContent = reference.text || '读取知识文件…'; $('referenceDialog').showModal();
    if (reference.entryId && reference.readFile !== false) {
      const result = await api('/api/engine/get', { method: 'POST', body: { projectId: state.projects.some(p => p.projectId === reference.projectId) ? reference.projectId : id, spaceId: reference.spaceId, entryId: reference.entryId } });
      if (epoch === referenceEpoch && id === state.projectId && $('referenceDialog').open) $('referenceContent').textContent = result.chunks.map(c => c.chunk_text).join('\n');
    }
  }
  async function refreshSnapshot() {
    const epoch = ++snapshotEpoch;
    try { const snapshot = await api('/api/engine/snapshot'); if (epoch !== snapshotEpoch || !navigator.onLine) return; state.snapshot = snapshot; state.engineAvailable = true; }
    catch { if (epoch !== snapshotEpoch) return; state.engineAvailable = false; }
    render();
  }
  function scheduleRefresh() { if (!navigator.onLine) return; clearTimeout(refreshTimer); refreshTimer = setTimeout(() => { refreshSnapshot(); post('eventBridge', { type: 'kb:refresh' }); }, 160); }
  function connectProgress() {
    if (!navigator.onLine || !state.health.engine?.up || state.stream) return;
    const stream = new EventSource('/api/engine/progress'); state.stream = stream;
    stream.addEventListener('snapshot', () => { if (state.stream !== stream) return; $('activityConnection').textContent = '已连接实时更新'; scheduleRefresh(); });
    stream.addEventListener('progress', () => { if (state.stream === stream) scheduleRefresh(); });
    stream.onerror = () => { if (state.stream === stream) $('activityConnection').textContent = '连接中断，正在恢复快照'; };
  }
  function refreshRegistry(force = false) {
    if (!navigator.onLine) return Promise.resolve();
    if (registryPromise && !force) return registryPromise;
    const epoch = ++registryEpoch;
    const job = (async () => {
    try {
      const [brain, projects, health] = await Promise.all([api('/api/brain'), api('/api/projects/aggregated'), api('/api/modules/health')]);
      if (epoch !== registryEpoch) return;
      state.brain = brain.brain; state.root = brain.knowledgeRoot; state.projects = projects.projects; state.health = health.modules; state.ownership = health.ownership;
      state.indexStorage = { path: brain.indexStoragePath, ...brain.configuration?.indexStorage };
      state.scopeStatus = brain.configuration?.scopeStatus;
      if (!activeProject()) { state.projectId = state.projects[0]?.projectId || ''; state.epoch++; Object.keys(frames).forEach(frameContext); }
      renderProjectOptions(); renderSystem(); connectProgress(); await refreshSnapshot(); updateMemoryFilter(); setView(state.view);
    } catch (error) { toast(error.message); }
    finally { if (epoch === registryEpoch) { registryPromise = null; connectProgress(); } }
    })();
    registryPromise = job;
    return job;
  }
  function renderSystem() {
    const down = Object.keys(modules).filter(key => !state.health[key]?.up);
    const pending = state.ownership?.owner === 'engine' && !state.ownership.ready;
    const storagePending = !!state.indexStorage?.expectedPath && state.indexStorage.status !== 'ready';
    renderStorageInfo();
    $('systemDot').className = `dot ${down.length || pending ? 'issue' : 'up'}`;
    $('systemTitle').textContent = pending ? '知识引擎连接待恢复' : down.length ? '部分服务需要处理' : '系统连接正常';
    $('systemDetail').textContent = pending ? `${state.ownership.message || '服务恢复后自动重试。'}${state.ownership.error ? ` · ${state.ownership.error.step} (${state.ownership.error.code})` : ''}` : down.length ? down.map(k => modules[k]).join('、') : '本机知识服务已连接';
    if (storagePending && !pending && !down.length) { $('systemDot').className = 'dot issue'; $('systemTitle').textContent = '索引目录接线待恢复'; $('systemDetail').textContent = `目标目录：${state.indexStorage.expectedPath}。请在系统状态中修复接线。`; }
    if (state.root && state.scopeStatus?.status === 'pending' && !pending && !down.length) { $('systemDot').className = 'dot issue'; $('systemTitle').textContent = '共享知识接线待恢复'; $('systemDetail').textContent = '已有知识与长期记忆保留，请在系统状态中修复接线。'; }
    $('moduleHealth').innerHTML = Object.entries(modules).map(([key, name]) => `<div class="row"><div><b>${esc(name)}</b><small>${esc(state.health[key]?.url || '')}</small></div>${badge(state.health[key]?.up ? '在线' : '离线', state.health[key]?.up ? 'up' : 'issue')}</div>`).join('');
    if (!navigator.onLine) {
      $('systemDot').className = 'dot issue'; $('systemTitle').textContent = '网页连接中断';
      $('systemDetail').textContent = '恢复连接后自动读取状态，后台维护不受影响。';
      $('moduleHealth').innerHTML = '<p>当前网页无法确认服务状态，连接恢复后重新读取。</p>';
    }
  }
  async function openSystem() {
    $('systemDrawer').hidden = false; $('drawerBackdrop').hidden = false;
    $('brainName').value = state.brain.name; $('knowledgeRoot').value = state.root;
    renderStorageInfo();
    await Promise.all([loadMaintenance(), loadAgentCapture()]);
  }
  function renderStorageInfo() {
    $('indexStoragePath').textContent = state.indexStorage?.actualPath || state.indexStorage?.path || '设置知识根目录后自动确定';
    $('indexStorageStatus').textContent = state.indexStorage?.status === 'ready' ? '索引目录已生效。' : `索引接线待恢复；目标目录：${state.indexStorage?.expectedPath || state.indexStorage?.path || '尚未设置'}`;
  }
  async function loadAgentCapture() {
    const epoch = ++captureEpoch;
    try {
      const result = await api('/api/integrations/status?captureOnly=1');
      if (epoch !== captureEpoch) return;
      $('agentCaptureList').innerHTML = result.clients.map(agent => {
        const capture = agent.developmentCapture;
        const found = agent.available || agent.configFound;
        const software = agent.available ? '检测到命令' : agent.configFound ? '检测到配置' : '未检测到';
        const status = !capture.ok ? '接线异常' : capture.installed ? '已配置采集' : '未接入';
        return `<div class="agent-capture-row"><div><b>${esc(agent.label)}</b><small>${esc(software)} · ${esc(status)}</small><small>${esc(capture.detail)}</small></div><div class="actions"><button data-agent-capture="install" data-agent-client="${esc(agent.client)}" ${!found || captureBusy ? 'disabled' : ''}>${capture.installed ? '修复' : '接入'}</button>${capture.installed ? `<button data-agent-capture="uninstall" data-agent-client="${esc(agent.client)}" ${captureBusy ? 'disabled' : ''}>移除采集</button>` : ''}</div></div>`;
      }).join('');
    } catch (error) { if (epoch === captureEpoch) $('agentCaptureList').textContent = `无法检查采集状态：${error.message}`; }
  }
  async function changeAgentCapture(client, operation) {
    if (captureBusy) return;
    captureBusy = true; captureEpoch++;
    all('[data-agent-capture]').forEach(button => { button.disabled = true; });
    $('agentCaptureFeedback').textContent = operation === 'install' ? '正在配置采集 Hook…' : '正在移除托管采集，已有记录保留…';
    try {
      const result = await api(`/api/integrations/${operation}`, { method: 'POST', body: { clients: [client], captureOnly: true } });
      const capture = operation === 'install' ? result.clients[0]?.developmentCapture : result.capture[0];
      const success = result.complete === true && capture?.ok;
      $('agentCaptureFeedback').textContent = success ? operation === 'install' ? '采集配置已保存。请重新打开外部 Agent 会话，实际记录可在活动页面查看。' : '已移除托管采集，第三方配置与已有记录保留。' : `接入操作未完成：${capture?.detail || result.bridge?.detail || '请检查系统诊断记录。'}\n操作 ID：${result.operationId || '—'}`;
      $('agentCaptureFeedback').classList.toggle('issue', !success);
    } catch (error) { $('agentCaptureFeedback').textContent = `操作失败：${error.message}`; $('agentCaptureFeedback').classList.add('issue'); }
    finally { captureBusy = false; await loadAgentCapture(); post('eventBridge', { type: 'kb:refresh-agents' }); }
  }
  async function loadLogs() {
    const epoch = ++logEpoch;
    logStream?.close(); logStream = null;
    const params = new URLSearchParams({ pageSize: '100', q: $('logsSearch').value.trim() });
    const projectOnly = $('logsScope').value === 'project' && Boolean(state.projectId);
    if (projectOnly) params.set('projectId', state.projectId);
    const result = await api(`/api/logs?${params}`);
    if (epoch !== logEpoch || !$('logsDialog').open) return;
    $('logsDialog').dataset.streamCursor = result.streamCursor || '';
    $('logsContent').replaceChildren();
    for (const record of [...(result.entries || [])].reverse()) appendLog(record);
    $('logsStatus').textContent = `${(result.entries || []).length} 条诊断记录 · ${projectOnly ? '当前项目' : '系统与所有项目'}`;
    if (!$('logsSearch').value.trim()) {
      const streamParams = new URLSearchParams({ streamCursor: result.streamCursor || '' });
      if (projectOnly) streamParams.set('projectId', state.projectId);
      logStream = new EventSource(`/api/logs/stream?${streamParams}`);
      logStream.addEventListener('logs/appended', event => { if (epoch === logEpoch && $('logsDialog').open) appendLog(JSON.parse(event.data).record); });
    }
  }
  function appendLog(record) {
    const row = document.createElement('details'); row.className = 'log-entry';
    row.dataset.level = record.level;
    const summary = document.createElement('summary'); summary.className = 'row';
    const date = document.createElement('time'); date.textContent = time(record.ts || record.at);
    const text = document.createElement('pre'); text.textContent = record.message || '';
    const detail = document.createElement('pre'); detail.className = 'log-detail';
    detail.textContent = JSON.stringify(record, null, 2);
    summary.append(date, text); row.append(summary, detail); $('logsContent').append(row);
    while ($('logsContent').childElementCount > 100) $('logsContent').firstElementChild.remove();
  }
  function closeSystem() {
    $('systemDrawer').hidden = true; $('drawerBackdrop').hidden = true;
    if (resumeImport) {
      resumeImport = false;
      $('importDialog').showModal();
      checkImport().catch(error => toast(error.message));
    }
  }
  async function loadMaintenance() {
    try {
      const [profiles, saved] = await Promise.all([api('/api/terminal/profiles'), api('/api/terminal/maintenance-default')]);
      const list = Array.isArray(profiles) ? profiles : profiles.profiles || [];
      $('maintenanceModel').innerHTML = '<option value="">尚未选择后台默认模型</option>' + list.filter(p => p.enabled && p.credentialConfigured).map(p => `<option value="${esc(p.id)}">${esc(p.name)} · ${esc(p.models.default)}</option>`).join('');
      $('maintenanceModel').value = saved.profileId || '';
      $('configurationStatus').textContent = saved.profileId ? '此默认模型仅用于后台维护。' : '先配置供应商，再选择后台默认模型。';
      const embedding = await api('/api/terminal/embedding-config');
      $('embeddingStatus').textContent = embedding.configured ? `已配置 · ${embedding.config.model}` : '未配置，使用文本检索降级。';
      const capture = (await api('/api/terminal/health')).conversationCapture;
      $('captureStatus').textContent = !capture ? '工作台对话接线尚未启用。' : capture.error ? `工作台对话待恢复 · ${capture.pending} 条事件保留在本机，请检查接线。` : capture.pending ? `工作台对话正在同步 · ${capture.pending} 条待写入。` : capture.enabled ? '工作台对话自动保存到开发会话记录。' : '工作台对话捕获已关闭。';
    } catch { $('maintenanceModel').innerHTML = '<option value="">工作台暂时不可用</option>'; $('configurationStatus').textContent = '无法读取模型配置，请恢复工作台服务。'; }
  }
  async function openEmbedding() {
    const [profiles, embedding] = await Promise.all([api('/api/terminal/profiles'), api('/api/terminal/embedding-config')]);
    const list = Array.isArray(profiles) ? profiles : profiles.profiles || [];
    $('embeddingProfile').innerHTML = '<option value="">独立凭据</option>' + list.filter(p => p.enabled && p.credentialConfigured).map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
    const saved = embedding.config || {};
    $('embeddingProfile').value = saved.profileId || '';
    $('embeddingProvider').value = saved.provider || 'minimax';
    $('embeddingModel').value = saved.model || 'embo-01';
    $('embeddingEndpoint').value = saved.endpoint || '';
    $('embeddingSecret').value = '';
    $('embeddingSecretLabel').hidden = !!saved.profileId;
    $('embeddingFeedback').textContent = embedding.configured ? '配置已保存。留空凭据不会覆盖现有密钥。' : '向量检索尚未配置。';
    closeSystem(); $('embeddingDialog').showModal();
  }
  async function saveEmbedding(enabled = true) {
    const body = enabled ? { provider: $('embeddingProvider').value, model: $('embeddingModel').value, endpoint: $('embeddingEndpoint').value, profileId: $('embeddingProfile').value || null, secret: $('embeddingSecret').value } : { enabled: false };
    await api('/api/terminal/embedding-config', { method: 'PUT', body });
    $('embeddingSecret').value = '';
    const result = await api('/api/modules/configure', { method: 'POST', body: {} });
    $('embeddingFeedback').textContent = !enabled ? '已停用向量模型，知识文件保留。' : result.configuration.embedding ? '已保存并同步到向量检索服务。' : '配置已保存，向量服务待恢复。请检查模块连接。';
    await loadMaintenance();
  }
  async function repair() {
    const project = activeProject(); if (!project) return toast('请先导入项目。');
    const result = await api(`/api/projects/${encodeURIComponent(project.projectId)}/module-register`, { method: 'POST', body: {} });
    const pending = Object.entries(result.modules).filter(([, v]) => !v.ok).map(([key]) => modules[key]);
    $('wiringFeedback').textContent = pending.length ? `项目已登记，待恢复：${pending.join('、')}` : '四个模块已连接。';
    toast($('wiringFeedback').textContent); await refreshRegistry(true); Object.keys(frames).forEach(frameContext);
  }
  async function pick(target) {
    const result = await api('/api/terminal/system/pick-folder');
    if (result.cancelled || !result.path) return;
    $(target).value = result.path; $(target).dispatchEvent(new Event('input', { bubbles: true }));
  }
  function openImport() {
    resumeImport = false; $('setupImportRoot').hidden = true;
    $('importForm').reset(); state.importId = `project-${crypto.randomUUID()}`; state.preflight = null; state.preflightEpoch++;
    $('importDomain').innerHTML = '<option value="">未分组</option>' + state.brain.domains.map(d => `<option value="${esc(d.id)}">${esc(d.name)}</option>`).join('');
    $('importDomain').value = activeProject()?.domainId || '';
    $('gitInitChoice').hidden = true; $('replaceHookChoice').hidden = true; $('confirmImport').disabled = true; $('preflightStatus').textContent = '填写目录后检查导入条件。'; $('importDialog').showModal();
  }
  function importInput() { return { projectId: state.importId, brainId: state.brain.id, domainId: $('importDomain').value || null, localPath: $('importCode').value.trim(), knowledgePath: $('importKnowledge').value.trim(), displayName: $('importName').value.trim(), knowledgeLanguage: 'zh-CN', confirmGitInit: $('importForm').elements.confirmGitInit.checked, replaceManagedHookProjectId: $('importForm').elements.confirmReplaceHook.checked ? state.preflight?.checks.hook?.replacementProjectId : undefined }; }
  const problemLabels = { KNOWLEDGE_ROOT_MISSING: '请在系统状态中设置知识根目录。', AI_PROFILE_REQUIRED: '请配置可用模型；后台默认模型在系统状态中设置。', DUPLICATE_PROJECT: '此项目已导入，请打开已有项目。', HOOK_CONFLICT: '存在第三方 Hook，不会覆盖。请先检查冲突。', PATH_MISSING: '代码目录不存在。', PATH_REQUIRED: '请选择代码目录。' };
  async function checkImport() {
    const epoch = ++state.preflightEpoch; $('confirmImport').disabled = true;
    $('setupImportRoot').hidden = true;
    if (!$('importCode').value.trim()) return;
    $('preflightStatus').textContent = '正在检查目录、仓库与接线条件…';
    try {
      const result = await api('/api/projects/preflight-import', { method: 'POST', body: importInput(), allowNotReady: true });
      if (epoch !== state.preflightEpoch || !$('importDialog').open) return;
      state.preflight = result; $('gitInitChoice').hidden = !result.plannedGitInit; $('replaceHookChoice').hidden = !result.checks.hook?.replacementProjectId;
      const messages = result.problems.map(p => problemLabels[p.code] || p.message);
      $('setupImportRoot').hidden = !result.problems.some(p => p.code === 'KNOWLEDGE_ROOT_MISSING');
      $('preflightStatus').textContent = result.ready ? result.plannedGitInit ? '目录检查通过。请确认初始化 Git；不分析历史。' : '检查通过。只建立当前提交的跟踪基线，不分析历史。' : [...new Set(messages)].join('\n');
      $('preflightStatus').classList.toggle('issue', !result.ready);
      $('confirmImport').disabled = !result.ready || result.plannedGitInit && !$('importForm').elements.confirmGitInit.checked || result.checks.hook?.replacementProjectId && !$('importForm').elements.confirmReplaceHook.checked || !$('importKnowledge').value.trim();
    } catch (error) { if (epoch === state.preflightEpoch) $('preflightStatus').textContent = error.message; }
  }
  document.addEventListener('click', e => {
    const button = e.target.closest('button'); if (!button) return;
    const execute = async () => {
      if (button.dataset.view) setView(button.dataset.view);
      if (button.dataset.go) { if (button.dataset.go === 'memory') state.memoryTab = 'candidate'; setView(button.dataset.go); }
      if (button.dataset.close && !(button.dataset.close === 'unbindDialog' && unbinding)) $(button.dataset.close).close();
      if (button.dataset.selectProject) selectProject(button.dataset.selectProject);
      if (button.dataset.scope) { state.scope = button.dataset.scope; all('[data-scope]').forEach(b => b.classList.toggle('active', b.dataset.scope === state.scope)); post('vectorHub', { type: 'kb:scope', scope: state.scope }); }
      if (button.dataset.memoryTab) { state.memoryTab = button.dataset.memoryTab; renderMemories(); }
      if (button.dataset.activityTab) { state.activityTab = button.dataset.activityTab; setView('activity'); post('eventBridge', { type: 'kb:visibility', visible: state.activityTab === 'sessions' }); post('eventBridge', { type: 'kb:refresh' }); }
      if (button.dataset.action === 'import') openImport();
      if (button.dataset.action === 'repair') await repair();
      if (button.dataset.action === 'system') await openSystem();
      if (button.dataset.agentCapture) await changeAgentCapture(button.dataset.agentClient, button.dataset.agentCapture);
      if (button.dataset.action === 'unbind') { const p = activeProject(); if (p && !unbinding) { unbindProjectId = p.projectId; $('unbindProjectName').textContent = `解绑「${p.name}」？`; $('unbindFeedback').textContent = ''; $('unbindDialog').showModal(); } }
      if (button.dataset.retryRun) { await api(`/api/engine/runs/${encodeURIComponent(button.dataset.retryRun)}/retry`, { method: 'POST', body: {} }); await refreshSnapshot(); }
      if (button.dataset.contextIndex !== undefined) await openReference(state.contexts.get(state.projectId).references[Number(button.dataset.contextIndex)]);
      if (button.dataset.memoryAction) {
        const memory = state.snapshot.memories.find(m => m.id === button.dataset.memoryId); if (!memory) return;
        const action = button.dataset.memoryAction;
        if (action === 'evidence') await openReference({ ...memory.evidence, readFile: false, text: memory.evidence.quote, title: '记忆来源依据（冻结原文）' });
        else if (action === 'edit' || action === 'confirm') openMemory(memory);
        else { await api(`/api/engine/memories/${encodeURIComponent(memory.id)}`, { method: 'PATCH', body: { status: 'ignored' } }); await refreshSnapshot(); }
      }
    };
    execute().catch(error => toast(error.message));
  });
  document.addEventListener('change', e => { if (e.target.id === 'projectDomain') api(`/api/projects/${encodeURIComponent(state.projectId)}`, { method: 'PATCH', body: { domainId: e.target.value || null } }).then(() => refreshRegistry(true)).catch(error => toast(error.message)); });
  window.addEventListener('message', event => {
    if (event.origin !== location.origin || !event.data || typeof event.data !== 'object') return;
    const key = Object.keys(frames).find(k => $(frames[k].id).contentWindow === event.source); if (!key) return;
    const message = event.data;
    if (message.type === 'kb:open-integrations' && key === 'eventBridge') { openSystem().then(() => $('agentCaptureSection').scrollIntoView({ block: 'start' })).catch(error => toast(error.message)); return; }
    if (message.type === 'kb:ready') { frames[key].ready = true; frameContext(key); if (frames[key].openSettings) { post(key, { type: 'kb:open-settings' }); frames[key].openSettings = false; } }
    if (message.requestId && message.requestId !== frames[key].requestId) return;
    if (message.type === 'kb:knowledge' && key === 'terminal') {
      const project = state.projects.find(p => p.modules.terminal.projectId === message.projectId);
      if (project) { state.contexts.set(project.projectId, message.knowledge); if (project.projectId === state.projectId) renderContext(); }
    }
  });
  on('projectSelect', 'change', e => selectProject(e.target.value));
  on('themeToggle', 'click', () => { document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; localStorage.setItem('kb.theme', document.documentElement.dataset.theme); Object.keys(frames).forEach(key => post(key, { type: 'kb:theme', theme: document.documentElement.dataset.theme })); });
  on('openSystem', 'click', openSystem); on('closeSystem', 'click', closeSystem); on('drawerBackdrop', 'click', closeSystem);
  on('repairWiring', 'click', repair);
  on('refreshAgentCapture', 'click', () => captureBusy ? undefined : loadAgentCapture());
  on('configureProviders', 'click', () => { closeSystem(); setView('work'); initializeFrame('terminal'); if (frames.terminal.ready) post('terminal', { type: 'kb:open-settings' }); else frames.terminal.openSettings = true; });
  on('saveMaintenance', 'click', async () => { await api('/api/terminal/maintenance-default', { method: 'PUT', body: { profileId: $('maintenanceModel').value || null } }); const result = await api('/api/modules/configure', { method: 'POST', body: {} }); $('configurationStatus').textContent = result.configuration.model ? '后台默认模型已保存并同步。' : '配置已保存，后台运行配置尚未同步，请检查模块连接。'; });
  on('openEmbedding', 'click', openEmbedding);
  on('embeddingProfile', 'change', () => { $('embeddingSecretLabel').hidden = !!$('embeddingProfile').value; });
  on('embeddingProvider', 'change', () => { $('embeddingModel').value = $('embeddingProvider').value === 'minimax' ? 'embo-01' : 'text-embedding-3-small'; });
  on('embeddingForm', 'submit', async event => { event.preventDefault(); await saveEmbedding(); });
  on('disableEmbedding', 'click', () => saveEmbedding(false));
  on('embeddingDialog', 'close', () => { $('embeddingSecret').value = ''; });
  on('saveBrainSettings', 'click', async () => { await api('/api/brain', { method: 'PATCH', body: { name: $('brainName').value } }); const saved = await api('/api/settings', { method: 'PATCH', body: { knowledge: { rootPath: $('knowledgeRoot').value } } }); toast(saved.configuration?.scopeStatus?.status === 'pending' ? '设置已保存，共享知识接线待恢复；已有知识保留。' : saved.configuration?.indexStorage?.status === 'ready' ? '设置已保存，索引目录已生效；已有知识未移动。' : '设置已保存，索引目录接线待恢复；已有知识保留。'); await refreshRegistry(true); if (resumeImport) closeSystem(); });
  on('setupImportRoot', 'click', async () => { $('importDialog').close(); resumeImport = true; await openSystem(); $('knowledgeRoot').focus(); });
  on('pickRoot', 'click', () => pick('knowledgeRoot')); on('pickCode', 'click', () => pick('importCode')); on('pickKnowledge', 'click', () => pick('importKnowledge'));
  on('openEngine', 'click', () => { closeSystem(); initializeFrame('engine'); $('engineDialog').showModal(); post('engine', { type: 'kb:visibility', visible: true }); });
  on('engineDialog', 'close', () => post('engine', { type: 'kb:visibility', visible: false }));
  on('openLogs', 'click', async () => { closeSystem(); $('logsDialog').showModal(); await loadLogs(); });
  on('logsDialog', 'close', () => { logEpoch++; logStream?.close(); logStream = null; });
  on('logsScope', 'change', loadLogs);
  on('copyReference', 'click', async () => {
    const text = $('referenceMeta').textContent + '\n\n' + $('referenceContent').textContent;
    try { await navigator.clipboard.writeText(text); }
    catch { const field = document.createElement('textarea'); field.value = text; document.body.append(field); field.select(); const copied = document.execCommand('copy'); field.remove(); if (!copied) throw new Error('复制失败，请选择引用内容手动复制。'); }
    toast('已复制知识与来源。');
  });
  on('loadLogs', 'click', loadLogs);
  on('exportLogs', 'click', async () => { const params = new URLSearchParams({ q: $('logsSearch').value.trim() }); if ($('logsScope').value === 'project' && state.projectId) params.set('projectId', state.projectId); const response = await fetch(`/api/logs/export?${params}`); if (!response.ok) throw new Error('诊断导出失败。'); const blob = await response.blob(); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = 'knowledge-diagnostics.jsonl'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); });
  on('createDomain', 'click', () => { $('domainForm').reset(); $('domainDialog').showModal(); });
  on('domainForm', 'submit', async e => { e.preventDefault(); await api('/api/domains', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }); $('domainDialog').close(); await refreshRegistry(true); });
  on('memoryScopeFilter', 'change', updateMemoryFilter); on('memoryTargetFilter', 'change', renderMemories);
  on('memoryScope', 'change', () => {
    const memory = state.snapshot.memories.find(m => m.id === editingMemoryId), type = $('memoryScope').value;
    const source = state.projects.find(p => p.projectId === memory?.evidence.projectId);
    updateMemoryTarget(type, type === 'project' ? source?.projectId : type === 'domain' ? source?.domainId : '');
  });
  on('memoryForm', 'submit', async e => {
    e.preventDefault();
    if ($('confirmMemory').disabled) return;
    const type = $('memoryScope').value, body = { text: $('memoryText').value, scopeType: type, scopeId: type === 'global' ? state.brain.id : $('memoryTarget').value };
    if (e.submitter?.dataset.mode === 'confirmed') body.status = 'confirmed';
    $('confirmMemory').disabled = true; $('saveMemoryCandidate').disabled = true;
    try {
      const result = await api(`/api/engine/memories/${encodeURIComponent(editingMemoryId)}`, { method: 'PATCH', body });
      $('memoryDialog').close(); await refreshSnapshot();
      toast(result.memory.syncStatus === 'pending' ? '确认已保存，记忆文件待恢复；未同步内容不会注入任务。' : body.status === 'confirmed' ? '记忆内容与适用范围已确认。' : '候选已保存，尚未生效。');
    } catch (error) { $('memoryFeedback').textContent = error.message; $('memoryFeedback').hidden = false; }
    finally { $('confirmMemory').disabled = false; $('saveMemoryCandidate').disabled = false; }
  });
  on('unbindForm', 'submit', async e => {
    e.preventDefault(); if (!unbindProjectId || unbinding) return;
    const projectId = unbindProjectId;
    unbinding = true; $('confirmUnbind').disabled = true; $('confirmUnbind').textContent = '正在解绑…';
    $('unbindFeedback').textContent = '正在停止项目接线并移除登记，磁盘文件不会删除。';
    try {
      await api(`/api/projects/${encodeURIComponent(projectId)}`, { method: 'DELETE', body: { deleteKnowledge: false } });
      state.contexts.delete(projectId);
      state.projects = state.projects.filter(project => project.projectId !== projectId);
      if (state.projectId === projectId) { state.projectId = state.projects[0]?.projectId || ''; state.epoch++; }
      renderProjectOptions(); render(); Object.keys(frames).forEach(frameContext);
      $('unbindDialog').close(); unbindProjectId = '';
      // A late read started before DELETE cannot restore the removed project.
      await refreshRegistry(true); localStorage.setItem('kb.project', state.projectId);
      Object.keys(frames).forEach(frameContext);
      toast('项目已从列表移除，代码、知识和会话仍保留。');
    } catch (error) { $('unbindFeedback').textContent = error.message; }
    finally { unbinding = false; $('confirmUnbind').disabled = false; $('confirmUnbind').textContent = '解绑并保留数据'; }
  });
  on('unbindDialog', 'cancel', e => { if (unbinding) e.preventDefault(); });
  on('importForm', 'input', e => {
    if (e.target.id === 'importCode') { const name = e.target.value.trim().split(/[\\/]/).filter(Boolean).pop() || ''; $('importName').value = name; if (state.root) $('importKnowledge').value = `${state.root.replace(/[\\/]+$/, '')}/${name}-${state.importId.slice(-6)}`; }
    clearTimeout(preflightTimer); $('confirmImport').disabled = true; preflightTimer = setTimeout(checkImport, 250);
  });
  on('importForm', 'submit', async e => {
    e.preventDefault(); if (!state.preflight?.ready || state.preflight.plannedGitInit && !$('importForm').elements.confirmGitInit.checked || state.preflight.checks.hook?.replacementProjectId && !$('importForm').elements.confirmReplaceHook.checked) return;
    $('confirmImport').disabled = true; $('confirmImport').textContent = '正在登记…';
    let failed = false, registered = false;
    try { const result = await api('/api/projects/import', { method: 'POST', body: importInput() }); registered = true; state.projectId = result.projectId; state.epoch++; $('importDialog').close(); await refreshRegistry(true); Object.keys(frames).forEach(frameContext); setView('projects'); toast(Object.values(result.modules).every(m => m.ok) ? '项目已导入，四个模块已连接。' : '项目已导入，部分接线待恢复。'); }
    catch (error) {
      failed = true;
      if (registered) { toast(`项目已登记，但页面状态刷新失败：${error.message}`); return; }
      $('preflightStatus').textContent = `导入失败：${error.message}\n错误码：${error.code || 'UNKNOWN'}${error.operationId ? `\n操作 ID：${error.operationId}` : ''}\n请在系统诊断记录中查看详细原因。`;
      $('preflightStatus').classList.add('issue'); $('confirmImport').disabled = false;
    }
    finally { $('confirmImport').textContent = '导入项目'; if ($('importDialog').open && !failed) checkImport(); }
  });
  window.addEventListener('hashchange', () => setView(location.hash.slice(1)));
  window.addEventListener('offline', () => {
    snapshotEpoch++; clearTimeout(refreshTimer);
    state.stream?.close(); state.stream = null; logStream?.close(); logStream = null; logEpoch++;
    state.engineAvailable = false; $('activityConnection').textContent = '连接中断，恢复后自动读取快照';
    renderSystem(); render();
  });
  window.addEventListener('online', () => {
    $('activityConnection').textContent = state.engineAvailable && state.stream?.readyState === EventSource.OPEN ? '已连接实时更新' : '正在恢复快照'; refreshRegistry();
    if ($('logsDialog').open) loadLogs().catch(error => toast(error.message));
  });
  window.addEventListener('beforeunload', () => { state.stream?.close(); logStream?.close(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSystem(); });
  document.documentElement.dataset.theme = localStorage.getItem('kb.theme') === 'dark' ? 'dark' : 'light';
  all('[data-scope]').forEach(button => button.classList.toggle('active', button.dataset.scope === state.scope));
  state.view = titles[location.hash.slice(1)] ? location.hash.slice(1) : 'home';
  setView(state.view); refreshRegistry();
  setInterval(() => { if (!document.hidden) refreshRegistry(); }, 30000);
})();
