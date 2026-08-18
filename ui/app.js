(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const state = { projects: [], activeProjectId: '', view: 'workbench', settings: 'ai', settingsOpen: false, conversationCursor: null, conversationTurns: [], logs: [], logStream: null, logCursor: '', newLogs: 0, activeSessionId: '', sessionStream: null, assistantCard: null, toolCards: new Map(), lastUserText: '' };
  const today = () => { const d = new Date(), pad = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const api = async (url, options = {}) => {
    const response = await fetch(url, { ...options, headers: options.body ? { 'content-type': 'application/json', ...(options.headers || {}) } : options.headers });
    const text = await response.text();
    const body = text ? JSON.parse(text) : {};
    if (!response.ok) throw Object.assign(new Error(body.error?.message || `请求失败 (${response.status})`), { body, status: response.status });
    return body;
  };
  const activeProject = () => state.projects.find(project => project.projectId === state.activeProjectId) || null;
  const setText = (node, value) => { node.textContent = value == null ? '' : String(value); };
  async function copyText(value) {
    const text = String(value == null ? '' : value);
    if (navigator.clipboard?.writeText) { try { await navigator.clipboard.writeText(text); return; } catch {} }
    const input = document.createElement('textarea'); input.value = text; input.setAttribute('readonly', ''); input.style.position = 'fixed'; input.style.opacity = '0'; document.body.append(input); input.select(); document.execCommand('copy'); input.remove();
  }
  const option = (value, label) => { const node = document.createElement('option'); node.value = value; node.textContent = label; return node; };
  const formatTime = iso => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '—' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); };
  function staticEmpty(parent, message) { parent.replaceChildren(); const empty = document.createElement('div'); empty.className = 'empty'; const text = document.createElement('span'); text.textContent = message; empty.append(text); parent.append(empty); }

  function renderProjects() {
    const list = $('project-list');
    list.replaceChildren();
    for (const id of ['mobile-project', 'relation-project', 'conversation-project']) $(id).replaceChildren();
    $('logs-project').replaceChildren(option('', '全部项目'));
    for (const project of state.projects) {
      const button = document.createElement('button');
      button.className = `project-button${project.projectId === state.activeProjectId ? ' active' : ''}${project.config.enabled === false ? ' disabled' : ''}`;
      button.dataset.projectId = project.projectId;
      const dot = document.createElement('span'); dot.className = 'project-dot';
      const body = document.createElement('span');
      const name = document.createElement('span'); name.className = 'project-name'; name.textContent = project.config.displayName;
      const id = document.createElement('span'); id.className = 'project-id'; id.textContent = project.projectId;
      body.append(name, id); button.append(dot, body); button.addEventListener('click', () => selectProject(project.projectId)); list.append(button);
      $('mobile-project').append(option(project.projectId, project.config.displayName));
      $('relation-project').append(option(project.projectId, project.config.displayName));
      $('conversation-project').append(option(project.projectId, project.config.displayName));
      $('logs-project').append(option(project.projectId, project.config.displayName));
    }
    setText($('project-count'), state.projects.length);
    $('mobile-project').value = state.activeProjectId;
    $('conversation-project').value = state.activeProjectId;
    $('relation-project').value = state.activeProjectId;
    renderRelations();
    updateProjectContext();
  }
  function updateProjectContext() {
    const project = activeProject();
    setText($('top-title'), project ? project.config.displayName : 'Project Knowledge');
    setText($('top-subtitle'), project ? project.config.repoPath : '选择项目开始工作');
    setText($('workbench-project'), project ? project.projectId : '尚未选择项目');
    $('chat-input').disabled = !project; $('chat-send').disabled = !project; $('open-delete').disabled = !project;
  }
  function selectProject(projectId) { if (projectId !== state.activeProjectId) closeSessionStream(); state.activeProjectId = projectId; renderProjects(); if (state.settings === 'conversation') loadConversations(true); }
  function showView(view) { state.view = view; document.querySelectorAll('.view').forEach(node => node.classList.toggle('active', node.id === `view-${view}`)); document.querySelectorAll('[data-view]').forEach(node => node.classList.toggle('active', node.dataset.view === view)); }
  async function loadState() {
    const body = await api('/api/state');
    state.projects = body.projects || [];
    if (!state.activeProjectId || !state.projects.some(project => project.projectId === state.activeProjectId)) state.activeProjectId = state.projects[0]?.projectId || '';
    $('knowledge-root').value = body.settings?.knowledge?.rootPath || '';
    renderProjects();
  }

  function openSettings(section = 'ai') { state.settingsOpen = true; $('settings-backdrop').hidden = false; $('settings-drawer').hidden = false; showSettings(section); }
  function closeSettings() { state.settingsOpen = false; $('settings-backdrop').hidden = true; $('settings-drawer').hidden = true; stopLogStream(); }
  function showSettings(section) {
    state.settings = section;
    document.querySelectorAll('[data-settings]').forEach(node => node.classList.toggle('active', node.dataset.settings === section));
    document.querySelectorAll('.settings-section').forEach(node => node.classList.toggle('active', node.id === `settings-${section}`));
    if (section === 'ai') loadProfiles();
    if (section === 'conversation') loadConversationProjects();
    if (section === 'logs') loadLogs(); else stopLogStream();
    if (section === 'knowledge') renderRelations();
  }
  async function loadProfiles() {
    const list = $('profile-list');
    try {
      const body = await api('/api/ai-profiles');
      list.replaceChildren();
      const profiles = body.config?.profiles || [];
      if (!profiles.length) return staticEmpty(list, '尚未配置 AI 模型。');
      for (const profile of profiles) {
        const card = document.createElement('div'); card.className = 'profile-card';
        const title = document.createElement('div'); title.className = 'profile-title'; title.textContent = profile.name || profile.id;
        const meta = document.createElement('div'); meta.className = 'meta'; meta.textContent = `${profile.vendor || 'custom'} · ${profile.model || '默认模型'} · ${profile.apiKeyConfigured ? '密钥已配置' : '未配置密钥'}`;
        card.append(title, meta); list.append(card);
      }
    } catch (error) { staticEmpty(list, error.message); }
  }
  function renderRelations() {
    const list = $('relation-list'); list.replaceChildren();
    const project = state.projects.find(item => item.projectId === $('relation-project').value) || activeProject();
    if (!project) return;
    const selected = new Set(project.config.relatedProjectIds || []);
    for (const candidate of state.projects) {
      if (candidate.projectId === project.projectId) continue;
      const label = document.createElement('label'); label.className = 'check';
      const input = document.createElement('input'); input.type = 'checkbox'; input.value = candidate.projectId; input.checked = selected.has(candidate.projectId);
      const text = document.createElement('span'); text.textContent = candidate.config.displayName; label.append(input, text); list.append(label);
    }
  }

  async function loadConversationProjects() {
    try {
      const body = await api('/api/conversations/projects');
      const allowed = new Set((body.projects || []).map(project => project.projectId));
      if (!allowed.has(state.activeProjectId)) state.activeProjectId = body.projects?.[0]?.projectId || '';
      $('conversation-project').value = state.activeProjectId;
      $('conversation-date').value = $('conversation-date').value || today();
      await loadConversations(true);
    } catch (error) { staticEmpty($('conversation-list'), error.message); }
  }
  async function loadConversations(reset = false) {
    const projectId = $('conversation-project').value || state.activeProjectId;
    const date = $('conversation-date').value || today();
    if (!projectId) return staticEmpty($('conversation-list'), '暂无可用项目。');
    if (reset) { state.conversationCursor = null; state.conversationTurns = []; }
    const params = new URLSearchParams({ projectId, date, limit: '50' });
    if (state.conversationCursor) params.set('cursor', state.conversationCursor);
    try {
      const body = await api(`/api/conversations/turns?${params}`);
      state.conversationTurns.push(...body.turns); state.conversationCursor = body.nextCursor || null; renderConversations();
    } catch (error) { staticEmpty($('conversation-list'), error.message); }
  }
  function renderConversations() {
    const list = $('conversation-list'); list.replaceChildren();
    if (!state.conversationTurns.length) return staticEmpty(list, '这个日期没有开发对话。');
    const labels = { committed: '已提交', associated: '关联提交', uncommitted: '未提交' };
    for (const turn of state.conversationTurns) {
      const card = document.createElement('article'); card.className = 'turn-card'; card.dataset.turnId = turn.turnId;
      const head = document.createElement('div'); head.className = 'turn-head'; head.textContent = formatTime(turn.startedAt);
      const body = document.createElement('div'); body.className = 'turn-body';
      const makeMessage = (label, value) => { const node = document.createElement('div'); node.className = 'turn-message'; const title = document.createElement('strong'); title.textContent = label; const text = document.createElement('span'); text.textContent = value; node.append(title, text); return node; };
      body.append(makeMessage('你的 Prompt', turn.userPrompt || '（无用户文本）'), makeMessage('AI 回复', turn.assistantReply || '（尚无回复）'));
      const foot = document.createElement('div'); foot.className = 'turn-foot'; const stamp = document.createElement('span'); stamp.textContent = formatTime(turn.updatedAt);
      const commit = document.createElement('span'); commit.className = `commit-label ${turn.annotation.status}`; const shas = (turn.annotation.commits || []).map(item => item.shortSha).join(' · '); commit.textContent = `${labels[turn.annotation.status] || '未提交'}${shas ? ` · ${shas}` : ''}`;
      foot.append(stamp, commit); card.append(head, body, foot); list.append(card);
    }
    if (state.conversationCursor) { const more = document.createElement('button'); more.className = 'button'; more.textContent = '加载更早对话'; more.addEventListener('click', () => loadConversations(false)); list.append(more); }
  }

  function logParams(includeCursor = false) {
    const params = new URLSearchParams(); const date = $('logs-date').value || today();
    params.set('from', date); params.set('to', date); params.set('pageSize', $('logs-limit').value || '500');
    if ($('logs-project').value) params.set('projectId', $('logs-project').value);
    if ($('logs-scope').value === 'important') params.set('levels', 'info,warn,error,fatal');
    if ($('logs-scope').value === 'errors') params.set('levels', 'warn,error,fatal');
    if ($('logs-search').value.trim()) params.set('q', $('logs-search').value.trim());
    if (includeCursor && state.logCursor) params.set('streamCursor', state.logCursor);
    return params;
  }
  async function loadLogs() {
    stopLogStream(); $('logs-date').value = $('logs-date').value || today(); staticEmpty($('record-list'), '正在读取运行记录…');
    try {
      const body = await api(`/api/logs?${logParams()}`);
      state.logs = [...(body.entries || [])].reverse(); state.logCursor = body.streamCursor || ''; state.newLogs = 0; renderLogs();
      requestAnimationFrame(() => { const list = $('record-list'); list.scrollTop = list.scrollHeight; });
      if ($('logs-date').value === today()) startLogStream();
    } catch (error) { staticEmpty($('record-list'), error.message); }
  }
  function renderLogs() {
    const list = $('record-list'); const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 48; list.replaceChildren();
    if (!state.logs.length) staticEmpty(list, '当前条件下没有运行记录。');
    for (const record of state.logs) {
      const article = document.createElement('article'); article.className = 'log-record'; article.dataset.level = record.level; article.dataset.logId = record.id;
      const row = document.createElement('div'); row.className = 'record-row'; const body = document.createElement('div'); body.className = 'record-body';
      const message = document.createElement('div'); message.className = 'record-message'; message.textContent = record.message || record.event;
      const meta = document.createElement('div'); meta.className = 'record-meta';
      for (const value of [record.projectDisplayName || record.projectId || '系统', record.phase, record.durationMs ? `${record.durationMs} ms` : '']) { if (!value) continue; const span = document.createElement('span'); span.textContent = value; meta.append(span); }
      body.append(message, meta); const time = document.createElement('time'); time.className = 'record-time'; time.dateTime = record.ts; time.textContent = formatTime(record.ts); row.append(body, time);
      const detail = document.createElement('div'); detail.className = 'record-detail'; const grid = document.createElement('div'); grid.className = 'detail-grid';
      for (const [label, value] of [['级别', record.level], ['组件', record.component || '—'], ['事件', record.event || '—'], ['操作', record.operationId || '—'], ['阶段', record.phase || '—'], ['尝试', String(record.attempt || 0)], ['提交', record.commitSha || '—'], ['运行', record.runId || '—'], ['耗时', record.durationMs == null ? '—' : `${record.durationMs} ms`], ['记录 ID', record.id]]) { const item = document.createElement('div'); item.className = 'detail-item'; const strong = document.createElement('strong'); strong.textContent = label; const span = document.createElement('span'); span.textContent = value; item.append(strong, span); grid.append(item); }
      const raw = document.createElement('pre'); raw.className = 'detail-json'; raw.textContent = JSON.stringify({ context: record.context, error: record.error }, null, 2);
      const copy = document.createElement('button'); copy.className = 'button detail-copy'; copy.textContent = '复制详情'; copy.addEventListener('click', event => { event.stopPropagation(); copyText(raw.textContent); }); detail.append(grid, raw, copy);
      row.addEventListener('click', () => article.classList.toggle('expanded')); article.append(row, detail); list.append(article);
    }
    setText($('logs-summary'), `${state.logs.length} 条记录`); if (nearBottom) requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; }); updateNewLogButton();
  }
  function appendLog(record) {
    if (state.logs.some(item => item.id === record.id)) return;
    const list = $('record-list'); const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 48; state.logs.push(record);
    const limit = Number($('logs-limit').value || 500); if (state.logs.length > limit) state.logs.splice(0, state.logs.length - limit);
    if (!atBottom) state.newLogs += 1; renderLogs(); if (atBottom) requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
  }
  function updateNewLogButton() { const button = $('new-records'); button.hidden = !state.newLogs; button.textContent = `有 ${state.newLogs} 条新记录`; }
  function startLogStream() {
    if (!state.logCursor) return;
    const stream = new EventSource(`/api/logs/stream?${logParams(true)}`); state.logStream = stream; $('logs-connection').textContent = '';
    stream.addEventListener('logs/appended', event => { try { appendLog(JSON.parse(event.data).record); } catch {} });
    stream.addEventListener('logs/ready', () => { $('logs-connection').textContent = ''; }); stream.onerror = () => { $('logs-connection').textContent = '连接正在恢复…'; };
  }
  function stopLogStream() { if (state.logStream) { state.logStream.close(); state.logStream = null; } $('logs-connection').textContent = ''; }
  async function exportLogs() {
    const response = await fetch(`/api/logs/export?${logParams()}`); if (!response.ok) throw new Error(`导出失败 (${response.status})`);
    const blob = await response.blob(); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `project-knowledge-logs-${$('logs-date').value || today()}.jsonl`; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  function toggleTheme() { const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = next; localStorage.setItem('pk-theme', next); }

  function appendWorkbenchCard(kind, label, value) {
    const list = $('chat-list'); if (list.querySelector('.empty')) list.replaceChildren();
    const card = document.createElement('div'); card.className = `message-card ${kind}`;
    const role = document.createElement('div'); role.className = 'message-role'; role.textContent = label;
    const content = document.createElement('span'); content.className = 'message-content'; content.textContent = value || '';
    card.append(role, content); list.append(card); list.scrollTop = list.scrollHeight;
    return { card, content, role };
  }
  function renderWorkbenchEvent(event) {
    if (!event || !event.type) return;
    if (event.type === 'claude/message-start' && event.role === 'assistant') state.assistantCard = null;
    if (event.type === 'claude/user-prompt' && event.text && event.text !== state.lastUserText) {
      appendWorkbenchCard('user', '你', event.text); state.lastUserText = event.text;
    }
    if (event.type === 'claude/text-delta' && event.text) {
      if (!state.assistantCard) state.assistantCard = appendWorkbenchCard('assistant', 'Claude', '');
      state.assistantCard.content.textContent += event.text; $('chat-list').scrollTop = $('chat-list').scrollHeight;
    }
    if (event.type === 'claude/result' && event.result && !event.isError) {
      if (!state.assistantCard) state.assistantCard = appendWorkbenchCard('assistant', 'Claude', event.result);
      else state.assistantCard.content.textContent = event.result;
    }
    if (event.type === 'claude/tool-use-start' || event.type === 'claude/tool-use') {
      const key = event.id || `${event.name || 'tool'}-${state.toolCards.size}`;
      let item = state.toolCards.get(key);
      if (!item) { item = appendWorkbenchCard('tool', `工具 · ${event.name || 'Tool'}`, '运行中'); state.toolCards.set(key, item); }
      const detail = event.input ? JSON.stringify(event.input, null, 2) : (event.summary || '运行中'); item.content.textContent = detail;
    }
    if (event.type === 'claude/state') { setText($('workbench-status'), event.state === 'idle' ? '就绪' : event.state); if (['ended', 'failed', 'aborted'].includes(event.state)) state.assistantCard = null; }
    if (event.type === 'claude/error') appendWorkbenchCard('error', '错误', event.message || 'Claude 会话失败。');
  }
  function closeSessionStream() { if (state.sessionStream) state.sessionStream.close(); state.sessionStream = null; state.activeSessionId = ''; state.assistantCard = null; state.toolCards.clear(); }
  function subscribeSession(sessionId) {
    if (state.sessionStream) state.sessionStream.close();
    const stream = new EventSource(`/api/claude/sessions/${encodeURIComponent(sessionId)}/events`); state.sessionStream = stream;
    for (const type of ['claude/message-start', 'claude/user-prompt', 'claude/text-delta', 'claude/result', 'claude/tool-use-start', 'claude/tool-use', 'claude/state', 'claude/error']) stream.addEventListener(type, event => { try { renderWorkbenchEvent(JSON.parse(event.data)); } catch {} });
    stream.onerror = () => { if (state.activeSessionId === sessionId) setText($('workbench-status'), '正在重连'); };
  }

  async function submitImport(event) {
    event.preventDefault(); const notice = $('import-notice');
    try {
      const body = await api('/api/projects/import', { method: 'POST', body: JSON.stringify({ localPath: $('import-path').value, displayName: $('import-name').value || undefined, projectId: $('import-id').value || undefined }) });
      notice.className = 'notice'; notice.textContent = '项目已导入。'; await loadState(); selectProject(body.projectId); showView('workbench'); event.target.reset();
    } catch (error) { notice.className = 'notice error'; notice.textContent = error.message; }
  }
  async function sendChat() {
    const project = activeProject(), text = $('chat-input').value.trim(); if (!project || !text) return;
    state.lastUserText = text; appendWorkbenchCard('user', '你', text); $('chat-input').value = ''; state.assistantCard = null;
    try { if (!state.activeSessionId) { const started = await api('/api/claude/sessions', { method: 'POST', body: JSON.stringify({ projectId: project.projectId }) }); state.activeSessionId = started.sessionId; subscribeSession(started.sessionId); } await api(`/api/claude/sessions/${encodeURIComponent(state.activeSessionId)}/input`, { method: 'POST', body: JSON.stringify({ text }) }); }
    catch (error) { appendWorkbenchCard('error', '错误', error.message); }
  }

  document.querySelectorAll('[data-view]').forEach(node => node.addEventListener('click', () => showView(node.dataset.view)));
  document.querySelectorAll('[data-settings]').forEach(node => node.addEventListener('click', () => showSettings(node.dataset.settings)));
  for (const id of ['open-settings', 'top-settings', 'mobile-settings']) $(id).addEventListener('click', () => openSettings('ai'));
  for (const id of ['top-import', 'mobile-import']) $(id).addEventListener('click', () => showView('import'));
  $('close-settings').addEventListener('click', closeSettings); $('settings-backdrop').addEventListener('click', closeSettings);
  $('theme-button').addEventListener('click', toggleTheme); $('client-theme').addEventListener('click', toggleTheme);
  $('mobile-project').addEventListener('change', event => selectProject(event.target.value)); $('import-form').addEventListener('submit', submitImport); $('import-cancel').addEventListener('click', () => showView('workbench'));
  $('chat-send').addEventListener('click', sendChat); $('chat-input').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendChat(); } });
  $('save-knowledge').addEventListener('click', async () => { try { await api('/api/settings', { method: 'PATCH', body: JSON.stringify({ knowledge: { rootPath: $('knowledge-root').value } }) }); await loadState(); } catch (error) { alert(error.message); } });
  $('relation-project').addEventListener('change', renderRelations); $('save-relations').addEventListener('click', async () => { const projectId = $('relation-project').value, relatedProjectIds = [...$('relation-list').querySelectorAll('input:checked')].map(input => input.value); try { await api(`/api/projects/${encodeURIComponent(projectId)}`, { method: 'PATCH', body: JSON.stringify({ relatedProjectIds }) }); await loadState(); } catch (error) { alert(error.message); } });
  $('conversation-project').addEventListener('change', event => { state.activeProjectId = event.target.value; loadConversations(true); }); $('conversation-date').addEventListener('change', () => loadConversations(true));
  let logTimer; for (const id of ['logs-date', 'logs-project', 'logs-scope', 'logs-limit']) $(id).addEventListener('change', loadLogs); $('logs-search').addEventListener('input', () => { clearTimeout(logTimer); logTimer = setTimeout(loadLogs, 250); }); $('logs-export').addEventListener('click', () => exportLogs().catch(error => { $('logs-connection').textContent = error.message; })); $('new-records').addEventListener('click', () => { state.newLogs = 0; updateNewLogButton(); const list = $('record-list'); list.scrollTop = list.scrollHeight; });
  $('open-delete').addEventListener('click', () => { const project = activeProject(); if (!project) return; $('delete-copy').textContent = `确认解除“${project.config.displayName}”？默认保留知识目录。`; $('delete-knowledge').checked = false; $('delete-confirm').value = ''; $('delete-confirm-field').hidden = true; $('delete-error').hidden = true; $('delete-dialog').showModal(); });
  $('delete-knowledge').addEventListener('change', event => { $('delete-confirm-field').hidden = !event.target.checked; }); $('delete-cancel').addEventListener('click', () => $('delete-dialog').close());
  $('delete-submit').addEventListener('click', async () => { const project = activeProject(); try { await api(`/api/projects/${encodeURIComponent(project.projectId)}`, { method: 'DELETE', body: JSON.stringify({ deleteKnowledge: $('delete-knowledge').checked, confirmationToken: $('delete-confirm').value }) }); $('delete-dialog').close(); await loadState(); } catch (error) { $('delete-error').hidden = false; $('delete-error').textContent = error.message; } });

  document.documentElement.dataset.theme = localStorage.getItem('pk-theme') || 'light'; $('logs-date').value = today(); $('conversation-date').value = today();
  window.__PK_APP__ = { getState: () => ({ projects: state.projects.length, activeProjectId: state.activeProjectId, view: state.view, settings: state.settings, settingsOpen: state.settingsOpen, conversationTurns: state.conversationTurns.length, logCount: state.logs.length, newLogs: state.newLogs }), openSettings, showSettings, loadLogs, renderWorkbenchEvent };
  loadState().catch(error => { setText($('top-subtitle'), error.message); });
})();
