(function (global) {
  "use strict";

  if (!global.customElements || !global.HTMLElement) return;

  const escapeHtml = (value) => String(value == null ? "" : value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
  })[character]);
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const eventButton = (event) => event.composedPath().find((node) => node?.matches?.("button")) || null;

  const PRESETS = [
    { id: "anthropic", name: "Anthropic", mark: "A", color: "#a85f3d", baseUrl: "https://api.anthropic.com", model: "claude-sonnet-4-5" },
    { id: "minimax", name: "MiniMax", mark: "M", color: "#6554c0", baseUrl: "https://api.minimaxi.com/anthropic", model: "MiniMax-M3" },
    { id: "glm", name: "智谱 GLM", mark: "G", color: "#2563c4", baseUrl: "https://open.bigmodel.cn/api/anthropic", model: "glm-4.6" },
    { id: "deepseek", name: "DeepSeek", mark: "D", color: "#3158c8", baseUrl: "https://api.deepseek.com/anthropic", model: "deepseek-chat" },
    { id: "custom", name: "自定义", mark: "+", color: "#667085", baseUrl: "", model: "" },
  ];

  function newProfile() {
    const id = `profile-${Date.now().toString(36)}`;
    return {
      id, name: "", provider: "", runtime: "claude-code", protocol: "anthropic-compatible", baseUrl: "",
      credentialRef: `credential:${id}`, credentialConfigured: false, credentialMasked: "",
      models: { default: "", fast: "", reasoning: "", coding: "", largeContext: "" },
      contextWindow: 200000, timeoutMs: 300000, permissionMode: "default",
      systemPrompt: { type: "preset", preset: "claude_code", content: "" }, enabled: true,
    };
  }

  function hostOf(value) {
    try { return new URL(value).hostname; } catch { return value || "未配置地址"; }
  }

  function presetFor(profile) {
    const provider = String(profile?.provider || "").toLowerCase();
    const direct = PRESETS.find((item) => item.id !== "custom" && (provider.includes(item.id) || provider.includes(item.name.toLowerCase())));
    if (direct) return direct;
    const host = hostOf(profile?.baseUrl).toLowerCase();
    if (host.includes("minimax")) return PRESETS[1];
    if (host.includes("bigmodel") || host.includes("zhipu")) return PRESETS[2];
    if (host.includes("deepseek")) return PRESETS[3];
    if (host === "api.anthropic.com") return PRESETS[0];
    return PRESETS[4];
  }

  const common = `
    :host{display:block;min-width:0;color:var(--caw-text,#182230);font:13px/1.45 Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif}
    *{box-sizing:border-box}button,input,select{font:inherit;color:inherit}button{cursor:pointer}.button{height:32px;padding:0 11px;border:1px solid var(--caw-line,#d7dfe8);border-radius:7px;background:var(--caw-panel,#fff);font-size:11px}.button:hover{border-color:var(--caw-line-strong,#c4ced9)}.button.primary{border-color:transparent;background:var(--caw-accent,#4f6f8f);color:#fff}.button:disabled{cursor:not-allowed;opacity:.5}
  `;

  class AiProfileList extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: "open" });
      this._profiles = [];
      this._busy = false;
      this.shadowRoot.addEventListener("click", (event) => this.handleClick(event));
    }

    connectedCallback() { this.render(); }
    set profiles(value) { this._profiles = Array.isArray(value) ? clone(value) : []; this.render(); }
    get profiles() { return clone(this._profiles); }
    set busy(value) { this._busy = Boolean(value); this.render(); }

    render() {
      if (!this.isConnected) return;
      this.shadowRoot.innerHTML = `<style>${common}
        .list{border:1px solid var(--caw-line);border-radius:9px;overflow:hidden;background:var(--caw-panel)}.row{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:12px;padding:11px 12px;border-bottom:1px solid var(--caw-line)}.row:last-child{border-bottom:0}.identity{display:flex;align-items:center;gap:10px;min-width:0}.logo{display:grid;place-items:center;flex:none;width:30px;height:30px;border-radius:8px;color:#fff;font-size:11px;font-weight:800}.copy{min-width:0}.copy strong{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12px}.meta{display:flex;gap:7px;margin-top:3px;color:var(--caw-muted);font-size:9px;white-space:nowrap;overflow:hidden}.meta span{overflow:hidden;text-overflow:ellipsis}.state{display:inline-flex;align-items:center;gap:4px;flex:none;color:var(--caw-muted);font-size:9px}.state.good{color:var(--caw-good)}.dot{width:6px;height:6px;border-radius:50%;background:currentColor}.actions{display:flex;align-items:center;gap:5px}.actions button{height:27px;padding:0 7px;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--caw-muted);font-size:9px}.actions button:hover{border-color:var(--caw-line);background:var(--caw-panel-2);color:var(--caw-text)}.actions .remove:hover{color:var(--caw-bad)}.empty{padding:32px 16px;border:1px dashed var(--caw-line-strong);border-radius:9px;color:var(--caw-muted);text-align:center;font-size:10px}.empty strong{display:block;margin-bottom:4px;color:var(--caw-text);font-size:12px}@media(max-width:520px){.row{grid-template-columns:1fr}.actions{padding-left:40px}.state{display:none}}
      </style>${this._profiles.length ? `<div class="list">${this._profiles.map((profile) => this.row(profile)).join("")}</div>` : '<div class="empty"><strong>暂无模型配置</strong>点击“新增”创建第一个模型。</div>'}`;
    }

    row(profile) {
      const preset = presetFor(profile);
      return `<div class="row"><div class="identity"><span class="logo" style="background:${preset.color}">${escapeHtml(preset.mark)}</span><div class="copy"><strong>${escapeHtml(profile.name || profile.models?.default || "未命名模型")}</strong><div class="meta"><span>${escapeHtml(profile.models?.default || "未配置模型")}</span><span>·</span><span>${escapeHtml(hostOf(profile.baseUrl))}</span></div></div></div><div class="actions"><span class="state ${profile.credentialConfigured ? "good" : ""}"><i class="dot"></i>${profile.credentialConfigured ? "Key 已配置" : "缺少 Key"}</span><button data-action="test" data-id="${escapeHtml(profile.id)}" ${this._busy ? "disabled" : ""}>测试</button><button data-action="edit" data-id="${escapeHtml(profile.id)}" ${this._busy ? "disabled" : ""}>编辑</button><button class="remove" data-action="delete" data-id="${escapeHtml(profile.id)}" ${this._busy ? "disabled" : ""}>删除</button></div></div>`;
    }

    handleClick(event) {
      const button = eventButton(event);
      if (!button?.dataset.action) return;
      const profile = this._profiles.find((item) => item.id === button.dataset.id);
      if (!profile) return;
      this.dispatchEvent(new CustomEvent(`profile-${button.dataset.action}`, {
        bubbles: true, composed: true, detail: { profile: clone(profile), credential: "" },
      }));
    }
  }

  class AiProfileEditor extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: "open" });
      this._profile = newProfile();
      this._credential = "";
      this._editingCredential = true;
      this._presetId = "custom";
      this._status = "";
      this._tone = "";
      this._busy = false;
      this.shadowRoot.addEventListener("click", (event) => this.handleClick(event));
    }

    connectedCallback() { this.render(); }
    set profile(value) {
      this._profile = clone(value || newProfile());
      this._credential = "";
      this._editingCredential = !this._profile.credentialConfigured;
      this._presetId = presetFor(this._profile).id;
      this.render();
    }
    get profile() { this.capture(); return clone(this._profile); }
    set busy(value) { this.setBusy(value); }
    setStatus(message, tone = "") { this._status = String(message || ""); this._tone = tone; this.render(true); }
    setBusy(value, message) { this._busy = Boolean(value); if (message) this._status = message; this.render(true); }

    capture() {
      const form = this.shadowRoot?.querySelector("form");
      if (!form) return;
      const data = new FormData(form);
      const model = String(data.get("model") || "").trim();
      const id = this._profile.id;
      if (this._editingCredential) this._credential = String(data.get("apiKey") || "");
      this._profile = {
        ...this._profile,
        id,
        name: String(data.get("name") || "").trim(),
        provider: String(data.get("provider") || "").trim(),
        baseUrl: String(data.get("baseUrl") || "").trim().replace(/\/+$/, ""),
        credentialRef: this._profile.credentialRef || `credential:${id}`,
        runtime: "claude-code",
        protocol: String(data.get("protocol") || "anthropic-compatible"),
        models: { default: model, fast: model, reasoning: model, coding: model, largeContext: model },
        timeoutMs: Number(data.get("timeoutMs") || 300000),
        contextWindow: 200000,
        permissionMode: "default",
        systemPrompt: { type: "preset", preset: "claude_code", content: "" },
        enabled: true,
      };
    }

    credentialField(profile) {
      if (profile.credentialConfigured && !this._editingCredential) {
        const masked = profile.credentialMasked || "已安全保存";
        return `<input type="text" value="${escapeHtml(masked)}" readonly aria-label="API Key 已保存"><button type="button" class="key-action" data-action="replace-key">更换</button>`;
      }
      return `<input name="apiKey" type="text" autocomplete="off" spellcheck="false" value="${escapeHtml(this._credential)}" placeholder="请输入 API Key" aria-label="API Key">${profile.credentialConfigured ? '<button type="button" class="key-action" data-action="cancel-key">取消更换</button>' : '<span class="key-state">输入可见</span>'}`;
    }

    render(preserve = false) {
      if (!this.isConnected) return;
      if (preserve) this.capture();
      const profile = this._profile;
      const exists = Boolean(profile.name || profile.provider || profile.baseUrl || profile.models?.default);
      this.shadowRoot.innerHTML = `<style>${common}
        .editor{border:1px solid var(--caw-line);border-radius:9px;background:var(--caw-panel);overflow:hidden}.head,.foot{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:11px 13px}.head{border-bottom:1px solid var(--caw-line)}.head strong{font-size:12px}.head span{display:block;margin-top:2px;color:var(--caw-muted);font-size:9px}.body{padding:14px}.presets{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px}.preset{display:flex;align-items:center;gap:6px;height:31px;padding:0 9px;border:1px solid var(--caw-line);border-radius:7px;background:var(--caw-panel-2);font-size:9px}.preset.active{border-color:var(--caw-accent);background:var(--caw-accent-soft)}.mark{display:grid;place-items:center;width:18px;height:18px;border-radius:5px;color:#fff;font-size:8px;font-weight:800}.fields{display:grid;grid-template-columns:1fr 1fr;gap:11px}label{display:grid;gap:5px;min-width:0;color:var(--caw-muted);font-size:9px}label.wide{grid-column:1/-1}input,select{width:100%;height:36px;padding:0 9px;border:1px solid var(--caw-line);border-radius:7px;background:var(--caw-panel-2);outline:0}input[readonly]{color:var(--caw-muted);background:var(--caw-panel)}input:focus,select:focus{border-color:var(--caw-accent);box-shadow:0 0 0 2px var(--caw-accent-soft)}.key{display:flex;gap:6px}.key input{flex:1}.key-state,.key-action{display:grid;place-items:center;flex:none;padding:0 9px;border:1px solid var(--caw-line);border-radius:7px;background:var(--caw-panel);color:var(--caw-muted);font-size:8px}.key-action:hover{border-color:var(--caw-accent);color:var(--caw-text)}details{margin-top:11px;border-top:1px solid var(--caw-line)}summary{padding-top:10px;color:var(--caw-muted);font-size:9px;cursor:pointer}.advanced{padding-top:10px}.foot{border-top:1px solid var(--caw-line)}.feedback{min-width:0;color:var(--caw-muted);font-size:9px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.feedback.good{color:var(--caw-good)}.feedback.bad{color:var(--caw-bad)}.actions{display:flex;gap:6px}@media(max-width:520px){.fields{grid-template-columns:1fr}label.wide{grid-column:auto}.presets{display:grid;grid-template-columns:1fr 1fr}}
      </style><section class="editor"><header class="head"><div><strong>${exists ? "编辑模型" : "新增模型"}</strong><span>测试只验证当前内容，保存后配置才会生效</span></div><button class="button" data-action="cancel">返回</button></header><div class="body"><div class="presets">${PRESETS.map((item) => `<button type="button" class="preset ${item.id === this._presetId ? "active" : ""}" data-preset="${item.id}"><i class="mark" style="background:${item.color}">${escapeHtml(item.mark)}</i>${escapeHtml(item.name)}</button>`).join("")}</div><form><div class="fields"><label>配置名称<input name="name" value="${escapeHtml(profile.name || "")}" placeholder="例如 MiniMax 主配置"></label><label>供应商<input name="provider" value="${escapeHtml(profile.provider || "")}" placeholder="例如 MiniMax"></label><label class="wide">请求地址<input name="baseUrl" value="${escapeHtml(profile.baseUrl || "")}" placeholder="https://api.example.com/anthropic"></label><label class="wide">模型名称<input name="model" value="${escapeHtml(profile.models?.default || "")}" placeholder="例如 MiniMax-M3"></label><label class="wide">API Key<div class="key">${this.credentialField(profile)}</div></label></div><details><summary>高级设置</summary><div class="fields advanced"><label>API 协议<select name="protocol"><option value="anthropic-compatible" ${profile.protocol !== "openai-compatible" ? "selected" : ""}>Anthropic Compatible</option><option value="openai-compatible" ${profile.protocol === "openai-compatible" ? "selected" : ""}>OpenAI Compatible</option></select></label><label>请求超时<input name="timeoutMs" type="number" min="1000" value="${Number(profile.timeoutMs || 300000)}"></label></div></details></form></div><footer class="foot"><span class="feedback ${escapeHtml(this._tone)}">${escapeHtml(this._status)}</span><div class="actions"><button class="button" data-action="test" ${this._busy ? "disabled" : ""}>${this._busy ? "测试中…" : "测试连接"}</button><button class="button primary" data-action="save" ${this._busy ? "disabled" : ""}>保存</button></div></footer></section>`;
    }

    payload() {
      this.capture();
      const profile = this._profile;
      if (!profile.name) throw new Error("请填写配置名称");
      if (!profile.provider) throw new Error("请填写供应商");
      if (!profile.baseUrl) throw new Error("请填写请求地址");
      if (!profile.models.default) throw new Error("请填写模型名称");
      if (!profile.credentialConfigured && !this._credential) throw new Error("请输入 API Key");
      return { profile: clone(profile), credential: this._editingCredential ? this._credential : "" };
    }

    emit(name) {
      try {
        this.dispatchEvent(new CustomEvent(name, { bubbles: true, composed: true, detail: this.payload() }));
      } catch (error) {
        this.setStatus(error.message, "bad");
      }
    }

    handleClick(event) {
      const button = eventButton(event);
      if (!button) return;
      if (button.dataset.action === "cancel") this.dispatchEvent(new CustomEvent("profile-cancel", { bubbles: true, composed: true }));
      if (button.dataset.action === "save") this.emit("profile-save");
      if (button.dataset.action === "test") this.emit("profile-test");
      if (button.dataset.action === "replace-key") {
        this.capture();
        this._editingCredential = true;
        this._credential = "";
        this._status = "";
        this.render();
        this.shadowRoot.querySelector('[name="apiKey"]')?.focus();
      }
      if (button.dataset.action === "cancel-key") {
        this.capture();
        this._editingCredential = false;
        this._credential = "";
        this.render();
      }
      if (button.dataset.preset) {
        this.capture();
        const preset = PRESETS.find((item) => item.id === button.dataset.preset) || PRESETS[4];
        this._presetId = preset.id;
        this._profile.provider = preset.id === "custom" ? "" : preset.name;
        this._profile.name = preset.id === "custom" ? "" : `${preset.name} 配置`;
        this._profile.baseUrl = preset.baseUrl;
        this._profile.models = { default: preset.model, fast: preset.model, reasoning: preset.model, coding: preset.model, largeContext: preset.model };
        this.render();
      }
    }
  }

  class AiProfileSettings extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: "open" });
      this._profiles = [];
      this._view = "list";
      this._draft = null;
      this._status = "";
      this._tone = "";
      this._busy = false;
      this.shadowRoot.addEventListener("click", (event) => {
        if (event.target.closest("[data-add]")) this.openNew();
      });
      this.addEventListener("profile-edit", (event) => {
        event.stopPropagation();
        this.openEditor(event.detail.profile);
      });
      this.addEventListener("profile-cancel", (event) => {
        event.stopPropagation();
        this.closeEditor();
      });
    }

    connectedCallback() { this.render(); }
    set profiles(value) { this._profiles = Array.isArray(value) ? clone(value) : []; this.render(); }
    get profiles() { return clone(this._profiles); }
    setStatus(message, tone = "") {
      this._status = String(message || "");
      this._tone = tone;
      const feedback = this.shadowRoot?.querySelector(".feedback");
      if (feedback) { feedback.textContent = this._status; feedback.className = `feedback ${tone}`; }
      this.shadowRoot?.querySelector("ai-profile-editor")?.setStatus(this._status, tone);
    }
    setBusy(value, message) {
      this._busy = Boolean(value);
      if (message) this._status = message;
      const list = this.shadowRoot?.querySelector("ai-profile-list");
      if (list) list.busy = this._busy;
      this.shadowRoot?.querySelector("ai-profile-editor")?.setBusy(this._busy, message);
    }
    openNew() { this._draft = newProfile(); this._view = "editor"; this._status = ""; this.render(); }
    closeEditor() { this._view = "list"; this._draft = null; this.render(); }
    openEditor(profile) { this._draft = clone(profile); this._view = "editor"; this._status = ""; this.render(); }

    render() {
      if (!this.isConnected) return;
      this.shadowRoot.innerHTML = `<style>${common}.module{width:100%;min-width:0}.bar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:9px}.bar strong{font-size:13px}.feedback{min-width:0;color:var(--caw-muted);font-size:9px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.feedback.good{color:var(--caw-good)}.feedback.bad{color:var(--caw-bad)}.bar-actions{display:flex;align-items:center;gap:9px}</style><section class="module">${this._view === "list" ? `<div class="bar"><strong>AI 模型</strong><div class="bar-actions"><span class="feedback ${escapeHtml(this._tone)}">${escapeHtml(this._status)}</span><button class="button primary" data-add>新增</button></div></div><ai-profile-list></ai-profile-list>` : "<ai-profile-editor></ai-profile-editor>"}</section>`;
      this.bind();
    }

    bind() {
      const list = this.shadowRoot.querySelector("ai-profile-list");
      if (list) {
        list.profiles = this._profiles;
        list.busy = this._busy;
        list.addEventListener("profile-edit", (event) => this.openEditor(event.detail.profile));
      }
      const editor = this.shadowRoot.querySelector("ai-profile-editor");
      if (editor) {
        editor.profile = this._draft;
        editor.setStatus(this._status, this._tone);
        editor.setBusy(this._busy);
      }
    }
  }

  if (!global.customElements.get("ai-profile-list")) global.customElements.define("ai-profile-list", AiProfileList);
  if (!global.customElements.get("ai-profile-editor")) global.customElements.define("ai-profile-editor", AiProfileEditor);
  if (!global.customElements.get("ai-profile-settings")) global.customElements.define("ai-profile-settings", AiProfileSettings);
  global.AiProfileList = AiProfileList;
  global.AiProfileEditor = AiProfileEditor;
  global.AiProfileSettings = AiProfileSettings;
})(typeof window !== "undefined" ? window : globalThis);
