// ui/i18n.js
//
// T10 — minimal zh-CN / en-US translation dictionary + helpers.
// Restored from v4.1.22 I18N content (functional baseline, not code
// structure). Loaded as a plain script before app.js so the IIFE in
// app.js can pick it up via the global `I18N` symbol.

(function () {
  'use strict';
  const DICT = {
    'zh-CN': {
      'app.title': 'Project Knowledge',
      'app.brand.eyebrow': 'AI 知识库',
      'app.brand.title': '控制中心',
      'app.nav.workbench': 'Claude Code',
      'app.nav.badge': '项目',
      'app.action.theme.dark': '深色模式',
      'app.action.theme.light': '浅色模式',
      'app.action.settings': '设置',
      'app.workbench.empty.title': '从项目知识开始对话',
      'app.workbench.empty.hint': '选择左侧项目，输入问题或开发需求。',
      'app.workbench.placeholder': '向 Claude 发送消息…',
      'app.workbench.state.ready': '就绪',
      'app.workbench.state.reconnecting': '正在重连',
      'app.import.title': '导入项目',
      'app.import.help': '导入只建立项目登记、Git 跟踪基线和托管 Hook，不运行初始化分析。下方的所有输入都会触发后端 preflight，导入按钮在所有必填项就绪前保持禁用。',
      'app.import.path.label': '本地路径',
      'app.import.path.placeholder': 'D:\\Projects\\my-project',
      'app.import.path.web.help': '桌面端会调用原生目录选择器；Web 模式请直接输入绝对路径。',
      'app.import.pickFolder': '选择目录…',
      'app.import.language.label': '知识输出语言',
      'app.import.profile.label': 'AI 配置',
      'app.import.profile.help': '由后端解析；不指定则使用默认 / 第一个可用配置。',
      'app.import.team.label': '使用 Team Knowledge（可选）',
      'app.import.team.store': 'Team Store 本地路径',
      'app.import.team.subdir': '子目录',
      'app.import.team.provider': 'Provider',
      'app.import.team.help': '仅当项目需要绑定到共享知识库时填写。',
      'app.import.preflight.ready': '所有前置条件就绪，可以导入。',
      'app.import.preflight.problemsTitle': '导入前需要处理：',
      'app.import.submit': '导入',
      'app.import.reset': '重置',
      'app.import.success': '项目已导入。',
      'app.settings.ai': 'AI 模型',
      'app.settings.knowledge': '知识库存储',
      'app.settings.relations': '知识关联',
      'app.settings.conversation': '开发对话',
      'app.settings.logs': '日志',
      'app.settings.client': '桌面客户端',
      'app.settings.ai.help': '配置模型并为项目分配 Profile。',
      'app.settings.knowledge.rootLabel': '知识库根目录',
      'app.settings.knowledge.save': '保存',
      'app.language.toggle': '界面语言',
    },
    'en-US': {
      'app.title': 'Project Knowledge',
      'app.brand.eyebrow': 'AI Knowledge Base',
      'app.brand.title': 'Control Center',
      'app.nav.workbench': 'Claude Code',
      'app.nav.badge': 'Projects',
      'app.action.theme.dark': 'Dark mode',
      'app.action.theme.light': 'Light mode',
      'app.action.settings': 'Settings',
      'app.workbench.empty.title': 'Start a conversation with project knowledge',
      'app.workbench.empty.hint': 'Pick a project on the left, then ask a question or describe a development need.',
      'app.workbench.placeholder': 'Send a message to Claude…',
      'app.workbench.state.ready': 'Ready',
      'app.workbench.state.reconnecting': 'Reconnecting',
      'app.import.title': 'Import project',
      'app.import.help': 'Import only registers the project, freezes the Git tracking baseline, and installs a managed post-commit hook. No initial AI analysis runs. Every change below triggers a backend preflight, and the Import button stays disabled until every mandatory prerequisite is satisfied.',
      'app.import.path.label': 'Local path',
      'app.import.path.placeholder': 'D:\\Projects\\my-project',
      'app.import.path.web.help': 'Desktop mode uses the native folder picker; in Web mode paste the absolute path.',
      'app.import.pickFolder': 'Pick folder…',
      'app.import.language.label': 'Knowledge output language',
      'app.import.profile.label': 'AI profile',
      'app.import.profile.help': 'Resolved server-side; if unset, the default / first-usable profile is used.',
      'app.import.team.label': 'Bind to a Team Knowledge store (optional)',
      'app.import.team.store': 'Team store local path',
      'app.import.team.subdir': 'Subdirectory',
      'app.import.team.provider': 'Provider',
      'app.import.team.help': 'Fill in only when the project must join a shared knowledge base.',
      'app.import.preflight.ready': 'All prerequisites are satisfied — ready to import.',
      'app.import.preflight.problemsTitle': 'Resolve before importing:',
      'app.import.submit': 'Import',
      'app.import.reset': 'Reset',
      'app.import.success': 'Project imported.',
      'app.settings.ai': 'AI Profiles',
      'app.settings.knowledge': 'Knowledge Store',
      'app.settings.relations': 'Related Knowledge',
      'app.settings.conversation': 'Development Conversation',
      'app.settings.logs': 'Logs',
      'app.settings.client': 'Desktop Client',
      'app.settings.ai.help': 'Configure models and assign a profile per project.',
      'app.settings.knowledge.rootLabel': 'Knowledge root',
      'app.settings.knowledge.save': 'Save',
      'app.language.toggle': 'UI language',
    },
  };

  const STORAGE_KEY = 'pk.uiLanguage';

  function readPersistedLanguage() {
    try {
      const raw = window.localStorage && window.localStorage.getItem(STORAGE_KEY);
      if (raw === 'zh-CN' || raw === 'en-US') return raw;
    } catch {}
    return null;
  }

  function persistLanguage(lang) {
    try {
      if (window.localStorage) window.localStorage.setItem(STORAGE_KEY, lang);
    } catch {}
  }

  function activeLanguage() {
    if (window.__PK_I18N_ACTIVE__) return window.__PK_I18N_ACTIVE__;
    return readPersistedLanguage() || 'zh-CN';
  }

  function t(key, fallback) {
    const lang = activeLanguage();
    const dict = DICT[lang] || DICT['zh-CN'];
    return dict[key] != null ? dict[key] : (fallback != null ? fallback : key);
  }

  function setLanguage(lang) {
    if (!DICT[lang]) lang = 'zh-CN';
    window.__PK_I18N_ACTIVE__ = lang;
    persistLanguage(lang);
    if (typeof document !== 'undefined') {
      document.documentElement.lang = lang === 'en-US' ? 'en' : 'zh-CN';
    }
    if (typeof window.__PK_I18N_ONCHANGE__ === 'function') {
      window.__PK_I18N_ONCHANGE__(lang);
    }
  }

  function availableLanguages() {
    return Object.keys(DICT);
  }

  window.I18N = { t, setLanguage, activeLanguage, availableLanguages };
})();
