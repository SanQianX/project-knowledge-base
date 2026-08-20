(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const { t: i18n, setLanguage, activeLanguage } = window.I18N || { t: k => k };
  const state = {
    projects: [], profiles: [], profileConfig: null, profileIndex: -1, profileKey: '',
    activeProjectId: '', view: 'workbench', settings: 'ai', settingsOpen: false,
    conversationCursor: null, conversationTurns: [], logs: [], logStream: null, logCursor: '', newLogs: 0,
    activeSessionId: '', sessionStream: null, assistantContent: null, toolCards: new Map(), lastUserText: '',
    messageCount: 0, pendingDeleteId: '',
  };
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

  function projectDotClass(project) {
    if (project.projectId === state.activeProjectId) return 'dot claude';
    return project.config.enabled === false ? 'dot idle' : 'dot good';
  }
  function renderProjects() {
    const list = $('project-list');
    list.replaceChildren();
    $('mobile-project').replaceChildren();
    $('conversation-project').replaceChildren();
    $('logs-project').replaceChildren(option('', '全部项目'));
    for (const project of state.projects) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = `project-card${project.projectId === state.activeProjectId ? ' active' : ''}`;
      card.dataset.projectId = project.projectId;
      const line = document.createElement('div'); line.className = 'project-line';
      const main = document.createElement('div');
      const name = document.createElement('div'); name.className = 'project-name'; name.textContent = project.config.displayName;
      const id = document.createElement('div'); id.className = 'project-id'; id.textContent = project.projectId;
      main.append(name, id);
      const dot = document.createElement('span'); dot.className = projectDotClass(project);
      line.append(main, dot);
      const repo = document.createElement('div'); repo.className = 'project-path'; repo.textContent = project.config.repoPath || '';
      card.append(line, repo);
      card.addEventListener('click', () => selectProject(project.projectId));
      card.addEventListener('contextmenu', event => {
        event.preventDefault();
        openContextmenu(project.projectId, event.clientX, event.clientY);
      });
      list.append(card);
      $('mobile-project').append(option(project.projectId, project.config.displayName));
      $('conversation-project').append(option(project.projectId, project.config.displayName));
      $('logs-project').append(option(project.projectId, project.config.displayName));
    }
    $('mobile-project').value = state.activeProjectId;
    $('conversation-project').value = state.activeProjectId;
    renderAssignments();
    renderRelations();
    updateProjectContext();
  }
  function updateProjectContext() {
    const project = activeProject();
    setText($('wb-project'), project ? project.config.displayName : '未选择项目');
    const modelChip = $('wb-model');
    const profile = project && state.profiles.find(item => item.id === project.config.aiProfileId);
    if (profile) { setText(modelChip, `${profile.vendor || profile.id} · ${profile.model || profile.mainModel || ''}`); modelChip.hidden = false; }
    else { setText(modelChip, ''); modelChip.hidden = true; }
    $('chat-input').disabled = !project; $('send-btn').disabled = !project;
  }
  function selectProject(projectId) { if (projectId !== state.activeProjectId) closeSessionStream(); state.activeProjectId = projectId; renderProjects(); if (state.settings === 'conversation') loadConversations(true); }
  const viewTitles = { workbench: 'Claude Code', import: '导入项目' };
  function showView(view) {
    state.view = view;
    document.querySelectorAll('.view').forEach(node => node.classList.toggle('active', node.id === `view-${view}`));
    document.querySelectorAll('[data-go]').forEach(node => node.classList.toggle('active', node.dataset.go === view));
    setText($('page-title'), viewTitles[view] || view);
    hideContextmenu();
  }
  async function loadState() {
    const [body, profileBody] = await Promise.all([api('/api/state'), api('/api/ai-profiles')]);
    state.projects = body.projects || [];
    state.profileConfig = profileBody.config || null;
    state.profiles = state.profileConfig?.profiles || [];
    if (!state.activeProjectId || !state.projects.some(project => project.projectId === state.activeProjectId)) state.activeProjectId = state.projects[0]?.projectId || '';
    $('knowledge-root').value = body.settings?.knowledge?.rootPath || '';
    setText($('brand-root'), body.settings?.knowledge?.rootPath || '');
    fillImportProfiles();
    renderProjects();
    if (state.settings === 'ai') fillProfileFields();
  }

  function fillImportProfiles() {
    const select = $('import-profile');
    if (!select) return;
    select.replaceChildren();
    select.append(option('', i18n('app.import.profile.help')));
    for (const profile of state.profiles) {
      const label = profile.name ? `${profile.name} · ${profile.id}` : profile.id;
      select.append(option(profile.id, label));
    }
    if (state.profileConfig && state.profileConfig.defaultProfileId) {
      select.value = state.profileConfig.defaultProfileId;
    }
  }

  const settingsTitles = {
    ai: ['AI 模型', '配置模型并为项目分配 Profile。'],
    knowledge: ['知识库存储', '设置未来新导入项目使用的全局知识库根目录。'],
    relations: ['知识关联', '管理显式的跨项目知识检索关系。'],
    conversation: ['开发对话', '查看项目开发过程中的需求与 AI 回复。'],
    logs: ['日志', '查看系统和项目的运行记录；异常会自动突出显示。'],
    client: ['桌面客户端', '桌面版本与更新状态。'],
  };
  function openSettings(section = 'ai') { state.settingsOpen = true; $('settings-backdrop').classList.add('show'); $('settings-drawer').classList.add('show'); showSettings(section); }
  function closeSettings() { state.settingsOpen = false; $('settings-backdrop').classList.remove('show'); $('settings-drawer').classList.remove('show'); stopLogStream(); }
  function showSettings(section) {
    state.settings = section;
    document.querySelectorAll('[data-settings]').forEach(node => node.classList.toggle('active', node.dataset.settings === section));
    document.querySelectorAll('.settings-section').forEach(node => node.classList.toggle('active', node.id === `settings-${section}`));
    const [title, help] = settingsTitles[section] || ['', ''];
    setText($('settings-title'), title); setText($('settings-help'), help);
    if (section === 'ai') { fillProfileSelect(); fillProfileFields(); renderAssignments(); }
    if (section === 'conversation') loadConversationProjects();
    if (section === 'logs') loadLogs(); else stopLogStream();
    if (section === 'relations') renderRelations();
  }

  function fillProfileSelect() {
    const select = $('profile-select');
    select.replaceChildren();
    state.profiles.forEach((profile, index) => select.append(option(String(index), `${profile.id}${profile.model ? ' · ' + profile.model : ''}`)));
    if (state.profileIndex < 0 || state.profileIndex >= state.profiles.length) state.profileIndex = state.profiles.length ? 0 : -1;
    select.value = String(state.profileIndex);
  }
  function fillProfileFields() {
    const profile = state.profiles[state.profileIndex];
    $('profile-vendor').value = profile?.vendor || '';
    $('profile-model').value = profile?.model || profile?.mainModel || '';
    $('profile-base-url').value = profile?.baseUrl || '';
    $('profile-key').value = '';
    state.profileKey = '';
    $('profile-vendor').disabled = $('profile-model').disabled = $('profile-base-url').disabled = $('profile-key').disabled = !profile;
  }
  function bindProfileDraft() {
    const profile = state.profiles[state.profileIndex];
    if (!profile) return;
    profile.vendor = $('profile-vendor').value;
    profile.model = $('profile-model').value;
    profile.baseUrl = $('profile-base-url').value;
  }
  async function saveProfiles() {
    bindProfileDraft();
    const profiles = state.profiles.map((profile, index) => {
      const { hasApiKey, apiKeyMasked, ...rest } = profile;
      if (index === state.profileIndex && state.profileKey) rest.apiKeyUpdate = { mode: 'replace', value: state.profileKey };
      return rest;
    });
    try {
      const body = await api('/api/ai-profiles', { method: 'PUT', body: JSON.stringify({ profiles, defaultProfileId: state.profileConfig?.defaultProfileId || null }) });
      state.profileConfig = body.config; state.profiles = body.config?.profiles || [];
      fillProfileSelect(); fillProfileFields(); renderAssignments(); updateProjectContext();
      flashProfileSaved('模型配置已保存。');
    } catch (error) { flashProfileSaved(error.message, true); }
  }
  function flashProfileSaved(message, isError = false) {
    const notice = $('profile-notice');
    notice.hidden = false; notice.className = `notice${isError ? ' error' : ''}`; notice.textContent = message;
    if (!isError) setTimeout(() => { if (notice.textContent === message) notice.hidden = true; }, 2500);
  }
  function renderAssignments() {
    const host = $('assignment-list'); if (!host) return;
    host.replaceChildren();
    if (!state.profiles.length) { const empty = document.createElement('div'); empty.className = 'muted'; empty.style.fontSize = '12px'; empty.textContent = '尚未配置 AI 模型。'; host.append(empty); return; }
    for (const project of state.projects) {
      const row = document.createElement('div'); row.className = 'panel project-assign';
      const name = document.createElement('span'); name.textContent = project.config.displayName;
      const select = document.createElement('select'); select.className = 'input';
      select.append(option('', '未分配'));
      for (const profile of state.profiles) select.append(option(profile.id, `${profile.id} · ${profile.model || profile.mainModel || '默认模型'}`));
      select.value = project.config.aiProfileId || '';
      select.addEventListener('change', async () => {
        if (!select.value) { select.value = project.config.aiProfileId || ''; return; }
        try { await api(`/api/projects/${encodeURIComponent(project.projectId)}`, { method: 'PATCH', body: JSON.stringify({ aiProfileId: select.value }) }); await loadState(); }
        catch (error) { alert(error.message); select.value = project.config.aiProfileId || ''; }
      });
      row.append(name, select); host.append(row);
    }
  }
  function renderRelations() {
    const host = $('relation-list'); if (!host) return;
    host.replaceChildren();
    const project = activeProject();
    if (!project) { const empty = document.createElement('div'); empty.className = 'muted'; empty.style.fontSize = '12px'; empty.textContent = '暂无可用项目。'; host.append(empty); return; }
    const selected = new Set(project.config.relatedProjectIds || []);
    let any = false;
    for (const candidate of state.projects) {
      if (candidate.projectId === project.projectId) continue;
      any = true;
      const row = document.createElement('label'); row.className = 'panel project-assign';
      const name = document.createElement('span'); name.textContent = candidate.config.displayName;
      const input = document.createElement('input'); input.type = 'checkbox'; input.value = candidate.projectId; input.checked = selected.has(candidate.projectId);
      row.append(name, input); host.append(row);
    }
    if (!any) { const empty = document.createElement('div'); empty.className = 'muted'; empty.style.fontSize = '12px'; empty.textContent = '没有其他可关联的项目。'; host.append(empty); }
  }

  async function loadConversationProjects() {
    try {
      const body = await api('/api/conversations/projects');
      const allowed = new Set((body.projects || []).map(project => project.projectId));
      if (!allowed.has(state.activeProjectId)) state.activeProjectId = body.projects?.[0]?.projectId || '';
      $('conversation-project').value = state.activeProjectId;
      $('conversation-date').value = $('conversation-date').value || today();
      await loadConversations(true);
    } catch (error) { renderConversationEmpty(error.message); }
  }
  async function loadConversations(reset = false) {
    const projectId = $('conversation-project').value || state.activeProjectId;
    const date = $('conversation-date').value || today();
    if (!projectId) return renderConversationEmpty('暂无可用项目。');
    if (reset) { state.conversationCursor = null; state.conversationTurns = []; }
    const params = new URLSearchParams({ projectId, date, limit: '50' });
    if (state.conversationCursor) params.set('cursor', state.conversationCursor);
    try {
      const body = await api(`/api/conversations/turns?${params}`);
      state.conversationTurns.push(...body.turns); state.conversationCursor = body.nextCursor || null; renderConversations();
    } catch (error) { renderConversationEmpty(error.message); }
  }
  function renderConversationEmpty(message) {
    const stream = $('conversation-stream');
    stream.replaceChildren();
    const empty = document.createElement('div'); empty.className = 'conversation-empty'; empty.textContent = message || '这一天还没有开发对话。';
    stream.append(empty);
  }
  function renderConversations() {
    const stream = $('conversation-stream');
    stream.replaceChildren();
    if (!state.conversationTurns.length) return renderConversationEmpty('这一天还没有开发对话。');
    const labels = { committed: '已提交', associated: '关联提交', uncommitted: '未提交' };
    for (const turn of state.conversationTurns) {
      const wrap = document.createElement('article'); wrap.className = 'turn'; wrap.dataset.turnId = turn.turnId;
      const head = document.createElement('div'); head.className = 'turn-head';
      const at = document.createElement('span'); at.textContent = formatTime(turn.startedAt);
      head.append(at);
      const card = document.createElement('div'); card.className = 'turn-card';
      const makeMessage = (className, role, value) => {
        const message = document.createElement('div'); message.className = `turn-message ${className}`;
        const roleNode = document.createElement('div'); roleNode.className = 'turn-role'; roleNode.textContent = role;
        const text = document.createElement('div'); text.className = 'turn-text'; text.textContent = value;
        message.append(roleNode, text); return message;
      };
      card.append(
        makeMessage('user', '你', turn.userPrompt || '（无用户文本）'),
        makeMessage('assistant', 'AI', turn.assistantReply || '（尚无回复）'),
      );
      const foot = document.createElement('div'); foot.className = 'turn-foot';
      const label = document.createElement('span'); label.className = `commit-label ${turn.annotation.status}`;
      label.textContent = labels[turn.annotation.status] || '未提交';
      foot.append(label);
      for (const commit of turn.annotation.commits || []) {
        const ref = document.createElement('span'); ref.className = 'commit-ref'; ref.textContent = commit.shortSha;
        if (commit.subject) ref.title = commit.subject;
        foot.append(ref);
      }
      card.append(foot); wrap.append(head, card); stream.append(wrap);
    }
    if (state.conversationCursor) {
      const more = document.createElement('button'); more.type = 'button'; more.className = 'btn'; more.style.display = 'block'; more.style.margin = '0 auto';
      more.textContent = '加载更早对话'; more.addEventListener('click', () => loadConversations(false));
      stream.append(more);
    }
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
    stopLogStream(); $('logs-date').value = $('logs-date').value || today();
    $('record-list').replaceChildren(); $('record-empty').style.display = 'none';
    setText($('logs-summary'), '正在读取运行记录…');
    try {
      const body = await api(`/api/logs?${logParams()}`);
      state.logs = [...(body.entries || [])].reverse(); state.logCursor = body.streamCursor || ''; state.newLogs = 0; renderLogs();
      requestAnimationFrame(() => { const list = $('record-list'); list.scrollTop = list.scrollHeight; });
      if ($('logs-date').value === today()) startLogStream();
    } catch (error) {
      state.logs = []; renderLogs(); $('record-empty').style.display = 'block';
      $('record-empty').textContent = error.message; setText($('logs-summary'), '读取失败');
    }
  }
  function createRecordEntry(record) {
    const entry = document.createElement('div');
    entry.className = 'record-entry'; entry.dataset.logId = record.id; entry.dataset.level = record.level;
    const row = document.createElement('button'); row.type = 'button'; row.className = 'record-row';
    const main = document.createElement('span'); main.className = 'record-main';
    const title = document.createElement('span'); title.className = 'record-title'; title.textContent = record.message;
    const meta = document.createElement('span'); meta.className = 'record-meta';
    const parts = [
      ['record-project', record.projectDisplayName || record.projectId || '系统'],
      ['record-category', record.component || record.event || ''],
      ['record-duration', record.durationMs != null ? `${record.durationMs.toLocaleString()} ms` : ''],
    ];
    parts.forEach(([className, value], index) => {
      if (!value) return;
      if (index) { const sep = document.createElement('span'); sep.className = 'record-meta-sep'; sep.textContent = '·'; meta.append(sep); }
      const node = document.createElement('span'); node.className = className; node.textContent = value; meta.append(node);
    });
    main.append(title, meta);
    const time = document.createElement('span'); time.className = 'record-time'; time.textContent = formatTime(record.ts);
    row.append(main, time);
    const detail = document.createElement('div'); detail.className = 'record-detail';
    const grid = document.createElement('div'); grid.className = 'record-detail-grid';
    for (const [key, value] of [
      ['level', String(record.level || '').toUpperCase()], ['component', record.component || '—'], ['event', record.event || '—'],
      ['operationId', record.operationId || '—'], ['runId', record.runId || '—'], ['commit', record.commitSha || '—'],
      ['phase', record.phase || '—'], ['attempt', String(record.attempt || 0)], ['durationMs', record.durationMs == null ? '—' : String(record.durationMs)],
    ]) {
      const span = document.createElement('span'); const b = document.createElement('b'); b.textContent = `${key}:`;
      span.append(b, document.createTextNode(` ${value}`)); grid.append(span);
    }
    const message = document.createElement('div'); message.className = 'record-detail-message'; message.textContent = record.message;
    const actions = document.createElement('div'); actions.className = 'record-detail-actions';
    const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'btn'; copy.textContent = '复制详情';
    copy.addEventListener('click', event => { event.stopPropagation(); copyText(message.textContent); });
    actions.append(copy);
    detail.append(grid, message, actions);
    row.addEventListener('click', () => entry.classList.toggle('open'));
    entry.append(row, detail);
    return entry;
  }
  function renderLogs() {
    const list = $('record-list'); const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 48;
    const frag = document.createDocumentFragment();
    for (const record of state.logs) frag.append(createRecordEntry(record));
    list.replaceChildren(frag);
    $('record-empty').style.display = state.logs.length ? 'none' : 'block';
    const limit = Number($('logs-limit').value || 500);
    setText($('logs-summary'), `已加载 ${state.logs.length.toLocaleString()} 条 · 显示上限 ${limit.toLocaleString()} 条`);
    if (nearBottom) requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
    updateNewLogButton();
  }
  function appendLog(record) {
    if (state.logs.some(item => item.id === record.id)) return;
    const list = $('record-list'); const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 48;
    state.logs.push(record);
    const limit = Number($('logs-limit').value || 500);
    if (state.logs.length > limit) {
      state.logs.splice(0, state.logs.length - limit);
      while (list.children.length > state.logs.length) list.firstElementChild.remove();
    }
    $('record-empty').style.display = 'none';
    list.append(createRecordEntry(record));
    setText($('logs-summary'), `已加载 ${state.logs.length.toLocaleString()} 条 · 显示上限 ${limit.toLocaleString()} 条`);
    if (!atBottom) state.newLogs += 1;
    updateNewLogButton();
    if (atBottom) requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
  }
  function updateNewLogButton() { const button = $('new-records'); button.hidden = !state.newLogs; button.textContent = `有 ${state.newLogs} 条新记录`; }
  function startLogStream() {
    if (!state.logCursor) return;
    const stream = new EventSource(`/api/logs/stream?${logParams(true)}`); state.logStream = stream;
    const warning = $('logs-connection');
    stream.addEventListener('logs/appended', event => { try { appendLog(JSON.parse(event.data).record); } catch {} });
    stream.addEventListener('logs/ready', () => warning.classList.remove('show'));
    stream.onerror = () => warning.classList.add('show');
  }
  function stopLogStream() {
    if (state.logStream) { state.logStream.close(); state.logStream = null; }
    $('logs-connection').classList.remove('show');
  }
  async function exportLogs() {
    const response = await fetch(`/api/logs/export?${logParams()}`); if (!response.ok) throw new Error(`导出失败 (${response.status})`);
    const blob = await response.blob(); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `project-knowledge-logs-${$('logs-date').value || today()}.jsonl`; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function toggleTheme() {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next; localStorage.setItem('pk-theme', next);
    setText($('theme-button'), next === 'dark' ? '浅色模式' : '深色模式');
  }

  function clearChatEmpty() { $('chat').querySelector('.empty-chat')?.remove(); }
  function bumpMessageCount() { state.messageCount += 1; setText($('msg-count'), String(state.messageCount)); }
  function appendBubble(kind, build) {
    clearChatEmpty();
    const row = document.createElement('div'); row.className = `msg-row${kind === 'user' ? ' user' : ''}`;
    const bubble = document.createElement('div'); bubble.className = kind === 'tool' ? 'bubble tool-card' : `bubble${kind === 'error' ? ' error' : ''}`;
    build(bubble);
    row.append(bubble); $('chat').append(row); $('chat').scrollTop = $('chat').scrollHeight;
    bumpMessageCount();
    return { row, bubble };
  }
  function renderWorkbenchEvent(event) {
    if (!event || !event.type) return;
    if (event.type === 'claude/message-start' && event.role === 'assistant') state.assistantContent = null;
    if (event.type === 'claude/user-prompt' && event.text && event.text !== state.lastUserText) {
      state.lastUserText = event.text;
      appendBubble('user', bubble => { bubble.textContent = event.text; });
    }
    if (event.type === 'claude/text-delta' && event.text) {
      if (!state.assistantContent) {
        state.assistantContent = appendBubble('assistant', bubble => {
          const name = document.createElement('strong'); name.textContent = 'Claude';
          bubble.append(name, document.createElement('br'), document.createElement('br'));
          const content = document.createElement('span'); bubble.append(content);
        }).bubble.querySelector('span:last-child');
      }
      state.assistantContent.textContent += event.text; $('chat').scrollTop = $('chat').scrollHeight;
    }
    if (event.type === 'claude/result' && event.result && !event.isError) {
      if (!state.assistantContent) {
        state.assistantContent = appendBubble('assistant', bubble => {
          const name = document.createElement('strong'); name.textContent = 'Claude';
          bubble.append(name, document.createElement('br'), document.createElement('br'));
          const content = document.createElement('span'); bubble.append(content);
        }).bubble.querySelector('span:last-child');
      }
      state.assistantContent.textContent = event.result;
    }
    if (event.type === 'claude/tool-use-start' || event.type === 'claude/tool-use') {
      const key = event.id || `${event.name || 'tool'}-${state.toolCards.size}`;
      let item = state.toolCards.get(key);
      if (!item) {
        item = appendBubble('tool', bubble => {
          const title = document.createElement('div'); title.className = 'tool-title';
          const code = document.createElement('div'); code.className = 'tool-code';
          bubble.append(title, code);
        });
        state.toolCards.set(key, item);
      }
      const title = item.bubble.querySelector('.tool-title');
      const code = item.bubble.querySelector('.tool-code');
      const hint = event.input?.path || event.input?.file_path || event.input?.command || '';
      setText(title, `${event.name || 'Tool'}${hint ? ' · ' + hint : ''}`);
      setText(code, event.input ? JSON.stringify(event.input, null, 2) : (event.summary || '运行中'));
      $('chat').scrollTop = $('chat').scrollHeight;
    }
    if (event.type === 'claude/state') {
      setText($('wb-state'), event.state === 'idle' ? '就绪' : event.state);
      if (['ended', 'failed', 'aborted'].includes(event.state)) state.assistantContent = null;
    }
    if (event.type === 'claude/error') appendBubble('error', bubble => { bubble.textContent = event.message || 'Claude 会话失败。'; });
  }
  function closeSessionStream() { if (state.sessionStream) state.sessionStream.close(); state.sessionStream = null; state.activeSessionId = ''; state.assistantContent = null; state.toolCards.clear(); }
  function subscribeSession(sessionId) {
    if (state.sessionStream) state.sessionStream.close();
    const stream = new EventSource(`/api/claude/sessions/${encodeURIComponent(sessionId)}/events`); state.sessionStream = stream;
    for (const type of ['claude/message-start', 'claude/user-prompt', 'claude/text-delta', 'claude/result', 'claude/tool-use-start', 'claude/tool-use', 'claude/state', 'claude/error']) stream.addEventListener(type, event => { try { renderWorkbenchEvent(JSON.parse(event.data)); } catch {} });
    stream.onerror = () => { if (state.activeSessionId === sessionId) setText($('wb-state'), '正在重连'); };
  }

  async function submitImport(event) {
    event.preventDefault();
    const notice = $('import-notice') || (() => { const n = document.createElement('div'); n.id = 'import-notice'; n.className = 'notice'; n.hidden = true; document.querySelector('#import-form').appendChild(n); return n; })();
    const payload = buildImportPayload();
    try {
      const body = await api('/api/projects/import', { method: 'POST', body: JSON.stringify(payload) });
      notice.hidden = false; notice.className = 'notice'; notice.textContent = '项目已导入。';
      const projectId = body.projectId || body.project?.projectId || '';
      const config = body.project?.config || body.config || {};
      // T07: the preview-pane labels changed. Only pv-repo + pv-knowledge-root
      // survive in the new layout; pv-project-id / pv-knowledge were dropped
      // because they duplicate the project sidebar. Guard against null.
      if ($('pv-repo')) setText($('pv-repo'), config.repoPath || payload.localPath);
      if ($('pv-knowledge-root')) setText($('pv-knowledge-root'), config.knowledgePath || '');
      await loadState(); selectProject(projectId); showView('workbench'); event.target.reset();
    } catch (error) { notice.hidden = false; notice.className = 'notice error'; notice.textContent = error.message; }
  }

  // T07 — build the import payload from the new UI controls.
  function buildImportPayload() {
    const payload = {
      localPath: $('import-path').value,
      aiProfileId: $('import-profile').value || null,
      knowledgeLanguage: $('import-language').value || 'zh-CN',
    };
    if ($('import-team-enabled').checked) {
      const storePath = $('import-team-store').value.trim();
      const kbSubdir = $('import-team-subdir').value.trim();
      const provider = $('import-team-provider').value;
      if (storePath && kbSubdir) {
        payload.teamBinding = { provider, storePath, kbSubdir };
      }
    }
    return payload;
  }

  // T07 — preflight the import whenever any input changes; update the
  // preview pane, problem list, and Import button enable state.
  let preflightSeq = 0;
  let preflightTimer = null;
  function schedulePreflight() {
    if (preflightTimer) clearTimeout(preflightTimer);
    preflightTimer = setTimeout(runPreflight, 250);
  }
  async function runPreflight() {
    const seq = ++preflightSeq;
    const submit = $('import-submit');
    const path = $('import-path').value.trim();
    if (!path) {
      submit.disabled = true;
      setText($('pv-git-status'), '等待路径输入');
      setText($('pv-hook'), '等待 preflight');
      setText($('pv-ai-profile'), '—');
      setText($('pv-knowledge-root'), $('knowledge-root').value || '—');
      $('import-preflight').hidden = true;
      $('import-errors').hidden = true;
      $('import-auto-init').hidden = true;
      return;
    }
    const payload = buildImportPayload();
    try {
      const result = await api('/api/projects/preflight-import', { method: 'POST', body: JSON.stringify(payload) });
      if (seq !== preflightSeq) return;
      renderPreflight(result);
    } catch (error) {
      if (seq !== preflightSeq) return;
      submit.disabled = true;
      const err = $('import-errors');
      err.hidden = false;
      err.textContent = `Preflight 失败：${error.message}`;
    }
  }
  function renderPreflight(result) {
    const submit = $('import-submit');
    submit.disabled = !result.ready;
    setText($('pv-knowledge-root'), result.effective && result.effective.knowledgeRoot || '—');
    if (result.effective && result.effective.aiProfile) {
      setText($('pv-ai-profile'), `${result.effective.aiProfile.id} (${result.effective.aiProfile.source})`);
    } else {
      setText($('pv-ai-profile'), '—');
    }
    const gitCheck = result.checks && result.checks.git;
    if (gitCheck && gitCheck.ok) {
      const desc = gitCheck.emptyRepo
        ? 'Git 仓库（空仓库）'
        : gitCheck.headCommit
          ? `Git 仓库 @ ${gitCheck.headCommit.slice(0, 7)}`
          : 'Git 仓库';
      setText($('pv-git-status'), desc);
    } else if (gitCheck && gitCheck.plannedInit) {
      setText($('pv-git-status'), '非 Git 目录（将自动初始化）');
    } else {
      setText($('pv-git-status'), '路径无效');
    }
    const hookCheck = result.checks && result.checks.hook;
    if (hookCheck && hookCheck.ok) {
      setText($('pv-hook'), hookCheck.reason === 'legacy-v1' ? '已检测到 v1 Hook，将升级到 v2' : '准备安装托管 Hook');
    } else if (hookCheck && hookCheck.reason === 'third-party') {
      setText($('pv-hook'), '⚠ 第三方 Hook（不会覆盖）');
    } else {
      setText($('pv-hook'), '—');
    }
    const autoInit = $('import-auto-init');
    autoInit.hidden = !result.plannedGitInit;
    const preNotice = $('import-preflight');
    if (result.ready) {
      preNotice.hidden = false;
      preNotice.className = 'notice';
      preNotice.textContent = '所有前置条件就绪，可以导入。';
    } else {
      preNotice.hidden = true;
    }
    const errNotice = $('import-errors');
    if (result.problems && result.problems.length) {
      errNotice.hidden = false;
      errNotice.className = 'notice error';
      errNotice.replaceChildren();
      const strong = document.createElement('strong'); strong.textContent = '导入前需要处理：'; errNotice.append(strong);
      const list = document.createElement('ul');
      list.style.margin = '6px 0 0 18px';
      list.style.padding = '0';
      for (const problem of result.problems) {
        const li = document.createElement('li');
        li.textContent = `${problem.message} [${problem.code}]`;
        if (problem.action) {
          const hint = document.createElement('span');
          hint.className = 'muted';
          hint.style.marginLeft = '6px';
          hint.textContent = `操作：${problem.action}`;
          li.append(hint);
        }
        list.append(li);
      }
      errNotice.append(list);
    } else {
      // Clear stale text from a previous render so the notice does not
      // display a phantom problem after the user fixes the input.
      errNotice.hidden = true;
      errNotice.textContent = '';
    }
  }
  async function sendChat() {
    const project = activeProject(), text = $('chat-input').value.trim(); if (!project || !text) return;
    state.lastUserText = text;
    appendBubble('user', bubble => { bubble.textContent = text; });
    $('chat-input').value = ''; state.assistantContent = null;
    try {
      if (!state.activeSessionId) {
        const started = await api('/api/claude/sessions', { method: 'POST', body: JSON.stringify({ projectId: project.projectId }) });
        state.activeSessionId = started.sessionId; subscribeSession(started.sessionId);
      }
      await api(`/api/claude/sessions/${encodeURIComponent(state.activeSessionId)}/input`, { method: 'POST', body: JSON.stringify({ text }) });
    } catch (error) { appendBubble('error', bubble => { bubble.textContent = error.message; }); }
  }

  function openContextmenu(projectId, x, y) {
    state.pendingDeleteId = projectId;
    setText($('context-id'), projectId);
    const menu = $('context-menu');
    menu.classList.add('show');
    menu.style.left = Math.min(x, window.innerWidth - 210) + 'px';
    menu.style.top = Math.min(y, window.innerHeight - 90) + 'px';
  }
  function hideContextmenu() { $('context-menu').classList.remove('show'); }
  function openDeleteDialog(projectId) {
    const project = state.projects.find(item => item.projectId === projectId);
    if (!project) return;
    state.pendingDeleteId = projectId;
    setText($('delete-copy'), `确认移除“${project.config.displayName}”？默认只解除项目管理并保留知识目录。`);
    $('delete-knowledge').checked = false; $('delete-confirm').value = ''; $('delete-confirm-field').hidden = true; $('delete-error').hidden = true;
    $('delete-dialog').showModal();
  }

  document.querySelectorAll('[data-go]').forEach(node => node.addEventListener('click', () => showView(node.dataset.go)));
  document.querySelectorAll('[data-settings]').forEach(node => node.addEventListener('click', () => showSettings(node.dataset.settings)));
  for (const id of ['open-settings', 'mobile-settings']) $(id).addEventListener('click', () => openSettings('ai'));
  $('close-settings').addEventListener('click', closeSettings); $('settings-backdrop').addEventListener('click', closeSettings);
  $('theme-button').addEventListener('click', toggleTheme); $('client-theme').addEventListener('click', toggleTheme);
  $('mobile-project').addEventListener('change', event => selectProject(event.target.value));
  // T10: UI language toggle in the settings drawer header.
  const uiLang = $('ui-language');
  if (uiLang) {
    uiLang.value = activeLanguage();
    uiLang.addEventListener('change', event => {
      setLanguage(event.target.value);
      renderI18nLabels();
    });
  }
  window.__PK_I18N_ONCHANGE__ = () => {
    if (uiLang) uiLang.value = activeLanguage();
    renderI18nLabels();
  };
  function renderI18nLabels() {
    const map = {
      'wb-state': 'app.workbench.state.ready',
      'import-language': null, // options translated at fill time
    };
    for (const [id, key] of Object.entries(map)) {
      const node = $(id);
      if (node && key) node.textContent = i18n(key);
    }
    // Re-render import view labels if visible.
    if ($('import-path') && $('import-path').placeholder) {
      $('import-path').placeholder = i18n('app.import.path.placeholder');
    }
  }
  $('import-form').addEventListener('submit', submitImport);
  // T07: any change in the import form re-runs preflight; the Import button
  // stays disabled until every required prerequisite is satisfied.
  for (const id of ['import-path', 'import-language', 'import-profile', 'import-team-enabled', 'import-team-store', 'import-team-subdir', 'import-team-provider']) {
    $(id).addEventListener('input', schedulePreflight);
    $(id).addEventListener('change', schedulePreflight);
  }
  // T07: Desktop folder picker — only visible when the Desktop preload has
  // exposed window.projectKnowledgeDesktop.pickFolder.
  const desktop = typeof window !== 'undefined' ? window.projectKnowledgeDesktop : null;
  if (desktop && typeof desktop.pickFolder === 'function') {
    const picker = $('import-pick-folder');
    picker.hidden = false;
    picker.addEventListener('click', async () => {
      try {
        const result = await desktop.pickFolder();
        if (result && result.path) {
          $('import-path').value = result.path;
          schedulePreflight();
        }
      } catch (error) {
        const err = $('import-errors');
        err.hidden = false;
        err.className = 'notice error';
        err.textContent = `目录选择器失败：${error.message}`;
      }
    });
  }
  // T07: reset button must re-run preflight so the Import button state matches
  // an empty form.
  const importReset = $('import-reset');
  if (importReset) {
    importReset.addEventListener('click', () => setTimeout(schedulePreflight, 0));
  }
  // T07: whenever settings panel closes, knowledge root may have changed;
  // re-run preflight so the preview reflects the new root.
  for (const id of ['knowledge-root']) $(id).addEventListener('change', schedulePreflight);
  $('send-btn').addEventListener('click', sendChat);
  $('chat-input').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendChat(); } });
  $('save-knowledge').addEventListener('click', async () => { try { await api('/api/settings', { method: 'PATCH', body: JSON.stringify({ knowledge: { rootPath: $('knowledge-root').value } }) }); await loadState(); } catch (error) { alert(error.message); } });
  $('profile-select').addEventListener('change', event => { bindProfileDraft(); state.profileIndex = Number(event.target.value); fillProfileFields(); });
  for (const id of ['profile-vendor', 'profile-model', 'profile-base-url']) $(id).addEventListener('input', bindProfileDraft);
  $('profile-key').addEventListener('input', event => { state.profileKey = event.target.value; });
  $('profile-add').addEventListener('click', () => {
    bindProfileDraft();
    state.profiles.push({ id: `profile-${Date.now().toString(36)}`, vendor: '', model: '', baseUrl: '' });
    state.profileIndex = state.profiles.length - 1;
    fillProfileSelect(); fillProfileFields();
  });
  $('profile-save').addEventListener('click', saveProfiles);
  $('save-relations').addEventListener('click', async () => {
    const project = activeProject(); if (!project) return;
    const relatedProjectIds = [...$('relation-list').querySelectorAll('input:checked')].map(input => input.value);
    try { await api(`/api/projects/${encodeURIComponent(project.projectId)}`, { method: 'PATCH', body: JSON.stringify({ relatedProjectIds }) }); await loadState(); }
    catch (error) { alert(error.message); }
  });
  $('conversation-project').addEventListener('change', event => { state.activeProjectId = event.target.value; renderProjects(); loadConversations(true); });
  $('conversation-date').addEventListener('change', () => loadConversations(true));
  let logTimer; for (const id of ['logs-date', 'logs-project', 'logs-scope', 'logs-limit']) $(id).addEventListener('change', loadLogs);
  $('logs-search').addEventListener('input', () => { clearTimeout(logTimer); logTimer = setTimeout(loadLogs, 250); });
  $('logs-export').addEventListener('click', () => exportLogs().catch(error => { const warning = $('logs-connection'); warning.classList.add('show'); warning.textContent = error.message; }));
  $('new-records').addEventListener('click', () => { state.newLogs = 0; updateNewLogButton(); const list = $('record-list'); list.scrollTop = list.scrollHeight; });
  $('remove-project').addEventListener('click', () => { hideContextmenu(); openDeleteDialog(state.pendingDeleteId); });
  document.addEventListener('click', event => { if (!event.target.closest('.context-menu') && !event.target.closest('.project-card')) hideContextmenu(); });
  $('open-delete').addEventListener('click', () => { if (activeProject()) openDeleteDialog(activeProject().projectId); });
  $('delete-knowledge').addEventListener('change', event => { $('delete-confirm-field').hidden = !event.target.checked; });
  $('delete-cancel').addEventListener('click', () => $('delete-dialog').close());
  $('delete-submit').addEventListener('click', async () => {
    const projectId = state.pendingDeleteId || activeProject()?.projectId; if (!projectId) return;
    try {
      await api(`/api/projects/${encodeURIComponent(projectId)}`, { method: 'DELETE', body: JSON.stringify({ deleteKnowledge: $('delete-knowledge').checked, confirmationToken: $('delete-confirm').value }) });
      $('delete-dialog').close(); state.pendingDeleteId = '';
      if (state.activeSessionId && projectId === state.activeProjectId) closeSessionStream();
      await loadState();
    } catch (error) { $('delete-error').hidden = false; $('delete-error').textContent = error.message; }
  });

  const storedTheme = localStorage.getItem('pk-theme') || 'light';
  document.documentElement.dataset.theme = storedTheme;
  setText($('theme-button'), storedTheme === 'dark' ? '浅色模式' : '深色模式');
  $('logs-date').value = today(); $('conversation-date').value = today();
  window.__PK_APP__ = { getState: () => ({ projects: state.projects.length, activeProjectId: state.activeProjectId, view: state.view, settings: state.settings, settingsOpen: state.settingsOpen, conversationTurns: state.conversationTurns.length, logCount: state.logs.length, newLogs: state.newLogs }), openSettings, showSettings, loadLogs, renderWorkbenchEvent };
  loadState().catch(error => { setText($('brand-root'), error.message); });
})();
