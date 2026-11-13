(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const ProgressSource = window.KnowledgeLive?.EventSource || EventSource;
  const all = selector => [...document.querySelectorAll(selector)];
  const titles = { home: '首页', memory: '长期记忆', projects: '项目', search: '知识检索', activity: '活动记录' };
  const modules = { terminal: 'Agent 工作台', vectorHub: '知识索引', eventBridge: '开发事件', engine: '知识引擎' };
  // The workbench frame stays as a hidden service mount for provider/model
  // configuration from the system drawer; it is no longer a navigation page.
  const frames = {
    terminal: { id: 'workFrame', url: '/modules/terminal/agent-terminal/?embed=1&apiBase=/api/terminal&transport=live', view: '', ready: false },
    eventBridge: { id: 'bridgeFrame', url: '/modules/eventbridge/?embed=1&apiBase=/api/eventbridge', view: 'activity', ready: false },
    engine: { id: 'engineFrame', url: '/modules/engine/?embed=1&apiBase=/api/engine', ready: false },
  };
  const knowledgePanel = { providerId: 'kb.knowledge.references', version: 0, registered: false, registering: false, failed: false, error: null, panelId: '', pending: null, sending: null, queued: false, deliveredPanelId: '' };
  const panelRequests = new Map();
  let panelRequestSeq = 0;
  const state = {
    brain: { id: 'brain-default', name: '我的智脑', domains: [] }, root: '', projects: [], projectId: localStorage.getItem('kb.project') || '', view: 'home',
    health: {}, snapshot: { projects: [], runs: [], events: [], memories: [] }, engineAvailable: false, epoch: 0, contexts: new Map(), stream: null, importId: '', preflight: null, preflightEpoch: 0,
    overview: null, overviewError: null, overviewLoading: false, overviewEpoch: 0,
    groups: { items: [], total: 0, loading: false, epoch: 0 },
    memory: { tab: 'library', folder: 'all', q: '', items: [], total: 0, cursors: [null], page: 0, loading: false, epoch: 0 },
    candidates: { items: [], total: 0, cursors: [null], page: 0, loading: false, epoch: 0 },
    projects: [], projectsPage: { q: '', domain: '', items: [], total: 0, cursors: [null], page: 0, loading: false, epoch: 0, detail: null },
    detailGroups: { detail: null, epoch: 0 },
    search: { q: '', draft: '', projectId: '', scope: 'brain', type: 'all', done: false, results: [], page: 0, loading: false, epoch: 0 },
    activityFilter: 'all', activityTab: 'updates', activityProject: null, activityBefore: null, activityPage: null, runDetails: new Map(),
    pendingOpenRun: '',
  };
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const activeProject = () => state.projects.find(p => p.projectId === state.projectId);
  const domainName = id => state.brain.domains.find(d => d.id === id)?.name || '未分组';
  const projectName = id => state.projects.find(p => p.projectId === id)?.name || id;
  const time = value => value ? new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
  const clamp2 = text => String(text || '').replace(/\n\s*\n/g, '\n');
  const SCOPE_LABEL = { project: '项目记忆', domain: '领域记忆', global: '全局记忆', group: '组合记忆' };
  const recoveryLabel = run => {
    const recovery = run.recovery;
    if (['failed', 'index-pending'].includes(run.state)) {
      if (!recovery) return run.state === 'index-pending' ? '自动恢复中' : '需要处理';
      if (recovery.kind === 'config-blocked') return '等待配置';
      if (recovery.budgetExhaustedAt) return '需要处理';
      return '自动恢复中';
    }
    return '';
  };
  const label = run => run.state === 'queued' && run.phase === 'waiting-previous' ? '等待前一条提交恢复'
    : ['failed', 'index-pending'].includes(run.state) ? `${({ failed: '维护失败', 'index-pending': '索引待修复' })[run.state]} · ${recoveryLabel(run)}`
    : ({ queued: '排队', running: '维护中', succeeded: '已更新 · 可检索', cancelled: '已取消' })[run.state] || run.state;
  const badge = (text, status = '') => `<span class="status ${esc(status)}">${esc(text)}</span>`;
  let toastTimer, refreshTimer, preflightTimer, logStream, logEpoch = 0, referenceEpoch = 0, snapshotEpoch = 0, registryEpoch = 0, registryPromise = null, resumeImport = false, unbindProjectId = '', unbinding = false;
  let captureEpoch = 0, captureBusy = false;
  let registryStream = null, registryReceipt = null, registryRefreshTimer;
  let toastUndo = null;
  async function api(url, options = {}) {
    const { allowNotReady, timeoutMs = (options.method || 'GET') === 'GET' && !url.includes('pick-folder') ? 8000 : 0, ...init } = options;
    if (init.body && typeof init.body !== 'string') init.body = JSON.stringify(init.body);
    if (init.body) init.headers = { 'Content-Type': 'application/json', ...init.headers };
    const controller = new AbortController();
    const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      const data = await response.json();
      if (!response.ok || data.ok === false && !allowNotReady) throw Object.assign(new Error(data.error?.message || data.message || (typeof data.error === 'string' ? data.error : `请求失败 (${response.status})`)), { code: data.error?.code || data.error, operationId: data.error?.operationId || response.headers.get('X-Operation-Id') || '' });
      return data;
    } catch (error) { if (controller.signal.aborted) throw new Error('状态读取超时，保留上次内容，请稍后重试。'); throw error; }
    finally { clearTimeout(timer); }
  }
  function toast(text, undo = null) {
    const box = $('toast');
    box.textContent = '';
    const span = document.createElement('span'); span.textContent = text; box.append(span);
    if (undo) { const button = document.createElement('button'); button.textContent = '撤销'; button.dataset.action = 'toast-undo'; box.append(button); toastUndo = undo; }
    box.hidden = false; clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { box.hidden = true; toastUndo = null; }, 6000);
  }
  function on(id, event, callback) { $(id).addEventListener(event, e => Promise.resolve(callback(e)).catch(error => toast(error.message))); }
  function post(key, message) { const frame = frames[key]; if (frame.ready) $(frame.id).contentWindow.postMessage(message, location.origin); }
  function initializeFrame(key) { const frame = frames[key]; if (!frame.initialized) { $(frame.id).src = frame.url; frame.initialized = true; } }
  function frameVisible(key) { return key === 'engine' ? $('engineDialog').open : key === 'eventBridge' && state.view === 'activity' && state.activityTab === 'sessions'; }
  function frameContext(key) {
    const project = activeProject();
    const frame = frames[key];
    if (!frame.ready) return;
    const ref = key === 'eventBridge' ? project?.modules?.eventBridge?.projectId || project?.workspacePath : project?.projectId;
    frame.requestId = `${state.epoch}:${key}`;
    const signature = JSON.stringify([state.epoch, ref || '', document.documentElement.dataset.theme, frameVisible(key)]);
    if (frame.contextSignature === signature) return;
    frame.contextSignature = signature;
    post(key, { type: 'kb:theme', theme: document.documentElement.dataset.theme });
    post(key, { type: 'kb:select-project', project: ref || '', projectId: project?.projectId || '', requestId: frame.requestId });
    post(key, { type: 'kb:visibility', visible: frameVisible(key) });
  }
  function knowledgePanelFailed(reason) {
    if (knowledgePanel.failed) return;
    if (knowledgePanel.pending) { clearTimeout(knowledgePanel.pending.timer); knowledgePanel.pending = null; }
    knowledgePanel.failed = true;
    knowledgePanel.error = reason;
    knowledgePanel.sending = null; knowledgePanel.queued = false;
    if (knowledgePanel.panelId) toast('知识引用暂时无法加载，请关闭引用标签后重试。');
  }
  function panelRequest(type, payload, timeoutMs = 6000) {
    if (!frames.terminal.ready) return Promise.resolve({ ok: false, code: 'NOT_READY', error: '终端尚未就绪' });
    return new Promise(resolve => {
      const requestId = `kpanel-${++panelRequestSeq}`;
      const timer = setTimeout(() => { if (panelRequests.has(requestId)) { panelRequests.delete(requestId); resolve({ ok: false, code: 'TIMEOUT', error: '面板响应超时' }); } }, timeoutMs);
      panelRequests.set(requestId, reply => { clearTimeout(timer); resolve(reply); });
      post('terminal', { type, requestId, ...payload });
    });
  }
  function knowledgePayload(projectId) {
    const context = state.contexts.get(projectId);
    return {
      title: '本次知识引用', projectId: String(projectId || ''), projectName: state.projects.find(project => project.projectId === projectId)?.name || '',
      theme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
      status: context?.status || 'not-retrieved',
      references: (context?.references || []).slice(0, 50).map(r => ({
        entryId: String(r.entryId || ''), title: String(r.title || r.entryId || ''),
        text: String(r.text || '').slice(0, 800), source: `${r.projectId ? projectName(r.projectId) : ''} / ${r.entryId || ''}`,
      })),
    };
  }
  async function resetKnowledgePanel() {
    if (knowledgePanel.registering) return;
    knowledgePanel.registering = true;
    knowledgePanel.registered = false; knowledgePanel.failed = false; knowledgePanel.error = null;
    knowledgePanel.panelId = ''; knowledgePanel.version = 0;
    knowledgePanel.ready = false;
    knowledgePanel.sending = null; knowledgePanel.queued = false; knowledgePanel.deliveredPanelId = '';
    if (knowledgePanel.pending) { clearTimeout(knowledgePanel.pending.timer); knowledgePanel.pending = null; }
    try {
      const reply = await panelRequest('kb:panel/register', { panel: {
        providerId: knowledgePanel.providerId, panelType: 'knowledge', title: '本次知识引用',
        url: '/knowledge-panel.html', capabilities: ['read-only'], multiInstance: 'single', appliesTo: { projects: '*' },
      } });
      if (reply.ok) { knowledgePanel.registered = true; if (knowledgePanel.panelId) void pushKnowledgeToPanel(); }
      else if (!knowledgePanel.failed) knowledgePanelFailed('注册被拒绝');
    } catch (error) { if (!knowledgePanel.failed) knowledgePanelFailed(error.message); }
    finally { knowledgePanel.registering = false; }
  }
  async function pushKnowledgeToPanel(projectId = state.projectId, panelId = knowledgePanel.panelId) {
    if (!knowledgePanel.registered || knowledgePanel.failed || !projectId || !panelId) return;
    if (knowledgePanel.ready === false) return;
    if (knowledgePanel.sending) { knowledgePanel.queued = true; return; }
    const transfer = { projectId, epoch: state.epoch };
    knowledgePanel.sending = transfer;
    const current = () => knowledgePanel.sending === transfer && state.epoch === transfer.epoch && state.projectId === projectId && knowledgePanel.registered && !knowledgePanel.failed;
    try {
      if (!current() || !panelId) return;
      knowledgePanel.panelId = panelId;
      const version = ++knowledgePanel.version;
      if (knowledgePanel.pending) clearTimeout(knowledgePanel.pending.timer);
      const timer = setTimeout(() => {
        if (knowledgePanel.pending && knowledgePanel.pending.version === version) knowledgePanelFailed('面板未确认内容');
      }, 8000);
      knowledgePanel.pending = { version, projectId, panelId, timer };
      const relayed = await panelRequest('kb:panel/content', { panelId: knowledgePanel.panelId, providerId: knowledgePanel.providerId, version, content: knowledgePayload(projectId) });
      if (current() && !relayed.ok) knowledgePanelFailed('内容投递失败');
    } finally {
      if (knowledgePanel.sending === transfer) {
        knowledgePanel.sending = null;
        if (knowledgePanel.queued) { knowledgePanel.queued = false; void pushKnowledgeToPanel(); }
      }
    }
  }
  function handlePanelState(message) {
    const panel = (message.panels || []).find(p => p.providerId === knowledgePanel.providerId);
    if (!panel) {
      if (knowledgePanel.pending) { clearTimeout(knowledgePanel.pending.timer); knowledgePanel.pending = null; }
      knowledgePanel.panelId = ''; knowledgePanel.deliveredPanelId = '';
      knowledgePanel.ready = false;
      knowledgePanel.failed = false; knowledgePanel.error = null;
      knowledgePanel.sending = null; knowledgePanel.queued = false;
      return;
    }
    if (panel.panelId !== knowledgePanel.panelId) {
      knowledgePanel.failed = false; knowledgePanel.error = null;
      knowledgePanel.deliveredPanelId = '';
    }
    if (panel.panelId) knowledgePanel.panelId = panel.panelId;
    knowledgePanel.ready = panel.ready !== false;
    if (!knowledgePanel.ready) {
      if (knowledgePanel.pending) { clearTimeout(knowledgePanel.pending.timer); knowledgePanel.pending = null; }
      knowledgePanel.deliveredPanelId = '';
      return;
    }
    if (panel.error && panel.error !== 'CONTENT_ACK_ERROR') { knowledgePanelFailed('面板加载失败'); return; }
    if (!knowledgePanel.pending) {
      if (!knowledgePanel.sending && knowledgePanel.deliveredPanelId !== panel.panelId) void pushKnowledgeToPanel(state.projectId, panel.panelId);
      return;
    }
    const pending = knowledgePanel.pending;
    if (pending.projectId !== state.projectId || pending.panelId !== panel.panelId) {
      clearTimeout(pending.timer); knowledgePanel.pending = null;
      if (!knowledgePanel.sending) void pushKnowledgeToPanel(state.projectId, panel.panelId);
      return;
    }
    const ack = panel.content?.ack;
    if (ack && String(ack.version) === String(pending.version)) {
      clearTimeout(pending.timer);
      knowledgePanel.pending = null;
      if (ack.ok && !panel.error) { knowledgePanel.deliveredPanelId = panel.panelId; }
      else knowledgePanelFailed(ack.error || '面板渲染失败');
    } else if (panel.error && panel.error !== 'CONTENT_ACK_ERROR') {
      clearTimeout(pending.timer);
      knowledgePanel.pending = null;
      knowledgePanelFailed('面板加载失败');
    }
  }
  function setView(view) {
    if (!titles[view]) view = 'home';
    const changed = state.view !== view;
    state.view = view;
    history.replaceState(null, '', `#${view}`);
    all('[data-view]').forEach(button => button.classList.toggle('active', button.dataset.view === view));
    all('.view').forEach(section => section.classList.toggle('active', section.id === `view-${view}`));
    $('pageTitle').textContent = titles[view];
    if (view === 'activity' && state.activityTab === 'sessions' && activeProject()) initializeFrame('eventBridge');
    Object.keys(frames).forEach(key => post(key, { type: 'kb:visibility', visible: frameVisible(key) }));
    render();
    if (view === 'home') void loadOverview();
    if (view === 'memory') { void loadGroups(); void loadMemoryPage(); void loadCandidates(); }
    if (view === 'projects' && !state.projectsPage.detail) void loadProjectsPage();
    if (view === 'search') renderSearch();
    if (view === 'activity' && (changed || state.activityProject !== state.projectId)) void loadActivityPage();
  }
  function selectProject(id) {
    if (id === state.projectId && activeProject()) return;
    state.projectId = id; state.epoch++;
    state.snapshot.runs = []; state.activityProject = null; state.activityBefore = null; state.runDetails = new Map();
    void refreshSnapshot();
    referenceEpoch++; $('referenceDialog').close();
    if ($('logsDialog').open) loadLogs().catch(error => toast(error.message));
    if (!$('systemDrawer').hidden) loadAgentCapture().catch(error => toast(error.message));
    localStorage.setItem('kb.project', id);
    $('projectSelect').value = id;
    Object.keys(frames).forEach(frameContext);
    if (knowledgePanel.registered && !knowledgePanel.failed && frames.terminal.ready) void pushKnowledgeToPanel(id);
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
    const candidatesTotal = state.overview?.totals?.candidates ?? 0;
    $('memoryCount').textContent = candidatesTotal; $('memoryCount').hidden = !candidatesTotal;
    const needsTotal = state.overview?.needsTotal ?? 0;
    $('homeCount').textContent = needsTotal; $('homeCount').hidden = !needsTotal;
    if (state.view === 'home') renderHome();
    if (state.view === 'projects') renderProjects();
    if (state.view === 'memory') renderMemories();
    if (state.view === 'search') renderSearch();
    if (state.view === 'activity') renderActivity();
    renderSystem();
  }
  // ============ 首页：全局待办 + 候选 + 组合入口 ============
  async function loadOverview(force = false) {
    if (state.overviewLoading && !force) return;
    const epoch = ++state.overviewEpoch;
    state.overviewLoading = true;
    try {
      const overview = await api('/api/engine/overview');
      if (epoch !== state.overviewEpoch) return;
      state.overview = overview; state.overviewError = null;
    } catch (error) {
      if (epoch !== state.overviewEpoch) return;
      state.overviewError = error.message;
    } finally { if (epoch === state.overviewEpoch) state.overviewLoading = false; }
    if (state.view === 'home') renderHome();
    render();
  }
  function needRow(item) {
    if (item.kind === 'run') return `<div class="row"><div><b>${esc(item.title)} · ${esc(projectName(item.projectId))}</b><small>${esc(item.commitSha?.slice(0, 8) || '')} ${esc(item.error?.message || '')}</small></div>${badge(recoveryLabel(item) || '需要处理', 'issue')}<button data-open-run="${esc(item.runId)}" data-run-project="${esc(item.projectId)}">去处理</button></div>`;
    if (item.kind === 'journal') return `<div class="row"><div><b>提交事件消费受阻</b><small>${esc(item.journalId)} · ${esc(item.message)}</small></div>${badge('需要处理', 'issue')}</div>`;
    if (item.kind === 'late-commit') return `<div class="row"><div><b>晚到的旧提交待受控处理</b><small>${esc(projectName(item.projectId))} · ${esc(String(item.commitSha || '').slice(0, 12))}</small></div>${badge('需要处理', 'issue')}</div>`;
    if (item.kind === 'scope-index') return `<div class="row"><div><b>共享知识索引待恢复</b><small>${esc(item.name)} · ${esc(item.message)}</small></div>${badge('需要处理', 'issue')}</div>`;
    return '';
  }
  function renderHome() {
    if (!state.projectsLoaded) { $('homeContent').innerHTML = state.projectsError ? '<div class="empty">项目登记读取失败，未把失败当作空知识库。<button data-action="refresh">重试读取</button></div>' : '<div class="empty">正在读取项目登记…</div>'; return; }
    if (state.overviewError) {
      $('homeContent').innerHTML = `<div class="empty">全局状态读取失败：${esc(state.overviewError)}<br>已保存的待办与记忆不受影响，也不会显示为零待办。<button data-action="reload-overview">重试</button></div>`;
      return;
    }
    if (!state.overview) { $('homeContent').innerHTML = '<div class="empty">正在读取全局待办…</div>'; return; }
    if (!state.projects.length) { $('homeContent').innerHTML = '<div class="empty"><h2>从第一个项目开始</h2><p>选择代码目录和知识目录，保留项目原有文件。</p><button class="primary" data-action="import">导入第一个项目</button></div>'; return; }
    const overview = state.overview;
    const needs = overview.needsPreview || [];
    const candidates = overview.candidatesPreview || [];
    const recovering = overview.recoveringPreview || [];
    const groups = overview.groupsPreview || [];
    const needsRows = needs.slice(0, 3).map(needRow).join('') || '<p class="small-empty">目前没有需要你处理的事项。</p>';
    const candidateRows = candidates.slice(0, 3).map(m => `<div class="row"><div><b>${esc(m.title)}</b><small>${esc(clamp2(m.text).slice(0, 120))}</small><small>${m.evidence ? `来源：${esc(projectName(m.evidence.projectId))} · commit ${esc(m.evidence.commitSha.slice(0, 8))}` : '来源：手动添加'}</small></div><button data-action="review-candidate" data-id="${esc(m.id)}">审核</button></div>`).join('') || '<p class="small-empty">没有待确认的记忆。智脑不会自动把项目行为当作你的偏好。</p>';
    const comboCards = groups.slice(0, 4).map(g => `<button class="combo-card" data-action="open-group" data-id="${esc(g.id)}"><div><b>${esc(g.name)}</b><small>${g.memberCount} 条记忆 · ${g.boundProjectCount} 个项目</small></div><span aria-hidden="true">›</span></button>`).join('') || '<p class="small-empty">还没有记忆组合。到「长期记忆」创建第一个组合。</p>';
    $('homeContent').innerHTML = `
      <div class="grid2">
        <section class="panel"><h2>需要处理 ${overview.needsTotal ? badge(overview.needsTotal, 'issue') : ''}</h2>${needsRows}
          ${overview.needsTotal > needs.length ? '<button data-action="activity-needs">查看全部待办</button>' : ''}
          ${overview.totals.recovering ? `<div class="recovery-banner">${overview.totals.recovering} 项正在自动恢复，无需操作<button data-action="activity-recovering">查看</button></div>` : ''}
        </section>
        <section class="panel"><h2>待确认记忆 ${overview.totals.candidates ? badge(overview.totals.candidates, '') : ''}</h2>${candidateRows}
          ${overview.totals.candidates > candidates.length ? '<button data-go="memory">查看候选箱</button>' : ''}
        </section>
      </div>
      <section class="panel" style="margin-top:24px"><div class="section-heading" style="margin-bottom:12px"><h2>记忆组合</h2><button data-go="memory">管理记忆</button></div><div class="combo-grid">${comboCards}</div></section>`;
  }
  // ============ 长期记忆：组合 + 独立小记忆 + 候选 ============
  async function loadGroups() {
    const epoch = ++state.groups.epoch;
    state.groups.loading = true;
    try {
      const result = await api('/api/engine/memory-groups?limit=100');
      if (epoch !== state.groups.epoch) return;
      state.groups.items = result.groups; state.groups.total = result.total;
    } catch (error) { if (epoch === state.groups.epoch) toast('组合列表读取失败：' + error.message); }
    finally { if (epoch === state.groups.epoch) state.groups.loading = false; }
    if (state.view === 'memory') renderMemories();
  }
  const groupById = id => state.groups.items.find(g => g.id === id);
  async function loadMemoryPage() {
    const memory = state.memory;
    const epoch = ++memory.epoch;
    memory.loading = true;
    try {
      const params = new URLSearchParams({ status: 'confirmed', limit: '10' });
      if (memory.folder === 'ungrouped') params.set('ungrouped', '1');
      else if (memory.folder !== 'all') params.set('groupId', memory.folder);
      if (memory.q.trim()) params.set('q', memory.q.trim());
      const cursor = memory.cursors[memory.page];
      if (cursor) params.set('cursor', cursor);
      const result = await api('/api/engine/memories?' + params);
      if (epoch !== memory.epoch) return;
      memory.items = result.memories; memory.total = result.total;
      if (result.nextCursor) memory.cursors[memory.page + 1] = result.nextCursor; else memory.cursors.length = memory.page + 1;
    } catch (error) { if (epoch === memory.epoch) toast('记忆列表读取失败：' + error.message); }
    finally { if (epoch === memory.epoch) memory.loading = false; }
    if (state.view === 'memory') renderMemories();
  }
  async function loadCandidates() {
    const candidates = state.candidates;
    const epoch = ++candidates.epoch;
    candidates.loading = true;
    try {
      const params = new URLSearchParams({ status: 'candidate', limit: '10' });
      const cursor = candidates.cursors[candidates.page];
      if (cursor) params.set('cursor', cursor);
      const result = await api('/api/engine/memories?' + params);
      if (epoch !== candidates.epoch) return;
      candidates.items = result.memories; candidates.total = result.total;
      if (result.nextCursor) candidates.cursors[candidates.page + 1] = result.nextCursor; else candidates.cursors.length = candidates.page + 1;
    } catch (error) { if (epoch === candidates.epoch) toast('候选列表读取失败：' + error.message); }
    finally { if (epoch === candidates.epoch) candidates.loading = false; }
    if (state.view === 'memory') renderMemories();
  }
  function memoryCard(m) {
    const scopeText = m.scopeType === 'group' ? (m.groups?.length ? `组合：${m.groups.map(g => esc(g.name)).join('、')}` : '未归组合') : `${SCOPE_LABEL[m.scopeType] || ''} · ${m.scopeType === 'domain' ? esc(domainName(m.scopeId)) : m.scopeType === 'project' ? esc(projectName(m.scopeId)) : '所有项目'}`;
    const statusBadge = m.targetAvailable === false ? badge('目标已失效，不会注入', 'issue') : m.syncStatus === 'pending' ? badge('写入待恢复', 'issue') : '';
    return `<article class="memory-item"><button class="reference" data-action="memory-detail" data-id="${esc(m.id)}"><b>${esc(m.title)}</b><small>${esc(clamp2(m.text).slice(0, 160))}</small><small>${scopeText}</small></button><div class="actions">${statusBadge}<button data-action="memory-edit" data-id="${esc(m.id)}">编辑</button><button data-action="memory-groups" data-id="${esc(m.id)}">组合归属</button>${m.sourceType !== 'manual' ? `<button data-action="memory-evidence" data-id="${esc(m.id)}">查看依据</button>` : ''}<button data-action="memory-delete" data-id="${esc(m.id)}">删除</button></div></article>`;
  }
  function pagerUi(kind, page, total, pageSize) {
    const pages = Math.max(1, Math.ceil(total / pageSize));
    if (total <= pageSize && page === 0) return '';
    return `<div class="pager"><span>${total ? page * pageSize + 1 : 0}–${Math.min((page + 1) * pageSize, total)} / ${total}</span><div class="actions"><button data-page="${kind}" data-value="${page - 1}" ${page === 0 ? 'disabled' : ''}>上一页</button><span>${page + 1} / ${pages}</span><button data-page="${kind}" data-value="${page + 1}" ${page + 1 >= pages ? 'disabled' : ''}>下一页</button></div></div>`;
  }
  function renderMemories() {
    if (!state.engineAvailable) { $('memoryContent').innerHTML = '<div class="empty">知识引擎暂时不可用。未读取到的记忆不会显示为已确认。</div>'; return; }
    const memory = state.memory, candidates = state.candidates;
    if (memory.tab === 'candidate') {
      const rows = candidates.items.map(m => `<div class="row"><div><b>${esc(m.title)}</b><small>${esc(clamp2(m.text).slice(0, 140))}</small><small>${m.evidence ? `来源：${esc(projectName(m.evidence.projectId))} · ${esc(m.evidence.commitSha.slice(0, 8))}` : '来源：手动添加'}</small></div><button class="primary" data-action="review-candidate" data-id="${esc(m.id)}">审核</button></div>`).join('');
      $('memoryContent').innerHTML = `<div class="segmented" style="margin-bottom:20px"><button data-memory-tab="library">记忆库</button><button class="active" data-memory-tab="candidate">候选箱 ${candidates.total || ''}</button></div>
        ${rows || '<div class="empty small-empty">候选箱为空。维护产物中的有据偏好会进入这里，等待你的确认。</div>'}
        ${pagerUi('candidate', candidates.page, candidates.total, 10)}`;
      return;
    }
    const current = memory.folder !== 'all' && memory.folder !== 'ungrouped' ? groupById(memory.folder) : null;
    const folderName = current ? current.name : memory.folder === 'ungrouped' ? '未归组合' : '全部记忆';
    const folders = `<aside class="memory-folders">
        <button class="${memory.folder === 'all' ? 'active' : ''}" data-folder="all">全部记忆</button>
        <button class="${memory.folder === 'ungrouped' ? 'active' : ''}" data-folder="ungrouped">未归组合</button>
        <hr>
        ${state.groups.items.map(g => `<button class="${memory.folder === g.id ? 'active' : ''}" data-folder="${esc(g.id)}">${esc(g.name)} <small>${g.memberCount}</small></button>`).join('')}
        <hr>
        <button data-action="new-group">＋ 新建组合</button>
      </aside>`;
    const header = `<div class="section-heading" style="margin-bottom:12px"><div><h2>${esc(folderName)}</h2><p>${current ? `<button class="link-button" data-action="group-projects" data-id="${esc(current.id)}">应用到项目（${current.boundProjectCount}）</button>` : memory.folder === 'ungrouped' ? '不在任何组合中的记忆；加入组合并应用到项目后生效。' : '包含全部已确认记忆；同一记忆被多处引用时只保留一条。'}</p></div>
      <div class="actions">${current ? `<button data-action="group-settings" data-id="${esc(current.id)}">组合设置</button><button data-action="add-existing" data-id="${esc(current.id)}">选入已有记忆</button>` : ''}<button class="primary" data-action="new-memory">＋ 添加记忆</button></div></div>`;
    const items = memory.items.map(m => memoryCard(m)).join('') || '<div class="empty small-empty">没有匹配的记忆。</div>';
    $('memoryContent').innerHTML = `<div class="segmented" style="margin-bottom:20px"><button class="active" data-memory-tab="library">记忆库</button><button data-memory-tab="candidate">候选箱 ${state.overview?.totals?.candidates || ''}</button></div>
      <div class="memory-layout">${folders}<section class="memory-main">
        ${header}
        <div class="actions" style="margin-bottom:16px"><input id="memoryQuery" placeholder="查找记忆标题或内容" aria-label="查找记忆" value="${esc(memory.q)}" style="flex:1"></div>
        <div class="memory-list">${items}</div>
        ${pagerUi('memory', memory.page, memory.total, 10)}
      </section></div>`;
  }
  // ============ 项目：服务端分页 + 组合标签 + 生效记忆 ============
  async function loadProjectsPage() {
    const projects = state.projectsPage;
    const epoch = ++projects.epoch;
    projects.loading = true;
    try {
      const params = new URLSearchParams({ limit: '20' });
      if (projects.q.trim()) params.set('q', projects.q.trim());
      if (projects.domain) params.set('domain', projects.domain);
      const cursor = projects.cursors[projects.page];
      if (cursor) params.set('cursor', cursor);
      const result = await api('/api/projects/page?' + params);
      if (epoch !== projects.epoch) return;
      projects.items = result.projects; projects.total = result.total;
      if (result.nextCursor) projects.cursors[projects.page + 1] = result.nextCursor; else projects.cursors.length = projects.page + 1;
      await Promise.allSettled(result.projects.map(async p => {
        try { const groups = await api(`/api/engine/projects/${encodeURIComponent(p.projectId)}/memory-groups`); if (epoch === projects.epoch) p.groups = groups.groups; } catch { if (epoch === projects.epoch) p.groups = []; }
      }));
    } catch (error) { if (epoch === projects.epoch) toast('项目列表读取失败：' + error.message); }
    finally { if (epoch === projects.epoch) projects.loading = false; }
    if (state.view === 'projects') renderProjects();
  }
  async function openProjectDetail(projectId) {
    state.projectsPage.detail = projectId;
    state.detailGroups.loadingDetail = projectId;
    try { await Promise.all([loadProjectsPage(), loadDetail(projectId)]); }
    finally { if (state.detailGroups.loadingDetail === projectId) state.detailGroups.loadingDetail = null; }
    renderProjects();
  }
  async function loadDetail(projectId) {
    const epoch = ++state.detailGroups.epoch;
    const detail = { projectId, groups: [], effective: { items: [], total: 0, cursors: [null], page: 0 } };
    state.detailGroups.detail = detail;
    state.detailGroups.loadingDetail = projectId;
    try {
      const [groups, effective] = await Promise.all([
        api(`/api/engine/projects/${encodeURIComponent(projectId)}/memory-groups`),
        api(`/api/engine/projects/${encodeURIComponent(projectId)}/effective-memories?limit=10`),
      ]);
      if (epoch !== state.detailGroups.epoch) return;
      detail.groups = groups.groups;
      detail.effective.items = effective.memories; detail.effective.total = effective.total;
      if (effective.nextCursor) detail.effective.cursors[1] = effective.nextCursor;
    } catch (error) { if (epoch === state.detailGroups.epoch) toast('项目详情读取失败：' + error.message); }
    if (state.view === 'projects') renderProjects();
  }
  async function loadDetailEffectivePage() {
    const detail = state.detailGroups.detail;
    if (!detail) return;
    const epoch = state.detailGroups.epoch;
    const cursor = detail.effective.cursors[detail.effective.page];
    try {
      const params = new URLSearchParams({ limit: '10' });
      if (cursor) params.set('cursor', cursor);
      const effective = await api(`/api/engine/projects/${encodeURIComponent(detail.projectId)}/effective-memories?` + params);
      if (epoch !== state.detailGroups.epoch) return;
      detail.effective.items = effective.memories; detail.effective.total = effective.total;
      if (effective.nextCursor) detail.effective.cursors[detail.effective.page + 1] = effective.nextCursor; else detail.effective.cursors.length = detail.effective.page + 1;
    } catch (error) { toast('生效记忆读取失败：' + error.message); }
    renderProjects();
  }
  function groupTag(group, projectId) {
    return `<span class="group-tag" draggable="true" data-drag-group="${esc(group.id)}" data-project="${esc(projectId)}"><span>${esc(group.name)}</span><button data-action="unlink-group" data-id="${esc(group.id)}" data-project="${esc(projectId)}" aria-label="从项目移除组合 ${esc(group.name)}" draggable="false">×</button></span>`;
  }
  function renderProjects() {
    const detailId = state.projectsPage.detail;
    const detailLoading = state.detailGroups.loadingDetail === detailId;
    if (detailId && detailLoading && state.detailGroups.detail?.projectId === detailId) return renderProjectDetail();
    if (detailId && !detailLoading && state.projectsPage.items.some(p => p.projectId === detailId) && state.detailGroups.detail?.projectId === detailId) return renderProjectDetail();
    if (!detailLoading) state.projectsPage.detail = null;
    const rows = state.projectsPage.items.map(p => `<div class="project-row" data-drop-project="${esc(p.projectId)}">
        <div class="project-name"><button class="link-button" data-action="project-detail" data-id="${esc(p.projectId)}">${esc(p.name)}</button><small>${esc(domainName(p.domainId))}</small></div>
        <div class="group-tags">${(p.groups || []).slice(0, 3).map(g => groupTag(g, p.projectId)).join('') || '<small>未挂载组合</small>'}${(p.groups || []).length > 3 ? `<button class="link-button" data-action="project-detail" data-id="${esc(p.projectId)}">＋${p.groups.length - 3}</button>` : ''}</div>
        <button data-action="project-groups" data-id="${esc(p.projectId)}">＋ 组合</button>
      </div>`).join('') || '<div class="empty small-empty">没有匹配的项目。</div>';
    $('projectsContent').innerHTML = `
      <div class="actions" style="margin-bottom:16px">
        <input id="projectQuery" placeholder="搜索全部项目（名称或目录）" aria-label="搜索项目" value="${esc(state.projectsPage.q)}" style="flex:1">
        <select id="projectDomainFilter" aria-label="按领域筛选"><option value="">全部领域</option>${state.brain.domains.map(d => `<option value="${esc(d.id)}" ${state.projectsPage.domain === d.id ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select>
      </div>
      <div class="dragbar" data-unlink-drop><span>拖动组合到项目行可应用；把项目上的标签拖回这里解除</span>${state.groups.items.map(g => `<button draggable="true" data-drag-group="${esc(g.id)}" data-action="group-projects" data-id="${esc(g.id)}">${esc(g.name)}</button>`).join('')}</div>
      ${rows}
      ${pagerUi('projects', state.projectsPage.page, state.projectsPage.total, 20)}`;
  }
  function renderProjectDetail() {
    const detail = state.detailGroups.detail;
    const project = state.projectsPage.items.find(p => p.projectId === detail.projectId);
    if (!project) { state.projectsPage.detail = null; return renderProjects(); }
    const effective = detail.effective;
    const items = effective.items.map(m => `<article class="memory-item"><button class="reference" data-action="memory-detail" data-id="${esc(m.id)}"><b>${esc(m.title)}</b><small>${esc(clamp2(m.text).slice(0, 160))}</small><small>${(m.sources || []).map(s => s.kind === 'group' ? `组合：${esc(s.groupName)}` : `${SCOPE_LABEL[s.scopeType] || '作用域'}`).join(' · ')}</small></button></article>`).join('') || '<div class="empty small-empty">为项目添加组合后，在这里查看生效记忆。</div>';
    $('projectsContent').innerHTML = `
      <div class="section-heading"><button class="link-button" data-action="project-list">‹ 返回项目列表</button><div class="actions"><button data-action="unbind">解绑并保留数据</button><button data-action="edit-project" data-id="${esc(project.projectId)}">项目设置</button></div></div>
      <h2>${esc(project.name)}</h2><p>${esc(domainName(project.domainId))}</p>
      <div class="detail-path">${esc(project.workspacePath)}</div>
      <section class="panel" style="margin-top:20px"><div class="section-heading" style="margin-bottom:12px"><h2>使用的组合</h2><button data-action="project-groups" data-id="${esc(project.projectId)}">＋ 添加组合</button></div>
        <div class="group-tags">${detail.groups.map(g => groupTag(g, project.projectId)).join('') || '<small>尚未添加组合</small>'}</div></section>
      <section class="panel" style="margin-top:20px"><h2>生效记忆 <small>${effective.total} 条 · 已按记忆去重</small></h2>
        <div class="memory-list">${items}</div>
        ${pagerUi('effective', effective.page, effective.total, 10)}</section>`;
  }
  // ============ 检索：真实引擎 API ============
  function renderSearch() {
    const search = state.search;
    const projectOptions = [`<option value="">全部项目</option>`, ...state.projects.map(p => `<option value="${esc(p.projectId)}" ${search.projectId === p.projectId ? 'selected' : ''}>${esc(p.name)}</option>`)].join('');
    const typeOptions = [['all', '知识与记忆'], ['knowledge', '项目知识'], ['memory', '长期记忆']].map(([id, name]) => `<option value="${id}" ${search.type === id ? 'selected' : ''}>${name}</option>`).join('');
    let resultsHtml = '<div class="empty small-empty">输入关键词，查找已保存的项目知识和长期记忆。</div>';
    if (search.done) {
      const filtered = search.results.filter(r => search.type === 'all' || (search.type === 'memory') === Boolean(r.memoryId));
      const pageRows = filtered.slice(search.page * 8, (search.page + 1) * 8).map((r, i) => `<article class="result-row"><button class="reference" data-action="search-detail" data-index="${search.page * 8 + i}"><b>${esc(r.title)}</b><small>${esc(clamp2(r.snippet || r.chunk_text || '').slice(0, 180))}</small></button><small>${r.memoryId ? `长期记忆${r.memoryScopeType && r.memoryScopeType !== 'group' ? ' · ' + (SCOPE_LABEL[r.memoryScopeType] || '') : ''}` : `${esc(projectName(r.scope_project_id || r.projectId))}${r.commitSha ? ` · commit ${esc(r.commitSha.slice(0, 8))}` : ''}`}</small></article>`).join('');
      resultsHtml = `<p class="muted" style="margin:12px 0">${search.results.length} 条结果${filtered.length !== search.results.length ? `（当前筛选 ${filtered.length} 条）` : ''}</p>${pageRows || '<div class="empty small-empty">没有找到匹配内容，试试其他关键词。</div>'}${pagerUi('search', search.page, filtered.length, 8)}`;
    }
    $('searchContent').innerHTML = `
      <form id="searchForm"><div class="actions" style="margin-bottom:12px">
        <input name="query" placeholder="搜索知识或记忆，例如：测试、索引" aria-label="搜索知识和记忆" value="${esc(search.draft)}" style="flex:1">
        <button class="primary" type="submit">搜索</button></div>
        <div class="actions">
          <select name="project" aria-label="检索项目">${projectOptions}</select>
          <select name="type" aria-label="检索类型">${typeOptions}</select>
          <select name="scope" aria-label="检索范围">${[['brain', '整个智脑'], ['domain', '所属领域'], ['project', '当前项目']].map(([id, name]) => `<option value="${id}" ${search.scope === id ? 'selected' : ''}>${name}</option>`).join('')}</select>
        </div></form>
      ${search.loading ? '<div class="empty small-empty">正在检索…</div>' : resultsHtml}`;
    const form = $('searchForm');
    if (form) {
      form.addEventListener('submit', event => { event.preventDefault(); runSearch(new FormData(form)); });
      form.elements.query.addEventListener('input', () => { state.search.draft = form.elements.query.value; });
    }
  }
  async function runSearch(formData) {
    const search = state.search;
    search.q = String(formData.get('query') || '').trim();
    search.draft = search.q;
    search.projectId = String(formData.get('project') || '');
    search.type = String(formData.get('type') || 'all');
    search.scope = String(formData.get('scope') || 'brain');
    search.page = 0;
    if (!search.q) { toast('请输入检索关键词。'); return; }
    const epoch = ++search.epoch;
    search.loading = true; search.done = false;
    renderSearch();
    try {
      const body = { query: search.q, scope: search.scope, limit: 30 };
      if (search.projectId) body.projectId = search.projectId;
      else if (state.projectId && search.scope !== 'brain') body.projectId = state.projectId;
      const result = await api('/api/engine/search', { method: 'POST', body, timeoutMs: 15000 });
      if (epoch !== search.epoch) return;
      search.results = result.results || [];
      search.done = true;
    } catch (error) {
      if (epoch !== search.epoch) return;
      search.results = []; search.done = true;
      toast('检索失败：' + error.message);
    } finally { if (epoch === search.epoch) search.loading = false; }
    renderSearch();
  }
  // ============ 活动记录 ============
  function maintenanceWarning() {
    const status = state.snapshot.maintenance;
    if (!status || !state.engineAvailable) return null;
    if (Object.hasOwn(status, 'projectId') && status.projectId !== (state.projectId || null)) return null;
    if (status.journal?.error) return { title: '提交事件消费受阻', message: '部分提交可能尚未生成分析任务，请查看诊断日志并恢复事件消费。', failures: status.journal.failures || [] };
    if (status.executionEnabled === false || status.consuming === false) return { title: '提交维护尚未启用', message: '请在系统状态中检查项目接线；事件消费恢复后，已捕获的提交才能进入分析队列。', failures: [] };
    return null;
  }
  function renderActivity() {
    all('[data-activity-tab]').forEach(button => button.classList.toggle('active', button.dataset.activityTab === state.activityTab));
    $('activityUpdates').hidden = state.activityTab !== 'updates'; $('activitySessions').hidden = state.activityTab !== 'sessions';
    if (state.activityTab === 'sessions') return;
    const filters = [['all', '全部'], ['recovering', '自动恢复'], ['needs', '需处理'], ['completed', '已完成'], ['changes', '操作记录']];
    const filterBar = `<div class="segmented" style="margin-bottom:16px">${filters.map(([id, name]) => `<button data-activity-filter="${id}" class="${state.activityFilter === id ? 'active' : ''}">${name}</button>`).join('')}</div>`;
    let body;
    if (state.activityFilter === 'changes') {
      const events = state.snapshot.events || [];
      body = events.map(e => `<div class="row"><div><b>${esc(e.summary)}</b><small>${e.projectId ? esc(projectName(e.projectId)) + ' · ' : ''}${time(e.at)}</small></div></div>`).join('') || '<div class="empty small-empty">还没有操作记录。</div>';
    } else {
      const runs = (state.activityProject === state.projectId ? state.activityPage?.runs || [] : state.snapshot.runs)
        .filter(r => !state.projectId || r.projectId === state.projectId)
        .map(r => ({ ...state.runDetails?.get(r.runId), ...r }))
        .filter(r => state.activityFilter === 'all'
          || (state.activityFilter === 'needs' && ['failed', 'index-pending'].includes(r.state) && recoveryLabel(r) !== '自动恢复中')
          || (state.activityFilter === 'recovering' && recoveryLabel(r) === '自动恢复中')
          || (state.activityFilter === 'completed' && r.state === 'succeeded'));
      const open = new Set(all('.run[open]').map(d => d.dataset.runId));
      body = state.engineAvailable ? runs.map(r => `<details class="run" data-run-id="${esc(r.runId)}" ${open.has(r.runId) ? 'open' : ''}><summary><time>${time(r.startedAt)}</time><strong>${esc(projectName(r.projectId))} · ${esc(r.commitSha.slice(0, 8))}</strong>${badge(label(r), ['failed', 'index-pending'].includes(r.state) && recoveryLabel(r) !== '自动恢复中' ? 'issue' : r.state === 'succeeded' ? 'up' : '')}</summary><div><p>提交：${esc(r.commitSha)}<br>阶段：${esc(r.phase)} · 入口：${esc(r.trigger)}<br>知识晋升：${time(r.promotedAt)} · 索引：${esc(r.indexState)}${r.recovery ? `<br>恢复：${esc(recoveryLabel(r))} · 已尝试 ${r.recovery.attempts} 次${r.recovery.nextRetryAt ? ` · 下次 ${time(r.recovery.nextRetryAt)}` : ''}` : ''}</p>${r.error ? `<p class="error">${esc(r.error.message)} (${esc(r.error.code)})</p>${r.error.details ? `<p>失败原因：${esc(r.error.details.upstreamMessage)}<br>类别：${esc(r.error.details.failureKind)} · HTTP：${esc(r.error.details.httpStatus ?? '—')} · 尝试：${esc(r.error.details.attempt)}</p>` : ''}` : ''}${(r.staging?.operations || []).map(op => `<div class="operation">${esc(op.operation)} · ${esc(op.path)}<br>${esc(op.reason)}</div>`).join('')}${['failed', 'index-pending'].includes(r.state) ? `<button data-retry-run="${esc(r.runId)}">重试失败阶段</button>` : ''}</div></details>`).join('') || '<div class="empty small-empty">此分类没有记录。</div>' : '<div class="empty small-empty">知识引擎离线。记录仍保留在本机，连接恢复后自动读取。</div>';
      const nav = `<div class="actions" style="margin-top:12px">${state.activityBefore ? '<button data-run-page="">回到最新记录</button>' : ''}${state.activityPage?.nextCursor ? `<button data-run-page="${esc(state.activityPage.nextCursor)}">更早的记录</button>` : ''}</div>`;
      body += nav;
    }
    $('activityUpdates').innerHTML = filterBar + body;
    applyPendingOpenRun();
    renderMaintenanceWarning();
  }
  // A home「去处理」click must land on its exact run even though the activity
  // list re-renders from several async sources (snapshot refresh, SSE, older-
  // page loads): the pending id survives those renders and is applied once
  // the row really exists, so the race can never swallow the expansion.
  function applyPendingOpenRun() {
    if (!state.pendingOpenRun) return;
    const row = document.querySelector(`details.run[data-run-id="${CSS.escape(state.pendingOpenRun)}"]`);
    if (!row) return;
    state.pendingOpenRun = '';
    if (!row.open) row.open = true;
    row.scrollIntoView({ block: 'center' });
  }
  function renderMaintenanceWarning() {
    const warning = maintenanceWarning();
    if (warning) {
      const notice = document.createElement('div'); notice.className = 'empty error';
      const title = document.createElement('strong'); title.textContent = warning.title;
      const message = document.createElement('p'); message.textContent = warning.message;
      notice.append(title, message);
      for (const failure of warning.failures) {
        const detail = document.createElement('small');
        detail.textContent = `${failure.code} · ${failure.journalId}${failure.sequence === null ? '' : ` · 事件 ${failure.sequence}`}`;
        notice.append(detail);
      }
      $('activityUpdates').prepend(notice);
    }
  }
  let activityEpoch = 0;
  // The home「需要处理」panel is an entry into handling, not a read-only
  // preview: one click opens the exact failed run in the activity view —
  // expanded, details loading, retry within reach — instead of leaving the
  // user to hunt for the record the home page already named.
  async function openRunDetail(runId, projectId) {
    state.activityTab = 'updates';
    state.pendingOpenRun = runId;
    if (projectId && projectId !== state.projectId) selectProject(projectId);
    setView('activity');
    await loadActivityPage();
    applyPendingOpenRun();
    if (!document.querySelector(`details.run[data-run-id="${CSS.escape(runId)}"]`)) {
      state.pendingOpenRun = '';
      toast('这条记录不在最近一页运行中，请从活动记录列表手动查找。');
    }
  }
  async function loadActivityPage(before = state.activityBefore) {
    const epoch = ++activityEpoch, projectId = state.projectId;
    if (!projectId) return;
    try {
      const result = await api(`/api/engine/runs?summary=1&limit=50&projectId=${encodeURIComponent(projectId)}${before ? `&before=${encodeURIComponent(before)}` : ''}`);
      if (epoch !== activityEpoch || projectId !== state.projectId) return;
      state.activityProject = projectId; state.activityPage = result; state.activityBefore = before;
      if (state.view === 'activity') renderActivity();
    } catch { if (epoch === activityEpoch) toast('运行列表刷新失败，保留已有记录。'); }
  }
  document.addEventListener('toggle', async event => {
    const node = event.target;
    if (!node.matches?.('.run[open]') || !node.dataset.runId || node.dataset.loading) return;
    const id = node.dataset.runId, projectId = state.projectId;
    state.runDetails ||= new Map(); if (state.runDetails.has(id)) return;
    node.dataset.loading = '1';
    try { const result = await api(`/api/engine/runs/${encodeURIComponent(id)}`); if (projectId !== state.projectId || result.run.projectId !== projectId) return; state.runDetails.set(id, result.run); renderActivity(); }
    catch { if (projectId === state.projectId) toast('运行详情读取失败，请重新展开重试。'); }
    finally { delete node.dataset.loading; }
  }, true);
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
    const projectId = state.projectId;
    try { const snapshot = await api(`/api/engine/snapshot?summary=1&limit=50${projectId ? `&projectId=${encodeURIComponent(projectId)}` : ''}`); if (epoch !== snapshotEpoch || projectId !== state.projectId || !navigator.onLine) return; state.snapshot = snapshot; state.engineAvailable = true; state.snapshotStale = false; }
    catch { if (epoch !== snapshotEpoch) return; state.snapshotStale = true; }
    render();
    if (state.view === 'activity') void loadActivityPage();
    if (state.view === 'home') void loadOverview(true);
  }
  function scheduleRefresh() { if (!navigator.onLine) return; clearTimeout(refreshTimer); refreshTimer = setTimeout(() => { refreshSnapshot(); post('eventBridge', { type: 'kb:refresh' }); }, 160); }
  function connectProgress() {
    if (!navigator.onLine || !state.health.engine?.up || state.stream) return;
    const stream = new ProgressSource('/api/engine/progress?summary=1'); state.stream = stream;
    stream.addEventListener('snapshot', () => { if (state.stream !== stream) return; $('activityConnection').textContent = '已连接实时更新'; scheduleRefresh(); });
    stream.addEventListener('progress', () => { if (state.stream === stream) scheduleRefresh(); });
    stream.onerror = () => { if (state.stream === stream) $('activityConnection').textContent = '连接中断，正在恢复快照'; };
  }
  function connectRegistryEvents() {
    if (registryStream || !navigator.onLine) return;
    const stream = registryStream = new ProgressSource('/api/registry/events');
    const changed = event => {
      if (registryStream !== stream) return;
      let receipt; try { receipt = JSON.parse(event.data); } catch { return; }
      const signature = `${receipt.instanceId}:${receipt.revision}`;
      const previous = registryReceipt; registryReceipt = signature;
      if (!previous || previous === signature) return;
      clearTimeout(registryRefreshTimer);
      registryRefreshTimer = setTimeout(() => { if (!document.hidden) void refreshRegistry(); }, 100);
    };
    stream.addEventListener('registry-snapshot', changed);
    stream.addEventListener('registry-changed', changed);
  }
  function refreshRegistry(force = false) {
    if (!navigator.onLine) return Promise.resolve();
    if (registryPromise && !force) return registryPromise;
    const epoch = ++registryEpoch;
    const job = (async () => {
      try {
        const apply = () => { if (epoch !== registryEpoch) return; renderProjectOptions(); renderSystem(); setView(state.view); };
        const projects = api('/api/projects/projection').then(result => {
          if (epoch !== registryEpoch) return;
          state.projects = result.projects; state.projectsLoaded = true; state.projectsError = null;
          if (!activeProject()) { state.projectId = state.projects[0]?.projectId || ''; state.epoch++; }
          Object.keys(frames).forEach(frameContext); apply();
        }).catch(error => { if (epoch === registryEpoch) { state.projectsError = error.message; render(); } throw error; });
        const brain = api('/api/brain').then(brain => {
          if (epoch !== registryEpoch) return;
          state.brain = brain.brain; state.root = brain.knowledgeRoot;
          state.indexStorage = { path: brain.indexStoragePath, ...brain.configuration?.indexStorage }; state.scopeStatus = brain.configuration?.scopeStatus; apply();
        });
        const health = api('/api/modules/health').then(health => { if (epoch !== registryEpoch) return; state.health = health.modules; state.ownership = health.ownership; apply(); connectProgress(); });
        const results = await Promise.allSettled([projects, brain, health, refreshSnapshot()]);
        if (epoch === registryEpoch && results.some(r => r.status === 'rejected')) toast('部分状态暂未刷新，已有内容已保留。');
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
    if (!pending && state.ownership?.pendingProjects?.length) { $('systemDot').className = 'dot issue'; $('systemTitle').textContent = '部分项目接线待恢复'; $('systemDetail').textContent = state.ownership.message; }
    if (state.snapshotStale) { $('systemDot').className = 'dot issue'; $('systemTitle').textContent = '知识状态刷新未完成'; $('systemDetail').textContent = '保留上次有效内容，连接恢复后自动更新。'; }
    if (storagePending && !pending && !down.length) { $('systemDot').className = 'dot issue'; $('systemTitle').textContent = '索引目录接线待恢复'; $('systemDetail').textContent = `目标目录：${state.indexStorage.expectedPath}。请在系统状态中修复接线。`; }
    if (state.root && state.scopeStatus?.status === 'pending' && !pending && !down.length) { $('systemDot').className = 'dot issue'; $('systemTitle').textContent = '共享知识接线待恢复'; $('systemDetail').textContent = '已有知识与长期记忆保留，请在系统状态中修复接线。'; }
    const maintenance = maintenanceWarning();
    if (maintenance && state.health.engine?.up && !pending) { $('systemDot').className = 'dot issue'; $('systemTitle').textContent = maintenance.title; $('systemDetail').textContent = maintenance.message; }
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
    await Promise.all([loadMaintenance(), loadAgentCapture(true)]);
  }
  function renderStorageInfo() {
    $('indexStoragePath').textContent = state.indexStorage?.actualPath || state.indexStorage?.path || '设置知识根目录后自动确定';
    $('indexStorageStatus').textContent = state.indexStorage?.status === 'ready' ? '索引目录已生效。' : `索引接线待恢复；目标目录：${state.indexStorage?.expectedPath || state.indexStorage?.path || '尚未设置'}`;
  }
  let captureScanTimer = null;
  async function loadAgentCapture(force = false) {
    clearTimeout(captureScanTimer);
    const epoch = ++captureEpoch;
    try {
      const projectId = state.projectId;
      const params = new URLSearchParams();
      if (projectId) params.set('projectId', projectId);
      if (force) params.set('refresh', '1');
      const result = await api('/api/integrations/status?' + params);
      if (projectId !== state.projectId || epoch !== captureEpoch) return;
      const badgeState = { connected: 'up', error: 'issue' };
      const badgeText = { checking: '检测中', connected: '已接入', disconnected: '未接入', error: '异常', 'not-detected': '未检测到' };
      $('agentCaptureList').innerHTML = result.clients.map(agent => {
        const capture = agent.developmentCapture;
        const found = agent.available || agent.configFound;
        const software = agent.available ? '检测到命令' : agent.configFound ? '检测到配置' : capture.state === 'checking' ? '正在检测客户端' : '未检测到';
        const auto = agent.automaticContext;
        const mcp = agent.mcpStartup;
        const mcpLine = mcp ? `MCP ${mcp.state === 'ready' ? '已通过' : '未通过'}${mcp.code ? `（${esc(mcp.code)}）` : ''}${mcp.detail ? ` · ${esc(mcp.detail)}` : ''}` : '';
        const repairLine = agent.repair ? `启动自动修复：${agent.repair.state === 'repaired' ? '成功' : `失败${agent.repair.error ? ` · ${esc(agent.repair.error)}` : ''}`}` : '';
        const summary = agent.summary || 'checking';
        const switchOn = summary === 'connected';
        const details = [
          `<small>${esc(software)} · ${esc(capture.detail || '')}</small>`,
          auto ? `<small>开发前知识：${esc(auto.detail)}</small>` : '',
          mcpLine ? `<small>${mcpLine}</small>` : '',
          repairLine ? `<small>${repairLine}</small>` : '',
          summary === 'error' ? `<div class="actions"><button data-agent-retry="1" data-agent-client="${esc(agent.client)}" ${captureBusy ? 'disabled' : ''}>重试修复</button></div>` : '',
        ].filter(Boolean).join('');
        return `<div class="agent-capture-row"><div><b>${esc(agent.label)}</b> ${badge(badgeText[summary] || summary, badgeState[summary] || '')}<details class="agent-detail"><summary>详情</summary>${details}</details></div><div class="actions"><button data-agent-switch="${switchOn ? 'uninstall' : 'install'}" data-agent-client="${esc(agent.client)}" ${!found || captureBusy ? 'disabled' : ''}>${switchOn ? '移除' : '接入'}</button></div></div>`;
      }).join('');
      const pendingScan = ['checking', 'refreshing'].includes(result.scan?.state)
        || (result.clients || []).some(client => client.developmentCapture?.state === 'checking' || client.knowledgeIntegration?.state === 'checking' || client.summary === 'checking');
      if (pendingScan) captureScanTimer = setTimeout(() => {
        if (epoch === captureEpoch && !$('systemDrawer').hidden) loadAgentCapture().catch(error => toast(error.message));
      }, 1500);
    } catch (error) { if (epoch === captureEpoch) $('agentCaptureList').textContent = `无法检查采集状态：${error.message}`; }
  }
  async function changeAgentAccess(client, operation) {
    if (captureBusy) return;
    captureBusy = true; captureEpoch++;
    all('[data-agent-switch]').forEach(button => { button.disabled = true; });
    $('agentCaptureFeedback').textContent = operation === 'install' ? '正在接入，保留第三方配置…' : '正在移除，已有记录保留…';
    try {
      const result = await api(`/api/integrations/${operation}`, { method: 'POST', body: { clients: [client] } });
      const success = result.complete === true;
      $('agentCaptureFeedback').textContent = success
        ? operation === 'install' ? '已接入。重新打开客户端后生效，实际记录可在活动页面查看。' : '已移除，第三方配置与已有记录保留。'
        : `操作未完成，展开详情查看原因；更多请查系统诊断记录（操作 ID：${result.operationId || '—'}）。`;
      $('agentCaptureFeedback').classList.toggle('issue', !success);
    } catch (error) { $('agentCaptureFeedback').textContent = `操作失败：${error.message}`; $('agentCaptureFeedback').classList.add('issue'); }
    finally { captureBusy = false; await loadAgentCapture(); post('eventBridge', { type: 'kb:refresh-agents' }); }
  }
  async function retryAgentRepair(client) {
    if (captureBusy) return;
    captureBusy = true; captureEpoch++;
    $('agentCaptureFeedback').textContent = '正在重试修复…';
    try {
      const result = await api('/api/integrations/install', { method: 'POST', body: { clients: [client] } });
      $('agentCaptureFeedback').textContent = result.complete === true ? '修复成功，重新打开客户端后生效。' : `修复未完成，详情见系统诊断记录（操作 ID：${result.operationId || '—'}）。`;
      $('agentCaptureFeedback').classList.toggle('issue', result.complete !== true);
    } catch (error) { $('agentCaptureFeedback').textContent = `修复失败：${error.message}`; $('agentCaptureFeedback').classList.add('issue'); }
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
      logStream = new ProgressSource(`/api/logs/stream?${streamParams}`);
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
    clearTimeout(captureScanTimer);
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
  // ============ 通用对话框（appDialog） ============
  function appDialogOpen(title, bodyHtml, actions = []) {
    $('appDialogTitle').textContent = title;
    $('appDialogBody').innerHTML = bodyHtml;
    $('appDialogFeedback').hidden = true; $('appDialogFeedback').classList.remove('issue');
    $('appDialogActions').innerHTML = '';
    for (const action of actions) {
      const button = document.createElement('button');
      button.textContent = action.label;
      if (action.class) button.className = action.class;
      if (action.form) { button.type = 'submit'; button.setAttribute('form', action.form); }
      else { button.type = 'button'; button.addEventListener('click', () => Promise.resolve(action.run()).catch(error => appDialogError(error.message))); }
      $('appDialogActions').append(button);
    }
    $('appDialog').showModal();
  }
  function appDialogError(message) { $('appDialogFeedback').textContent = message; $('appDialogFeedback').hidden = false; $('appDialogFeedback').classList.add('issue'); }
  function appDialogClose() { $('appDialog').close(); }
  function confirmDialog(title, text, confirmLabel, run) {
    appDialogOpen(title, `<p class="feedback" style="margin:0">${esc(text)}</p>`, [
      { label: '取消', run: appDialogClose },
      { label: confirmLabel, class: 'danger', run: async () => { appDialogClose(); await run(); } },
    ]);
  }
  function memoryById(id) {
    return state.memory.items.find(m => m.id === id) || state.candidates.items.find(m => m.id === id) || state.detailGroups.detail?.effective.items.find(m => m.id === id);
  }
  // ---- 记忆编辑器（标题 + 多行正文 + 可选组合/作用域） ----
  function memoryEditor(memory = null) {
    const isLegacy = memory && memory.scopeType !== 'group';
    const groupOptions = ['<option value="">暂不加入组合</option>', ...state.groups.items.map(g => `<option value="${esc(g.id)}" ${memory?.groups?.[0]?.id === g.id ? 'selected' : ''}>${esc(g.name)}</option>`)].join('');
    const scopeOptions = isLegacy || !memory
      ? `<label>适用范围<select name="scopeType"><option value="group" ${!isLegacy ? 'selected' : ''}>组合记忆：通过组合应用到项目</option><option value="global" ${memory?.scopeType === 'global' ? 'selected' : ''}>全局：所有领域与项目</option><option value="domain" ${memory?.scopeType === 'domain' ? 'selected' : ''}>领域：指定领域内的项目</option><option value="project" ${memory?.scopeType === 'project' ? 'selected' : ''}>项目：仅指定项目</option></select></label>
         <label data-role="scope-target" hidden>适用目标<select name="scopeTarget"></select></label>`
      : '';
    appDialogOpen(memory ? '编辑记忆' : '添加记忆', `
      <form id="memoryForm">
        <label>标题<input name="title" maxlength="120" required value="${esc(memory?.title || '')}" placeholder="例如：开发时保护日常服务"></label>
        <label>内容<textarea name="text" required rows="8" placeholder="这是一条完整记忆，可以包含多个段落和列表。">${esc(memory?.text || '')}</textarea></label>
        ${memory ? '' : `<label>加入组合<select name="groupId">${groupOptions}</select></label>`}
        ${scopeOptions}
        <p class="muted">${memory?.scopeType === 'group' ? '这条记忆通过组合应用到项目；正文只有一份，被所有引用共享。' : '多段正文保存在同一条记忆中，不会按换行拆分。'}</p>
      </form>`, [
      { label: '取消', run: appDialogClose },
      { label: memory ? '保存' : '添加', class: 'primary', form: 'memoryForm' },
    ]);
    const form = $('memoryForm');
    const scopeSelect = form.elements.scopeType;
    const targetLabel = form.querySelector('[data-role="scope-target"]');
    const fillTargets = type => {
      const targets = type === 'domain' ? state.brain.domains.map(d => ({ id: d.id, name: d.name })) : type === 'project' ? state.projects.map(p => ({ id: p.projectId, name: p.name })) : [];
      targetLabel.hidden = targets.length === 0;
      form.elements.scopeTarget.innerHTML = targets.map(t => `<option value="${esc(t.id)}" ${memory?.scopeId === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('');
    };
    if (scopeSelect) {
      fillTargets(scopeSelect.value);
      scopeSelect.addEventListener('change', () => fillTargets(scopeSelect.value));
    }
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const title = form.elements.title.value.trim();
      const text = form.elements.text.value.trim();
      if (!title || !text) return appDialogError('请填写标题和记忆内容。');
      const scopeType = form.elements.scopeType?.value || 'group';
      if (scopeType !== 'group' && scopeType !== 'global' && !form.elements.scopeTarget?.value) return appDialogError('请选择适用目标。');
      try {
        let saved;
        if (memory) {
          const body = { title, text };
          if (form.elements.scopeType && (memory.scopeType !== scopeType || scopeType !== 'group')) {
            body.scopeType = scopeType;
            body.scopeId = scopeType === 'global' ? state.brain.id : form.elements.scopeTarget?.value;
          }
          saved = await api(`/api/engine/memories/${encodeURIComponent(memory.id)}`, { method: 'PATCH', body });
        } else {
          const body = { title, text, brainId: state.brain.id, scopeType, scopeId: scopeType === 'group' || scopeType === 'global' ? state.brain.id : form.elements.scopeTarget?.value };
          saved = await api('/api/engine/memories', { method: 'POST', body });
          const groupId = form.elements.groupId?.value;
          if (groupId) await api(`/api/engine/memory-groups/${encodeURIComponent(groupId)}/members`, { method: 'POST', body: { addMemoryIds: [saved.memory.id] } });
        }
        appDialogClose();
        toast(memory ? '记忆已保存，多行内容保持在同一条记忆中。' : '记忆已保存。');
        await Promise.all([loadMemoryPage(), loadGroups(), loadOverview(true)]);
        if (state.projectsPage.detail) await loadDetail(state.projectsPage.detail);
      } catch (error) { appDialogError(error.message); }
    });
  }
  // ---- 候选审核 ----
  function reviewCandidate(memory) {
    const groupOptions = ['<option value="">暂不加入组合</option>', ...state.groups.items.map(g => `<option value="${esc(g.id)}">${esc(g.name)}</option>`)].join('');
    appDialogOpen('审核候选记忆', `
      <form id="reviewForm">
        <h3>${esc(memory.title)}</h3>
        <p class="feedback" style="white-space:pre-wrap">${esc(memory.text)}</p>
        <p class="muted">${memory.evidence ? `来源：${esc(projectName(memory.evidence.projectId))} · commit ${esc(memory.evidence.commitSha.slice(0, 8))} · ${esc(memory.evidence.entryId)}` : '来源：手动添加'}</p>
        ${memory.evidence?.quote ? `<details class="agent-detail" style="margin:12px 0"><summary>查看原始依据（冻结原文）</summary><p class="feedback" style="white-space:pre-wrap">${esc(memory.evidence.quote)}</p></details>` : ''}
        <label>确认后加入组合<select name="groupId">${groupOptions}</select></label>
        <p class="muted" data-role="impact">确认后保留在记忆库；加入组合并应用到项目后生效。</p>
      </form>`, [
      { label: '忽略', class: 'danger', run: async () => { await api(`/api/engine/memories/${encodeURIComponent(memory.id)}`, { method: 'PATCH', body: { status: 'ignored' } }); appDialogClose(); toast('已忽略候选。'); await Promise.all([loadCandidates(), loadOverview(true)]); } },
      { label: '取消', run: appDialogClose },
      { label: '确认收录', class: 'primary', form: 'reviewForm' },
    ]);
    const form = $('reviewForm');
    form.elements.groupId.addEventListener('change', () => {
      const group = groupById(form.elements.groupId.value);
      $('appDialogBody').querySelector('[data-role="impact"]').textContent = group ? `加入后，使用「${group.name}」的 ${group.boundProjectCount} 个项目后续新任务会读到它。` : '确认后保留在记忆库；加入组合并应用到项目后生效。';
    });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      try {
        await api(`/api/engine/memories/${encodeURIComponent(memory.id)}`, { method: 'PATCH', body: { status: 'confirmed' } });
        const groupId = form.elements.groupId.value;
        if (groupId) await api(`/api/engine/memory-groups/${encodeURIComponent(groupId)}/members`, { method: 'POST', body: { addMemoryIds: [memory.id] } });
        appDialogClose();
        toast(groupId ? `已确认并加入「${groupById(groupId)?.name}」。` : '已确认，保留在记忆库中。');
        await Promise.all([loadCandidates(), loadGroups(), loadMemoryPage(), loadOverview(true)]);
      } catch (error) { appDialogError(error.message); }
    });
  }
  // ---- 记忆详情 ----
  function memoryDetail(memory) {
    const groups = memory.groups || [];
    appDialogOpen(memory.title, `
      <p class="muted">${memory.sourceType === 'manual' ? `手动添加 · ${time(memory.createdAt)}` : memory.evidence ? `${esc(projectName(memory.evidence.projectId))} · commit ${esc(memory.evidence.commitSha.slice(0, 8))} · ${time(memory.updatedAt)}` : time(memory.updatedAt)}</p>
      <p class="feedback" style="white-space:pre-wrap;max-height:40vh;overflow:auto">${esc(memory.text)}</p>
      <p class="muted">所在组合：${groups.map(g => esc(g.name)).join('、') || '未归组合'}${memory.scopeType !== 'group' ? ` · 原作用域：${SCOPE_LABEL[memory.scopeType]}（${memory.scopeType === 'domain' ? esc(domainName(memory.scopeId)) : memory.scopeType === 'project' ? esc(projectName(memory.scopeId)) : '所有项目'}）` : ''}</p>`, [
      { label: '关闭', run: appDialogClose },
      ...(memory.status === 'confirmed' ? [
        { label: '组合归属', run: () => memoryGroupsDialog(memory) },
        { label: '编辑', class: 'primary', run: () => memoryEditor(memory) },
      ] : []),
    ]);
  }
  // ---- 记忆的组合归属（多选差量） ----
  async function memoryGroupsDialog(memory) {
    await loadGroups();
    const checks = state.groups.items.map(g => `<label class="checkbox"><input type="checkbox" name="groups" value="${esc(g.id)}" ${memory.groups?.some(mg => mg.id === g.id) ? 'checked' : ''}><span>${esc(g.name)} <small>${g.memberCount} 条</small></span></label>`).join('') || '<p class="muted">先创建一个组合。</p>';
    appDialogOpen('选择记忆所在的组合', `
      <form id="memoryGroupsForm">${checks}</form>
      <p class="muted">同一条记忆可被多个组合引用，内容只维护一份。</p>`, [
      { label: '取消', run: appDialogClose },
      { label: '保存', class: 'primary', run: async () => {
        const chosen = new Set([...$('memoryGroupsForm').querySelectorAll('[name=groups]:checked')].map(x => x.value));
        const current = new Set((memory.groups || []).map(g => g.id));
        const add = [...chosen].filter(id => !current.has(id));
        const remove = [...current].filter(id => !chosen.has(id));
        await Promise.all(state.groups.items.filter(g => add.includes(g.id) || remove.includes(g.id)).map(g =>
          api(`/api/engine/memory-groups/${encodeURIComponent(g.id)}/members`, { method: 'POST', body: { addMemoryIds: add.includes(g.id) ? [memory.id] : [], removeMemoryIds: remove.includes(g.id) ? [memory.id] : [] } })));
        appDialogClose(); toast('组合归属已更新，仍共享同一条记忆。');
        await Promise.all([loadGroups(), loadMemoryPage()]);
        if (state.projectsPage.detail) await loadDetail(state.projectsPage.detail);
      } },
    ]);
  }
  // ---- 组合设置 / 新建 ----
  function groupEditor(group = null) {
    appDialogOpen(group ? '组合设置' : '新建组合', `
      <form id="groupForm">
        <label>组合名称<input name="name" maxlength="80" required value="${esc(group?.name || '')}" placeholder="例如：通用约定"></label>
        ${group ? `<p class="muted">${group.memberCount} 条独立记忆 · ${group.boundProjectCount} 个项目使用。删除组合会保留其中的小记忆。</p>` : '<p class="muted">先创建组合，再添加或选入独立的小记忆。</p>'}
      </form>`, [
      ...(group ? [{ label: '删除组合', class: 'danger', run: () => confirmDialog('删除组合？', `「${group.name}」将解除 ${group.boundProjectCount} 个项目的关联。里面的小记忆仍保留在「全部记忆」中。`, '删除', async () => {
        await api(`/api/engine/memory-groups/${encodeURIComponent(group.id)}`, { method: 'DELETE' });
        state.memory.folder = 'all';
        toast('组合已删除，小记忆保留。');
        await Promise.all([loadGroups(), loadMemoryPage(), loadOverview(true)]);
        if (state.projectsPage.detail) await loadDetail(state.projectsPage.detail); else await loadProjectsPage();
      }) }] : []),
      { label: '取消', run: appDialogClose },
      { label: '保存', class: 'primary', form: 'groupForm' },
    ]);
    $('groupForm').addEventListener('submit', async event => {
      event.preventDefault();
      const name = $('groupForm').elements.name.value.trim();
      if (!name) return appDialogError('请填写组合名称。');
      try {
        if (group) await api(`/api/engine/memory-groups/${encodeURIComponent(group.id)}`, { method: 'PATCH', body: { name } });
        else {
          const created = await api('/api/engine/memory-groups', { method: 'POST', body: { brainId: state.brain.id, name } });
          state.memory.folder = created.group.id; state.memory.page = 0; state.memory.cursors = [null];
        }
        appDialogClose(); toast('组合已保存。');
        await Promise.all([loadGroups(), loadMemoryPage()]);
      } catch (error) { appDialogError(error.message); }
    });
  }
  // ---- 组合应用到项目（跨页差量选择） ----
  async function groupProjectsDialog(group) {
    await loadGroups();
    const fresh = groupById(group.id) || group;
    const selected = new Set();
    const page = { items: [], total: 0, cursors: [null], index: 0, q: '' };
    appDialogOpen(`「${fresh.name}」使用范围`, `
      <input id="applyProjectQuery" placeholder="查找项目" aria-label="查找需要应用组合的项目" style="width:100%;margin-bottom:12px">
      <div id="applyProjectList" style="max-height:40vh;overflow:auto"></div>
      <div id="applyProjectPager"></div>
      <p class="muted" id="applyProjectCount" style="margin-top:12px"></p>`, [
      { label: '取消', run: appDialogClose },
      { label: '保存应用范围', class: 'primary', run: async () => {
        // Diff against the CURRENT server state, not the loaded snapshot:
        // unviewed pages keep their relations, only explicit changes ship.
        const detail = await api(`/api/engine/memory-groups/${encodeURIComponent(fresh.id)}`);
        const current = new Set(detail.group.boundProjectIds);
        const addProjectIds = [...selected].filter(id => !current.has(id));
        const removeProjectIds = [...current].filter(id => !selected.has(id));
        if (addProjectIds.length || removeProjectIds.length) {
          await api(`/api/engine/memory-groups/${encodeURIComponent(fresh.id)}/project-bindings`, { method: 'POST', body: { addProjectIds, removeProjectIds } });
        }
        appDialogClose(); toast('应用范围已保存。');
        await Promise.all([loadGroups(), loadProjectsPage(), loadOverview(true)]);
        if (state.projectsPage.detail) await loadDetail(state.projectsPage.detail);
      } },
    ]);
    const renderList = async () => {
      const params = new URLSearchParams({ limit: '7' });
      if (page.q.trim()) params.set('q', page.q.trim());
      const cursor = page.cursors[page.index];
      if (cursor) params.set('cursor', cursor);
      const result = await api('/api/projects/page?' + params);
      page.items = result.projects; page.total = result.total;
      if (result.nextCursor) page.cursors[page.index + 1] = result.nextCursor; else page.cursors.length = page.index + 1;
      $('applyProjectList').innerHTML = result.projects.map(p => `<label class="checkbox"><input type="checkbox" data-apply-project value="${esc(p.projectId)}" ${selected.has(p.projectId) ? 'checked' : ''}><span>${esc(p.name)} <small>${esc(domainName(p.domainId))}</small></span></label>`).join('') || '<p class="muted">没有匹配项目。</p>';
      const pages = Math.max(1, Math.ceil(result.total / 7));
      $('applyProjectPager').innerHTML = `<div class="pager"><span>${result.total} 个项目</span><div class="actions"><button data-apply-page="${page.index - 1}" ${page.index === 0 ? 'disabled' : ''}>上一页</button><span>${page.index + 1} / ${pages}</span><button data-apply-page="${page.index + 1}" ${page.index + 1 >= pages ? 'disabled' : ''}>下一页</button></div></div>`;
      $('applyProjectCount').textContent = `已选择 ${selected.size} 个项目，翻页后继续保留选择。`;
    };
    try {
      const detail = await api(`/api/engine/memory-groups/${encodeURIComponent(fresh.id)}`);
      for (const id of detail.group.boundProjectIds) selected.add(id);
    } catch { /* server state read failed: only explicit selections will ship */ }
    await renderList();
    const body = $('appDialogBody');
    const onQuery = event => { page.q = event.target.value; page.index = 0; page.cursors = [null]; renderList().catch(() => {}); };
    const onChange = event => {
      if (event.target.dataset?.applyProject !== undefined && event.target.type === 'checkbox') {
        if (event.target.checked) selected.add(event.target.value); else selected.delete(event.target.value);
        $('applyProjectCount').textContent = `已选择 ${selected.size} 个项目，翻页后继续保留选择。`;
      }
    };
    const onClick = event => {
      const button = event.target.closest('[data-apply-page]');
      if (!button || button.disabled) return;
      event.preventDefault(); event.stopPropagation();
      page.index = Number(button.dataset.applyPage); renderList().catch(() => {});
    };
    $('applyProjectQuery').addEventListener('input', onQuery);
    body.addEventListener('change', onChange);
    body.addEventListener('click', onClick, true);
    $('appDialog').addEventListener('close', () => { body.removeEventListener('change', onChange); body.removeEventListener('click', onClick, true); }, { once: true });
  }
  // ---- 项目的组合选择（多选差量） ----
  async function projectGroupsDialog(projectId) {
    await loadGroups();
    const project = state.projectsPage.items.find(p => p.projectId === projectId);
    if (!project) return;
    const current = new Set((project.groups || []).map(g => g.id));
    const selected = new Set(current);
    const checks = state.groups.items.map(g => `<label class="checkbox"><input type="checkbox" data-project-group value="${esc(g.id)}" ${selected.has(g.id) ? 'checked' : ''}><span>${esc(g.name)} <small>${g.memberCount} 条记忆</small></span></label>`).join('') || '<p class="muted">还没有组合。</p>';
    appDialogOpen(`为 ${project.name} 选择组合`, `
      ${checks}
      <p class="muted">只调整这个项目的引用关系。</p>`, [
      { label: '取消', run: appDialogClose },
      { label: '保存', class: 'primary', run: async () => {
        const addGroupIds = [...selected].filter(id => !current.has(id));
        const removeGroupIds = [...current].filter(id => !selected.has(id));
        if (addGroupIds.length || removeGroupIds.length) {
          await api(`/api/engine/projects/${encodeURIComponent(projectId)}/memory-groups/bind`, { method: 'POST', body: { addGroupIds, removeGroupIds } });
        }
        appDialogClose(); toast('已保存项目组合。');
        await loadProjectsPage();
        if (state.projectsPage.detail === projectId) await loadDetail(projectId);
      } },
    ]);
    const body = $('appDialogBody');
    const onChange = event => {
      if (event.target.dataset?.projectGroup !== undefined && event.target.type === 'checkbox') {
        if (event.target.checked) selected.add(event.target.value); else selected.delete(event.target.value);
      }
    };
    body.addEventListener('change', onChange);
    $('appDialog').addEventListener('close', () => body.removeEventListener('change', onChange), { once: true });
  }
  // ---- 选入已有记忆到组合 ----
  async function addExistingDialog(group) {
    const selected = new Set();
    const page = { items: [], total: 0, cursors: [null], index: 0, q: '' };
    appDialogOpen('选入已有记忆', `
      <input id="existingQuery" placeholder="查找已有记忆" aria-label="查找已有记忆" style="width:100%;margin-bottom:12px">
      <div id="existingList" style="max-height:40vh;overflow:auto"></div>
      <div id="existingPager"></div>
      <p class="muted" id="existingCount" style="margin-top:12px"></p>`, [
      { label: '取消', run: appDialogClose },
      { label: `加入「${group.name}」`, class: 'primary', run: async () => {
        if (!selected.size) return appDialogError('请先选择记忆。');
        await api(`/api/engine/memory-groups/${encodeURIComponent(group.id)}/members`, { method: 'POST', body: { addMemoryIds: [...selected] } });
        appDialogClose(); toast('已加入组合，没有复制记忆内容。');
        await Promise.all([loadGroups(), loadMemoryPage()]);
        if (state.projectsPage.detail) await loadDetail(state.projectsPage.detail);
      } },
    ]);
    const renderList = async () => {
      const params = new URLSearchParams({ status: 'confirmed', limit: '6' });
      if (page.q.trim()) params.set('q', page.q.trim());
      const cursor = page.cursors[page.index];
      if (cursor) params.set('cursor', cursor);
      const result = await api('/api/engine/memories?' + params);
      page.items = result.memories; page.total = result.total;
      if (result.nextCursor) page.cursors[page.index + 1] = result.nextCursor; else page.cursors.length = page.index + 1;
      $('existingList').innerHTML = result.memories.map(m => `<label class="checkbox"><input type="checkbox" data-existing-memory value="${esc(m.id)}" ${selected.has(m.id) ? 'checked' : ''}><span>${esc(m.title)}<small style="display:block">${esc(clamp2(m.text).slice(0, 65))}</small></span></label>`).join('') || '<p class="muted">没有匹配的已有记忆。</p>';
      const pages = Math.max(1, Math.ceil(result.total / 6));
      $('existingPager').innerHTML = `<div class="pager"><span>${result.total} 条</span><div class="actions"><button data-existing-page="${page.index - 1}" ${page.index === 0 ? 'disabled' : ''}>上一页</button><span>${page.index + 1} / ${pages}</span><button data-existing-page="${page.index + 1}" ${page.index + 1 >= pages ? 'disabled' : ''}>下一页</button></div></div>`;
      $('existingCount').textContent = `已选择 ${selected.size} 条，加入后共享原内容。`;
    };
    await renderList();
    const body = $('appDialogBody');
    const onQuery = event => { page.q = event.target.value; page.index = 0; page.cursors = [null]; renderList().catch(() => {}); };
    const onChange = event => {
      if (event.target.dataset?.existingMemory !== undefined && event.target.type === 'checkbox') {
        if (event.target.checked) selected.add(event.target.value); else selected.delete(event.target.value);
        $('existingCount').textContent = `已选择 ${selected.size} 条，加入后共享原内容。`;
      }
    };
    const onClick = event => {
      const button = event.target.closest('[data-existing-page]');
      if (!button || button.disabled) return;
      event.preventDefault(); event.stopPropagation();
      page.index = Number(button.dataset.existingPage); renderList().catch(() => {});
    };
    $('existingQuery').addEventListener('input', onQuery);
    body.addEventListener('change', onChange);
    body.addEventListener('click', onClick, true);
    $('appDialog').addEventListener('close', () => { body.removeEventListener('change', onChange); body.removeEventListener('click', onClick, true); }, { once: true });
  }
  // ============ 全局事件 ============
  document.addEventListener('click', e => {
    const button = e.target.closest('button'); if (!button) return;
    const execute = async () => {
      if (button.dataset.view) setView(button.dataset.view);
      if (button.dataset.go) setView(button.dataset.go);
      if (button.dataset.close && !(button.dataset.close === 'unbindDialog' && unbinding)) $(button.dataset.close).close();
      if (button.dataset.selectProject) selectProject(button.dataset.selectProject);
      if (button.dataset.memoryTab) { state.memory.tab = button.dataset.memoryTab; state.memory.page = 0; state.memory.cursors = [null]; renderMemories(); if (button.dataset.memoryTab === 'candidate') void loadCandidates(); }
      if (button.dataset.activityTab) { state.activityTab = button.dataset.activityTab; setView('activity'); post('eventBridge', { type: 'kb:visibility', visible: state.activityTab === 'sessions' }); post('eventBridge', { type: 'kb:refresh' }); }
      if (button.dataset.activityFilter) { state.activityFilter = button.dataset.activityFilter; renderActivity(); }
      if (button.dataset.folder) { state.memory.folder = button.dataset.folder; state.memory.q = ''; state.memory.page = 0; state.memory.cursors = [null]; await loadMemoryPage(); }
      if (button.dataset.page) {
        const target = button.dataset.page;
        const next = Math.max(0, Number(button.dataset.value) || 0);
        if (target === 'memory') { if (state.memory.cursors[next] !== undefined) { state.memory.page = next; await loadMemoryPage(); } }
        else if (target === 'candidate') { if (state.candidates.cursors[next] !== undefined) { state.candidates.page = next; await loadCandidates(); } }
        else if (target === 'projects') { if (state.projectsPage.cursors[next] !== undefined) { state.projectsPage.page = next; await loadProjectsPage(); } }
        else if (target === 'effective') { const detail = state.detailGroups.detail; if (detail && detail.effective.cursors[next] !== undefined) { detail.effective.page = next; await loadDetailEffectivePage(); } }
        else if (target === 'search') { state.search.page = next; renderSearch(); }
      }
      if (button.dataset.action === 'import') openImport();
      if (button.dataset.action === 'refresh') await refreshRegistry(true);
      if (button.dataset.action === 'reload-overview') await loadOverview(true);
      if (button.dataset.action === 'repair') await repair();
      if (button.dataset.action === 'system') await openSystem();
      if (button.dataset.action === 'activity-needs') { state.activityFilter = 'needs'; setView('activity'); renderActivity(); }
      if (button.dataset.action === 'activity-recovering') { state.activityFilter = 'recovering'; setView('activity'); renderActivity(); }
      if (button.dataset.agentSwitch) await changeAgentAccess(button.dataset.agentClient, button.dataset.agentSwitch);
      if (button.dataset.agentRetry) await retryAgentRepair(button.dataset.agentClient);
      if (button.dataset.action === 'unbind') { const p = activeProject(); if (p && !unbinding) { unbindProjectId = p.projectId; $('unbindProjectName').textContent = `解绑「${p.name}」？`; $('unbindFeedback').textContent = ''; $('unbindDialog').showModal(); } }
      if (button.dataset.openRun) await openRunDetail(button.dataset.openRun, button.dataset.runProject || '');
      if (button.dataset.retryRun) { await api(`/api/engine/runs/${encodeURIComponent(button.dataset.retryRun)}/retry`, { method: 'POST', body: {} }); await refreshSnapshot(); toast('已重新执行失败阶段。'); }
      if (button.dataset.runPage !== undefined) await loadActivityPage(button.dataset.runPage || null);
      if (button.dataset.action === 'toast-undo') { const undo = toastUndo; toastUndo = null; $('toast').hidden = true; await undo?.(); }
      if (button.dataset.action === 'new-group') groupEditor();
      if (button.dataset.action === 'group-settings') groupEditor(groupById(button.dataset.id));
      if (button.dataset.action === 'group-projects') await groupProjectsDialog(groupById(button.dataset.id));
      if (button.dataset.action === 'open-group') { setView('memory'); state.memory.tab = 'library'; state.memory.folder = button.dataset.id; state.memory.q = ''; state.memory.page = 0; state.memory.cursors = [null]; await loadMemoryPage(); }
      if (button.dataset.action === 'new-memory') memoryEditor();
      if (button.dataset.action === 'memory-edit') memoryEditor(memoryById(button.dataset.id));
      if (button.dataset.action === 'memory-detail') { const memory = memoryById(button.dataset.id); if (memory) memoryDetail(memory); else toast('列表已刷新，请重试。'); }
      if (button.dataset.action === 'memory-groups') { const memory = memoryById(button.dataset.id); if (memory) await memoryGroupsDialog(memory); }
      if (button.dataset.action === 'review-candidate') { const memory = state.candidates.items.find(m => m.id === button.dataset.id) || state.overview?.candidatesPreview?.find(m => m.id === button.dataset.id); if (memory) reviewCandidate(memory); else { await loadCandidates(); const fresh = state.candidates.items.find(m => m.id === button.dataset.id); if (fresh) reviewCandidate(fresh); else toast('候选不存在或已处理。'); } }
      if (button.dataset.action === 'memory-evidence') { const memory = memoryById(button.dataset.id); if (memory?.evidence) await openReference({ ...memory.evidence, readFile: false, text: memory.evidence.quote, title: '记忆来源依据（冻结原文）' }); }
      if (button.dataset.action === 'memory-delete') { const memory = memoryById(button.dataset.id); if (memory) confirmDialog('删除这条记忆？', `「${memory.title}」将从所有组合中移除。其他小记忆保留。`, '删除', async () => {
        await api(`/api/engine/memories/${encodeURIComponent(memory.id)}`, { method: 'DELETE' });
        toast('已删除记忆。');
        await Promise.all([loadMemoryPage(), loadGroups(), loadOverview(true)]);
        if (state.projectsPage.detail) await loadDetail(state.projectsPage.detail);
      }); }
      if (button.dataset.action === 'unlink-group') {
        const groupId = button.dataset.id, projectId = button.dataset.project;
        await api(`/api/engine/projects/${encodeURIComponent(projectId)}/memory-groups/bind`, { method: 'POST', body: { removeGroupIds: [groupId] } });
        toast('已解除关联，其他项目不变。', async () => {
          await api(`/api/engine/projects/${encodeURIComponent(projectId)}/memory-groups/bind`, { method: 'POST', body: { addGroupIds: [groupId] } });
          await loadProjectsPage(); if (state.projectsPage.detail === projectId) await loadDetail(projectId);
          toast('已恢复关联。');
        });
        await loadProjectsPage(); if (state.projectsPage.detail === projectId) await loadDetail(projectId);
      }
      if (button.dataset.action === 'project-detail') await openProjectDetail(button.dataset.id);
      if (button.dataset.action === 'project-list') { state.projectsPage.detail = null; renderProjects(); }
      if (button.dataset.action === 'project-groups') await projectGroupsDialog(button.dataset.id);
      if (button.dataset.action === 'edit-project') { const p = state.projectsPage.items.find(x => x.projectId === button.dataset.id); if (p) { await openProjectDetail(p.projectId); selectProject(p.projectId); await openSystem(); } }
      if (button.dataset.action === 'add-existing') { const group = groupById(state.memory.folder); if (group) await addExistingDialog(group); else toast('请先在左侧选择一个组合。'); }
      if (button.dataset.action === 'search-detail') { const row = state.search.results[Number(button.dataset.index)]; if (row) await openReference({ projectId: row.scope_project_id || row.projectId, spaceId: row.space_id, entryId: row.entry_id, commitSha: row.commitSha, title: row.title, text: row.snippet || row.chunk_text }); }
    };
    execute().catch(error => toast(error.message));
  });
  document.addEventListener('input', event => {
    if (event.target.id === 'memoryQuery') { state.memory.q = event.target.value; state.memory.page = 0; state.memory.cursors = [null]; clearTimeout(event.target.dataset.timer || 0); event.target.dataset.timer = setTimeout(() => loadMemoryPage(), 250); }
    if (event.target.id === 'projectQuery') { state.projectsPage.q = event.target.value; state.projectsPage.page = 0; state.projectsPage.cursors = [null]; clearTimeout(event.target.dataset.timer || 0); event.target.dataset.timer = setTimeout(() => loadProjectsPage(), 250); }
  });
  document.addEventListener('change', async event => {
    if (event.target.id === 'projectDomainFilter') { state.projectsPage.domain = event.target.value; state.projectsPage.page = 0; state.projectsPage.cursors = [null]; await loadProjectsPage(); }
  });
  // 拖放：组合 → 项目行 = 应用；标签 → 拖回条 = 解除（键盘等价操作见各按钮/对话框）
  let drag = null;
  document.addEventListener('dragstart', event => {
    const chip = event.target.closest('[data-drag-group]');
    if (!chip) return;
    drag = { groupId: chip.dataset.dragGroup, projectId: chip.dataset.project || null };
    event.dataTransfer.effectAllowed = 'copyMove';
    event.dataTransfer.setData('text/plain', drag.groupId);
  });
  document.addEventListener('dragover', event => {
    const dropProject = event.target.closest('[data-drop-project]');
    const unlinkBar = event.target.closest('[data-unlink-drop]');
    if (!drag || !dropProject && !unlinkBar) return;
    event.preventDefault();
    unlinkBar?.classList.add('over');
  });
  document.addEventListener('drop', async event => {
    const dropProject = event.target.closest('[data-drop-project]');
    const unlinkBar = event.target.closest('[data-unlink-drop]');
    if (!drag || !dropProject && !unlinkBar) return;
    event.preventDefault();
    all('.over').forEach(node => node.classList.remove('over'));
    try {
      if (dropProject) {
        if (dropProject.dataset.dropProject === drag.projectId) return;
        await api(`/api/engine/projects/${encodeURIComponent(dropProject.dataset.dropProject)}/memory-groups/bind`, { method: 'POST', body: { addGroupIds: [drag.groupId] } });
        toast('已应用到项目。');
      } else if (unlinkBar && drag.projectId) {
        await api(`/api/engine/projects/${encodeURIComponent(drag.projectId)}/memory-groups/bind`, { method: 'POST', body: { removeGroupIds: [drag.groupId] } });
        toast('已解除关联，其他项目不变。');
      }
    } catch (error) { toast(error.message); }
    finally { drag = null; await loadProjectsPage(); if (state.projectsPage.detail) await loadDetail(state.projectsPage.detail); }
  });
  document.addEventListener('dragend', () => { drag = null; all('.over').forEach(node => node.classList.remove('over')); });
  window.addEventListener('message', event => {
    if (event.origin !== location.origin || !event.data || typeof event.data !== 'object') return;
    const key = Object.keys(frames).find(k => $(frames[k].id).contentWindow === event.source); if (!key) return;
    const message = event.data;
    if (message.type === 'kb:open-integrations' && key === 'eventBridge') { openSystem().then(() => $('agentCaptureSection').scrollIntoView({ block: 'start' })).catch(error => toast(error.message)); return; }
    if (message.type === 'kb:ready') { frames[key].ready = true; frameContext(key); if (key === 'terminal') void resetKnowledgePanel(); if (frames[key].openSettings) { post(key, { type: 'kb:open-settings' }); frames[key].openSettings = false; } }
    if (key === 'terminal' && typeof message.type === 'string' && message.type.startsWith('kb:panel/')) {
      if (message.type === 'kb:panel/state') { handlePanelState(message); return; }
      const settle = panelRequests.get(message.requestId);
      if (settle) { panelRequests.delete(message.requestId); settle(message); }
      return;
    }
    if (message.requestId && message.requestId !== frames[key].requestId) return;
    if (message.type === 'kb:knowledge' && key === 'terminal') {
      const project = state.projects.find(p => p.modules.terminal.projectId === message.projectId);
      if (project) { state.contexts.set(project.projectId, message.knowledge); if (project.projectId === state.projectId) { void pushKnowledgeToPanel(project.projectId); } }
    }
  });
  on('projectSelect', 'change', e => selectProject(e.target.value));
  on('themeToggle', 'click', () => { document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; localStorage.setItem('kb.theme', document.documentElement.dataset.theme); applyAppearance(); Object.keys(frames).forEach(key => post(key, { type: 'kb:theme', theme: document.documentElement.dataset.theme })); void pushKnowledgeToPanel(); });
  const appearanceTokens = ['page','surface','surface2','surface3','line','text','muted','faint','nav','accent','accent-soft','good','bad','bad-soft'];
  const appearanceDefaults = {
    pure: {
      light: { page:'#ffffff',surface:'#ffffff',surface2:'#f6f6f7',surface3:'#ececee',line:'#e2e2e5',text:'#1a1a1e',muted:'#6d6d75',faint:'#8a8a92',nav:'#fafafa',accent:'#2f6db5','accent-soft':'#e2ecf8',good:'#2e7d5b',bad:'#b04a4a','bad-soft':'#f7ecec' },
      dark: { page:'#0e0e10',surface:'#1a1c26',surface2:'#20222e',surface3:'#2a2c3c',line:'#343644',text:'#eef0f6',muted:'#b3bad0',faint:'#8b91a6',nav:'#131319',accent:'#7da2ff','accent-soft':'#242e48',good:'#8cc8a8',bad:'#e89898','bad-soft':'#3a272b' },
    },
    oled: {
      light: { page:'#ffffff',surface:'#ffffff',surface2:'#f6f6f7',surface3:'#ececee',line:'#e2e2e5',text:'#1a1a1e',muted:'#6d6d75',faint:'#8a8a92',nav:'#fafafa',accent:'#2f6db5','accent-soft':'#e2ecf8',good:'#2e7d5b',bad:'#b04a4a','bad-soft':'#f7ecec' },
      dark: { page:'#000000',surface:'#101118',surface2:'#16171e',surface3:'#1e1f26',line:'#2e2f3a',text:'#f2f2f5',muted:'#b3bad0',faint:'#8b91a6',nav:'#050506',accent:'#7da2ff','accent-soft':'#1e263c',good:'#8cc8a8',bad:'#e89898','bad-soft':'#352428' },
    },
    steel: {
      light: { page:'#f3f5f7',surface:'#ffffff',surface2:'#f8f9fb',surface3:'#edf1f4',line:'#dce2e8',text:'#202733',muted:'#687587',faint:'#8e99a7',nav:'#eef1f4',accent:'#516f89','accent-soft':'#e6edf3',good:'#397761',bad:'#a05252','bad-soft':'#fbeeee' },
      dark: { page:'#171a1f',surface:'#20252d',surface2:'#252b34',surface3:'#2c333e',line:'#39424f',text:'#e6ebf0',muted:'#a0aaba',faint:'#788393',nav:'#1b2028',accent:'#8aa8cf','accent-soft':'#293748',good:'#81b29a',bad:'#d88b8b','bad-soft':'#39292d' },
    },
  };
  const appearance = { preset: 'pure', overrides: { light: {}, dark: {} }, skinTheme: 'light' };
  const sanitizeSkinTokens = source => {
    const themes = {};
    for (const theme of ['light', 'dark']) {
      themes[theme] = {};
      const entries = source?.[theme] && typeof source[theme] === 'object' ? source[theme] : {};
      for (const token of appearanceTokens) if (/^#[0-9a-fA-F]{6}$/.test(String(entries[token] || ''))) themes[theme][token] = String(entries[token]).toLowerCase();
    }
    return themes;
  };
  function applyAppearance() {
    const root = document.documentElement;
    root.dataset.skin = appearanceDefaults[appearance.preset] ? appearance.preset : 'pure';
    if (!root.style) return;
    const theme = root.dataset.theme === 'dark' ? 'dark' : 'light';
    for (const token of appearanceTokens) root.style.removeProperty(`--${token}`);
    for (const [token, value] of Object.entries(appearance.overrides[theme] || {})) if (appearanceTokens.includes(token)) root.style.setProperty(`--${token}`, value);
  }
  function syncAppearanceControls() {
    if (!$('skinPreset')) return;
    $('skinPreset').value = appearance.preset;
    all('#skinThemeTabs button').forEach(button => button.classList.toggle('active', button.dataset.skinTheme === appearance.skinTheme));
    all('#skinColors input[data-token], .skin-more input[data-token]').forEach(input => {
      const token = input.dataset.token;
      const fallback = appearanceDefaults[appearance.preset]?.[appearance.skinTheme]?.[token] || '#000000';
      input.value = (appearance.overrides[appearance.skinTheme]?.[token] || fallback).toLowerCase();
    });
  }
  async function saveAppearance() {
    const result = await api('/api/appearance', { method: 'PATCH', body: { appearance: { preset: appearance.preset, overrides: appearance.overrides } } });
    appearance.preset = result.appearance.preset; appearance.overrides = sanitizeSkinTokens(result.appearance.overrides);
    applyAppearance(); syncAppearanceControls();
    $('appearanceStatus').textContent = '皮肤已保存，对本机所有入口生效。';
  }
  async function loadAppearance() {
    try {
      const result = await api('/api/appearance', { allowNotReady: true });
      if (result.appearance) { appearance.preset = result.appearance.preset || 'pure'; appearance.overrides = sanitizeSkinTokens(result.appearance.overrides); }
    } catch { /* 服务未就绪时保持默认皮肤，不阻塞启动 */ }
    applyAppearance(); syncAppearanceControls();
  }
  on('skinPreset', 'change', () => { appearance.preset = $('skinPreset').value; applyAppearance(); syncAppearanceControls(); $('appearanceStatus').textContent = '预设已切换（即时预览），记得保存。'; });
  all('#skinThemeTabs button').forEach(button => button.addEventListener('click', () => { appearance.skinTheme = button.dataset.skinTheme; syncAppearanceControls(); }));
  all('#skinColors input[data-token], .skin-more input[data-token]').forEach(input => input.addEventListener('input', () => {
    appearance.overrides[appearance.skinTheme] = { ...appearance.overrides[appearance.skinTheme], [input.dataset.token]: input.value.toLowerCase() };
    applyAppearance(); $('appearanceStatus').textContent = '颜色已应用（即时预览），记得保存。';
  }));
  on('saveAppearance', 'click', saveAppearance);
  on('resetAppearance', 'click', async () => { appearance.preset = 'pure'; appearance.overrides = { light: {}, dark: {} }; await saveAppearance(); toast('已恢复默认皮肤。'); });
  on('exportSkin', 'click', () => {
    const tokens = {};
    for (const theme of ['light', 'dark']) tokens[theme] = { ...appearanceDefaults[appearance.preset][theme], ...appearance.overrides[theme] };
    const skin = { schema: 'kb-skin/v1', name: '我的皮肤', preset: appearance.preset, tokens };
    const url = URL.createObjectURL(new Blob([JSON.stringify(skin, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = 'kb-skin.json'; link.click(); URL.revokeObjectURL(url);
  });
  on('importSkin', 'click', () => $('importSkinFile').click());
  $('importSkinFile').addEventListener('change', async event => {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file) return;
    try {
      const skin = JSON.parse(await file.text());
      if (skin.schema !== 'kb-skin/v1') throw new Error('不是有效的 kb-skin/v1 皮肤文件。');
      if (appearanceDefaults[skin.preset]) appearance.preset = skin.preset;
      appearance.overrides = sanitizeSkinTokens(skin.tokens);
      await saveAppearance(); toast(`已导入皮肤「${String(skin.name || '未命名').slice(0, 40)}」。`);
    } catch (error) { toast(`导入失败：${error.message}`); }
  });
  on('openSystem', 'click', openSystem); on('closeSystem', 'click', closeSystem); on('drawerBackdrop', 'click', closeSystem);
  on('repairWiring', 'click', repair);
  on('configureProviders', 'click', () => {
    closeSystem();
    // Provider management lives in the workbench service; the hidden frame
    // hosts it without a "work" navigation page.
    initializeFrame('terminal');
    if (frames.terminal.ready) post('terminal', { type: 'kb:open-settings' }); else frames.terminal.openSettings = true;
    toast('正在打开模型供应商管理…');
  });
  on('saveMaintenance', 'click', async () => { await api('/api/terminal/maintenance-default', { method: 'PUT', body: { profileId: $('maintenanceModel').value || null } }); const result = await api('/api/modules/configure', { method: 'POST', body: {} }); $('configurationStatus').textContent = result.configuration.model ? '后台默认模型已保存并同步；被阻塞的维护任务会自动继续。' : '配置已保存，后台运行配置尚未同步，请检查模块连接。'; await loadOverview(true); });
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
  on('unbindForm', 'submit', async e => {
    e.preventDefault(); if (!unbindProjectId || unbinding) return;
    const projectId = unbindProjectId;
    unbinding = true; $('confirmUnbind').disabled = true; $('confirmUnbind').textContent = '正在解绑…';
    $('unbindFeedback').textContent = '正在停止项目接线并移除登记，磁盘文件不会删除。';
    try {
      await api(`/api/projects/${encodeURIComponent(projectId)}`, { method: 'DELETE', body: { deleteKnowledge: false } });
      state.contexts.delete(projectId);
      state.projects = state.projects.filter(project => project.projectId !== projectId);
      if (state.projectsPage.detail === projectId) state.projectsPage.detail = null;
      if (state.projectId === projectId) { state.projectId = state.projects[0]?.projectId || ''; state.epoch++; }
      renderProjectOptions(); render(); Object.keys(frames).forEach(frameContext);
      $('unbindDialog').close(); unbindProjectId = '';
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
    try { const result = await api('/api/projects/import', { method: 'POST', body: importInput() }); registered = true; state.projectId = result.projectId; state.epoch++; $('importDialog').close(); await refreshRegistry(true); Object.keys(frames).forEach(frameContext); setView('projects'); state.projectsPage.page = 0; state.projectsPage.cursors = [null]; await loadProjectsPage(); toast(Object.values(result.modules).every(m => m.ok) ? '项目已导入，四个模块已连接。' : '项目已导入，部分接线待恢复。'); }
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
    state.stream?.close(); state.stream = null; registryStream?.close(); registryStream = null; logStream?.close(); logStream = null; logEpoch++;
    state.engineAvailable = false; $('activityConnection').textContent = '连接中断，恢复后自动读取快照';
    renderSystem(); render();
  });
  window.addEventListener('online', () => {
    connectRegistryEvents();
    $('activityConnection').textContent = state.engineAvailable && state.stream?.readyState === EventSource.OPEN ? '已连接实时更新' : '正在恢复快照'; refreshRegistry();
    if ($('logsDialog').open) loadLogs().catch(error => toast(error.message));
  });
  window.addEventListener('beforeunload', () => { state.stream?.close(); registryStream?.close(); clearTimeout(registryRefreshTimer); logStream?.close(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { connectRegistryEvents(); void refreshRegistry(); } });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSystem(); });
  document.documentElement.dataset.theme = localStorage.getItem('kb.theme') === 'dark' ? 'dark' : 'light';
  applyAppearance(); void loadAppearance();
  state.view = titles[location.hash.slice(1)] ? location.hash.slice(1) : 'home';
  setView(state.view); refreshRegistry();
  connectRegistryEvents();
})();
