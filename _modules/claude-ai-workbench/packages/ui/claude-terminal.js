(function (global, factory) {
  let core = global.ClaudeWorkbenchCore;
  if (!core && typeof require === 'function') {
    try { core = require('@claude-ai-workbench/core'); }
    catch { try { core = require('../core'); } catch {} }
  }
  const exported = factory(core);
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  global.ClaudeWorkbenchPane = exported.ClaudeWorkbenchPane;
})(typeof window !== 'undefined' ? window : globalThis, function (Core) {
  'use strict';

  const COPY = {
    'zh-CN': {
      title: 'Claude Code', connecting: '正在连接', connected: '已连接', reconnecting: '正在重连', offline: '未连接',
      emptyTitle: '开始与 Claude Code 对话', emptyBody: '消息和工具调用只属于当前项目。', noContext: '请先选择项目',
      placeholder: '给 Claude 发送消息…', send: '发送', stop: '停止', default: '默认模式', acceptEdits: '自动接受编辑',
      plan: '计划模式', bypassPermissions: '跳过权限确认', token: '上下文', permission: '需要你的确认', allow: '允许', deny: '拒绝',
      running: '正在执行', done: '已完成', failed: '失败', thinking: '正在思考', unavailable: '终端组件未连接 Core。', attach: '附加图片', commands: '显示斜杠命令',
      commandTitle: 'Claude Code 命令', commandLoading: '正在读取当前环境支持的命令…', commandEmpty: '没有匹配的命令', removeImage: '移除图片', imageOnly: '图片',
      invalidImage: '仅支持 JPEG、PNG、GIF、WebP 图片。', imageTooLarge: '单张图片不能超过 10 MB。', imageTotalTooLarge: '本次图片总大小不能超过 20 MB。', tooManyImages: '一次最多发送 20 张图片。',
    },
    en: {
      title: 'Claude Code', connecting: 'Connecting', connected: 'Connected', reconnecting: 'Reconnecting', offline: 'Offline',
      emptyTitle: 'Start a Claude Code conversation', emptyBody: 'Messages and tool calls stay with this project.', noContext: 'Select a project first',
      placeholder: 'Message Claude…', send: 'Send', stop: 'Stop', default: 'Default Mode', acceptEdits: 'Accept edits',
      plan: 'Plan mode', bypassPermissions: 'Bypass permissions', token: 'Context', permission: 'Your approval is required', allow: 'Allow', deny: 'Deny',
      running: 'Running', done: 'Done', failed: 'Failed', thinking: 'Thinking', unavailable: 'Terminal Core is not connected.', attach: 'Attach image', commands: 'Show slash commands',
      commandTitle: 'Claude Code commands', commandLoading: 'Loading commands supported by this environment…', commandEmpty: 'No matching commands', removeImage: 'Remove image', imageOnly: 'Image',
      invalidImage: 'Only JPEG, PNG, GIF, and WebP images are supported.', imageTooLarge: 'Each image must be 10 MB or smaller.', imageTotalTooLarge: 'Images in one message must total 20 MB or less.', tooManyImages: 'A message can contain at most 20 images.',
    },
  };

  const CSS = `
    :host{display:block;min-width:280px;height:100%;color:var(--caw-text,#172231);font:13px/1.55 Inter,"Segoe UI",system-ui,sans-serif}
    *{box-sizing:border-box}button,textarea,select{font:inherit;color:inherit}button{cursor:pointer}
    .terminal{height:100%;min-height:420px;display:grid;grid-template-rows:auto minmax(0,1fr) auto;background:var(--caw-panel,#fff);border:1px solid var(--caw-line,#d7dfe8);border-radius:12px;overflow:hidden;box-shadow:0 10px 34px rgba(24,34,48,.08)}
    .bar{height:46px;padding:0 13px;display:flex;align-items:center;justify-content:space-between;gap:12px;border-bottom:1px solid var(--caw-line,#d7dfe8);background:var(--caw-panel,#fff)}
    .identity,.status{display:flex;align-items:center;min-width:0}.identity{gap:9px;font-weight:650}.status{gap:6px;color:var(--caw-muted,#687789);font-size:11px;white-space:nowrap}
    .dot{width:8px;height:8px;border-radius:50%;background:var(--caw-muted,#687789);box-shadow:0 0 0 3px color-mix(in srgb,var(--caw-muted,#687789) 14%,transparent)}
    .dot.connected{background:var(--caw-good,#2f7d64)}.dot.connecting,.dot.reconnecting,.dot.running{background:var(--caw-warn,#9a7428)}.dot.error{background:var(--caw-bad,#af4b4b)}
    .profile{max-width:156px;overflow:hidden;text-overflow:ellipsis;padding:2px 7px;border:1px solid var(--caw-line,#d7dfe8);border-radius:999px;background:var(--caw-panel-2,#f6f8fb);color:var(--caw-muted,#687789)}
    .messages{min-height:0;overflow:auto;padding:15px 14px 22px;background:var(--caw-panel-2,#f6f8fb);scrollbar-width:thin;scrollbar-color:var(--caw-line-strong,#bcc8d5) transparent}
    .empty{height:100%;min-height:210px;display:grid;place-items:center;text-align:center;color:var(--caw-muted,#687789)}.empty strong{display:block;margin-bottom:3px;color:var(--caw-text,#172231);font-size:14px}
    .line{margin:0 0 12px}.line.user{display:flex;justify-content:flex-end}.bubble{max-width:92%;border-radius:10px;padding:8px 10px;overflow-wrap:anywhere}
    .user .bubble{max-width:86%;background:var(--caw-accent,#4f6f8f);color:#fff;border-bottom-right-radius:3px}.assistant .bubble{padding:0 2px;color:var(--caw-text,#172231)}
    .markdown p{margin:0 0 8px}.markdown p:last-child{margin-bottom:0}.markdown h1,.markdown h2,.markdown h3{margin:12px 0 6px;line-height:1.3}.markdown h1{font-size:17px}.markdown h2{font-size:15px}.markdown h3{font-size:14px}.markdown ul{margin:5px 0;padding-left:20px}
    code{font-family:"Cascadia Code",Consolas,monospace;font-size:.92em;background:var(--caw-panel-3,#e8edf3);border-radius:4px;padding:1px 4px}.code{margin:8px 0;padding:9px 10px;overflow:auto;border:1px solid var(--caw-line,#d7dfe8);border-radius:7px;background:var(--caw-panel,#fff);font:12px/1.55 "Cascadia Code",Consolas,monospace;white-space:pre}
    .thinking,.system,.status-line{color:var(--caw-muted,#687789);font-size:12px}.thinking{font-style:italic}.error{padding:8px 10px;border:1px solid color-mix(in srgb,var(--caw-bad,#af4b4b) 28%,transparent);border-radius:8px;background:var(--caw-bad-soft,rgba(175,75,75,.11));color:var(--caw-bad,#af4b4b)}
    details.tool{border:1px solid var(--caw-line,#d7dfe8);border-radius:8px;background:var(--caw-panel,#fff);overflow:hidden}details.tool summary{list-style:none;display:flex;align-items:center;gap:7px;padding:7px 9px;cursor:pointer}details.tool summary::-webkit-details-marker{display:none}.tool-name{font-weight:600}.tool-state{margin-left:auto;color:var(--caw-muted,#687789);font-size:11px}.tool-body{padding:0 9px 9px}.tool-body pre{max-height:220px;margin:5px 0 0;padding:8px;overflow:auto;border-radius:6px;background:var(--caw-panel-2,#f6f8fb);white-space:pre-wrap;font:11px/1.5 "Cascadia Code",Consolas,monospace}
    .permission{padding:10px;border:1px solid color-mix(in srgb,var(--caw-warn,#9a7428) 35%,transparent);border-radius:9px;background:var(--caw-warn-soft,rgba(154,116,40,.12))}.permission-head{display:flex;gap:8px;align-items:baseline}.permission-head strong{font-size:12px}.permission-head span{color:var(--caw-muted,#687789);font:11px "Cascadia Code",Consolas,monospace}.permission-detail{margin-top:5px;color:var(--caw-muted,#687789);font-size:12px;overflow-wrap:anywhere}.permission-actions{display:flex;justify-content:flex-end;gap:7px;margin-top:9px}
    .small{min-width:60px;padding:5px 9px;border:1px solid var(--caw-line-strong,#bcc8d5);border-radius:6px;background:var(--caw-panel,#fff)}.small.primary{border-color:var(--caw-accent,#4f6f8f);background:var(--caw-accent,#4f6f8f);color:#fff}.small:hover{filter:brightness(.97)}
    .composer{position:relative;padding:8px 8px 7px;border-top:1px solid var(--caw-line,#d7dfe8);background:var(--caw-panel-2,#f6f8fb)}.composer.dragging{outline:2px solid var(--caw-accent,#4f6f8f);outline-offset:-3px}.input{display:flex;align-items:flex-end;gap:8px}.input:focus-within textarea{border-color:var(--caw-accent,#4f6f8f);box-shadow:0 0 0 2px var(--caw-accent-soft,rgba(79,111,143,.12))}
    .attachment-input{display:none}.attachment-tray{display:flex;gap:7px;overflow-x:auto;padding:0 0 7px}.attachment{position:relative;flex:0 0 62px;height:52px;border:1px solid var(--caw-line,#d7dfe8);border-radius:7px;overflow:hidden;background:var(--caw-panel,#fff)}.attachment img{width:100%;height:100%;display:block;object-fit:cover}.attachment-remove{position:absolute;right:2px;top:2px;width:18px;height:18px;display:grid;place-items:center;padding:0;border:0;border-radius:50%;background:rgba(20,28,38,.78);color:#fff;font-size:13px;line-height:1}.attachment-name{position:absolute;left:0;right:0;bottom:0;padding:2px 4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:linear-gradient(transparent,rgba(20,28,38,.8));color:#fff;font-size:8px}.image-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(112px,220px));gap:7px;margin-bottom:7px}.image-card{display:block;overflow:hidden;border:1px solid var(--caw-line,#d7dfe8);border-radius:8px;background:var(--caw-panel,#fff)}.image-card img{display:block;width:100%;max-height:260px;object-fit:contain;background:var(--caw-panel-3,#e8edf3)}.image-card span{display:block;padding:4px 7px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--caw-muted,#687789);font-size:9px}.user .image-grid{justify-content:end}.user .image-card{border-color:color-mix(in srgb,var(--caw-accent,#4f6f8f) 55%,white)}
    textarea{width:100%;min-height:34px;max-height:130px;padding:7px 10px;border:1px solid var(--caw-line-strong,#bcc8d5);border-radius:5px;outline:0;resize:none;overflow-y:hidden;background:var(--caw-panel,#fff);font:12px/1.55 "Cascadia Code",Consolas,monospace;transition:border-color .15s,box-shadow .15s}textarea::placeholder{color:var(--caw-muted,#687789)}textarea:disabled{cursor:not-allowed}
    .send{flex:0 0 34px;width:34px;height:34px;display:grid;place-items:center;border:0;border-radius:7px;background:var(--caw-accent,#4f6f8f);color:#fff;font-weight:700}.send.stop{background:var(--caw-bad,#af4b4b)}.send:disabled{opacity:.45;cursor:not-allowed}
    .footer{min-height:28px;margin-top:6px;display:flex;align-items:center;gap:6px;color:var(--caw-muted,#687789);font-size:11px}.tool-button,.pill{height:28px;display:flex;align-items:center;justify-content:center;border:1px solid transparent;border-radius:5px;background:transparent;color:var(--caw-muted,#687789)}.tool-button{position:relative;width:28px;padding:0}.tool-button:hover{background:var(--caw-panel-3,#e8edf3);color:var(--caw-text,#172231)}.pill{gap:6px;padding:0 8px;border-color:var(--caw-line,#d7dfe8);background:var(--caw-panel,#fff);white-space:nowrap}.pill:hover{border-color:var(--caw-line-strong,#bcc8d5)}.mode-dot{width:8px;height:8px;border-radius:50%}.chevron{width:9px;height:9px}.usage{font-family:"Cascadia Code",Consolas,monospace;font-variant-numeric:tabular-nums}.ring{--p:0;width:15px;height:15px;border-radius:50%;background:conic-gradient(var(--caw-good,#2f7d64) calc(var(--p)*1%),color-mix(in srgb,var(--caw-good,#2f7d64) 22%,transparent) 0);position:relative}.ring:after{content:"";position:absolute;inset:3px;border-radius:50%;background:var(--caw-panel,#fff)}.count{position:absolute;right:-4px;top:-5px;min-width:16px;height:16px;padding:0 4px;display:grid;place-items:center;border-radius:999px;background:var(--caw-accent,#4f6f8f);color:#fff;font-size:9px;font-weight:650}
    .popup{position:absolute;left:8px;bottom:42px;z-index:20;width:min(360px,calc(100% - 16px));max-height:min(330px,55vh);overflow:auto;padding:5px;border:1px solid var(--caw-line,#d7dfe8);border-radius:8px;background:var(--caw-panel,#fff);box-shadow:0 14px 38px rgba(24,34,48,.16)}.popup-title,.popup-empty{padding:5px 7px;color:var(--caw-muted,#687789);font-size:10px}.popup-title{text-transform:uppercase;letter-spacing:.06em}.popup-row{width:100%;display:flex;align-items:flex-start;gap:8px;padding:7px;border:0;border-radius:6px;background:transparent;text-align:left}.popup-row:hover,.popup-row.active{background:var(--caw-panel-2,#f6f8fb)}.popup-row .mode-dot{margin-top:5px;flex:none}.popup-copy{display:grid;min-width:0}.popup-copy strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.popup-copy small{color:var(--caw-muted,#687789);font-size:10px}.command-mark{width:20px;height:20px;display:grid;place-items:center;flex:none;border-radius:5px;background:var(--caw-accent,#4f6f8f);color:#fff;font:10px "Cascadia Code",Consolas,monospace}
    @media(max-width:430px){.terminal{border-radius:0;border-left:0;border-right:0}.profile{max-width:105px}.messages{padding-inline:11px}}
  `;

  const MODES = [
    { id: 'default', color: '#94a3b8' }, { id: 'acceptEdits', color: '#22c55e' },
    { id: 'bypassPermissions', color: '#f59e0b' }, { id: 'plan', color: '#a855f7' },
  ];
  const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
  const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
  const MAX_IMAGE_TOTAL_BYTES = 20 * 1024 * 1024;
  const MAX_IMAGES = 20;

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  }
  function json(value) {
    if (value == null || value === '') return '';
    if (typeof value === 'string') return value;
    try { return JSON.stringify(value, null, 2); } catch { return String(value); }
  }
  function markdown(value) {
    const escaped = escapeHtml(value);
    const blocks = [];
    let body = escaped.replace(/```(?:[\w-]+)?\n([\s\S]*?)```/g, (_, code) => {
      blocks.push(`<pre class="code">${code.replace(/\n$/, '')}</pre>`);
      return `\u0000${blocks.length - 1}\u0000`;
    });
    body = body.replace(/^### (.+)$/gm, '<h3>$1</h3>').replace(/^## (.+)$/gm, '<h2>$1</h2>').replace(/^# (.+)$/gm, '<h1>$1</h1>');
    body = body.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`([^`\n]+)`/g, '<code>$1</code>');
    const sections = body.split(/\n{2,}/).map(part => {
      if (/^\u0000\d+\u0000$/.test(part) || /^<h[1-3]>/.test(part)) return part;
      if (/^(?:- .+(?:\n|$))+/.test(part)) return `<ul>${part.split('\n').map(line => `<li>${line.replace(/^- /, '')}</li>`).join('')}</ul>`;
      return `<p>${part.replace(/\n/g, '<br>')}</p>`;
    }).join('');
    return sections.replace(/\u0000(\d+)\u0000/g, (_, index) => blocks[Number(index)] || '');
  }
  function normalizeContext(input) {
    if (!input) return null;
    return { ...input, contextId: input.contextId || input.projectId || '' };
  }
  function safeImageSource(value, mediaType) {
    const source = String(value || '');
    if (/^\/api\//.test(source) || /^https?:\/\//i.test(source)) return source;
    if (/^data:image\/(?:jpeg|png|gif|webp);base64,/i.test(source)) return source;
    if (source && IMAGE_TYPES.has(mediaType)) return `data:${mediaType};base64,${source}`;
    return '';
  }

  class ClaudeWorkbenchPane extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: 'open' });
      this._client = null;
      this._context = null;
      this._locale = 'zh-CN';
      this._draft = '';
      this._attachments = [];
      this._modeMenu = false;
      this._commandMenu = false;
      this._commandIndex = 0;
      this._dragDepth = 0;
      this._renderQueued = false;
      this._controller = null;
      this._ensureController();
    }
    connectedCallback() {
      this._ensureController();
      this.render();
      if (this._controller && this._client) this._controller.setAdapter(this._client);
      if (this._controller && this._context) this._controller.setContext(this._context);
    }
    disconnectedCallback() { if (!this.hasAttribute('preserve-controller')) this.destroy(); }
    set client(value) { this._client = value || null; this._ensureController(); if (this._controller) this._controller.setAdapter(this._client); }
    get client() { return this._client; }
    set adapter(value) { this.client = value; }
    get adapter() { return this._client; }
    set context(value) {
      this._context = normalizeContext(value);
      this._ensureController();
      if (this._controller && this.isConnected) this._controller.setContext(this._context);
      else this.render();
    }
    get context() { return this._context; }
    set locale(value) { this._locale = COPY[value] ? value : (String(value).toLowerCase().startsWith('en') ? 'en' : 'zh-CN'); this.render(); }
    get locale() { return this._locale; }
    get controller() { return this._controller; }
    _ensureController() {
      if (!this._controller && Core) this._controller = Core.createController({ adapter: this._client, onChange: state => this._onState(state) });
      return this._controller;
    }
    async newSession() { return this._run(() => this._controller.newSession()); }
    async restoreSession(id) { return this._run(() => this._controller.restoreSession(id)); }
    focusInput() { const input = this.shadowRoot.querySelector('textarea'); if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); } }
    destroy() { if (this._controller) this._controller.destroy(); this._controller = null; }
    _copy() { return COPY[this._locale] || COPY['zh-CN']; }
    _onState(state) {
      this.dispatchEvent(new CustomEvent('terminal-state-change', { detail: state }));
      this.dispatchEvent(new CustomEvent('workbench-state-change', { detail: state }));
      this.dispatchEvent(new CustomEvent('running-change', { detail: { running: Boolean(state.turnRunning) } }));
      if (!this._renderQueued) {
        this._renderQueued = true;
        queueMicrotask(() => { this._renderQueued = false; if (this.isConnected) this.render(); });
      }
    }
    async _run(action) {
      try { return await action(); }
      catch (error) {
        this.dispatchEvent(new CustomEvent('terminal-error', { detail: error }));
        this.dispatchEvent(new CustomEvent('workbench-error', { detail: error }));
        throw error;
      }
    }
    _status(state) {
      if (state.error) return ['error', this._copy().failed];
      if (state.turnRunning) return ['running', this._copy().running];
      const connection = state.session.connectionState || 'offline';
      return [connection, this._copy()[connection] || connection];
    }
    _modeLabel(mode) { return this._copy()[mode] || mode; }
    _modeColor(mode) { return (MODES.find(item => item.id === mode) || MODES[0]).color; }
    _appendLocalInfo(text, kind = 'status') {
      if (!this._controller) return;
      this._controller.state.lines.push({ id: `local-${Date.now()}`, at: new Date().toISOString(), kind, text });
      this.render();
    }
    _commands(state) {
      const query = this._draft.startsWith('/') ? this._draft.slice(1).trimStart().toLowerCase() : '';
      const commands = Array.isArray(state && state.commands) ? state.commands : [];
      if (!query || /\s/.test(query)) return /\s/.test(query) ? [] : commands;
      return commands.filter(item => {
        const haystack = [item.name, ...(item.aliases || [])].join(' ').toLowerCase();
        return haystack.includes(query);
      });
    }
    _selectCommand(command) {
      this._commandMenu = false;
      const name = command && command.name || String(command || '').replace(/^\//, '');
      const event = new CustomEvent('terminal-command', { bubbles: true, composed: true, cancelable: true, detail: { command: name, commandInfo: command, context: this._context, state: this._controller && this._controller.state } });
      if (!this.dispatchEvent(event)) { this.render(); return; }
      this._draft = `/${name}${command && command.argumentHint ? ' ' : ''}`;
      this.render();
      this.focusInput();
    }
    _reportAttachmentError(message) {
      const error = new Error(message);
      this.dispatchEvent(new CustomEvent('terminal-error', { detail: error }));
      this.dispatchEvent(new CustomEvent('workbench-error', { detail: error }));
      this._appendLocalInfo(message, 'error');
    }
    async _addFiles(fileList) {
      const files = Array.from(fileList || []).filter(Boolean);
      if (!files.length) return;
      if (this._attachments.length + files.length > MAX_IMAGES) return this._reportAttachmentError(this._copy().tooManyImages);
      let total = this._attachments.reduce((sum, item) => sum + Number(item.size || 0), 0);
      for (const file of files) {
        if (!IMAGE_TYPES.has(file.type)) { this._reportAttachmentError(this._copy().invalidImage); continue; }
        if (file.size > MAX_IMAGE_BYTES) { this._reportAttachmentError(this._copy().imageTooLarge); continue; }
        if (total + file.size > MAX_IMAGE_TOTAL_BYTES) { this._reportAttachmentError(this._copy().imageTotalTooLarge); break; }
        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader(); reader.onload = () => resolve(String(reader.result || '')); reader.onerror = () => reject(reader.error || new Error('Unable to read image')); reader.readAsDataURL(file);
        });
        const data = dataUrl.slice(dataUrl.indexOf(',') + 1);
        this._attachments.push({ id: `image-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, name: file.name || this._copy().imageOnly, mediaType: file.type, size: file.size, data, previewUrl: dataUrl });
        total += file.size;
      }
      this.dispatchEvent(new CustomEvent('terminal-attachments-change', { detail: { attachments: this._attachments.map(({ previewUrl, ...item }) => item) } }));
      this.render();
      this.focusInput();
    }
    _removeAttachment(id) {
      this._attachments = this._attachments.filter(item => item.id !== id);
      this.dispatchEvent(new CustomEvent('terminal-attachments-change', { detail: { attachments: this._attachments.map(({ previewUrl, ...item }) => item) } }));
      this.render();
      this.focusInput();
    }
    _openAttachmentPicker() {
      const event = new CustomEvent('terminal-attach-request', { bubbles: true, composed: true, cancelable: true, detail: { context: this._context, addFiles: files => this._addFiles(files) } });
      if (this.dispatchEvent(event)) this.shadowRoot.querySelector('.attachment-input')?.click();
    }
    _line(item, state) {
      const copy = this._copy();
      const imageCards = attachments => `<div class="image-grid">${(attachments || []).map(image => { const source = safeImageSource(image.url || image.data, image.mediaType); return source ? `<a class="image-card" href="${escapeHtml(source)}" target="_blank" rel="noreferrer"><img src="${escapeHtml(source)}" alt="${escapeHtml(image.name || copy.imageOnly)}"><span>${escapeHtml(image.name || copy.imageOnly)}</span></a>` : ''; }).join('')}</div>`;
      if (item.kind === 'user') return `<div class="line user"><div class="bubble">${imageCards(item.attachments)}${item.text ? escapeHtml(item.text) : ''}</div></div>`;
      if (item.kind === 'image') return `<div class="line assistant">${imageCards([item])}</div>`;
      if (item.kind === 'assistant') return item.text ? `<div class="line assistant"><div class="bubble markdown">${markdown(item.text)}</div></div>` : '';
      if (item.kind === 'thinking') return `<div class="line thinking">${escapeHtml(item.text || copy.thinking)}</div>`;
      if (item.kind === 'error') return `<div class="line error">${escapeHtml(item.text)}</div>`;
      if (item.kind === 'system' || item.kind === 'status') return `<div class="line ${item.kind === 'system' ? 'system' : 'status-line'}">${escapeHtml(item.text)}</div>`;
      if (item.kind === 'permission') {
        const active = state.permission && (state.permission.requestId === item.id || state.permission.requestId === item.requestId);
        const detail = item.text || json(item.input);
        return `<div class="line permission"><div class="permission-head"><strong>${escapeHtml(copy.permission)}</strong><span>${escapeHtml(item.name || '')}</span></div>${detail ? `<div class="permission-detail">${escapeHtml(detail)}</div>` : ''}${active ? `<div class="permission-actions"><button class="small" data-action="deny">${copy.deny}</button><button class="small primary" data-action="allow">${copy.allow}</button></div>` : ''}</div>`;
      }
      if (item.kind === 'tool' || item.kind === 'tool-result') {
        const status = item.status === 'error' ? copy.failed : item.status === 'running' ? copy.running : copy.done;
        const input = json(item.input); const result = item.result || item.text || '';
        return `<details class="line tool"><summary><span>›</span><span class="tool-name">${escapeHtml(item.name || item.toolUseId || 'Tool')}</span><span class="tool-state">${escapeHtml(status)}</span></summary><div class="tool-body">${input ? `<pre>${escapeHtml(input)}</pre>` : ''}${result ? `<pre>${escapeHtml(result)}</pre>` : ''}</div></details>`;
      }
      return item.text ? `<div class="line status-line">${escapeHtml(item.text)}</div>` : '';
    }
    render() {
      const copy = this._copy();
      const state = this._controller ? this._controller.state : {
        session: { connectionState: 'offline' }, lines: [], tokenUsage: { used: 0, total: 200000, hasUsage: false },
        permissionMode: 'default', requestPending: false, turnRunning: false, error: copy.unavailable,
      };
      const [statusClass, statusText] = this._status(state);
      const context = this._context || state.context || {};
      const profile = state.session.aiProfileId || context.aiProfileId || '';
      const usage = state.tokenUsage || {};
      const percent = usage.hasUsage && usage.total ? Math.min(100, (usage.used / usage.total) * 100) : 0;
      const mode = state.permissionMode || 'default';
      const commands = this._commands(state);
      if (this._commandIndex >= commands.length) this._commandIndex = 0;
      const imageIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>';
      const commandIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
      const sendIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>';
      const chevron = '<svg class="chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>';
      const modePopup = this._modeMenu ? `<div class="popup mode-popup"><div class="popup-title">Permission mode</div>${MODES.map(item => `<button class="popup-row ${item.id === mode ? 'active' : ''}" data-mode="${item.id}"><i class="mode-dot" style="background:${item.color}"></i><span class="popup-copy"><strong>${escapeHtml(this._modeLabel(item.id))}</strong></span></button>`).join('')}</div>` : '';
      const commandRows = commands.map((item, index) => `<button class="popup-row ${index === this._commandIndex ? 'active' : ''}" data-command-index="${index}"><i class="command-mark">›_</i><span class="popup-copy"><strong>/${escapeHtml(item.name)}${item.argumentHint ? ` ${escapeHtml(item.argumentHint)}` : ''}</strong>${item.description ? `<small>${escapeHtml(item.description)}</small>` : ''}</span></button>`).join('');
      const commandEmpty = state.commandError ? escapeHtml(state.commandError) : (Array.isArray(state.commands) && state.commands.length ? copy.commandEmpty : copy.commandLoading);
      const commandPopup = this._commandMenu ? `<div class="popup command-popup"><div class="popup-title">${escapeHtml(copy.commandTitle)}</div>${commandRows || `<div class="popup-empty">${commandEmpty}</div>`}</div>` : '';
      const disabled = !context.contextId || state.requestPending || Boolean(state.permission);
      const messageHtml = state.lines.length ? state.lines.map(line => this._line(line, state)).join('') : `<div class="empty"><div><strong>${escapeHtml(context.contextId ? copy.emptyTitle : copy.noContext)}</strong>${context.contextId ? `<span>${escapeHtml(copy.emptyBody)}</span>` : ''}</div></div>`;
      const attachmentTray = this._attachments.length ? `<div class="attachment-tray">${this._attachments.map(item => `<div class="attachment" title="${escapeHtml(item.name)}"><img src="${escapeHtml(item.previewUrl)}" alt="${escapeHtml(item.name)}"><span class="attachment-name">${escapeHtml(item.name)}</span><button class="attachment-remove" data-remove-attachment="${escapeHtml(item.id)}" title="${escapeHtml(copy.removeImage)}" aria-label="${escapeHtml(copy.removeImage)}">×</button></div>`).join('')}</div>` : '';
      const commandCount = Array.isArray(state.commands) ? state.commands.length : 0;
      this.shadowRoot.innerHTML = `<style>${CSS}</style><section class="terminal" aria-label="Claude Code terminal"><header class="bar"><div class="identity"><i class="dot ${statusClass}"></i><span>${copy.title}</span></div><div class="status"><span>${escapeHtml(statusText)}</span>${profile ? `<span class="profile" title="${escapeHtml(profile)}">${escapeHtml(profile)}</span>` : ''}</div></header><main class="messages" aria-live="polite">${messageHtml}</main><footer class="composer">${modePopup}${commandPopup}${attachmentTray}<input class="attachment-input" type="file" accept="image/jpeg,image/png,image/gif,image/webp" multiple><div class="input"><textarea rows="1" aria-label="${copy.placeholder}" placeholder="${copy.placeholder}" ${disabled ? 'disabled' : ''}>${escapeHtml(this._draft)}</textarea><button class="send ${state.turnRunning ? 'stop' : ''}" data-action="${state.turnRunning ? 'stop' : 'send'}" aria-label="${state.turnRunning ? copy.stop : copy.send}" ${!state.turnRunning && disabled ? 'disabled' : ''}>${state.turnRunning ? '■' : sendIcon}</button></div><div class="footer"><button class="tool-button" data-action="attach" title="${copy.attach}" aria-label="${copy.attach}">${imageIcon}</button><button class="pill" data-action="mode-menu" title="Permission mode"><i class="mode-dot" style="background:${this._modeColor(mode)}"></i><strong>${escapeHtml(this._modeLabel(mode))}</strong>${chevron}</button><span class="pill usage" title="${usage.used || 0} / ${usage.total || 0} tokens"><i class="ring" style="--p:${percent}"></i>${usage.hasUsage ? `${percent.toFixed(1)}%` : '—'}</span><button class="tool-button" data-action="commands" title="${copy.commands}" aria-label="${copy.commands}">${commandIcon}${commandCount ? `<span class="count">${commandCount}</span>` : ''}</button></div></footer></section>`;
      const messages = this.shadowRoot.querySelector('.messages'); if (messages) messages.scrollTop = messages.scrollHeight;
      const textarea = this.shadowRoot.querySelector('textarea');
      if (textarea) {
        const size = () => { textarea.style.height = 'auto'; const fullHeight = textarea.scrollHeight; textarea.style.height = `${Math.min(130, fullHeight)}px`; textarea.style.overflowY = fullHeight > 130 ? 'auto' : 'hidden'; };
        textarea.addEventListener('input', () => {
          this._draft = textarea.value; size();
          const shouldOpen = this._draft.startsWith('/') && !/\s/.test(this._draft.slice(1));
          if (shouldOpen !== this._commandMenu || shouldOpen) { this._commandMenu = shouldOpen; this._commandIndex = 0; this.render(); this.focusInput(); }
        }); size();
        textarea.addEventListener('paste', event => {
          const images = Array.from(event.clipboardData && event.clipboardData.files || []).filter(file => file.type.startsWith('image/'));
          if (images.length) { event.preventDefault(); this._addFiles(images); }
        });
        textarea.addEventListener('keydown', event => {
          if (this._commandMenu && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) { event.preventDefault(); const count = this._commands(state).length; if (count) { this._commandIndex = (this._commandIndex + (event.key === 'ArrowDown' ? 1 : -1) + count) % count; this.render(); this.focusInput(); } return; }
          if (event.key === 'Escape' && this._commandMenu) { event.preventDefault(); this._commandMenu = false; this.render(); this.focusInput(); return; }
          if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (this._commandMenu && commands.length) this._selectCommand(commands[this._commandIndex]); else this._send(); }
        });
      }
      const fileInput = this.shadowRoot.querySelector('.attachment-input');
      if (fileInput) fileInput.addEventListener('change', () => { this._addFiles(fileInput.files); fileInput.value = ''; });
      const composer = this.shadowRoot.querySelector('.composer');
      if (composer) {
        composer.addEventListener('dragenter', event => { if (event.dataTransfer && Array.from(event.dataTransfer.items || []).some(item => item.kind === 'file')) { event.preventDefault(); this._dragDepth += 1; composer.classList.add('dragging'); } });
        composer.addEventListener('dragover', event => { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'; });
        composer.addEventListener('dragleave', () => { this._dragDepth = Math.max(0, this._dragDepth - 1); if (!this._dragDepth) composer.classList.remove('dragging'); });
        composer.addEventListener('drop', event => { event.preventDefault(); this._dragDepth = 0; composer.classList.remove('dragging'); this._addFiles(Array.from(event.dataTransfer && event.dataTransfer.files || []).filter(file => file.type.startsWith('image/'))); });
      }
      this.shadowRoot.querySelectorAll('[data-action]').forEach(element => element.addEventListener('click', event => {
        const action = event.currentTarget.dataset.action;
        if (action === 'send') this._send();
        else if (action === 'stop') this._run(() => this._controller.abort());
        else if (action === 'allow') this._run(() => this._controller.resolvePermission(true));
        else if (action === 'deny') this._run(() => this._controller.resolvePermission(false));
        else if (action === 'attach') this._openAttachmentPicker();
        else if (action === 'mode-menu') { this._modeMenu = !this._modeMenu; this._commandMenu = false; this.render(); }
        else if (action === 'commands') { this._commandMenu = !this._commandMenu; this._modeMenu = false; this.render(); }
      }));
      this.shadowRoot.querySelectorAll('[data-mode]').forEach(element => element.addEventListener('click', () => { this._modeMenu = false; this._run(() => this._controller.setPermissionMode(element.dataset.mode)); }));
      this.shadowRoot.querySelectorAll('[data-command-index]').forEach(element => element.addEventListener('click', () => this._selectCommand(commands[Number(element.dataset.commandIndex)])));
      this.shadowRoot.querySelectorAll('[data-remove-attachment]').forEach(element => element.addEventListener('click', () => this._removeAttachment(element.dataset.removeAttachment)));
    }
    async _send() {
      const message = this._draft.trim();
      if ((!message && !this._attachments.length) || !this._controller) return;
      const attachments = this._attachments.map(({ previewUrl, ...item }) => item);
      this._draft = '';
      this._attachments = [];
      this._commandMenu = false;
      this.render();
      try { await this._run(() => this._controller.send(message, { attachments })); }
      catch { this._draft = message; this._attachments = attachments.map(item => ({ ...item, previewUrl: `data:${item.mediaType};base64,${item.data}` })); this.render(); }
    }
  }

  if (globalThis.customElements && !customElements.get('claude-workbench-pane')) customElements.define('claude-workbench-pane', ClaudeWorkbenchPane);
  return { ClaudeWorkbenchPane };
});
