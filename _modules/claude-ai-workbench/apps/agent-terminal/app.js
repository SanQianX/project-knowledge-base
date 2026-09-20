/* Agent Terminal — full-page UI over the versioned REST/SSE API. */
'use strict';

const client = window.createClaudeWorkbenchClient
  ? window.createClaudeWorkbenchClient({ apiBase: '/api/claude-workbench/v1' })
  : null;

const PERMISSION_LABELS = { default: '默认防护', acceptEdits: '接受编辑', plan: '计划模式', bypassPermissions: '完全访问' };
const EFFORT_LABELS = { low: '低', medium: '中', high: '高', max: '最高' };
const AGENT_LABELS = { 'claude-code': 'Claude Code', codex: 'Codex', opencode: 'OpenCode', zcode: 'ZCode' };

const state = {
  agents: [],
  projects: [],
  profiles: [],
  sessionTitles: new Map(),
  activeProjectId: null,
  activeSessionId: null,
  unsub: null,
  permissionMode: 'default',
  effort: 'high',
  currentAgent: 'claude-code',
  currentProfileId: undefined, // undefined: project default; null: agent-owned auth
  currentModel: null,
  sessionSummary: null,
  attachments: [],
  busy: false,
  follow: true, // auto-scroll sticks to bottom until the user scrolls away
  replaying: false, // true while replaying a session snapshot: no live timers/durations
  expanded: new Set(),
  caps: null,
};

const $ = id => document.getElementById(id);
const el = (tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text != null) node.textContent = text; return node; };

// Typed toasts: good / bad / neutral, each with an icon, stacked bottom-center.
// `bad` stays boolean-compatible with the original signature; 'good' opts into
// the success treatment. Purely visual — timing and message text are unchanged.
function toast(message, bad, good) {
  const host = $('toast');
  const kind = bad ? 'bad' : good ? 'good' : '';
  const item = el('div', `toast${kind ? ` ${kind}` : ''}`);
  item.append(icon(bad ? 'warn' : good ? 'check' : 'info', 14));
  item.append(el('span', null, String(message)));
  host.append(item);
  while (host.children.length > 3) host.firstChild.remove();
  setTimeout(() => {
    item.classList.add('leaving');
    setTimeout(() => item.remove(), 160);
  }, 3200);
}

function capabilitiesOf(agentId) {
  const agent = state.agents.find(item => item.id === agentId);
  return agent ? agent.capabilities : { thinking: true, permissions: true, toolStream: true, images: true, resume: true, modelOverride: true, generationParams: [] };
}

/* ===================== init ===================== */

async function init() {
  try {
    const health = await client.health();
    $('app-version').textContent = `v${health.version}`;
    $('about-text').textContent = `Agent Terminal v${health.version} · API ${health.apiVersion} · ${health.sessions} 个会话`;
  } catch { /* server unreachable is surfaced by the panels themselves */ }
  await Promise.all([refreshAgents(), refreshProfiles()]);
  await refreshProjects();
  // 首个 kb:ready 在项目清单就绪前就已发出（上方 health/agents/profiles 都要
  // 先跑完），壳届时下发的 kb:select-project 会扑空。清单就绪后再广播一次，
  // 让壳重新选中项目，避免嵌入态卡在"未登记/无项目可选"。
  if (window.parent !== window) window.parent.postMessage({ type: 'kb:ready', app: 'agent-terminal' }, '*');
  wireChrome();
  wireComposer();
  wireSettings();
  wireProjectModal();
}

/* ===================== agents & capabilities ===================== */

async function refreshAgents() {
  try { state.agents = await client.listAgents(); } catch { state.agents = []; }
  renderAgentSummary();
  renderAgentCards();
  applyCapabilityGates();
}

function renderAgentSummary() {
  const available = state.agents.filter(agent => agent.available);
  const dot = $('agent-dot');
  dot.classList.toggle('run', false);
  dot.style.background = available.length ? 'var(--good)' : 'var(--bad)';
  $('agent-summary').textContent = available.length
    ? `已发现 ${available.length} 个 Agent:${available.map(a => a.label).join(' · ')}`
    : '未发现可用 Agent';
}

function renderAgentCards() {
  const wrap = $('agent-cards');
  wrap.textContent = '';
  for (const agent of state.agents) {
    const card = el('div', 'agent-card' + (agent.available ? '' : ' missing'));
    const badge = el('span', `agent-badge ${agent.id}`, agent.id === 'claude-code' ? 'C' : agent.id === 'codex' ? 'X' : agent.id === 'zcode' ? 'Z' : 'O');
    const body = el('div', 'a-body');
    const name = el('div', 'a-name');
    name.append(el('span', null, agent.label));
    const chip = el('span', 'chip ' + (agent.available ? 'good' : ''), agent.available ? (agent.version ? `v${agent.version}` : '可用') : '不可用');
    name.append(chip);
    body.append(name);
    body.append(el('div', 'a-meta', `${agent.transport} · 认证:${agent.authModes.join(' / ')}${agent.reason ? ` · ${agent.reason}` : ''}`));
    const chips = el('div', 'cap-chips');
    const caps = agent.capabilities;
    for (const [key, label] of [['thinking', '思考流'], ['permissions', '权限'], ['toolStream', '工具流'], ['images', '图片'], ['resume', '恢复会话'], ['modelOverride', '模型覆盖']]) {
      const chip = el('span', 'chip' + (caps[key] ? '' : ' off'));
      if (caps[key]) chip.append(el('span', null, label));
      else {
        const off = el('span', null, label);
        off.style.opacity = '.7';
        chip.append(icon('close', 10), off);
      }
      chips.append(chip);
    }
    if (caps.generationParams.includes('effort')) chips.append(el('span', 'chip', '推理力度'));
    body.append(chips);
    card.append(badge, body);
    if (agent.id === state.currentAgent) card.style.outline = '1px solid var(--blue)';
    card.addEventListener('click', () => { selectAgent(agent.id); });
    wrap.append(card);
  }
}

function selectAgent(agentId) {
  prepareSelectionChange();
  state.currentAgent = agentId;
  applyCapabilityGates();
  renderAgentCards();
  renderModelLabel();
  toast(`新会话将使用 ${AGENT_LABELS[agentId] || agentId}`);
}

function applyCapabilityGates() {
  const caps = capabilitiesOf(state.currentAgent);
  state.caps = caps;
  $('effort-anchor').hidden = !caps.generationParams.includes('effort');
}

/* ===================== profiles & model selector ===================== */

async function refreshProfiles() {
  try { state.profiles = await client.listProfiles(); } catch { state.profiles = []; }
  renderModelLabel();
  renderProviderList();
}

function renderModelLabel() {
  const selection = resolvedSelection();
  const label = `${selection.providerName} · ${selection.model || '默认模型'}`;
  $('model-label').textContent = label;
  $('btn-model').title = `${AGENT_LABELS[state.currentAgent] || state.currentAgent} · ${label}`;
  const session = state.sessionSummary;
  $('session-provider').textContent = session
    ? `${AGENT_LABELS[session.agentId] || session.agentId} · ${session.authSource === 'agent-owned' ? 'Agent 自身登录' : session.providerName || selection.providerName} · ${session.model || selection.model || '默认模型'}`
    : `${AGENT_LABELS[state.currentAgent] || state.currentAgent} · ${state.currentProfileId === undefined ? '项目默认 · ' : ''}${label}`;
}

function resolvedSelection() {
  const project = state.projects.find(p => p.id === state.activeProjectId) || {};
  const profileId = state.currentProfileId === undefined ? project.defaultAiProfileId || null : state.currentProfileId;
  const profile = state.profiles.find(p => p.id === profileId);
  const model = state.currentProfileId === undefined ? project.defaultModel || (profile && profile.models.default) : state.currentModel || (profile && profile.models.default);
  return { profileId, model: model || null, providerName: profile ? profile.name : profileId ? '供应商不可用' : 'Agent 自身登录' };
}

// Agent choice is immutable per session, so switching agents detaches and the
// next message starts a fresh session.
function prepareSelectionChange() {
  if (!state.activeSessionId) return;
  detachSession({ preserveAttachments: true });
  resetStream();
  setBusyState('idle');
  $('session-title').textContent = '新会话';
  renderProjectList();
}

// Rebind the provider/model selection. With an active session the server
// switches that session in place — same conversation, next turn runs under
// the new selection. Without one it just primes the next session.
async function switchSelection(profileId, model) {
  if (!state.activeSessionId) {
    state.currentProfileId = profileId;
    state.currentModel = model || null;
    renderModelLabel();
    return true;
  }
  try {
    const summary = await client.updateSessionSelection({ sessionId: state.activeSessionId, aiProfileId: profileId === undefined ? null : profileId, model: model || null });
    if (state.sessionSummary) {
      state.sessionSummary = { ...state.sessionSummary, ...summary, title: state.sessionSummary.title };
    }
    state.currentProfileId = summary.aiProfileId !== undefined ? summary.aiProfileId : profileId;
    state.currentModel = summary.selectedModel || summary.model || model || null;
    renderModelLabel();
    toast(`当前会话已切换:${summary.providerName || (summary.aiProfileId ? '供应商' : 'Agent 自身登录')} · ${summary.model || '默认模型'}`, false, true);
    return true;
  } catch (error) {
    toast(error.message, true);
    return false;
  }
}

// Menu groups for the model picker: with auto-detection a provider can carry
// dozens of models, so the picker filters by id/label/tag/provider name.
function filterMenuEntries(profiles, query) {
  const q = String(query || '').trim().toLowerCase();
  const groups = [];
  for (const profile of profiles || []) {
    const entries = profile.models.list && profile.models.list.length
      ? profile.models.list
      : [{ id: profile.models.default, label: profile.models.default, tags: [] }];
    const filtered = q
      ? entries.filter(entry => `${entry.id || ''} ${entry.label || ''} ${(entry.tags || []).join(' ')} ${profile.name || ''}`.toLowerCase().includes(q))
      : entries;
    if (q && !filtered.length) continue;
    groups.push({ profile, entries: filtered });
  }
  return groups;
}

function openModelMenu() {
  const pop = $('pop-model');
  closePops();
  pop.textContent = '';
  const project = state.projects.find(p => p.id === state.activeProjectId);
  for (const [value, label] of [[undefined, '使用项目默认'], [null, 'Agent 自身登录 · 默认模型']]) {
    if (value === undefined && !project) continue;
    const item = el('button', 'pop-item' + (state.currentProfileId === value ? ' selected' : ''));
    item.append(el('span', 'grow', label), checkMark());
    item.addEventListener('click', () => {
      const active = Boolean(state.activeSessionId);
      // "使用项目默认" stays lazy while composing (undefined); an active
      // session must be rebound to the project's concrete defaults.
      const targetId = value === undefined && active ? project.defaultAiProfileId || null : value;
      const targetModel = value === undefined && active ? project.defaultModel || null : null;
      switchSelection(targetId, targetModel).then(ok => {
        if (!ok) return;
        if (value === undefined && !active && project.defaultAgentId) state.currentAgent = project.defaultAgentId;
        applyCapabilityGates();
        closePops();
      });
    });
    pop.append(item);
  }
  pop.append(el('div', 'pop-sep'));
  const search = el('input', 'pop-search');
  search.type = 'search';
  search.placeholder = `搜索模型(共 ${filterMenuEntries(state.profiles).reduce((sum, group) => sum + group.entries.length, 0)} 个)…`;
  const groups = el('div', 'pop-groups');
  const renderGroups = query => {
    groups.textContent = '';
    for (const { profile, entries } of filterMenuEntries(state.profiles, query)) {
    const group = el('div', 'pop-group');
    const glyph = el('span', null);
    glyph.append(icon('spark', 11));
    group.append(glyph, el('span', null, ` ${profile.name}`));
      if (!profile.enabled) group.append(el('span', 'tag', '已禁用'));
      else if (!profile.credentialConfigured) group.append(el('span', 'tag', '未配置密钥'));
      groups.append(group);
      for (const entry of entries) {
        const item = el('button', 'pop-item' + (state.currentProfileId === profile.id && state.currentModel === entry.id ? ' selected' : ''));
        item.disabled = !profile.enabled || !profile.credentialConfigured || !entry.id;
        const grow = el('span', 'grow', entry.label || entry.id);
        item.append(grow);
        const ctxBadge = contextWindowBadge(entry.contextWindow);
        if (ctxBadge) item.append(el('span', 'tag ctx', ctxBadge));
        for (const tag of entry.tags || []) item.append(el('span', 'tag', tag));
        item.append(checkMark());
        item.addEventListener('click', () => {
          switchSelection(profile.id, entry.id).then(ok => { if (ok) closePops(); });
        });
        groups.append(item);
      }
      groups.append(el('div', 'pop-sep'));
    }
    if (!groups.children.length) groups.append(el('div', 'pop-group', '没有匹配的模型'));
  };
  search.addEventListener('input', () => renderGroups(search.value));
  renderGroups('');
  pop.append(search, groups);
  if (project) {
    const saveDefault = el('button', 'pop-item muted');
    saveDefault.append(el('span', 'grow', '将当前选择设为项目默认'));
    saveDefault.addEventListener('click', async () => {
      const selection = resolvedSelection();
      try {
        await client.updateProject(project.id, { defaultAiProfileId: selection.profileId, defaultModel: selection.model, defaultAgentId: state.currentAgent });
        await refreshProjects(true);
        closePops();
        toast('已保存项目默认 Agent、供应商与模型', false, true);
      } catch (error) { toast(error.message, true); }
    });
    pop.append(saveDefault);
  }
  const manage = el('button', 'pop-item muted');
  manage.append(el('span', 'grow', '管理模型'));
  manage.addEventListener('click', () => { closePops(); openSettings('providers'); });
  pop.append(manage);
  pop.hidden = false;
  search.focus();
}

/* ===================== projects & sidebar ===================== */

async function refreshProjects(keepActive) {
  try { state.projects = await client.listProjects(); } catch { state.projects = []; }
  if (!keepActive || !state.projects.some(p => p.id === state.activeProjectId)) {
    state.activeProjectId = state.projects.length ? state.projects[0].id : null;
    if (state.activeProjectId && !state.expanded.has(state.activeProjectId)) state.expanded.add(state.activeProjectId);
    if (!state.activeSessionId && state.currentProfileId === undefined) {
      const project = state.projects.find(p => p.id === state.activeProjectId);
      state.currentAgent = project && project.defaultAgentId || state.currentAgent;
      applyCapabilityGates();
    }
  }
  renderModelLabel();
  await renderProjectList();
}

function sessionTitle(summary) {
  return state.sessionTitles.get(summary.sessionId) || summary.title || '会话';
}

// Replays fire many result events at once; without single-flight the
// concurrent renders all clear first and then all append, duplicating rows.
let projectListInFlight = false;
let projectListQueued = false;
async function renderProjectList() {
  if (projectListInFlight) { projectListQueued = true; return; }
  projectListInFlight = true;
  try {
    await renderProjectListOnce();
  } finally {
    projectListInFlight = false;
    if (projectListQueued) { projectListQueued = false; renderProjectList(); }
  }
}

async function renderProjectListOnce() {
  const wrap = $('project-list');
  wrap.textContent = '';
  if (!state.projects.length) {
    const empty = el('div', 'side-empty');
    const art = el('span', 'side-empty-art');
    art.append(icon('folder', 18));
    empty.append(art, el('div', null, '还没有项目'), el('div', 'side-empty-sub', '点击下方「添加项目」开始'));
    wrap.append(empty);
    renderArchived();
    return;
  }
  for (const project of state.projects) {
    const proj = el('div', 'proj' + (state.activeProjectId === project.id ? ' active' : ''));
    proj.dataset.project = project.id;
    const head = el('button', 'proj-item');
    const caret = el('span', 'p-caret' + (state.expanded.has(project.id) ? '' : ' closed'));
    caret.append(icon('caret', 12));
    const name = el('span', 'p-name', project.name);
    const acts = el('span', 'row-acts');
    const remove = el('span', 'act-btn danger');
    remove.title = '移除项目';
    remove.setAttribute('aria-label', remove.title);
    remove.append(icon('close', 12));
    remove.addEventListener('click', async ev => {
      ev.stopPropagation();
      if (!confirm(`移除项目“${project.name}”及其全部会话?`)) return;
      try {
        await client.removeProject(project.id);
        if (state.activeProjectId === project.id) { detachSession(); }
        await refreshProjects();
        toast('项目已移除', false, true);
      } catch (error) { toast(error.message, true); }
    });
    acts.append(remove);
    head.append(caret, name, acts);
    head.title = project.rootPath;
    head.addEventListener('click', () => {
      if (state.expanded.has(project.id)) state.expanded.delete(project.id);
      else state.expanded.add(project.id);
      if (state.activeProjectId !== project.id) {
        detachSession();
        resetStream();
        setBusyState('idle');
        state.activeProjectId = project.id;
        state.currentProfileId = undefined;
        state.currentModel = null;
        state.currentAgent = project.defaultAgentId || 'claude-code';
        $('session-title').textContent = '新会话';
        applyCapabilityGates();
        renderModelLabel();
      }
      renderProjectList();
    });
    proj.append(head);
    const list = el('div', 'sess-list');
    list.hidden = !state.expanded.has(project.id);
    proj.append(list);
    wrap.append(proj);
    loadProjectSessions(project.id, list);
  }
  renderArchived();
}

async function loadProjectSessions(projectId, listNode) {
  try {
    const sessions = await client.listSessions(projectId);
    if (!listNode.isConnected) return;
    listNode.textContent = '';
    if (!sessions.length) {
      listNode.append(el('div', 'proj-empty', '还没有会话'));
      return;
    }
    sessions.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    for (const summary of sessions) listNode.append(sessionRow(summary, projectId));
  } catch { listNode.textContent = ''; }
}

function sessionRow(summary, projectId) {
  const row = el('button', 'session' + (state.activeSessionId === summary.sessionId ? ' active' : ''));
  const badge = el('span', `agent-badge ${summary.agentId}`, badgeLetter(summary.agentId));
  const title = el('span', 's-title', sessionTitle(summary));
  const acts = el('span', 'row-acts');
  const archive = el('span', 'act-btn');
  archive.title = '归档';
  archive.setAttribute('aria-label', archive.title);
  archive.append(icon('archive', 12));
  archive.addEventListener('click', async ev => {
    ev.stopPropagation();
    try {
      await client.archiveSession(summary.sessionId);
      if (state.activeSessionId === summary.sessionId) detachSession();
      await renderProjectList();
    } catch (error) { toast(error.message, true); }
  });
  acts.append(archive);
  const when = el('span', 'when', shortWhen(summary.updatedAt));
  row.append(badge, title, acts, when);
  row.addEventListener('click', () => openSession(summary.sessionId));
  return row;
}

async function renderArchived() {
  const list = $('arch-list');
  const empty = $('arch-empty');
  list.textContent = '';
  const rows = [];
  for (const project of state.projects) {
    let archived = [];
    try { archived = await client.listSessions(project.id, { archived: true }); } catch { archived = []; }
    for (const summary of archived) {
      if (!summary.archived) continue;
      const row = el('button', 'session');
      row.append(el('span', `agent-badge ${summary.agentId}`, badgeLetter(summary.agentId)));
      row.append(el('span', 's-title', sessionTitle(summary)));
      const acts = el('span', 'row-acts');
      const restore = el('span', 'act-btn');
      restore.title = '恢复会话';
      restore.setAttribute('aria-label', restore.title);
      restore.append(icon('retry', 12));
      restore.addEventListener('click', async ev => {
        ev.stopPropagation();
        try { await client.restoreSession(summary.sessionId); await renderProjectList(); } catch (error) { toast(error.message, true); }
      });
      acts.append(restore);
      row.append(acts);
      row.addEventListener('click', () => openSession(summary.sessionId));
      rows.push(row);
    }
  }
  if (empty) list.append(empty);
  empty && (empty.hidden = rows.length > 0);
  for (const row of rows) list.append(row);
  const count = $('arch-count');
  if (count) { count.textContent = String(rows.length); count.hidden = !rows.length; }
}

function badgeLetter(agentId) {
  return { 'claude-code': 'C', codex: 'X', zcode: 'Z', opencode: 'O' }[agentId] || '?';
}

function shortWhen(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  const now = new Date();
  const minutes = Math.floor((now - date) / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes}分钟`;
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}小时`;
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

/* ===================== session lifecycle ===================== */

async function newSession() {
  if (!state.activeProjectId) { openProjectModal(); return; }
  try {
    const summary = await client.startSession(
      { contextId: state.activeProjectId, workspaceRef: state.activeProjectId, aiProfileId: state.currentProfileId, displayName: (state.projects.find(p => p.id === state.activeProjectId) || {}).name },
      { agentId: state.currentAgent, model: state.currentProfileId === undefined ? undefined : state.currentModel || undefined, permissionMode: state.permissionMode, effort: state.caps && state.caps.generationParams.includes('effort') ? state.effort : undefined },
    );
    if (state.activeSessionId === summary.sessionId) return;
    state.sessionTitles.set(summary.sessionId, '新会话');
    await openSession(summary.sessionId, { preserveAttachments: true });
    await renderProjectList();
    $('chat-input').focus();
  } catch (error) { toast(error.message, true); }
}

async function openSession(sessionId, options = {}) {
  detachSession(options);
  state.activeSessionId = sessionId;
  resetStream();
  let snapshot;
  try { snapshot = await client.loadSession(sessionId); } catch (error) { state.activeSessionId = null; toast(error.message, true); return; }
  const summary = snapshot.session;
  state.sessionSummary = summary;
  state.activeProjectId = summary.contextId || state.activeProjectId;
  state.currentAgent = summary.agentId || 'claude-code';
  state.currentProfileId = summary.aiProfileId || null;
  state.currentModel = summary.selectedModel || summary.model || null;
  renderModelLabel();
  applyCapabilityGates();
  state.permissionMode = snapshot.permissionMode || 'default';
  renderModeLabel();
  $('session-title').textContent = sessionTitle(summary);
  setBusyState(summary.state);
  let last = 0;
  // Timers and per-step durations are wall-clock side effects; replayed
  // snapshots did not witness them, so the stream must not fake them.
  state.replaying = true;
  try {
    for (const event of snapshot.events || []) { renderEvent(event); last = Math.max(last, event.sequence || 0); }
  } finally { state.replaying = false; }
  rememberTitleFromEvents(snapshot.events || []);
  state.unsub = client.subscribe(sessionId, event => renderEvent(event), () => {}, { afterSequence: last });
  await renderProjectList();
  refreshContextUsage();
}

function detachSession(options = {}) {
  if (state.unsub) { try { state.unsub(); } catch {} state.unsub = null; }
  state.activeSessionId = null;
  state.sessionSummary = null;
  if (!options.preserveAttachments) state.attachments = [];
  $('btn-ctx').hidden = true;
  renderAttachmentTray();
}

function rememberTitleFromEvents(events) {
  const prompt = events.find(event => event.type === 'claude/user-prompt' && event.text);
  if (prompt) {
    const title = prompt.text.replace(/\s+/g, ' ').slice(0, 24);
    state.sessionTitles.set(state.activeSessionId, title);
    $('session-title').textContent = title;
  }
}

function resetStream() {
  endTurnVisuals();
  const col = $('stream-col');
  col.textContent = '';
  turn = null;
  state.follow = true;
  const jump = $('jump-latest');
  if (jump) jump.hidden = true;
}

/* ===================== icons ===================== */

// One inline SVG set, stroked with currentColor — replaces the mixed
// emoji/unicode glyphs that read as unstyled "AI default".
const ICONS = {
  copy: '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
  retry: '<svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>',
  spark: '<svg viewBox="0 0 24 24"><path d="M12 3l1.9 5.8L20 12l-6.1 3.2L12 21l-1.9-5.8L4 12l6.1-3.2z"/></svg>',
  think: '<svg viewBox="0 0 24 24"><path d="M12 3a6 6 0 0 1 6 6c0 2-1 3.5-2 4.5V16h-8v-2.5C7 12.5 6 11 6 9a6 6 0 0 1 6-6z"/><path d="M10 19h4"/></svg>',
  shield: '<svg viewBox="0 0 24 24"><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/></svg>',
  eye: '<svg viewBox="0 0 24 24"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z"/><circle cx="12" cy="12" r="2.5"/></svg>',
  eyeOff: '<svg viewBox="0 0 24 24"><path d="M3 3l18 18"/><path d="M10.5 5.2A10.8 10.8 0 0 1 12 5c6.5 0 10 6 10 6a17 17 0 0 1-3 3.4M6.6 6.6C3.7 8.5 2 12 2 12s3.5 6 10 6c1.4 0 2.7-.3 3.8-.8"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>',
  pen: '<svg viewBox="0 0 24 24"><path d="M4 20h4L20 8l-4-4L4 16z"/></svg>',
  gear: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-2-1.2L14 3h-4l-.5 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7 7 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 2 1.2L10 21h4l.5-2.6a7 7 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.06-.4.1-.8.1-1.2z"/></svg>',
  caret: '<svg viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>',
  terminal: '<svg viewBox="0 0 24 24"><path d="m5 8 4 4-4 4"/><path d="M13 16h6"/></svg>',
  file: '<svg viewBox="0 0 24 24"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/></svg>',
  pencil: '<svg viewBox="0 0 24 24"><path d="M4 20h4L20 8l-4-4L4 16z"/></svg>',
  search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>',
  globe: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.5 3 14 0 18-3-4-3-14.5 0-18z"/></svg>',
  agent: '<svg viewBox="0 0 24 24"><rect x="4" y="7" width="16" height="12" rx="2"/><path d="M12 7V3M8 3h8"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/></svg>',
  warn: '<svg viewBox="0 0 24 24"><path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17.5v.5"/></svg>',
  switch: '<svg viewBox="0 0 24 24"><path d="M4 8h13l-3-3M20 16H7l3 3"/></svg>',
  dot: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/></svg>',
  send: '<svg viewBox="0 0 24 24"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="m5 12 5 5L20 7"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  archive: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><path d="M10 12h4"/></svg>',
  arrowDown: '<svg viewBox="0 0 24 24"><path d="M12 5v14"/><path d="m19 12-7 7-7-7"/></svg>',
  arrowLeft: '<svg viewBox="0 0 24 24"><path d="M20 12H4"/><path d="m11 5-7 7 7 7"/></svg>',
  bolt: '<svg viewBox="0 0 24 24"><path d="M13 2 4 14h6l-1 8 9-12h-6z"/></svg>',
  info: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8v.5"/></svg>',
  stop: '<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
  server: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5v.5M7 16.5v.5"/></svg>',
  folder: '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
};

function icon(name, size = 14) {
  const wrap = el('span', `ic ic-${name}`);
  wrap.style.width = `${size}px`;
  wrap.style.height = `${size}px`;
  wrap.innerHTML = ICONS[name] || ICONS.dot;
  return wrap;
}

// Selected-item tick for pop menus (visibility is CSS-driven via .selected).
function checkMark() {
  const mark = el('span', 'check');
  mark.append(icon('check', 13));
  return mark;
}

/* ===================== event rendering ===================== */

// One turn = everything between a user message and its result. Process output
// (thinking, tool calls, narration that precedes a tool call) folds into a
// single collapsible block headed by the running/elapsed timer, ZCode-style
// (工作中 X 秒 → 已工作 X 秒); only the final message stays in the open stream.
let turn = null;

function startTurn() {
  endTurnVisuals();
  turn = {
    startedAt: Date.now(), timerId: null, proc: null, steps: null, meta: null,
    texts: [], liveText: null, liveBody: null, liveRaw: '', liveThinking: null, liveThinkingBody: null,
    lastPrompt: '', changes: new Map(), interrupted: false,
    stderrNote: null, stderrLast: '', thinkHint: null, lastError: '',
  };
  return turn;
}

function ensureProc(t) {
  if (!(t.proc && t.proc.isConnected)) {
    const details = el('details', 'proc');
    details.open = true; // live process output stays visible while running; folds when the turn ends
    const summary = el('summary', null, '');
    const procCaret = el('span', 'caret');
    procCaret.append(icon('caret', 12));
    summary.append(procCaret);
    t.meta = el('span', 'p-meta', '工作中 0 秒');
    summary.append(t.meta);
    details.append(summary);
    t.steps = el('div', 'proc-steps');
    details.append(t.steps);
    $('stream-col').append(details);
    t.proc = details;
    if (!state.replaying) {
      t.timerId = setInterval(() => {
        if (t.meta && t.meta.isConnected) t.meta.textContent = `工作中 ${fmtElapsed(Date.now() - t.startedAt)}`;
      }, 500);
    } else {
      t.meta.textContent = '';
    }
  }
  // Narration streamed before this process entry belongs inside the fold —
  // finalize each block first: its pacer and streaming cursor must not leak
  // into the collapsed view (codex emits one text block per step).
  hideThinkingHint(t);
  for (const node of t.texts.splice(0)) {
    if (node._pacer) node._pacer.finish(node._rawFull || '');
    const body = node.querySelector && node.querySelector('.md-body');
    if (body) body.classList.remove('streaming');
    t.steps.append(node);
  }
  t.liveText = null; t.liveBody = null; t.liveRaw = '';
  return t;
}

function stampThinking(t) {
  if (!t || !t.liveThinking) return;
  const seg = t.liveThinking;
  const label = seg.querySelector('.t-meta');
  if (label && !label.textContent) label.textContent = `· 持续了 ${fmtElapsed(Date.now() - (seg._startedAt || Date.now()))}`;
  t.liveThinking = null;
}

function hideThinkingHint(t) {
  if (t && t.thinkHint && t.thinkHint.isConnected) t.thinkHint.remove();
  if (t) t.thinkHint = null;
}

function showThinkingHint(t) {
  if (!t || t.thinkHint) return;
  const hint = el('div', 'think-hint');
  hint.append(el('span', 'ring'), el('span', null, '思考中…'));
  $('stream-col').append(hint);
  t.thinkHint = hint;
}

function endTurnVisuals(durationMs) {
  const t = turn;
  if (!t) return;
  stampThinking(t);
  hideThinkingHint(t);
  if (t.timerId) { clearInterval(t.timerId); t.timerId = null; }
  const elapsed = fmtElapsed(durationMs != null && Number.isFinite(durationMs) ? durationMs : Date.now() - t.startedAt);
  if (t.meta && t.meta.isConnected) {
    // One title shape for live and replayed turns alike.
    const stepCount = t.proc ? t.proc.querySelectorAll('.step').length : 0;
    t.meta.textContent = state.replaying
      ? (stepCount ? `${stepCount} 个步骤` : '无步骤')
      : (stepCount ? `${stepCount} 个步骤 · 已工作 ${elapsed}` : `已工作 ${elapsed}`);
  }
  for (const node of [...t.texts, t.liveText]) {
    if (!node) continue;
    if (node._pacer) node._pacer.finish(node._rawFull || '');
    const body = node.querySelector && node.querySelector('.md-body');
    if (body) body.classList.remove('streaming');
  }
  if (t.liveBody) t.liveBody.classList.remove('streaming');
  if (t.proc) {
    // Belt and braces: no residual cursors or "running" steps inside the fold,
    // even when the driver never sent the matching completion events.
    for (const body of t.proc.querySelectorAll('.streaming')) body.classList.remove('streaming');
    for (const step of t.proc.querySelectorAll('.step')) {
      if (step.classList.contains('done')) continue;
      step.classList.add('done');
      const meta = step.querySelector('.s-meta');
      if (meta) { meta.classList.remove('running'); meta.textContent = t.interrupted ? '已中断' : '完成'; }
    }
    t.proc.open = false;
  }
  turn = null;
}

function fmtElapsed(ms) {
  const total = Math.max(0, Math.round(Number(ms || 0) / 1000));
  if (total < 60) return `${total} 秒`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return total % 60 ? `${minutes} 分 ${total % 60} 秒` : `${minutes} 分`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

/* Streamed text is rendered at a human pace instead of once per delta
   (ported from OpenCode's PacedMarkdown): small jumps land immediately,
   big backlogs advance in word-sized steps that snap to punctuation. */
const TEXT_RENDER_PACE_MS = 24;
const TEXT_RENDER_IMMEDIATE = 512;
const TEXT_RENDER_SNAP = /[\s.,!?;:)\]]/;

function pacedStep(remaining) {
  if (remaining <= 12) return 2;
  if (remaining <= 48) return 4;
  if (remaining <= 96) return 8;
  if (remaining <= 512) return 32;
  // Whole-block arrivals (codex/opencode deliver a step's text at once)
  // still reveal at a readable pace instead of slamming in.
  return 48;
}

function pacedNext(text, start) {
  const end = Math.min(text.length, start + pacedStep(text.length - start));
  const max = Math.min(text.length, end + 8);
  for (let i = end; i < max; i += 1) {
    if (TEXT_RENDER_SNAP.test(text[i] || '')) return i + 1;
  }
  return end;
}

function createPacer(render) {
  let shown = '';
  let timer = null;
  const stop = () => { if (timer) { clearTimeout(timer); timer = null; } };
  const tick = full => {
    const end = pacedNext(full, shown.length);
    shown = full.slice(0, end);
    render(shown);
    if (end < full.length) timer = setTimeout(() => { timer = null; tick(full); }, TEXT_RENDER_PACE_MS);
  };
  return {
    push(full) {
      if (!full.startsWith(shown) || full.length <= shown.length || full.length - shown.length <= TEXT_RENDER_IMMEDIATE) {
        stop();
        shown = full;
        render(shown);
        return;
      }
      stop();
      tick(full);
    },
    finish(full) {
      stop();
      shown = full;
      render(shown);
    },
  };
}

function renderEvent(event) {
  const col = $('stream-col');
  const empty = $('empty-hint');
  if (empty && empty.isConnected) empty.remove();
  const t = turn;
  switch (event.type) {
    case 'claude/session-ready':
      if (event.model) setBusyState('idle');
      if (state.sessionSummary && event.model) { state.sessionSummary.model = event.model; renderModelLabel(); }
      break;
    case 'claude/user-prompt': {
      rememberTitleFromEvents([event]);
      if (state.activeSessionId && event.text) state.sessionTitles.set(state.activeSessionId, event.text.replace(/\s+/g, ' ').slice(0, 24));
      const wrap = el('div', 'msg user');
      const bubble = el('div', 'bubble', event.text || '');
      wrap.append(bubble);
      const copy = el('button', 'bubble-copy');
      copy.title = '复制';
      copy.append(icon('copy', 13));
      copy.addEventListener('click', () => copyText(event.text || '', copy));
      wrap.append(copy);
      if (Array.isArray(event.attachments) && event.attachments.length) {
        const tray = el('div', 'attach-tray');
        for (const item of event.attachments) {
          if (String(item.mediaType || '').startsWith('image/')) {
            const img = document.createElement('img');
            img.src = item.url || '';
            img.alt = item.name || '图片附件';
            tray.append(img);
          } else {
            const chip = el('span', 'attachment-file');
            chip.append(icon('file', 12), el('span', null, ` ${item.name || '文本附件'}${item.size ? ` · ${formatBytes(item.size)}` : ''}`));
            tray.append(chip);
          }
        }
        wrap.append(tray);
      }
      col.append(wrap);
      const ctx = startTurn();
      ctx.lastPrompt = event.text || '';
      break;
    }
    case 'claude/text-start':
    case 'claude/text-delta': {
      stampThinking(t);
      const ctx = t || startTurn();
      if (!ctx.liveText || !ctx.liveText.isConnected) {
        const msg = el('div', 'msg ai');
        const body = el('div', 'md-body streaming');
        msg.append(body);
        col.append(msg);
        ctx.liveText = msg;
        ctx.liveBody = body;
        ctx.liveRaw = '';
        ctx.texts.push(msg); // ensureProc later folds narration that precedes a tool call
        msg._pacer = createPacer(shown => setMarkdown(body, shown));
      }
      if (event.type === 'claude/text-delta') {
        ctx.liveRaw += event.text || '';
        ctx.liveText._rawFull = ctx.liveRaw;
        ctx.liveText._pacer.push(ctx.liveRaw);
      }
      break;
    }
    case 'claude/thinking-start': {
      const ctx = ensureProc(t || startTurn());
      stampThinking(ctx);
      const seg = el('div', 'think-seg');
      seg._startedAt = Date.now();
      const label = el('div', 'think-label');
      const glyph = el('span', 't-glyph');
      glyph.append(icon('think', 13));
      label.append(glyph, el('span', null, '思考'), el('span', 't-meta', ''));
      seg.append(label);
      const body = el('div', 'think-body');
      seg.append(body);
      ctx.steps.append(seg);
      ctx.liveThinking = seg;
      ctx.liveThinkingBody = body;
      break;
    }
    case 'claude/thinking-delta':
      if (t && t.liveThinkingBody) t.liveThinkingBody.textContent += event.text || '';
      break;
    case 'claude/tool-use': {
      stampThinking(t);
      const ctx = ensureProc(t || startTurn());
      const input = event.input || {};
      ctx.steps.append(buildToolStep(event, input));
      break;
    }
    case 'claude/tool-result': {
      const target = col.querySelector(`.step[data-tool-id="${cssEscape(event.id || '')}"]`);
      const step = target || col.appendChild(buildToolStep({ id: event.id, name: event.toolName || '' }, {}));
      const body = step.querySelector('.step-body');
      if (body) {
        const output = event.output && typeof event.output === 'object' ? JSON.stringify(event.output, null, 2) : String(event.output || '');
        body.append(ioCard('text', output.slice(0, 4000), '输出'));
      }
      renderFileChanges(step, event, step._toolInput || {});
      const meta = step.querySelector('.s-meta');
      if (meta) {
        const done = event.isError ? '失败' : '完成';
        const seconds = state.replaying ? null : Math.round((Date.now() - (step._startedAt || Date.now())) / 1000);
        meta.textContent = seconds == null ? done : `${done} · ${fmtElapsed(seconds * 1000)}`;
        meta.classList.remove('running');
        meta.classList.toggle('failed', Boolean(event.isError));
      }
      step.classList.add('done');
      if (event.isError) step.classList.add('failed');
      if (t) collectTurnChanges(t, event, step._toolInput || {});
      break;
    }
    case 'claude/permission-request': {
      const card = el('div', 'perm');
      card.dataset.permId = event.requestId || '';
      const pIcon = el('span', 'p-icon');
      pIcon.append(icon('shield', 15));
      card.append(pIcon);
      const body = el('div', 'p-body');
      body.append(el('div', 'p-title', `${event.toolName || 'Agent'} 请求执行操作`));
      body.append(el('div', 'p-sub', permissionSubtitle(event)));
      card.append(body);
      const actions = el('div', 'p-actions');
      const allow = el('button', 'btn-allow', '允许');
      const deny = el('button', 'btn-deny', '拒绝');
      allow.addEventListener('click', () => settlePermission(card, event.requestId, true));
      deny.addEventListener('click', () => settlePermission(card, event.requestId, false));
      actions.append(allow, deny);
      card.append(actions);
      col.append(card);
      setBusyState('pending-permission');
      break;
    }
    case 'claude/permission-resolved': {
      const card = col.querySelector(`.perm[data-perm-id="${cssEscape(event.requestId || '')}"]`);
      if (card) settlePermissionCard(card, event.allow === true);
      setBusyState('running');
      break;
    }
    case 'claude/usage':
      refreshContextUsage();
      break;
    case 'claude/result': {
      stampThinking(t);
      const hadLiveText = Boolean(t && t.liveText && t.liveText.isConnected);
      const lastPrompt = t ? t.lastPrompt : '';
      const turnChanges = t ? t.changes : null;
      const turnModel = event.model || (state.sessionSummary && state.sessionSummary.model) || '';
      endTurnVisuals(event.durationMs != null ? event.durationMs : event.duration_ms);
      if (event.isError) {
        const err = el('div', 'msg ai');
        const dim = el('p', 'dim');
        dim.append(icon('warn', 13), el('span', null, ` ${event.result || event.message || '执行出错'}`));
        err.append(dim);
        col.append(err);
      } else {
        if (!hadLiveText && event.result) {
          const msg = el('div', 'msg ai');
          const body = el('div', 'md-body');
          msg.append(body);
          col.append(msg);
          setMarkdown(body, String(event.result));
        }
        const lastMsg = [...col.children].reverse().find(node => node.classList && node.classList.contains('ai'));
        if (lastMsg) lastMsg.append(msgFooter(String(event.result || lastMsg.textContent), lastPrompt, { model: turnModel }));
        if (turnChanges && turnChanges.size) col.append(renderTurnDiffs(turnChanges));
      }
      setBusyState('idle');
      refreshContextUsage();
      if (!state.replaying) refreshSessionRow();
      break;
    }
    case 'claude/state': {
      setBusyState(event.state);
      // The thinking phase can last tens of seconds with no driver events at
      // all (codex only reports reasoning on completion) — show a live hint
      // instead of dead air, and clear it as soon as anything real happens.
      if (event.state === 'thinking' && t && !t.proc && !t.liveText) showThinkingHint(t);
      else hideThinkingHint(t);
      // Turn finalization is driven by result/aborted/error events: step-level
      // state flapping (opencode emits idle between steps) must not split a
      // turn into several collapses.
      break;
    }
    case 'claude/aborted':
      if (t) t.interrupted = true;
      endTurnVisuals();
      {
        const stopNote = el('div', 'turn-note');
        stopNote.append(icon('stop', 12), el('span', null, ' 已停止'));
        col.append(stopNote);
      }
      {
        // The interrupted footer belongs to THIS turn's message only — when
        // nothing was streamed yet, the previous turn's message must not
        // grow a second footer.
        const ownMsg = t && t.liveText && t.liveText.isConnected ? t.liveText : null;
        if (ownMsg) ownMsg.append(msgFooter(ownMsg.textContent, t ? t.lastPrompt : '', { interrupted: true }));
      }
      setBusyState('idle');
      break;
    case 'claude/error': {
      const message = String(event.message || event.error || '执行出错');
      endTurnVisuals();
      const err = el('div', 'msg ai error');
      err.append(icon('warn', 15), el('span', 'err-text', message));
      col.append(err);
      setBusyState('idle');
      break;
    }
    case 'claude/stderr': {
      const ctx = t ? ensureProc(t) : null;
      const text = String(event.text || '').trim();
      if (!text) break;
      // One reusable "runtime output" block per turn: drivers emit a burst of
      // stderr chunks on startup, which must not become N separate folds.
      let note = ctx ? ctx.stderrNote : null;
      if (!note || !note.isConnected) {
        note = el('details', 'step note done');
        note._count = 0;
        const summary = el('summary', null, '');
        const noteCaret = el('span', 's-caret');
        noteCaret.append(icon('caret', 12));
        summary.append(noteCaret, el('span', 's-dot'), el('span', 's-name', '运行时输出'), el('span', 's-meta', ''));
        const noteBody = el('div', 'step-body');
        note.append(summary, noteBody);
        (ctx ? ctx.steps : col).append(note);
        if (ctx) { ctx.stderrNote = note; ctx.stderrLast = ''; }
      }
      const last = ctx ? ctx.stderrLast : note._last || '';
      if (text === last) break; // consecutive duplicates collapse
      if (ctx) ctx.stderrLast = text; else note._last = text;
      note.querySelector('.step-body').append(ioCard('text', text.slice(0, 2000), '输出'));
      note._count += 1;
      const meta = note.querySelector('.s-meta');
      if (meta) meta.textContent = `${note._count} 条`;
      break;
    }
    case 'claude/retry': {
      const ctx = t ? ensureProc(t) : null;
      const step = el('div', 'step-line');
      step.append(el('span', 's-dot'), el('span', 's-desc', `重试（第 ${event.attempt || '?'} 次）`));
      (ctx ? ctx.steps : col).append(step);
      break;
    }
    case 'claude/selection-changed': {
      if (state.sessionSummary) {
        if (event.toModel) state.sessionSummary.model = event.toModel;
        if (event.toAiProfileId !== undefined) state.sessionSummary.aiProfileId = event.toAiProfileId;
        renderModelLabel();
      }
      const from = event.fromModel || '默认模型';
      const to = event.toModel || '默认模型';
      const switchNote = el('div', 'turn-note');
      switchNote.append(icon('switch', 12), el('span', null, ` 已切换:${from} → ${to}`));
      col.append(switchNote);
      break;
    }
    default:
      break;
  }
  const stream = $('stream');
  // Follow-mode autoscroll (OpenCode-style): stick to the bottom while the
  // user hasn't scrolled away; the jump button restores following.
  if (stream && state.follow) stream.scrollTop = stream.scrollHeight;
}

function buildToolStep(event, input) {
  const step = el('details', 'step');
  step.dataset.toolId = event.id || '';
  step._toolInput = input;
  step._toolName = event.name;
  step._startedAt = Date.now();
  const verb = toolVerb(event.name);
  const summary = el('summary', null, '');
  const caret = el('span', 's-caret');
  caret.append(icon('caret', 12));
  summary.append(caret, icon(TOOL_ICONS[verb] || 'dot', 13), el('span', 's-name', verb), el('span', 's-desc', toolDetail(event.name, input)), buildToolArgs(input), el('span', 's-meta running', '运行中'));
  step.append(summary);
  // Edit/write steps change the workspace; keep them visible when the fold opens.
  if (verb === '编辑' || verb === '写入') step.open = true;
  const body = el('div', 'step-body');
  body.append(ioCard('json', input, '输入'));
  step.append(body);
  renderFileChanges(step, event, input);
  return step;
}

const TOOL_ICONS = {
  '命令': 'terminal', '读取': 'file', '写入': 'pencil', '编辑': 'pencil',
  '搜索': 'search', '网络': 'globe', '子任务': 'agent',
};

function buildToolArgs(input) {
  const wrap = el('span', 's-args');
  for (const key of ['pattern', 'include', 'glob', 'offset', 'limit', 'encoding', 'agent']) {
    const value = input ? input[key] : undefined;
    if (value === undefined || value === null || value === '') continue;
    wrap.append(el('i', null, `${key}=${value}`));
    if (wrap.children.length >= 3) break;
  }
  return wrap;
}

function toolVerb(name) {
  const tool = String(name || '').toLowerCase();
  if (tool === 'bash' || tool === 'terminal' || tool === 'shell') return '命令';
  if (tool === 'read') return '读取';
  if (tool === 'write') return '写入';
  if (['edit', 'apply_patch', 'multiedit', 'notebookedit'].includes(tool)) return '编辑';
  if (['grep', 'glob', 'search'].includes(tool)) return '搜索';
  if (['webfetch', 'websearch', 'fetch'].includes(tool)) return '网络';
  if (['task', 'agent'].includes(tool)) return '子任务';
  return '工具';
}

function toolDetail(name, input) {
  const tool = String(name || '').toLowerCase();
  const file = input.file_path || input.path || input.filePath || '';
  if (tool === 'bash' && input.command) return String(input.command).replace(/\s+/g, ' ').slice(0, 90);
  if (file) return String(file).slice(0, 90);
  if (input.pattern || input.query) return String(input.pattern || input.query).slice(0, 60);
  if (input.url) return String(input.url).slice(0, 60);
  return String(name || '').slice(0, 40);
}

// Copy feedback swaps the button's icon to a check mark instead of overwriting
// textContent (which would destroy the SVG and leave a blank button behind).
function copyText(text, button) {
  if (!navigator.clipboard) return;
  navigator.clipboard.writeText(String(text || '')).then(() => {
    const glyph = button.querySelector('.ic');
    if (!glyph) return;
    const restore = icon(glyph.classList.contains('ic-check') ? 'check' : 'copy', 13);
    button.classList.add('copied');
    glyph.replaceWith(icon('check', 13));
    setTimeout(() => {
      button.classList.remove('copied');
      const current = button.querySelector('.ic');
      if (current) current.replaceWith(restore);
    }, 1200);
  }).catch(() => {});
}

// 复制 / 重试 / 模型 · 已中断 · 时间 — the action row under the final assistant message.
function msgFooter(text, lastPrompt, options = {}) {
  const row = el('div', 'msg-foot');
  const copy = el('button', 'foot-btn');
  copy.title = '复制';
  copy.append(icon('copy', 12));
  copy.addEventListener('click', () => copyText(text, copy));
  row.append(copy);
  if (lastPrompt && !state.replaying && state.activeSessionId) {
    const retry = el('button', 'foot-btn');
    retry.title = '重试';
    retry.append(icon('retry', 13));
    retry.addEventListener('click', async () => {
      if (state.busy || state.sending) return;
      try {
        await client.send({ sessionId: state.activeSessionId, text: lastPrompt });
        setBusyState('running');
      } catch (error) { toast(error.message, true); }
    });
    row.append(retry);
  }
  const bits = [];
  if (options.model) bits.push(options.model);
  if (options.interrupted) bits.push('已中断');
  bits.push(new Date().toTimeString().slice(0, 5));
  row.append(el('span', 'foot-time', bits.join(' · ')));
  return row;
}

// Per-turn file change ledger: rows merged across tool calls (OpenCode-style
// "N 个文件更改 +A −D" summary block under the final message).
function collectTurnChanges(t, event, input) {
  if (!t.changes) t.changes = new Map();
  for (const change of fileChangeSummaries(event, input)) {
    if (!change.path) continue;
    const prev = t.changes.get(change.path) || { path: change.path, kind: change.kind, additions: 0, deletions: 0, counted: false, approximate: false };
    if (change.counts) {
      prev.additions += change.counts.additions || 0;
      prev.deletions += change.counts.deletions || 0;
      prev.counted = true;
      prev.approximate = prev.approximate || Boolean(change.counts.approximate);
    } else if (change.lines != null) {
      prev.additions += change.lines;
      prev.counted = true;
    }
    t.changes.set(change.path, prev);
  }
}

function renderTurnDiffs(changes) {
  const entries = [...changes.values()];
  const block = el('div', 'turn-diffs');
  const head = el('div', 'turn-diffs-head');
  head.append(el('span', 'td-label', `${entries.length} 个文件更改`));
  const counts = el('span', 'td-count');
  const adds = entries.reduce((sum, entry) => sum + entry.additions, 0);
  const dels = entries.reduce((sum, entry) => sum + entry.deletions, 0);
  counts.append(el('i', 'diff-add', `+${adds}`), el('i', 'diff-remove', `−${dels}`));
  if (entries.some(entry => entry.approximate)) counts.append(el('i', 'td-approx', '约'));
  head.append(counts);
  block.append(head);
  const list = el('div', 'turn-diffs-list');
  for (const entry of entries.slice(0, 10)) {
    const row = el('div', 'td-row');
    const label = { add: '新增', create: '新增', delete: '删除', remove: '删除', write: '写入', update: '修改' }[entry.kind] || '修改';
    row.append(el('span', 'file-path', `${label} ${entry.path}`));
    if (entry.counted) row.append(el('span', 'td-rowcount', `+${entry.additions} −${entry.deletions}`));
    list.append(row);
  }
  if (entries.length > 10) list.append(el('div', 'td-row td-more', `还有 ${entries.length - 10} 个文件…`));
  block.append(list);
  return block;
}

// Single-pass JSON highlighter: tokenizes raw text first (escaping each slice),
// because escaping first would turn quotes into &quot; and break the key regex.
function highlightJson(source) {
  const text = String(source);
  const re = /("(?:[^"\\]|\\.)*")(\s*:)|("(?:[^"\\]|\\.)*")|\b(true|false|null)\b|(-?\d+(?:\.\d+)?)/g;
  let out = '';
  let last = 0;
  for (let match; (match = re.exec(text));) {
    out += escapeHtml(text.slice(last, match.index));
    if (match[1]) out += `<span class="j-key">${escapeHtml(match[1])}</span>${escapeHtml(match[2])}`;
    else if (match[3]) out += `<span class="j-str">${escapeHtml(match[3])}</span>`;
    else if (match[4]) out += `<span class="j-bool">${match[4]}</span>`;
    else if (match[5]) out += `<span class="j-num">${match[5]}</span>`;
    last = re.lastIndex;
  }
  out += escapeHtml(text.slice(last));
  return out;
}

// Collapsible payload card with a language tag and copy button, ZCode-style.
function ioCard(lang, value, fallbackLabel) {
  const card = el('div', 'io-card');
  const text = value == null ? '' : typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  const pretty = typeof value === 'string' && lang === 'json' && value.trim().startsWith('{') ? safeStringify(value) : (typeof value === 'object' && value != null ? JSON.stringify(value, null, 2) : text);
  const head = el('div', 'io-head');
  const tag = el('span', 'io-tag');
  if (lang === 'json') { tag.append(el('span', 'io-brace', '{ }'), el('span', null, 'json')); }
  else tag.textContent = fallbackLabel || lang;
  head.append(tag);
  const copy = el('button', 'io-copy');
  copy.title = '复制';
  copy.append(icon('copy', 12));
  copy.addEventListener('click', () => copyText(pretty || text, copy));
  head.append(copy);
  card.append(head);
  const pre = el('pre');
  if (lang === 'json' && pretty) pre.innerHTML = highlightJson(pretty);
  else pre.textContent = String(text).slice(0, 4000);
  card.append(pre);
  return card;
}

function safeStringify(value) {
  try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return null; }
}

function textLines(value) {
  const text = String(value || '').replace(/\r\n/g, '\n');
  return text ? text.replace(/\n$/, '').split('\n') : [];
}

function changedLineCounts(before, after) {
  const oldLines = textLines(before), newLines = textLines(after);
  while (oldLines.length && newLines.length && oldLines[0] === newLines[0]) { oldLines.shift(); newLines.shift(); }
  while (oldLines.length && newLines.length && oldLines[oldLines.length - 1] === newLines[newLines.length - 1]) { oldLines.pop(); newLines.pop(); }
  // Bound the work for very large edits; never freeze the event stream.
  if (oldLines.length * newLines.length > 250000) return { additions: newLines.length, deletions: oldLines.length, approximate: true };
  const row = new Uint32Array(newLines.length + 1);
  for (const oldLine of oldLines) {
    let previous = 0;
    for (let j = 1; j <= newLines.length; j += 1) {
      const saved = row[j];
      row[j] = oldLine === newLines[j - 1] ? previous + 1 : Math.max(row[j], row[j - 1]);
      previous = saved;
    }
  }
  return { additions: newLines.length - row[newLines.length], deletions: oldLines.length - row[newLines.length] };
}

function patchCounts(patch) {
  if (typeof patch !== 'string' || !patch.trim()) return null;
  const lines = patch.split(/\r?\n/);
  const relevant = lines.filter(line => /^[+-]/.test(line) && !/^(---|\+\+\+)/.test(line));
  if (!relevant.length) return null;
  return { additions: relevant.filter(line => line[0] === '+').length, deletions: relevant.filter(line => line[0] === '-').length };
}

function fileChangeSummaries(event, input = {}) {
  const output = event.output && typeof event.output === 'object' ? event.output : {};
  const metadata = event.metadata || output.metadata || input.metadata || {};
  const changes = event.changes || input.changes || metadata.changes;
  if (Array.isArray(changes) && changes.length) {
    return changes.map(change => ({
      path: change.path || change.file_path || change.filePath || '',
      kind: typeof change.kind === 'string' ? change.kind : change.kind && change.kind.type || 'update',
      counts: Number.isFinite(change.additions) && Number.isFinite(change.deletions)
        ? { additions: change.additions, deletions: change.deletions }
        : patchCounts(change.diff || change.patch),
    }));
  }
  const path = input.file_path || input.path || input.filePath || metadata.filePath || metadata.filepath || '';
  const patch = event.diff || metadata.diff || input.diff || input.patch;
  if (patch) return [{ path, kind: 'update', counts: patchCounts(patch) }];
  const oldText = input.old_string == null ? input.oldString : input.old_string;
  const newText = input.new_string == null ? input.newString : input.new_string;
  if (typeof oldText === 'string' && typeof newText === 'string') return [{ path, kind: 'update', counts: changedLineCounts(oldText, newText) }];
  if (Array.isArray(input.edits)) return input.edits.flatMap(edit => fileChangeSummaries({}, { ...edit, file_path: path }));
  if (typeof input.content === 'string' && path) return [{ path, kind: 'write', lines: textLines(input.content).length }];
  if (input.files) return [{ path: String(input.files), kind: 'update', counts: null }];
  return [];
}

function renderFileChanges(details, event, input) {
  const changes = fileChangeSummaries(event, input);
  if (!changes.length) return;
  const old = details.querySelector('.file-changes');
  if (old) old.remove();
  const wrap = el('div', 'file-changes');
  for (const change of changes) {
    const row = el('div', 'file-change');
    const label = { add: '新增', create: '新增', delete: '删除', remove: '删除', write: '写入', update: '修改' }[change.kind] || '修改';
    row.append(el('span', 'file-path', `${label} ${change.path || '文件'}`));
    if (change.counts) {
      if (change.counts.approximate) row.append(el('span', 'meta', '约'));
      row.append(el('span', 'diff-add', `+${change.counts.additions}`), el('span', 'diff-remove', `−${change.counts.deletions}`));
    } else if (change.lines != null) row.append(el('span', 'meta', `${change.lines} 行`));
    else row.append(el('span', 'meta', '未提供行差异'));
    wrap.append(row);
  }
  // The chips stay above the fold inside the step body; the full tool payload remains collapsed.
  const host = details.querySelector('.step-body') || details.querySelector('summary');
  if (host) host.append(wrap);
}

/* ===================== markdown ===================== */

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function inlineMd(text) {
  const codes = [];
  let out = text.replace(/`([^`]+)`/g, (match, code) => { codes.push(code); return `\u0001${codes.length - 1}\u0001`; });
  out = out
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  return out.replace(/\u0001(\d+)\u0001/g, (match, index) => `<code>${codes[Number(index)]}</code>`);
}

// Minimal renderer for agent replies: escape first, then apply the handful of
// constructs replies actually use. The model output is never trusted as HTML.
function renderMarkdown(source) {
  const text = String(source || '').replace(/\r\n/g, '\n');
  const blocks = [];
  const withCode = text.replace(/```([\w+#.-]*)[ \t]*\n?([\s\S]*?)(?:```|$)/g, (match, lang, code) => {
    blocks.push({ lang: String(lang || '').slice(0, 24), code: String(code).replace(/\n$/, '') });
    return `\u0000${blocks.length - 1}\u0000`;
  });
  const out = [];
  let list = null;
  let para = [];
  const flushPara = () => { if (para.length) { out.push(`<p>${para.join('<br>')}</p>`); para = []; } };
  const flushList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const line of escapeHtml(withCode).split('\n')) {
    const stripped = line.trim();
    const bullet = stripped.match(/^[-*+]\s+(.*)$/);
    const ordered = stripped.match(/^(\d+)[.)]\s+(.*)$/);
    if (bullet || ordered) {
      flushPara();
      const want = bullet ? 'ul' : 'ol';
      if (list !== want) { flushList(); out.push(`<${want}>`); list = want; }
      out.push(`<li>${inlineMd(bullet ? bullet[1] : ordered[2])}</li>`);
      continue;
    }
    flushList();
    if (!stripped) { flushPara(); continue; }
    const heading = stripped.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushPara();
      const level = Math.min(heading[1].length + 2, 6);
      out.push(`<h${level}>${inlineMd(heading[2])}</h${level}>`);
      continue;
    }
    if (/^(---+|\*\*\*+|___+)\s*$/.test(stripped)) { flushPara(); out.push('<hr>'); continue; }
    const quote = stripped.match(/^&gt;\s?(.*)$/);
    if (quote) { flushPara(); out.push(`<blockquote>${inlineMd(quote[1])}</blockquote>`); continue; }
    para.push(inlineMd(stripped));
  }
  flushList();
  flushPara();
  return out.join('\n').replace(/\u0000(\d+)\u0000/g, (match, index) => {
    const block = blocks[Number(index)];
    if (!block) return '';
    return `<div class="codeblock"><div class="cb-head"><span class="cb-lang">${escapeHtml(block.lang)}</span><button type="button" class="cb-copy">复制</button></div><pre><code>${escapeHtml(block.code)}</code></pre></div>`;
  });
}

function setMarkdown(node, source) {
  // Some agents leak raw <think> blocks into the text stream; that is process
  // narration, not reply content — never render it in the open stream.
  const text = stripThink(String(source || ''));
  // Very large streams would re-render markdown on every delta; degrade to text.
  if (text.length > 200000) { node.textContent = text; return; }
  node.innerHTML = renderMarkdown(text);
}

function stripThink(text) {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/<think>[\s\S]*$/, '').trim();
}

function permissionSubtitle(event) {
  const input = event.input || {};
  return `${event.toolName || ''} ${input.file_path || input.command || ''}`.trim().slice(0, 120) || '请求授权';
}

async function settlePermission(card, requestId, allow) {
  try {
    await client.resolvePermission({ sessionId: state.activeSessionId, requestId, allow });
    settlePermissionCard(card, allow);
  } catch (error) { toast(error.message, true); }
}

function settlePermissionCard(card, allow) {
  const actions = card.querySelector('.p-actions');
  if (actions) {
    const stateNode = el('span', 'p-state' + (allow ? '' : ' no'), allow ? '已允许' : '已拒绝');
    actions.replaceWith(stateNode);
  }
  // Settled approvals fold to a single inline line (OpenCode-style), not a card.
  card.classList.add('settled');
}

function cssEscape(value) { return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&'); }
function fmtTokens(value) {
  const n = Number(value || 0);
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/* ===================== busy / activity / context ===================== */

function setBusyState(sessionState) {
  state.busy = ['running', 'thinking', 'tool-running', 'spawning', 'pending-permission'].includes(sessionState);
  const status = $('session-status');
  const send = $('btn-send');
  if (sessionState && sessionState !== 'idle') {
    status.hidden = false;
    $('session-status-text').textContent = {
      running: '工作中', thinking: '思考中', 'tool-running': '执行工具', spawning: '启动中',
      'pending-permission': '等待授权', aborted: '已停止', failed: '失败',
    }[sessionState] || sessionState;
  } else {
    status.hidden = true;
  }
  send.innerHTML = '';
  if (state.busy) send.append(el('span', 'sq'));
  else { const up = el('span', 'up'); up.append(icon('send', 16)); send.append(up); }
  send.title = state.busy ? '停止' : '发送';
}

async function refreshContextUsage() {
  if (!state.activeSessionId) return;
  try {
    const usage = await fetch(`/api/claude-workbench/v1/sessions/${encodeURIComponent(state.activeSessionId)}/context-usage`).then(r => (r.ok ? r.json() : null));
    if (!usage) return;
    $('btn-ctx').hidden = false;
    $('btn-ctx').title = usage.percent != null ? `上下文用量 ${usage.percent}%` : '上下文用量';
    $('ctx-label').textContent = `${fmtTokens(usage.used)} / ${fmtTokens(usage.contextWindow)}`;
    let mini = $('ctx-mini');
    if (!mini) { mini = el('span', 'ctx-mini'); mini.id = 'ctx-mini'; $('btn-ctx').append(mini); }
    mini.textContent = '';
    const miniFill = el('i');
    miniFill.style.width = `${Math.min(100, usage.percent || 0)}%`;
    mini.append(miniFill);
    const pop = $('pop-ctx');
    pop.textContent = '';
    const head = el('div', 'ctx-head');
    head.append(el('span', null, '上下文容量'), el('span', 'num', `${fmtTokens(usage.used)}/${fmtTokens(usage.contextWindow)}${usage.percent != null ? ` (${usage.percent}%)` : ''}`));
    pop.append(head);
    const bar = el('div', 'bar');
    const fill = el('i');
    fill.style.width = `${Math.min(100, usage.percent || 0)}%`;
    bar.append(fill);
    pop.append(bar);
    for (const [key, label] of [['messages', '消息'], ['tools', '工具'], ['other', '其他']]) {
      const row = el('div', 'ctx-row');
      row.append(el('span', null, `${label}(估算)`), el('span', null, fmtTokens(usage.breakdown[key])));
      pop.append(row);
    }
    pop.append(el('div', 'ctx-sep'));
    const foot = el('div', 'ctx-row');
    foot.append(el('span', null, '模型'), el('span', null, usage.model || '-'));
    pop.append(foot);
  } catch { /* leave the chip hidden */ }
}

async function refreshSessionRow() { await renderProjectList(); }

/* ===================== composer ===================== */

function wireComposer() {
  const input = $('chat-input');
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(150, input.scrollHeight)}px`;
  });
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendCurrent(); }
  });
  $('btn-send').addEventListener('click', () => {
    if (state.busy) { stopCurrent(); } else { sendCurrent(); }
  });
  $('btn-attach').addEventListener('click', () => $('file-input').click());
  $('file-input').addEventListener('change', async event => {
    for (const file of event.target.files || []) await addAttachment(file);
    event.target.value = '';
  });
  $('btn-mode').addEventListener('click', () => openModeMenu());
  $('btn-model').addEventListener('click', openModelMenu);
  $('btn-effort').addEventListener('click', openEffortMenu);
  $('btn-ctx').addEventListener('click', () => { refreshContextUsage(); togglePop('pop-ctx'); });
  document.addEventListener('click', ev => { if (!ev.target.closest('.anchor')) closePops(); });
  document.addEventListener('keydown', ev => { if (ev.key === 'Escape') closePops(); });
}

async function addAttachment(file) {
  try {
    const mediaType = attachmentMediaType(file);
    const isImage = mediaType.startsWith('image/');
    if (isImage && (!state.caps || !state.caps.images)) throw new Error('当前 Agent 不支持图片输入；可以添加文本文件');
    if (state.attachments.length >= 20) throw new Error('每条消息最多 20 件附件');
    if (!file.size) throw new Error('不能添加空文件');
    if (file.size > (isImage ? 10 * 1024 * 1024 : 512 * 1024)) throw new Error(isImage ? '图片每件最多 10MB' : '文本文件每件最多 512KB');
    if (state.attachments.reduce((sum, item) => sum + item.size, file.size) > 20 * 1024 * 1024) throw new Error('每条消息的附件总计最多 20MB');
    const data = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.onerror = () => reject(new Error(`无法读取 ${file.name}`));
      reader.readAsDataURL(file);
    });
    state.attachments.push({ name: file.name, mediaType, data, size: file.size });
    renderAttachmentTray();
  } catch (error) { toast(error.message, true); }
}

function attachmentMediaType(file) {
  const textTypes = { txt: 'text/plain', md: 'text/markdown', json: 'application/json', csv: 'text/csv' };
  const extension = String(file.name || '').split('.').pop().toLowerCase();
  if (textTypes[extension]) return textTypes[extension];
  if (['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(file.type)) return file.type;
  throw new Error('支持 JPG、PNG、GIF、WebP 图片及 txt、md、json、csv 文本文件');
}

function formatBytes(size) {
  return size < 1024 ? `${size} B` : `${Math.ceil(size / 1024)} KB`;
}

function renderAttachmentTray() {
  let tray = document.querySelector('.composer .attach-tray');
  if (!state.attachments.length) { tray && tray.remove(); return; }
  if (!tray) {
    tray = el('div', 'attach-tray');
    $('composer').prepend(tray);
  }
  tray.textContent = '';
  state.attachments.forEach((item, index) => {
    const attachment = el('div', 'attachment-item');
    const isImage = item.mediaType.startsWith('image/');
    attachment.classList.toggle('img', isImage);
    if (isImage) {
      const img = document.createElement('img');
      img.src = `data:${item.mediaType};base64,${item.data}`;
      img.alt = item.name;
      attachment.append(img);
    } else {
      const chip = el('span', 'attachment-file');
      chip.append(icon('file', 12), el('span', null, ` ${item.name} · ${formatBytes(item.size)}`));
      attachment.append(chip);
    }
    const remove = el('button', 'attachment-remove');
    remove.title = `移除 ${item.name}`;
    remove.setAttribute('aria-label', remove.title);
    remove.append(icon('close', 11));
    remove.addEventListener('click', () => { state.attachments.splice(index, 1); renderAttachmentTray(); });
    attachment.append(remove);
    tray.append(attachment);
  });
}

async function sendCurrent() {
  if (state.busy || state.sending) return;
  const input = $('chat-input');
  const text = input.value.trim();
  if (!text && !state.attachments.length) return;
  state.sending = true;
  if (!state.activeSessionId) { await newSession(); if (!state.activeSessionId) { state.sending = false; return; } }
  input.value = '';
  input.style.height = 'auto';
  const attachments = state.attachments.splice(0);
  renderAttachmentTray();
  try {
    await client.send({
      sessionId: state.activeSessionId,
      text,
      attachments: attachments.map(item => ({ name: item.name, mediaType: item.mediaType, data: item.data })),
      // Effort rides on every message so mid-session switches take effect.
      options: { effort: state.caps && state.caps.generationParams.includes('effort') ? state.effort : undefined },
    });
    setBusyState('running');
    state.follow = true; // sending a message re-engages follow mode
  } catch (error) {
    toast(error.message, true);
    input.value = text;
    state.attachments.unshift(...attachments);
    renderAttachmentTray();
  } finally {
    state.sending = false;
  }
}

async function stopCurrent() {
  if (!state.activeSessionId) return;
  try { await client.abort(state.activeSessionId); } catch (error) { toast(error.message, true); }
}

/* ===================== pop menus ===================== */

function closePops() { document.querySelectorAll('.pop').forEach(pop => { pop.hidden = true; }); }
function togglePop(id) {
  const pop = $(id);
  const wasHidden = pop.hidden;
  closePops();
  pop.hidden = !wasHidden;
}

function openModeMenu() {
  if (!state.caps || !state.caps.permissions) { toast('当前 Agent 不支持权限配置', true); return; }
  const pop = $('pop-mode');
  pop.textContent = '';
  for (const [mode, label] of Object.entries(PERMISSION_LABELS)) {
    const item = el('button', 'pop-item' + (state.permissionMode === mode ? ' selected' : ''));
    item.append(el('span', 'grow', label), checkMark());
    item.addEventListener('click', async () => {
      state.permissionMode = mode;
      renderModeLabel();
      closePops();
      if (state.activeSessionId) {
        try { await client.setPermissionMode(state.activeSessionId, mode); } catch (error) { toast(error.message, true); }
      }
    });
    pop.append(item);
  }
  pop.hidden = false;
}

function openEffortMenu() {
  const pop = $('pop-effort');
  pop.textContent = '';
  for (const [level, label] of Object.entries(EFFORT_LABELS)) {
    const item = el('button', 'pop-item' + (state.effort === level ? ' selected' : ''));
    item.append(el('span', 'grow', label), checkMark());
    item.addEventListener('click', () => {
      state.effort = level;
      $('effort-label').textContent = label;
      closePops();
    });
    pop.append(item);
  }
  pop.hidden = false;
}

function renderModeLabel() {
  $('mode-label').textContent = PERMISSION_LABELS[state.permissionMode] || state.permissionMode;
  $('btn-mode').classList.toggle('accent', state.permissionMode === 'bypassPermissions');
}

/* ===================== settings ===================== */

function openSettings(tab) {
  closePops();
  document.querySelectorAll('.stab').forEach(node => node.classList.toggle('active', node.dataset.s === tab));
  document.querySelectorAll('.spanel').forEach(node => node.classList.remove('active'));
  $(`s-${tab}`).classList.add('active');
  $('view-terminal').classList.remove('active');
  $('view-settings').classList.add('active');
}

function wireSettings() {
  $('open-settings').addEventListener('click', () => openSettings('providers'));
  $('settings-back').addEventListener('click', () => {
    $('view-settings').classList.remove('active');
    $('view-terminal').classList.add('active');
  });
  document.querySelectorAll('.stab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.stab').forEach(node => node.classList.remove('active'));
      tab.classList.add('active');
      document.querySelectorAll('.spanel').forEach(node => node.classList.remove('active'));
      $(`s-${tab.dataset.s}`).classList.add('active');
    });
  });
  $('btn-rescan').addEventListener('click', async () => { await refreshAgents(); toast('已重新扫描', false, true); });
  $('mgmt-add').addEventListener('click', () => renderProviderDetail(null));
  wireCaptureSetting();
}

/* ===================== 会话捕获（终端对话是否留档） ===================== */

const CAPTURE_API = '/api/claude-workbench/v1/capture-settings';

function renderCaptureNote(text, bad) {
  const note = $('capture-note');
  if (note) { note.textContent = text || ''; note.style.color = bad ? 'var(--red, #e5695e)' : ''; }
}

async function loadCaptureSetting() {
  const toggle = $('capture-toggle');
  if (!toggle) return;
  try {
    const response = await fetch(CAPTURE_API);
    const body = await response.json();
    toggle.checked = Boolean(body && body.terminalConversations);
    renderCaptureNote(toggle.checked ? '当前开启:新建的终端对话会进入开发对话记录。' : '当前关闭:终端对话不留档。');
  } catch (error) {
    toggle.disabled = true;
    renderCaptureNote(`读取捕获设置失败:${error.message}`, true);
  }
}

async function onCaptureToggle(event) {
  const toggle = event.target;
  const enabled = toggle.checked;
  toggle.disabled = true;
  try {
    const response = await fetch(CAPTURE_API, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ terminalConversations: enabled }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    renderCaptureNote(enabled ? '当前开启:新建的终端对话会进入开发对话记录。' : '当前关闭:终端对话不留档。');
    toast(enabled ? '已开启:此后新建的终端对话会留档' : '已关闭:此后新建的终端对话不留档', false, true);
  } catch (error) {
    toggle.checked = !enabled;
    toast(`保存失败:${error.message}`, true);
  } finally {
    toggle.disabled = false;
  }
}

function wireCaptureSetting() {
  const toggle = $('capture-toggle');
  if (!toggle) return;
  toggle.addEventListener('change', onCaptureToggle);
  loadCaptureSetting();
}

function renderProviderList() {
  const list = $('provider-list');
  if (!list) return;
  list.textContent = '';
  for (const profile of state.profiles) {
    const item = el('button', 'mgmt-item' + (profile.id === state.providerDetailId ? ' active' : ''));
    item.dataset.profile = profile.id;
    const glyph = el('span', null);
    glyph.append(icon('server', 13));
    const name = el('span', 'grow', profile.name);
    const dot = el('span', 'dot' + (profile.enabled && profile.credentialConfigured ? '' : ' off'));
    item.append(glyph, name, dot);
    item.addEventListener('click', () => renderProviderDetail(profile.id));
    list.append(item);
  }
}

let providerDraft = null;

function renderProviderDetail(profileId) {
  state.providerDetailId = profileId || 'new';
  renderProviderList();
  const detail = $('provider-detail');
  detail.textContent = '';
  const profile = state.profiles.find(p => p.id === profileId);
  providerDraft = profile
    ? { ...profile, original: profile, models: JSON.parse(JSON.stringify(profile.models.list || [])) }
    : { id: '', name: '', baseUrl: '', openaiBaseUrl: '', protocol: 'anthropic-compatible', models: [], enabled: true, credentialConfigured: false, credentialMasked: '' };
  // Two explicit slots: baseUrl = Anthropic endpoint, openaiBaseUrl = OpenAI
  // endpoint. The dropdown picks which slot the single visible input edits;
  // either slot alone is enough to save the provider.

  const panel = el('div', 'pd active');
  const head = el('div', 'pd-head');
  head.append(el('h3', null, profile ? providerDraft.name : '添加模型供应商'));
  if (profile) {
    const chip = el('span', 'status-chip' + (profile.enabled ? '' : ' off'), profile.enabled ? '已启用' : '已禁用');
    head.append(chip);
    const toggle = el('button', 'ghost', profile.enabled ? '禁用' : '启用');
    toggle.addEventListener('click', async () => {
      try { await client.saveProfile({ ...profile, enabled: !profile.enabled }); await refreshProfiles(); renderProviderDetail(profileId); } catch (error) { toast(error.message, true); }
    });
    head.append(toggle);
    head.append(el('span', 'sp'));
    const del = el('button', 'del');
    del.title = '删除供应商';
    del.append(icon('trash', 13));
    del.addEventListener('click', async () => {
      if (!confirm(`删除供应商“${profile.name}”?`)) return;
      try { await client.deleteProfile(profile.id); state.providerDetailId = null; await refreshProfiles(); renderProviderDetail(null); } catch (error) { toast(error.message, true); }
    });
    head.append(del);
  }
  panel.append(head);

  const nameField = field('名称', 'text', providerDraft.name, '如:智谱 GLM', value => { providerDraft.name = value; });
  panel.append(nameField);

  const protocolField = el('div', 'f');
  protocolField.append(el('label', null, '接口类型'));
  const protocolSelect = el('select', 'fin');
  for (const [value, label] of [['anthropic-compatible', 'Anthropic 兼容(Claude Code)'], ['openai-compatible', 'OpenAI 兼容(Codex / OpenCode)']]) {
    const option = el('option', null, label);
    option.value = value;
    protocolSelect.append(option);
  }
  protocolSelect.value = providerDraft.protocol === 'openai-compatible' ? 'openai-compatible' : 'anthropic-compatible';
  protocolSelect.setAttribute('aria-label', '接口类型');
  protocolField.append(protocolSelect);
  protocolField.append(el('span', 'field-note', '切换类型即可分别填写两种协议的 Base URL;只填一个也能添加供应商,两种端点共用同一个 API Key。'));
  panel.append(protocolField);

  // One visible input bound to the slot the dropdown selects — switching the
  // dropdown swaps the shown url so each protocol's endpoint is edited in place.
  const baseUrlField = el('div', 'f');
  baseUrlField.append(el('label', null, 'Base URL'));
  const baseUrlInput = el('input', 'fin');
  baseUrlInput.type = 'url';
  baseUrlInput.spellcheck = false;
  baseUrlInput.setAttribute('aria-label', 'Base URL');
  const slotFor = protocol => (protocol === 'openai-compatible' ? 'openaiBaseUrl' : 'baseUrl');
  const syncBaseUrlInput = () => {
    baseUrlInput.value = providerDraft[slotFor(providerDraft.protocol)] || '';
    baseUrlInput.placeholder = providerDraft.protocol === 'openai-compatible'
      ? 'https://api.example.com/v1'
      : 'https://api.example.com/anthropic';
  };
  baseUrlInput.addEventListener('input', () => { providerDraft[slotFor(providerDraft.protocol)] = baseUrlInput.value.trim().replace(/\/+$/, ''); });
  syncBaseUrlInput();
  protocolSelect.addEventListener('change', () => {
    providerDraft.protocol = protocolSelect.value;
    syncBaseUrlInput();
  });
  baseUrlField.append(baseUrlInput);
  baseUrlField.append(el('span', 'field-note', '当前填写的是所选接口类型的端点;另一协议端点留空时,保存会自动探测同域名路径并回填(仅验证过的)。'));
  panel.append(baseUrlField);

  // Escape hatch for providers whose other-protocol endpoint sits on an
  // unguessable path (e.g. Zhipu /api/paas/v4): only when auto-detection
  // could not verify one does this field appear.
  const keyField = el('div', 'f');
  keyField.append(el('label', null, `API Key${providerDraft.credentialConfigured ? `(已配置 ${providerDraft.credentialMasked})` : ''}`));
  const keyRow = el('div', 'key-row');
  const keyInput = el('input', 'fin');
  keyInput.type = 'password';
  keyInput.placeholder = providerDraft.credentialConfigured ? '留空保持不变' : '输入 API Key';
  keyInput.addEventListener('input', () => { providerDraft.credential = keyInput.value; });
  // Finishing the key entry (blur after typing) pulls the models by itself.
  keyInput.addEventListener('change', async () => {
    const added = await autoDetectDraftModels();
    if (added > 0) toast(`已自动填入 ${added} 个模型,保存后即可在聊天中选用`, false, true);
  });
  const eye = el('button', 'eye');
  eye.append(icon('eye', 15));
  eye.addEventListener('click', () => {
    keyInput.type = keyInput.type === 'password' ? 'text' : 'password';
    eye.textContent = '';
    eye.append(icon(keyInput.type === 'password' ? 'eye' : 'eyeOff', 15));
  });
  keyRow.append(keyInput, eye);
  keyField.append(keyRow);
  panel.append(keyField);

  const foot = el('div', 'pd-foot');
  const note = el('span', 'note');
  note.append(icon('info', 13), el('span', null, ` ${profile ? '密钥单独加密存储,不随配置回传。' : '填好 Base URL 与 API Key 后点「添加供应商」,模型会自动检测填入。'}`));
  foot.append(note);
  const errorBox = el('div', 'form-error');
  errorBox.hidden = true;
  const showError = message => { errorBox.textContent = message; errorBox.hidden = false; };
  if (profile) {
    const test = el('button', 'ghost');
    test.append(icon('bolt', 13), el('span', null, '测试'));
    test.addEventListener('click', async () => {
      toast('测试中…');
      try {
        const result = await client.testProfileDraft(buildProfilePayload(), providerDraft.credential || '');
        toast(`测试通过:${result.model || 'ok'} · ${result.durationMs}ms`, false, true);
      } catch (error) { toast(`测试失败:${error.message}`, true); }
    });
    foot.append(test);
  }
  const save = el('button', 'cta', profile ? '保存' : '添加供应商');
  save.addEventListener('click', async () => {
    errorBox.hidden = true;
    save.disabled = true;
    try {
      // The default flow is zero manual models: fill them from the provider
      // right before saving so the saved profile is immediately usable.
      const added = await autoDetectDraftModels();
      if (added > 0) toast(`已自动填入 ${added} 个模型`, false, true);
      const payload = buildProfilePayload();
      const saved = await client.saveProfile(payload);
      if (providerDraft.credential) await client.setCredential(saved.id, providerDraft.credential);
      state.providerDetailId = saved.id;
      if (!state.activeSessionId) { state.currentProfileId = saved.id; state.currentModel = saved.models.default || null; }
      await refreshProfiles();
      renderProviderDetail(saved.id);
      toast('已保存', false, true);
    } catch (error) { showError(error.message); } finally { save.disabled = false; }
  });
  foot.append(save);
  panel.append(foot, errorBox);
  detail.append(panel);
}

function buildProfilePayload() {
  const models = providerDraft.models.filter(entry => entry.id && entry.id.trim());
  const id = providerDraft.id || slugify(providerDraft.name || `provider-${Date.now().toString(36)}`);
  // Two explicit slots pass straight through; the stored protocol is the slot
  // the dropdown last selected — but an empty OpenAI slot must never be stored
  // as openai-compatible, because the server would then derive the OpenAI
  // endpoint from the Anthropic URL.
  const baseUrl = String(providerDraft.baseUrl || '').trim();
  const openaiBaseUrl = String(providerDraft.openaiBaseUrl || '').trim() || inferredOpenaiBaseUrl(baseUrl);
  const protocol = openaiBaseUrl && providerDraft.protocol === 'openai-compatible'
    ? 'openai-compatible'
    : 'anthropic-compatible';
  return {
    ...(providerDraft.original || {}),
    id,
    name: providerDraft.name || id,
    provider: providerDraft.name || id,
    protocol,
    baseUrl,
    openaiBaseUrl,
    enabled: providerDraft.enabled !== false,
    models: {
      ...(providerDraft.original ? providerDraft.original.models : {}),
      default: models.some(m => m.id === (providerDraft.original && providerDraft.original.models.default)) ? providerDraft.original.models.default : models.length ? models[0].id : '',
      list: models.map(m => ({ id: m.id.trim(), openaiId: m.openaiId || m.id.trim().replace(/\[1m\]$/i, ''), label: m.label || m.id.trim(), tags: m.tags || [], ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}) })),
    },
  };
}

function inferredOpenaiBaseUrl(baseUrl) {
  try {
    const url = new URL(baseUrl);
    return ['api.minimaxi.com', 'api.minimax.io'].includes(url.hostname) ? `${url.origin}/v1` : '';
  } catch { return ''; }
}

// Union of manually configured and detected model entries: user-typed ids and
// openaiId mappings survive, detection only enriches with capabilities.
function mergeDetectedModels(existing, detected) {
  const byId = new Map();
  for (const entry of existing) {
    const id = String(entry.id || '').trim();
    if (id) byId.set(id, { tags: [], ...entry, id });
  }
  for (const item of detected) {
    const id = String(item && item.id || '').trim();
    if (!id) continue;
    const current = byId.get(id);
    if (current) {
      if (item.contextWindow && !current.contextWindow) current.contextWindow = item.contextWindow;
      if (Array.isArray(item.tags) && item.tags.length) current.tags = [...new Set([...(current.tags || []), ...item.tags])].slice(0, 8);
      if (!current.label || current.label === id) current.label = item.label || current.label;
    } else {
      byId.set(id, {
        id,
        openaiId: item.openaiId || id.replace(/\[1m\]$/i, ''),
        label: item.label || id,
        tags: Array.isArray(item.tags) ? item.tags.slice(0, 8) : [],
        ...(item.contextWindow ? { contextWindow: item.contextWindow } : {}),
      });
    }
  }
  return [...byId.values()];
}

function contextWindowBadge(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n >= 1000000) return `${+(n / 1000000).toFixed(n % 1000000 ? 1 : 0)}M ctx`;
  if (n >= 1000) return `${Math.round(n / 1000)}K ctx`;
  return `${n} ctx`;
}

// Verified detection probes may fill an endpoint slot the user left empty —
// they show up in the form by switching the protocol dropdown. Filled slots
// are never overwritten and nothing is ever guessed.
function applyDetectedEndpoints(result) {
  if (!result || !result.sources) return;
  const { anthropic, openai } = result.sources;
  if (!providerDraft.baseUrl && anthropic && anthropic.ok && anthropic.baseUrl) {
    providerDraft.baseUrl = String(anthropic.baseUrl).replace(/\/+$/, '');
  }
  if (!providerDraft.openaiBaseUrl && openai && openai.ok && openai.baseUrl) {
    providerDraft.openaiBaseUrl = String(openai.baseUrl).replace(/\/+$/, '');
  }
}

// Zero-click detection: as soon as a key (or a saved credential) meets a base
// URL, the provider's model list fills itself. Runs only while the list is
// empty so curated selections are never churned. Returns the number of added
// models, 0 when there was nothing to do, -1 on failure.
async function autoDetectDraftModels() {
  if (providerDraft.models.some(entry => entry.id && entry.id.trim())) return 0;
  if (!providerDraft.baseUrl && !providerDraft.openaiBaseUrl) return 0;
  if (!providerDraft.credential && !providerDraft.credentialConfigured) return 0;
  try {
    const result = await client.detectProfileModels(buildProfilePayload(), providerDraft.credential || '');
    providerDraft.models = mergeDetectedModels(providerDraft.models, result.models || []);
    applyDetectedEndpoints(result);
    return providerDraft.models.filter(entry => entry.id && entry.id.trim()).length;
  } catch {
    return -1;
  }
}

function field(labelText, type, value, placeholder, onChange) {
  const wrap = el('div', 'f');
  const label = el('label', null, labelText);
  const input = el('input', 'fin');
  input.type = type;
  input.value = value || '';
  input.placeholder = placeholder || '';
  input.spellcheck = false;
  input.setAttribute('aria-label', labelText);
  input.addEventListener('input', () => onChange(input.value));
  wrap.append(label, input);
  return wrap;
}

function slugify(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || `provider-${Date.now().toString(36)}`;
}

/* ===================== project modal ===================== */

function openProjectModal() { $('btn-add-proj').click(); }

function wireProjectModal() {
  const modal = $('modal-add-proj');
  const path = $('np-path');
  const name = $('np-name');
  const confirmBtn = $('np-confirm');
  const errorBox = $('np-error');
  const deriveName = () => {
    const value = path.value.trim();
    const parts = value.split(/[\\/]+/).filter(Boolean);
    if (!name.dataset.touched && parts.length) name.value = parts[parts.length - 1];
    // Only a plausible absolute path (drive letter or UNC/POSIX root) enables
    // confirm; relative fragments surface the server's clearer error instead
    // of a dead-looking click.
    const absolute = /^([a-zA-Z]:[\\/]|\\\\|\/)/.test(value);
    confirmBtn.disabled = !absolute;
  };
  path.addEventListener('input', deriveName);
  name.addEventListener('input', () => { name.dataset.touched = '1'; });

  // The native folder picker IS the add-project flow: one click opens the
  // system dialog and a selection creates the project directly. The manual
  // form only appears as a fallback (picker unsupported / creation failed).
  const openModalPrefilled = (prefillPath, errorMessage) => {
    path.value = prefillPath || '';
    name.dataset.touched = '';
    deriveName();
    errorBox.textContent = errorMessage || '';
    errorBox.hidden = !errorMessage;
    modal.classList.add('open');
    path.focus();
  };

  let pickingProject = false;
  const pickerUrl = () => '/api/claude-workbench/v1/system/pick-folder';
  const addProjectViaPicker = async () => {
    if (pickingProject) return;
    pickingProject = true;
    try {
      let response;
      try {
        response = await fetch(pickerUrl());
      } catch { response = null; }
      if (!response || !response.ok) {
        // Picker unavailable (or transport error): fall back to manual entry.
        openModalPrefilled('', response && response.status !== 501 ? '无法打开文件夹选择器,请手动输入路径' : '');
        return;
      }
      const data = await response.json().catch(() => null);
      const picked = data && data.path;
      if (!picked) return; // user cancelled the native dialog — silent no-op
      const fallbackName = picked.split(/[\\/]+/).filter(Boolean).pop() || '新项目';
      try {
        const project = await client.createProject({ name: fallbackName, rootPath: picked });
        state.expanded.add(project.id);
        state.activeProjectId = project.id;
        await refreshProjects(true);
        toast(`项目“${project.name}”已添加`, false, true);
      } catch (error) {
        openModalPrefilled(picked, error.message);
      }
    } finally {
      pickingProject = false;
    }
  };

  $('btn-add-proj').addEventListener('click', addProjectViaPicker);
  $('hint-add-proj').addEventListener('click', () => $('btn-add-proj').click());
  const browseBtn = $('np-browse');
  if (browseBtn) browseBtn.addEventListener('click', async () => {
    browseBtn.disabled = true;
    try {
      // Direct fetch: the client SDK does not expose the picker endpoint.
      const response = await fetch(pickerUrl());
      if (!response.ok) {
        toast(response.status === 501 ? '当前系统不支持文件夹选择器,请手动输入路径' : '打开文件夹选择器失败', true);
        return;
      }
      const data = await response.json().catch(() => null);
      if (!data || !data.path) { toast('已取消选择'); return; }
      path.value = data.path;
      deriveName(); // fills the project name and enables confirm
      path.focus();
    } catch { toast('打开文件夹选择器失败', true); }
    finally { browseBtn.disabled = false; }
  });
  $('np-cancel').addEventListener('click', () => modal.classList.remove('open'));
  modal.addEventListener('click', ev => { if (ev.target === modal) modal.classList.remove('open'); });
  confirmBtn.addEventListener('click', async () => {
    errorBox.hidden = true;
    try {
      const project = await client.createProject({ name: name.value.trim() || undefined, rootPath: path.value.trim() });
      state.expanded.add(project.id);
      state.activeProjectId = project.id;
      modal.classList.remove('open');
      await refreshProjects(true);
      toast(`项目“${project.name}”已添加`, false, true);
    } catch (error) {
      errorBox.textContent = error.message;
      errorBox.hidden = false;
    }
  });
}

/* ===================== chrome wiring ===================== */

function wireChrome() {
  $('btn-new-session').addEventListener('click', newSession);
  $('stream-col').addEventListener('click', event => {
    const button = event.target.closest && event.target.closest('.cb-copy');
    if (button) {
      const code = button.closest('.codeblock') && button.closest('.codeblock').querySelector('code');
      if (code && navigator.clipboard) {
        navigator.clipboard.writeText(code.textContent).then(() => {
          button.textContent = '已复制';
          setTimeout(() => { button.textContent = '复制'; }, 1500);
        }).catch(() => {});
      }
      return;
    }
    // Tool steps stay closed while running (OpenCode pending-no-expand).
    const trigger = event.target.closest && event.target.closest('.step > summary');
    if (trigger) {
      const step = trigger.closest('.step');
      if (step && !step.classList.contains('done') && !step.open) event.preventDefault();
    }
  });
  const stream = $('stream');
  const jump = $('jump-latest');
  if (stream && stream.addEventListener) {
    stream.addEventListener('scroll', () => {
      const distance = stream.scrollHeight - stream.scrollTop - stream.clientHeight;
      if (distance > 120) state.follow = false;
      else if (distance < 40) state.follow = true;
      if (jump) jump.hidden = state.follow;
    });
  }
  if (jump) {
    jump.addEventListener('click', () => {
      state.follow = true;
      jump.hidden = true;
      if (stream) stream.scrollTop = stream.scrollHeight;
    });
  }
  // Archive section fold: visual-only toggle over the static sidebar markup.
  const archToggle = $('arch-toggle');
  if (archToggle) archToggle.addEventListener('click', () => {
    const archList = $('arch-list');
    const archCaret = $('arch-caret');
    const collapsed = !archList.hidden;
    archList.hidden = collapsed;
    if (archCaret) archCaret.classList.toggle('closed', collapsed);
    archToggle.setAttribute('aria-expanded', String(!collapsed));
  });
}

/* ===================== embed bridge（被外部壳嵌入时受控） =====================
 * 壳 → 终端：{type:'kb:sidebar', visible} 折叠/展开左侧项目栏；
 *   {type:'kb:select-project', project} 按 id/name/rootPath 选中项目；
 *   {type:'kb:list-sessions', project} 列出该项目非归档会话（≤50）；
 *   {type:'kb:open-session', sessionId} 打开指定会话；
 *   {type:'kb:archive-session', sessionId} 归档会话；
 *   {type:'kb:remove-project', project, keepSessions} 移除项目登记（默认保留会话记录）。
 * 终端 → 壳：kb:ready（就绪）/ kb:projects（选择结果与项目清单）/
 *   kb:sessions / kb:session / kb:archived / kb:removed-project（各操作回执）。
 * URL 参数：?embed=1 进入嵌入态（默认折叠项目栏，sidebar=1 保持展开），project= 预选。 */
function embedAllowedOrigin(origin) {
  if (origin === 'null') return true; // file:// 壳
  try {
    const u = new URL(origin);
    return u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
  } catch { return false; }
}
function setEmbedSidebarVisible(visible) {
  document.body.classList.toggle('embed-collapse', !visible);
}
function embedFindProject(ref) {
  const refStr = String(ref || '');
  if (!refStr) return null;
  return state.projects.find(p => p.id === refStr || p.name === refStr || (p.rootPath || '') === refStr) || null;
}
function embedSelectProject(ref) {
  const project = embedFindProject(ref);
  if (!project) return false;
  if (state.activeProjectId !== project.id) {
    detachSession();
    resetStream();
    setBusyState('idle');
    state.activeProjectId = project.id;
    state.currentProfileId = undefined;
    state.currentModel = null;
    state.currentAgent = project.defaultAgentId || 'claude-code';
    $('session-title').textContent = '新会话';
    applyCapabilityGates();
    renderModelLabel();
  }
  state.expanded.add(project.id);
  renderProjectList();
  return true;
}
window.addEventListener('message', async ev => {
  if (!embedAllowedOrigin(ev.origin)) return;
  const data = ev.data;
  if (!data || typeof data !== 'object') return;
  const reply = payload => { if (ev.source) ev.source.postMessage(Object.assign({ app: 'agent-terminal' }, payload), '*'); };
  if (data.type === 'kb:sidebar') setEmbedSidebarVisible(!!data.visible);
  else if (data.type === 'kb:select-project') {
    reply({ type: 'kb:projects', ok: embedSelectProject(data.project), activeProjectId: state.activeProjectId,
      projects: state.projects.map(p => ({ id: p.id, name: p.name, rootPath: p.rootPath })) });
  } else if (data.type === 'kb:list-sessions') {
    const project = embedFindProject(data.project);
    if (!project) { reply({ type: 'kb:sessions', ok: false, project: data.project, sessions: [] }); return; }
    const includeArchived = data.includeArchived === true;
    try {
      // client 的 archived=1 语义是"仅归档"——含归档时合并两段查询
      const sessions = includeArchived
        ? [...(await client.listSessions(project.id)), ...(await client.listSessions(project.id, { archived: true }))]
        : await client.listSessions(project.id);
      const rows = (Array.isArray(sessions) ? sessions : [])
        .filter(s => includeArchived ? true : !s.archived)
        .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
        .slice(0, 50)
        .map(s => ({ sessionId: s.sessionId, title: sessionTitle(s), agentId: s.agentId, updatedAt: s.updatedAt, archived: !!s.archived }));
      // project 字段回显请求方传入的引用（id/name/rootPath）——壳按它发来的键匹配回执
      reply({ type: 'kb:sessions', ok: true, project: String(data.project || project.id), projectId: project.id, includeArchived, sessions: rows });
    } catch (error) { reply({ type: 'kb:sessions', ok: false, error: error.message, sessions: [] }); }
  } else if (data.type === 'kb:open-session') {
    const sessionId = String(data.sessionId || '');
    try { await openSession(sessionId); } catch { /* openSession 内部已 toast */ }
    reply({ type: 'kb:session', ok: state.activeSessionId === sessionId, sessionId });
  } else if (data.type === 'kb:archive-session') {
    const sessionId = String(data.sessionId || '');
    try {
      await client.archiveSession(sessionId);
      if (state.activeSessionId === sessionId) detachSession();
      await renderProjectList();
      reply({ type: 'kb:archived', ok: true, sessionId });
    } catch (error) { reply({ type: 'kb:archived', ok: false, error: error.message }); }
  } else if (data.type === 'kb:restore-session') {
    const sessionId = String(data.sessionId || '');
    try {
      await client.restoreSession(sessionId);
      await renderProjectList();
      reply({ type: 'kb:restored', ok: true, sessionId });
    } catch (error) { reply({ type: 'kb:restored', ok: false, error: error.message }); }
  } else if (data.type === 'kb:remove-project') {
    const project = embedFindProject(data.project);
    if (!project) { reply({ type: 'kb:removed-project', ok: false, error: 'project not found' }); return; }
    try {
      await client.removeProject(project.id, { keepSessions: data.keepSessions !== false });
      if (state.activeProjectId === project.id) detachSession();
      await refreshProjects();
      reply({ type: 'kb:removed-project', ok: true, projectId: project.id, keepSessions: data.keepSessions !== false });
    } catch (error) { reply({ type: 'kb:removed-project', ok: false, error: error.message }); }
  }
});
function embedInit() {
  const q = new URLSearchParams(location.search);
  if (q.get('embed') === '1') {
    setEmbedSidebarVisible(q.get('sidebar') !== '1');
    const preset = q.get('project');
    if (preset) {
      const trySelect = () => { if (!embedSelectProject(preset)) setTimeout(trySelect, 500); };
      setTimeout(trySelect, 0);
    }
  }
  if (window.parent !== window) window.parent.postMessage({ type: 'kb:ready', app: 'agent-terminal' }, '*');
}
embedInit();
// 主区顶栏常驻设置入口（嵌入折叠侧栏后仍可达；与模型弹层内「管理模型」同目标）
const bindTopSettings = () => {
  const btn = $('btn-top-settings');
  if (btn) btn.addEventListener('click', () => openSettings('providers'));
};
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindTopSettings);
else bindTopSettings();

if (client) init();
else document.addEventListener('DOMContentLoaded', () => toast('client SDK 加载失败', true));
