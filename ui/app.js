(() => {
  'use strict';
  // Control Center shell: 连接与投影 —— 功能本体在模块（terminal :5760 / vector-hub :8787 / 会话浏览 :8790）。
  const $ = id => document.getElementById(id);
  const i18nApi = window.I18N || {};
  const i18n = typeof i18nApi.t === 'function' ? i18nApi.t : key => key;
  const setLanguage = typeof i18nApi.setLanguage === 'function' ? i18nApi.setLanguage : () => {};
  const activeLanguage = typeof i18nApi.activeLanguage === 'function' ? i18nApi.activeLanguage : () => 'zh-CN';
  const state = {
    projects: [], activeProjectId: '', view: 'terminal', settings: 'conversation', settingsOpen: false,
    conversationCursor: null, conversationTurns: [], logs: [], logStream: null, logCursor: '', newLogs: 0,
    messageCount: 0, pendingDeleteId: '',
    modules: { terminal: { url: 'http://127.0.0.1:5760', up: false }, vectorHub: { url: 'http://127.0.0.1:8787', up: false }, eventBridge: { url: 'http://127.0.0.1:8790', up: false } },
    sessionsByProject: new Map(),   // projectId -> [{sessionId,title,agentId,updatedAt}]
    fold: { term: false, vh: false, eb: false }, // false = 该模块项目列表折叠（默认）
    linkRetries: { term: 0, vh: 0 }, // kb:select-project 竞态假阴性的有界重试计数
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
  const option = (value, label) => { const node = document.createElement('option'); node.value = value; node.textContent = label; return node; };
  const formatTime = iso => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '—' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); };
  async function copyText(value) {
    const text = String(value == null ? '' : value);
    if (navigator.clipboard?.writeText) { try { await navigator.clipboard.writeText(text); return; } catch {} }
    const input = document.createElement('textarea'); input.value = text; input.setAttribute('readonly', ''); input.style.position = 'fixed'; input.style.opacity = '0'; document.body.append(input); input.select(); document.execCommand('copy'); input.remove();
  }

  /* ===================== 嵌入协议（壳 ↔ 模块） ===================== */
  const FRAME_OF = { term: 'fr-5760', vh: 'fr-8787', eb: 'fr-8790' };
  // 模块 kb:ready/kb:projects 消息里的 app 标识 → 壳侧的模块键
  const APP_KEY_OF = { 'agent-terminal': 'term', 'vector-hub': 'vh', 'event-bridge': 'eb' };
  // 每个模块的联动状态 chip（会话浏览暂无联动协议，chip 缺省）
  const CHIP_OF = { term: 'sync-5760', vh: 'sync-8787', eb: null };
  function postTo(key, msg) {
    const frame = $(FRAME_OF[key]);
    if (frame && frame.contentWindow) frame.contentWindow.postMessage(msg, '*');
  }
  function syncFold(key) { postTo(key, { type: 'kb:sidebar', visible: state.fold[key] }); }
  function renderFoldIcons() {
    document.querySelectorAll('.nav-fold').forEach(node => {
      const on = state.fold[node.dataset.fold];
      node.classList.toggle('on', on);
      node.title = `模块项目列表：${on ? '已展开，点击折叠' : '已折叠，点击展开'}`;
    });
  }
  function linkProjectToModules(project) {
    if (!project) return;
    postTo('term', { type: 'kb:select-project', project: project.repoPath || project.projectId });
    postTo('vh', { type: 'kb:select-project', project: (project.modules.vectorHub && project.modules.vectorHub.projectName) || project.projectId });
  }
  window.addEventListener('message', ev => {
    const data = ev.data;
    if (!data || typeof data !== 'object') return;
    const moduleKey = APP_KEY_OF[data.app] || (data.app ? null : 'term');
    if (data.type === 'kb:ready') {
      if (!moduleKey) return;
      setTimeout(() => { syncFold(moduleKey); linkProjectToModules(activeProject()); }, 150);
    } else if (data.type === 'kb:projects') {
      const chip = moduleKey ? $(CHIP_OF[moduleKey]) : null;
      const project = activeProject();
      if (!chip || !project) return;
      if (data.ok) {
        state.linkRetries[moduleKey] = 0;
        chip.textContent = `联动: ${project.displayName}`;
        chip.style.color = 'var(--good)'; chip.title = '';
      } else {
        chip.textContent = `未登记: ${project.displayName}`;
        chip.style.color = 'var(--warnText)';
        chip.title = '该模块还没有这个项目——在导入项目时勾选登记即可建立联动';
        // 模块项目清单未就绪时 kb:ready 触发的首轮选中会扑空（假阴性）：
        // 有界重试补发，真未登记则几次后停下，chip 保持如实提示
        if ((state.linkRetries[moduleKey] || 0) < 4) {
          state.linkRetries[moduleKey] = (state.linkRetries[moduleKey] || 0) + 1;
          const delay = [800, 2500, 6000, 10000][state.linkRetries[moduleKey] - 1] || 10000;
          setTimeout(() => { if (activeProject()) linkProjectToModules(activeProject()); }, delay);
        }
      }
    } else if (data.type === 'kb:sessions') {
      if (!data.ok) return;
      state.sessionsByProject.set(data.project, data.sessions || []);
      renderProjectSessions(data.project);
    } else if (data.type === 'kb:session' && data.ok) {
      showView('terminal');
    }
  });

  function renderBrandStatus() {
    setText($('brand-root'), state.projects.length ? `${state.projects.length} 个项目 · 终端${state.modules.terminal.up ? '✓' : '×'} 检索${state.modules.vectorHub.up ? '✓' : '×'} 会话${state.modules.eventBridge.up ? '✓' : '×'}` : '暂无项目');
  }
  function probeModules() {
    for (const [key, id] of [['term', 'st-5760'], ['vh', 'st-8787'], ['bridge', 'st-8790']]) {
      const status = $(id);
      if (!status) continue;
      const info = key === 'term' ? state.modules.terminal : key === 'vh' ? state.modules.vectorHub : state.modules.eventBridge;
      let attempts = 0;
      const attempt = () => {
        fetch(info.url + '/', { mode: 'no-cors', cache: 'no-store' })
          .then(() => {
            info.up = true;
            status.classList.remove('down'); status.classList.add('ok');
            status.querySelector('.st-text').textContent = `已连接 ${info.url.replace(/^https?:\/\//, '')}`;
            renderBrandStatus();
          })
          .catch(() => {
            info.up = false;
            // 模块服务随壳自启，冷启动（node 起进程 + 服务监听）可能慢于首轮
            // 探测：有界退避重试，避免一次性误报"未检测到"并停在那直到手动刷新
            attempts += 1;
            if (attempts <= 10) {
              status.querySelector('.st-text').textContent = `连接中 ${info.url.replace(/^https?:\/\//, '')}…`;
              setTimeout(attempt, [500, 1000, 2000, 3000][Math.min(attempts - 1, 3)]);
              return;
            }
            status.classList.add('down');
            status.querySelector('.st-text').textContent = `未检测到 ${info.url.replace(/^https?:\/\//, '')} — 界面将显示为空白`;
            renderBrandStatus();
          });
      };
      attempt();
    }
  }
  function mountEmbeds() {
    const termUrl = state.modules.terminal.url, vhUrl = state.modules.vectorHub.url, ebUrl = state.modules.eventBridge.url;
    $('fr-5760').src = `${termUrl}/agent-terminal/?embed=1`;
    $('fr-8787').src = `${vhUrl}/?embed=1`;
    $('fr-8790').src = `${ebUrl}/?embed=1`;
    $('open-5760').href = `${termUrl}/agent-terminal/`;
    $('open-8787').href = `${vhUrl}/`;
    $('open-8790').href = `${ebUrl}/`;
  }

  /* ===================== 项目栏（聚合投影） ===================== */
  function projectDotClass(project) {
    if (project.projectId === state.activeProjectId) return 'dot claude';
    if (!project.modules.terminal.registered && !project.modules.vectorHub.registered && !project.modules.eventBridge.registered) return 'dot idle';
    return 'dot good';
  }
  function renderProjects() {
    const list = $('project-list');
    list.replaceChildren();
    $('mobile-project').replaceChildren();
    $('conversation-project').replaceChildren();
    $('logs-project').replaceChildren(option('', '全部项目'));
    for (const project of state.projects) {
      const wrap = document.createElement('div'); wrap.className = 'project-item'; wrap.dataset.projectId = project.projectId;
      const card = document.createElement('button');
      card.type = 'button';
      card.className = `project-card${project.projectId === state.activeProjectId ? ' active' : ''}`;
      card.dataset.projectId = project.projectId;
      const line = document.createElement('div'); line.className = 'project-line';
      const main = document.createElement('div');
      const name = document.createElement('div'); name.className = 'project-name'; name.textContent = project.displayName;
      const badges = document.createElement('div'); badges.className = 'module-badges';
      const termBadge = document.createElement('span'); termBadge.className = `mbadge${project.modules.terminal.registered ? ' on' : ''}`; termBadge.textContent = '端'; termBadge.title = project.modules.terminal.registered ? '已登记到 Agent 终端' : '未登记到 Agent 终端';
      const vhBadge = document.createElement('span'); vhBadge.className = `mbadge${project.modules.vectorHub.registered ? ' on' : ''}`; vhBadge.textContent = '检'; vhBadge.title = project.modules.vectorHub.registered ? '已登记到 vector-hub' : '未登记到 vector-hub';
      const ebBadge = document.createElement('span'); ebBadge.className = `mbadge${project.modules.eventBridge && project.modules.eventBridge.registered ? ' on' : ''}`; ebBadge.textContent = '桥'; ebBadge.title = project.modules.eventBridge && project.modules.eventBridge.registered ? '已登记到会话浏览（ai-coding-event-bridge）' : '未登记到会话浏览（ai-coding-event-bridge）';
      badges.append(termBadge, vhBadge, ebBadge);
      main.append(name, badges);
      const caret = document.createElement('span'); caret.className = 'proj-caret'; caret.textContent = '▸'; caret.title = '历史会话';
      const dot = document.createElement('span'); dot.className = projectDotClass(project);
      line.append(main, dot, caret);
      const repo = document.createElement('div'); repo.className = 'project-path'; repo.textContent = project.repoPath || '';
      card.append(line, repo);
      card.addEventListener('click', event => { if (event.target.closest('.proj-caret')) return; selectProject(project.projectId); });
      caret.addEventListener('click', event => {
        event.stopPropagation();
        const sessions = wrap.querySelector('.proj-sessions');
        const expanded = !sessions.hidden;
        sessions.hidden = expanded;
        caret.classList.toggle('open', !expanded);
        if (!expanded && !state.sessionsByProject.has(project.repoPath || project.projectId)) {
          sessions.replaceChildren(sessionPlaceholder('正在向终端拉取会话…'));
          // 拉取超时兜底：终端未连接/未登记时不至于永远停在"正在拉取"
          const key = project.repoPath || project.projectId;
          setTimeout(() => {
            if (!state.sessionsByProject.has(key)) {
              const host = sessions.querySelector('.sess-empty');
              if (host) host.textContent = '未能获取会话（终端未连接或该项目未登记到终端）';
            }
          }, 8000);
          postTo('term', { type: 'kb:list-sessions', project: key });
        }
      });
      card.addEventListener('contextmenu', event => {
        event.preventDefault();
        openContextmenu(project.projectId, event.clientX, event.clientY);
      });
      const sessions = document.createElement('div'); sessions.className = 'proj-sessions'; sessions.hidden = true;
      wrap.append(card, sessions);
      list.append(wrap);
      $('mobile-project').append(option(project.projectId, project.displayName));
      $('conversation-project').append(option(project.projectId, project.displayName));
      $('logs-project').append(option(project.projectId, project.displayName));
    }
    $('mobile-project').value = state.activeProjectId;
    $('conversation-project').value = state.activeProjectId;
    updateProjectContext();
  }
  function sessionPlaceholder(text) { const div = document.createElement('div'); div.className = 'sess-empty'; div.textContent = text; return div; }
  function renderProjectSessions(projectKey) {
    const wrap = [...document.querySelectorAll('.project-item')].find(node => {
      const project = state.projects.find(item => item.projectId === node.dataset.projectId);
      return project && (project.repoPath || project.projectId) === projectKey;
    });
    if (!wrap) return;
    const host = wrap.querySelector('.proj-sessions');
    const sessions = state.sessionsByProject.get(projectKey) || [];
    host.replaceChildren();
    if (!sessions.length) { host.append(sessionPlaceholder('该模块还没有此项目的会话')); return; }
    for (const session of sessions) {
      const row = document.createElement('button'); row.type = 'button'; row.className = 'sess-row';
      row.dataset.sessionId = session.sessionId;
      const title = document.createElement('span'); title.className = 'sess-title'; title.textContent = session.title || session.sessionId;
      const agent = document.createElement('span'); agent.className = 'sess-agent'; agent.textContent = session.agentId || '';
      row.append(title, agent);
      row.addEventListener('click', () => {
        postTo('term', { type: 'kb:open-session', sessionId: session.sessionId });
        showView('terminal');
      });
      host.append(row);
    }
  }
  function updateProjectContext() {
    const project = activeProject();
    setText($('page-title'), ({ terminal: 'Agent 终端', search: '知识检索', bridge: '会话浏览', import: '导入项目' })[state.view] || 'Agent 终端');
    linkProjectToModules(project);
  }
  function selectProject(projectId) {
    state.activeProjectId = projectId;
    renderProjects();
    if (state.settings === 'conversation') loadConversations(true);
  }
  const viewTitles = { terminal: 'Agent 终端', search: '知识检索', bridge: '会话浏览', import: '导入项目' };
  function showView(view) {
    state.view = view;
    document.querySelectorAll('.view').forEach(node => node.classList.toggle('active', node.id === `view-${view}`));
    document.querySelectorAll('[data-go]').forEach(node => node.classList.toggle('active', node.dataset.go === view));
    setText($('page-title'), viewTitles[view] || view);
    hideContextmenu();
  }
  async function loadState() {
    const aggregate = await api('/api/projects/aggregated');
    state.projects = (aggregate.projects || []).map(project => ({
      projectId: project.projectId,
      displayName: project.name || project.projectId,
      repoPath: project.workspacePath || '',
      knowledgePath: project.knowledgePath || '',
      modules: project.modules || { terminal: {}, vectorHub: {}, eventBridge: {} },
    }));
    if (!state.activeProjectId || !state.projects.some(project => project.projectId === state.activeProjectId)) state.activeProjectId = state.projects[0]?.projectId || '';
    renderProjects();
    if (state.settings === 'conversation') loadConversationProjects();
  }
  async function refreshModulesHealth() {
    try {
      const body = await api('/api/modules/health');
      state.modules.terminal = { ...state.modules.terminal, ...body.modules.terminal };
      state.modules.vectorHub = { ...state.modules.vectorHub, ...body.modules.vectorHub };
      state.modules.eventBridge = { ...state.modules.eventBridge, ...body.modules.eventBridge };
    } catch { /* server down; probes keep their state */ }
  }

  /* ===================== 导入：只触发两个模块的登记（壳不自建设置面） ===================== */
  async function submitImport(event) {
    event.preventDefault();
    const notice = $('import-notice') || (() => { const n = document.createElement('div'); n.id = 'import-notice'; n.className = 'notice'; n.hidden = true; document.querySelector('#import-form').appendChild(n); return n; })();
    const payload = buildImportPayload();
    try {
      const body = await api('/api/projects/import', { method: 'POST', body: JSON.stringify(payload) });
      const projectId = body.projectId || body.project?.projectId || '';
      renderModuleRegistration(body.modules);
      notice.hidden = false; notice.className = 'notice'; notice.textContent = '项目已导入并登记到模块。';
      await loadState(); selectProject(projectId); showView('terminal'); event.target.reset(); renderFoldIcons();
    } catch (error) { notice.hidden = false; notice.className = 'notice error'; notice.textContent = error.message; }
  }
  function renderModuleRegistration(modules) {
    const node = $('pv-modules');
    if (!modules) { setText(node, '待登记'); return; }
    const term = modules.terminal && modules.terminal.ok ? '终端 ✓' : modules.terminal && modules.terminal.status === 'pending' ? '终端 待登记' : '终端 ✗';
    const vh = modules.vectorHub && modules.vectorHub.ok ? '检索 ✓' : modules.vectorHub && modules.vectorHub.status === 'pending' ? '检索 待登记' : '检索 ✗';
    const eb = modules.eventBridge && modules.eventBridge.ok ? '会话 ✓' : modules.eventBridge && modules.eventBridge.status === 'pending' ? '会话 待登记' : '会话 ✗';
    setText(node, `${term} · ${vh} · ${eb}`);
  }
  function buildImportPayload() {
    // 语言/配置走后端默认（zh-CN / 终端 profile 唯一源）——壳上不再暴露
    return {
      localPath: $('import-path').value,
      knowledgePath: $('import-knowledge-path').value.trim() || null,
    };
  }

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
      setText($('pv-knowledge-root'), $('import-knowledge-path').value.trim() || '—');
      setText($('pv-modules'), '待登记');
      $('import-preflight').hidden = true;
      $('import-errors').hidden = true;
      $('import-auto-init').hidden = true;
      return;
    }
    try {
      const result = await api('/api/projects/preflight-import', { method: 'POST', body: JSON.stringify(buildImportPayload()) });
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
    setText($('pv-knowledge-root'), $('import-knowledge-path').value.trim() || (result.effective && result.effective.knowledgeRoot) || '—');
    const gitCheck = result.checks && result.checks.git;
    if (gitCheck && gitCheck.ok) {
      const desc = gitCheck.emptyRepo ? 'Git 仓库（空仓库）' : gitCheck.headCommit ? `Git 仓库 @ ${gitCheck.headCommit.slice(0, 7)}` : 'Git 仓库';
      setText($('pv-git-status'), desc);
    } else if (gitCheck && gitCheck.plannedInit) setText($('pv-git-status'), '非 Git 目录（将自动初始化）');
    else setText($('pv-git-status'), '路径无效');
    $('import-auto-init').hidden = !result.plannedGitInit;
    const preNotice = $('import-preflight');
    if (result.ready) { preNotice.hidden = false; preNotice.className = 'notice'; preNotice.textContent = '前置条件就绪，可以导入。'; }
    else preNotice.hidden = true;
    const errNotice = $('import-errors');
    if (result.problems && result.problems.length) {
      errNotice.hidden = false; errNotice.className = 'notice error'; errNotice.replaceChildren();
      const strong = document.createElement('strong'); strong.textContent = '导入前需要处理：'; errNotice.append(strong);
      const list = document.createElement('ul'); list.style.margin = '6px 0 0 18px'; list.style.padding = '0';
      for (const problem of result.problems) {
        const li = document.createElement('li');
        li.textContent = `${problem.message} [${problem.code}]`;
        if (problem.action) { const hint = document.createElement('span'); hint.className = 'muted'; hint.style.marginLeft = '6px'; hint.textContent = `操作：${problem.action}`; li.append(hint); }
        list.append(li);
      }
      errNotice.append(list);
    } else { errNotice.hidden = true; errNotice.textContent = ''; }
  }

  /* ===================== 开发对话（pkb 流水线域） ===================== */
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
      if (turn.userPrompt) card.append(makeMessage('user', '你', turn.userPrompt));
      if (turn.assistantReply) card.append(makeMessage('assistant', 'AI', turn.assistantReply));
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

  /* ===================== 日志（连接层运行记录） ===================== */
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

  /* ===================== 设置抽屉（开发对话 / 日志） ===================== */
  const settingsTitles = {
    conversation: ['开发对话', '查看项目开发过程中的需求与 AI 回复。'],
    logs: ['日志', '查看系统和项目的运行记录；异常会自动突出显示。'],
  };
  function openSettings(section = 'conversation') { state.settingsOpen = true; $('settings-backdrop').classList.add('show'); $('settings-drawer').classList.add('show'); showSettings(section); }
  function closeSettings() { state.settingsOpen = false; $('settings-backdrop').classList.remove('show'); $('settings-drawer').classList.remove('show'); stopLogStream(); }
  function showSettings(section) {
    state.settings = section;
    document.querySelectorAll('[data-settings]').forEach(node => node.classList.toggle('active', node.dataset.settings === section));
    document.querySelectorAll('.settings-section').forEach(node => node.classList.toggle('active', node.id === `settings-${section}`));
    const [title, help] = settingsTitles[section] || ['', ''];
    setText($('settings-title'), title); setText($('settings-help'), help);
    if (section === 'conversation') loadConversationProjects();
    if (section === 'logs') loadLogs(); else stopLogStream();
  }

  /* ===================== 右键管理与删除 ===================== */
  function openContextmenu(projectId, x, y) {
    state.pendingDeleteId = projectId;
    setText($('context-id'), projectId);
    const menu = $('context-menu');
    menu.classList.add('show');
    menu.style.left = Math.min(x, window.innerWidth - 210) + 'px';
    menu.style.top = Math.min(y, window.innerHeight - 110) + 'px';
  }
  function hideContextmenu() { $('context-menu').classList.remove('show'); }
  function openDeleteDialog(projectId) {
    const project = state.projects.find(item => item.projectId === projectId);
    if (!project) return;
    state.pendingDeleteId = projectId;
    setText($('delete-copy'), `确认移除“${project.displayName}”？默认保留知识目录与会话记录。`);
    $('delete-knowledge').checked = false; $('delete-confirm').value = ''; $('delete-confirm-field').hidden = true; $('delete-error').hidden = true;
    $('delete-dialog').showModal();
  }

  /* ===================== 事件绑定 ===================== */
  document.querySelectorAll('[data-go]').forEach(node => node.addEventListener('click', () => showView(node.dataset.go)));
  document.querySelectorAll('[data-settings]').forEach(node => node.addEventListener('click', () => showSettings(node.dataset.settings)));
  for (const id of ['open-settings', 'mobile-settings']) $(id).addEventListener('click', () => openSettings('conversation'));
  $('close-settings').addEventListener('click', closeSettings); $('settings-backdrop').addEventListener('click', closeSettings);
  $('theme-button').addEventListener('click', toggleTheme);
  $('mobile-project').addEventListener('change', event => selectProject(event.target.value));
  document.querySelectorAll('.nav-fold').forEach(node => node.addEventListener('click', event => {
    event.stopPropagation();
    const key = node.dataset.fold;
    state.fold[key] = !state.fold[key];
    renderFoldIcons(); syncFold(key);
  }));
  const uiLang = $('ui-language');
  if (uiLang) {
    uiLang.value = activeLanguage();
    uiLang.addEventListener('change', event => { setLanguage(event.target.value); renderI18nLabels(); });
  }
  window.__PK_I18N_ONCHANGE__ = () => { if (uiLang) uiLang.value = activeLanguage(); renderI18nLabels(); };
  function renderI18nLabels() {
    document.querySelectorAll('[data-i18n]').forEach(node => {
      const key = node.dataset.i18n;
      if (key) node.textContent = i18n(key);
    });
    if ($('import-path') && $('import-path').placeholder) $('import-path').placeholder = i18n('app.import.path.placeholder');
  }
  $('import-form').addEventListener('submit', submitImport);
  for (const id of ['import-path', 'import-knowledge-path']) {
    $(id).addEventListener('input', schedulePreflight);
    $(id).addEventListener('change', schedulePreflight);
  }
  // 目录选择：优先桌面端原生选择器；Web 模式经代理调用模块自带的原生选择器
  //（① 用终端的 pick-folder，② 用 vector-hub 的）。两者都返回 {path}，取消为 path:null。
  async function pickFolderVia(endpoint) {
    if (window.screenX !== undefined) {
      const win = `${Math.round(window.screenX)},${Math.round(window.screenY)},${Math.round(window.outerWidth)},${Math.round(window.outerHeight)}`;
      endpoint += (endpoint.includes('?') ? '&' : '?') + 'win=' + encodeURIComponent(win);
    }
    const response = await fetch(endpoint);
    if (response.status === 501) throw new Error('此环境不支持目录选择，请手动输入路径。');
    if (!response.ok) throw new Error(`目录选择失败 (${response.status})`);
    return response.json();
  }
  function bindFolderPicker(buttonId, inputId, endpoint) {
    $(buttonId).addEventListener('click', async () => {
      const err = $('import-errors');
      try {
        $(buttonId).disabled = true;
        const desktop = window.projectKnowledgeDesktop;
        const result = desktop && typeof desktop.pickFolder === 'function'
          ? await desktop.pickFolder()
          : await pickFolderVia(endpoint);
        if (result && result.path) { $(inputId).value = result.path; schedulePreflight(); }
      } catch (error) {
        err.hidden = false; err.className = 'notice error';
        err.textContent = error.message;
      } finally {
        $(buttonId).disabled = false;
      }
    });
  }
  bindFolderPicker('import-pick-folder', 'import-path', '/api/terminal/system/pick-folder');
  bindFolderPicker('import-pick-knowledge', 'import-knowledge-path', '/api/vectorhub/system/pick-folder');
  const importReset = $('import-reset');
  if (importReset) importReset.addEventListener('click', () => setTimeout(schedulePreflight, 0));
  $('conversation-project').addEventListener('change', event => { state.activeProjectId = event.target.value; renderProjects(); loadConversations(true); });
  $('conversation-date').addEventListener('change', () => loadConversations(true));
  let logTimer; for (const id of ['logs-date', 'logs-project', 'logs-scope', 'logs-limit']) $(id).addEventListener('change', loadLogs);
  $('logs-search').addEventListener('input', () => { clearTimeout(logTimer); logTimer = setTimeout(loadLogs, 250); });
  $('logs-export').addEventListener('click', () => exportLogs().catch(error => { const warning = $('logs-connection'); warning.classList.add('show'); warning.textContent = error.message; }));
  $('new-records').addEventListener('click', () => { state.newLogs = 0; updateNewLogButton(); const list = $('record-list'); list.scrollTop = list.scrollHeight; });
  $('remove-project').addEventListener('click', () => { hideContextmenu(); openDeleteDialog(state.pendingDeleteId); });
  document.addEventListener('click', event => { if (!event.target.closest('.context-menu') && !event.target.closest('.project-card')) hideContextmenu(); });
  $('delete-knowledge').addEventListener('change', event => { $('delete-confirm-field').hidden = !event.target.checked; });
  $('delete-cancel').addEventListener('click', () => $('delete-dialog').close());
  $('delete-submit').addEventListener('click', async () => {
    const projectId = state.pendingDeleteId || activeProject()?.projectId; if (!projectId) return;
    try {
      // 先解除模块登记（keepSessions：本地会话记录与知识目录全部保留）
      await api(`/api/projects/${encodeURIComponent(projectId)}/module-remove`, { method: 'POST' }).catch(() => {});
      await api(`/api/projects/${encodeURIComponent(projectId)}`, { method: 'DELETE', body: JSON.stringify({ deleteKnowledge: $('delete-knowledge').checked, confirmationToken: $('delete-confirm').value }) });
      $('delete-dialog').close(); state.pendingDeleteId = '';
      await loadState();
    } catch (error) { $('delete-error').hidden = false; $('delete-error').textContent = error.message; }
  });

  const storedTheme = localStorage.getItem('pk-theme') || 'light';
  document.documentElement.dataset.theme = storedTheme;
  setText($('theme-button'), storedTheme === 'dark' ? '浅色模式' : '深色模式');
  $('logs-date').value = today(); $('conversation-date').value = today();
  window.__PK_APP__ = { getState: () => ({ projects: state.projects.length, activeProjectId: state.activeProjectId, view: state.view, settings: state.settings, settingsOpen: state.settingsOpen, conversationTurns: state.conversationTurns.length, logCount: state.logs.length, newLogs: state.newLogs, modules: state.modules, fold: state.fold }), openSettings, showSettings, loadLogs, selectProject, showView };
  renderFoldIcons();
  (async () => {
    await refreshModulesHealth();
    mountEmbeds();
    probeModules();
    await loadState().catch(error => setText($('brand-root'), error.message));
    renderBrandStatus();
  })();
})();
