// Local MCP launcher for @sanqianx/project-knowledge.
// Zero-dependency: resolves only through the durable integration-runtime
// binding, pins the product package constant, joins the plugin-declared
// version into the agreement, enforces realpath containment for the entry,
// and spawns the package bin entry with the current Node runtime. No
// network, no npx, no cwd guessing, no fallbacks, no untrusted echo.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const PKG_NAME = '@sanqianx/project-knowledge';
const RUNTIME_SCHEMA = 'project-knowledge/integration-runtime/v1';
const ERROR_SCHEMA = 'project-knowledge/mcp-launcher-error/v1';
const BINDING_MAX_BYTES = 32768;
const MESSAGES = {
  BINDING_MISSING: '未找到本地 MCP 运行时绑定；请先在产品内完成知识接入。',
  BINDING_CORRUPT: '本地运行时绑定不可读或超出大小限制，已拒绝加载。',
  BINDING_SCHEMA_MISMATCH: '运行时绑定架构不匹配，已拒绝加载。',
  BINDING_PACKAGE_MISMATCH: '运行时绑定不是本产品包，已拒绝加载。',
  BINDING_VERSION_MISMATCH: '绑定、插件声明与安装包版本不一致，已拒绝加载。',
  BINDING_INVALID_ROOT: '运行时绑定的包根不可用，已拒绝加载。',
  BINDING_ENTRY_MISSING: '绑定的 MCP 入口文件不存在，已拒绝加载。',
  BINDING_ENTRY_INVALID: '绑定的 MCP 入口越界或不是普通文件，已拒绝加载。',
  LAUNCH_FAILED: '本地 MCP 服务进程启动失败。',
};

function fail(code) {
  process.stderr.write(JSON.stringify({ schema: ERROR_SCHEMA, code, message: MESSAGES[code] || '本地 MCP 启动器拒绝启动。' }) + '\n');
  process.exit(1);
}

function bindingPath() {
  return path.join(process.env.KB_DATA_DIR || path.join(os.homedir(), '.project-knowledge-v5'), 'integration-runtime.json');
}

function loadBinding() {
  const file = bindingPath();
  let stat = null;
  try { stat = fs.statSync(file); } catch (error) { fail('BINDING_MISSING'); }
  if (!stat.isFile() || stat.size > BINDING_MAX_BYTES) fail('BINDING_CORRUPT');
  let raw = '';
  try { raw = fs.readFileSync(file); } catch (error) { fail('BINDING_CORRUPT'); }
  let binding = null;
  try { binding = JSON.parse(raw); } catch (error) { fail('BINDING_CORRUPT'); }
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) fail('BINDING_CORRUPT');
  return binding;
}

const binding = loadBinding();
if (binding.schema !== RUNTIME_SCHEMA) fail('BINDING_SCHEMA_MISMATCH');
if (binding.packageName !== PKG_NAME) fail('BINDING_PACKAGE_MISMATCH');
if (typeof binding.packageRoot !== 'string' || !path.isAbsolute(binding.packageRoot)) fail('BINDING_INVALID_ROOT');
if (typeof binding.version !== 'string' || !binding.version) fail('BINDING_VERSION_MISMATCH');

let manifest = null;
try { manifest = JSON.parse(fs.readFileSync(path.join(binding.packageRoot, 'package.json'), 'utf8')); } catch (error) { fail('BINDING_PACKAGE_MISMATCH'); }
if (!manifest || typeof manifest !== 'object' || manifest.name !== PKG_NAME) fail('BINDING_PACKAGE_MISMATCH');
if (manifest.version !== binding.version) fail('BINDING_VERSION_MISMATCH');
if (process.env.KB_PLUGIN_VERSION && process.env.KB_PLUGIN_VERSION !== binding.version) fail('BINDING_VERSION_MISMATCH');

const bin = manifest.bin && typeof manifest.bin === 'object' && !Array.isArray(manifest.bin) ? manifest.bin['project-knowledge-mcp'] : manifest.bin;
if (typeof bin !== 'string' || !bin) fail('BINDING_ENTRY_MISSING');

let rootReal = '';
let entryReal = '';
try {
  rootReal = fs.realpathSync(binding.packageRoot);
  entryReal = fs.realpathSync(path.resolve(binding.packageRoot, bin));
} catch (error) { fail('BINDING_ENTRY_MISSING'); }
const relative = path.relative(rootReal, entryReal);
if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) fail('BINDING_ENTRY_INVALID');
try { if (!fs.statSync(entryReal).isFile()) fail('BINDING_ENTRY_INVALID'); } catch (error) { fail('BINDING_ENTRY_MISSING'); }

const child = spawn(process.execPath, [entryReal], { stdio: 'inherit', env: process.env, windowsHide: true });
child.on('error', error => fail('LAUNCH_FAILED'));
child.on('close', code => process.exit(code == null ? 1 : code));
