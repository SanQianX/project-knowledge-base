const path = require('path');

const KNOWLEDGE_MODES = new Set(['requestApproval', 'autoApply', 'directWriteKb']);
const PERMISSION_MODES = new Set(['plan', 'default', 'acceptEdits', 'auto', 'bypassPermissions']);

const DEFAULT_HOOK_PROMPT_TEMPLATE = `请根据以下 Git 提交更新当前项目知识库。

项目：{{displayName}} / {{projectSlug}}
知识库路径：{{kbPath}}
源码路径：{{repoPath}}
分支：{{branch}}
提交：{{commitHash}}
标题：{{commitSubject}}
作者：{{commitAuthor}}
日期：{{commitDate}}

变更文件：
{{changedFiles}}

Diff 摘要：
{{diffSummary}}

当前知识库模式：{{knowledgeMode}}
Claude 工具权限模式：{{permissionMode}}

执行边界：
- 只处理当前提交对知识库的影响。
- 只能读取源码项目，不能修改源码项目。
- 只能修改当前项目知识库目录内的内容。
- 不能修改其他项目知识库。
- Bash 只能用于只读检查，不能执行写操作或危险命令。

知识库更新原则：
一、语言要求：知识库内新增或修改的所有文本必须使用中文撰写；类名、函数名、API 端点、配置项、第三方库名称等专有名词可以保留英文原文。
二、上下文要求：如果当前环境提供对话记忆、项目记忆或历史讨论上下文，请结合这些信息理解本次代码变更背后的意图、讨论背景和决策原因；如果没有可用记忆，则基于源码、diff 和现有知识库谨慎更新，不要编造背景。
三、全面性要求：基于本次提交的变更文件及 Diff 摘要，系统性判断是否需要更新新增功能、行为变更、移除项、架构调整、配置变更、数据库迁移、使用方式和注意事项。
四、结构化更新：知识库修改应是增量式的。保留历史信息，同时为本次提交新增可回溯的章节或条目，建议记录提交哈希、日期、作者和关键变更文件。若变更影响 README、API 参考、开发指南或模块说明，请同步更新相关章节。
五、目标导向：更新后的知识库应让未来维护者无需重新翻阅大量代码，也能快速理解本次提交的实质影响，并能够正确使用或适配新代码。
六、证据约束：只记录能从代码、diff、现有知识库或明确上下文中确认的信息；不确定的内容请标注待确认，不要写成事实。
`;

const DEFAULT_INIT_PROMPT_TEMPLATE = `请为以下项目初始化当前项目知识库。

项目：{{displayName}} / {{projectSlug}}
知识库路径：{{kbPath}}
源码路径：{{repoPath}}
分支：{{branch}}
当前提交：{{commitHash}}
远程仓库：{{remoteUrl}}
主要语言：{{primaryLanguage}}
项目标签：{{tags}}

源码文件概览：
{{sourceOverview}}

当前知识库模式：{{knowledgeMode}}
Claude 工具权限模式：{{permissionMode}}

执行边界：
- 这是项目首次导入后的知识库初始化任务，不是某一次提交的增量更新。
- 可以读取源码项目来理解结构、入口、配置、脚本、依赖和重要模块。
- 不能修改源码项目。
- 只能修改当前项目知识库目录内的内容。
- 不能修改其他项目知识库。
- Bash 只能用于只读检查，不能执行写操作或危险命令。

初始化目标：
一、用中文建立一份可直接使用的项目知识库，专有名词可以保留英文。
二、优先更新 README、ARCHITECTURE、modules、changes 等现有知识库结构；如果已有文件存在，请增量补全，不要无意义覆盖。
三、总结项目用途、核心能力、运行方式、目录结构、关键模块、数据流、配置项、外部依赖、重要命令和常见维护任务。
四、识别项目的技术栈、入口文件、构建/测试/发布流程，以及与 Git、Hook、自动化或 AI 模型相关的约束。
五、为后续提交级知识库更新留下清晰结构，让未来维护者能按模块和变更历史继续补充。
六、只写能从源码、配置、README、package/lock 文件、脚本或现有知识库中确认的信息；不确定内容请标注待确认。
`;

const READ_TOOLS = ['Read', 'Grep', 'Glob'];
const WRITE_TOOLS = ['Edit', 'Write', 'MultiEdit'];
const BASH_TOOL = 'Bash';

function normalizeKnowledgeMode(value) {
  return KNOWLEDGE_MODES.has(value) ? value : 'requestApproval';
}

function normalizePermissionMode(value) {
  return PERMISSION_MODES.has(value) ? value : 'default';
}

function normalizeAutomationConfig(input) {
  const src = input && typeof input === 'object' ? input : {};
  const maxQueueSizeRaw = Number(src.maxQueueSize);
  const maxQueueSize = Number.isFinite(maxQueueSizeRaw) && maxQueueSizeRaw > 0
    ? Math.floor(maxQueueSizeRaw)
    : 10;
  return {
    enabled: src.enabled === true,
    postCommitEnabled: src.postCommitEnabled === true,
    knowledgeMode: normalizeKnowledgeMode(src.knowledgeMode),
    allowReadOnlyBash: src.allowReadOnlyBash !== false,
    maxQueueSize,
    hookPromptTemplate: typeof src.hookPromptTemplate === 'string' && src.hookPromptTemplate.trim()
      ? src.hookPromptTemplate
      : DEFAULT_HOOK_PROMPT_TEMPLATE,
    initPromptTemplate: typeof src.initPromptTemplate === 'string' && src.initPromptTemplate.trim()
      ? src.initPromptTemplate
      : DEFAULT_INIT_PROMPT_TEMPLATE,
  };
}

function normalizeClaudeWorkbenchConfig(input) {
  const src = input && typeof input === 'object' ? input : {};
  return {
    permissionMode: normalizePermissionMode(src.permissionMode),
  };
}

function renderTemplate(template, vars) {
  const source = typeof template === 'string' ? template : DEFAULT_HOOK_PROMPT_TEMPLATE;
  const safeVars = vars && typeof vars === 'object' ? vars : {};
  return source.replace(/\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g, (match, name) => {
    if (!Object.prototype.hasOwnProperty.call(safeVars, name)) return match;
    const value = safeVars[name];
    return value == null ? '' : String(value);
  });
}

function normalizePathForCompare(value) {
  if (!value || typeof value !== 'string') return '';
  return path.resolve(value).toLowerCase().replace(/[\\\/]+$/, '');
}

function pathsReferToSameLocation(a, b) {
  const left = normalizePathForCompare(a);
  const right = normalizePathForCompare(b);
  return !!left && !!right && left === right;
}

function isInsidePath(root, target) {
  if (!root || !target) return false;
  const rootAbs = path.resolve(root);
  const targetAbs = path.resolve(rootAbs, target);
  const rel = path.relative(rootAbs, targetAbs);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

function commandText(input) {
  if (typeof input === 'string') return input;
  if (input && typeof input === 'object') {
    return String(input.command || input.cmd || input.script || '');
  }
  return '';
}

function isReadOnlyBashCommand(input) {
  const command = commandText(input).trim();
  if (!command) return false;
  const lowered = command.toLowerCase();
  const denied = [
    ' rm ', 'del ', 'rmdir ', 'remove-item', ' mv ', 'move ', 'ren ', 'rename-item',
    'copy ', ' cp ', 'set-content', 'add-content', 'out-file', 'new-item',
    'git reset', 'git checkout', 'git clean', 'git commit', 'git push',
    'npm install', 'pnpm install', 'yarn add', 'pip install',
    '>', '>>', '| set-content', '| out-file',
  ];
  const padded = ` ${lowered}`;
  if (denied.some(token => padded.includes(token))) return false;
  const allowedPrefixes = [
    'git status', 'git log', 'git show', 'git diff',
    'ls', 'dir', 'get-childitem',
    'type', 'get-content',
    'findstr', 'select-string',
  ];
  return allowedPrefixes.some(prefix => lowered === prefix || lowered.startsWith(prefix + ' '));
}

function extractToolPaths(toolName, input) {
  if (!input || typeof input !== 'object') return [];
  const candidates = [];
  for (const key of ['file_path', 'path', 'notebook_path']) {
    if (typeof input[key] === 'string') candidates.push(input[key]);
  }
  if (toolName === 'MultiEdit' && Array.isArray(input.edits) && typeof input.file_path === 'string') {
    candidates.push(input.file_path);
  }
  return candidates;
}

function buildAutomationToolPolicy({ automation, kbPath }) {
  const cfg = normalizeAutomationConfig(automation);
  const canWriteKb = cfg.knowledgeMode === 'autoApply' || cfg.knowledgeMode === 'directWriteKb';
  const allowedTools = [...READ_TOOLS];
  if (canWriteKb) allowedTools.push(...WRITE_TOOLS);
  if (cfg.allowReadOnlyBash) allowedTools.push(BASH_TOOL);

  return {
    kind: 'kb-automation',
    kbPath,
    knowledgeMode: cfg.knowledgeMode,
    allowReadOnlyBash: cfg.allowReadOnlyBash,
    allowedTools,
    canWriteKb,
  };
}

function evaluateAutomationToolUse(policy, toolName, input) {
  if (!policy || policy.kind !== 'kb-automation') {
    return { behavior: 'ask', reason: 'no automation policy' };
  }
  if (!policy.allowedTools.includes(toolName)) {
    return { behavior: 'deny', reason: `tool is not allowed: ${toolName}` };
  }
  if (READ_TOOLS.includes(toolName)) {
    return { behavior: 'allow', reason: 'read tool allowed' };
  }
  if (toolName === BASH_TOOL) {
    if (!policy.allowReadOnlyBash) return { behavior: 'deny', reason: 'bash disabled' };
    return isReadOnlyBashCommand(input)
      ? { behavior: 'allow', reason: 'read-only bash command allowed' }
      : { behavior: 'deny', reason: 'bash command is not read-only allowlisted' };
  }
  if (WRITE_TOOLS.includes(toolName)) {
    if (!policy.canWriteKb) return { behavior: 'deny', reason: 'knowledge mode is read-only' };
    const paths = extractToolPaths(toolName, input);
    if (!paths.length) return { behavior: 'deny', reason: 'write tool has no file path' };
    for (const p of paths) {
      if (!isInsidePath(policy.kbPath, p)) {
        return { behavior: 'deny', reason: `write path outside current KB: ${p}` };
      }
    }
    return { behavior: 'allow', reason: 'write path is inside current KB' };
  }
  return { behavior: 'deny', reason: `unhandled tool: ${toolName}` };
}

module.exports = {
  KNOWLEDGE_MODES,
  PERMISSION_MODES,
  DEFAULT_HOOK_PROMPT_TEMPLATE,
  DEFAULT_INIT_PROMPT_TEMPLATE,
  normalizeKnowledgeMode,
  normalizePermissionMode,
  normalizeAutomationConfig,
  normalizeClaudeWorkbenchConfig,
  renderTemplate,
  normalizePathForCompare,
  pathsReferToSameLocation,
  isInsidePath,
  isReadOnlyBashCommand,
  buildAutomationToolPolicy,
  evaluateAutomationToolUse,
};
