const path = require('path');

const PERMISSION_MODES = new Set(['plan', 'default', 'acceptEdits', 'auto', 'bypassPermissions']);

const DEFAULT_HOOK_PROMPT_TEMPLATE = `请根据以下单个 Git 提交直接更新当前项目知识库。
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

Claude 工具权限模式：{{permissionMode}}

执行边界：
- 只分析并处理上面这一个提交，不要扫描或合并其他提交。
- 源码项目只读，不得修改源码。
- 直接增量更新当前项目知识库，不创建草稿，不等待人工审核。
- 不得修改其他项目知识库。
- Bash 只用于只读检查，不得执行写操作或危险命令。
- 知识库新增或修改的内容使用中文，代码标识符和专有名词可保留英文。
- 只记录能从源码、diff、现有知识库或明确上下文确认的信息。`;

const DEFAULT_INIT_PROMPT_TEMPLATE = `请为以下项目直接初始化知识库。
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

Claude 工具权限模式：{{permissionMode}}

执行边界：
- 源码项目只读，不得修改源码。
- 直接写入当前项目知识库，不创建草稿，不等待人工审核。
- 不得修改其他项目知识库。
- Bash 只用于只读检查，不得执行写操作或危险命令。
- 使用中文编写知识库，代码标识符和专有名词可保留英文。
- 只写入能够从源码、配置、README、依赖清单或现有知识库确认的信息。`;

const READ_TOOLS = ['Read', 'Grep', 'Glob'];
const WRITE_TOOLS = ['Edit', 'Write', 'MultiEdit'];
const BASH_TOOL = 'Bash';

function normalizePermissionMode(value) {
  return PERMISSION_MODES.has(value) ? value : 'default';
}

function normalizeAutomationConfig(input) {
  const src = input && typeof input === 'object' ? input : {};
  return {
    enabled: src.enabled === true,
    postCommitEnabled: src.postCommitEnabled === true,
    allowReadOnlyBash: src.allowReadOnlyBash !== false,
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
  const allowedTools = [...READ_TOOLS, ...WRITE_TOOLS];
  if (cfg.allowReadOnlyBash) allowedTools.push(BASH_TOOL);
  return {
    kind: 'kb-automation',
    kbPath,
    allowReadOnlyBash: cfg.allowReadOnlyBash,
    allowedTools,
    canWriteKb: true,
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
    const paths = extractToolPaths(toolName, input);
    if (!paths.length) return { behavior: 'deny', reason: 'write tool has no file path' };
    for (const filePath of paths) {
      if (!isInsidePath(policy.kbPath, filePath)) {
        return { behavior: 'deny', reason: `write path outside current KB: ${filePath}` };
      }
      if (path.basename(String(filePath)).toLowerCase() === '00-index.md') {
        return { behavior: 'deny', reason: '00-index.md is generated by the system and cannot be edited by AI' };
      }
    }
    return { behavior: 'allow', reason: 'write path is inside current KB' };
  }
  return { behavior: 'deny', reason: `unhandled tool: ${toolName}` };
}

module.exports = {
  PERMISSION_MODES,
  DEFAULT_HOOK_PROMPT_TEMPLATE,
  DEFAULT_INIT_PROMPT_TEMPLATE,
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
