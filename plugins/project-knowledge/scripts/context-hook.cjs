#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const DATA_SCHEMA = 'project-knowledge/runtime-control/v1';
const normalize = value => path.resolve(value).replace(/\\/g, '/').replace(/\/$/, '')[process.platform === 'win32' ? 'toLowerCase' : 'toString']();
const clientFrom = argv => argv[argv.indexOf('--client') + 1] || 'claude';

async function boundedJson(response) {
  const reader = response.body.getReader(); let bytes = 0; const parts = [];
  try {
    while (true) { const next = await reader.read(); if (next.done) break; bytes += next.value.length; if (bytes > 131072) { await reader.cancel(); throw new Error('CONTEXT_INVALID_RESPONSE'); } parts.push(Buffer.from(next.value)); }
    const value = JSON.parse(Buffer.concat(parts).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('CONTEXT_INVALID_RESPONSE');
    return value;
  } finally { reader.releaseLock(); }
}

function log(dataDir, event, input) {
  // Only metadata: never log the prompt, context body, headers or CLI environment.
  const projectId = /^project-[A-Za-z0-9._-]+$/.test(input.projectId || '') ? input.projectId : '';
  const record = { schema: 'log/v2', id: `log-${crypto.randomUUID()}`, ts: new Date().toISOString(), level: input.code ? 'warn' : 'info', component: 'agent-context', event, message: input.code ? '开发前知识读取未完成，已提示后继续。' : '知识上下文已输出给客户端；模型实际送达需原生运行证据。', projectId, operationId: input.requestId, phase: 'context', context: { client: input.client, code: input.code || null, status: input.status, factCount: input.factCount, memoryCount: input.memoryCount, durationMs: input.durationMs } };
  try { const directory = path.join(dataDir, 'logs', projectId ? 'projects' : 'system', ...(projectId ? [projectId] : [])); fs.mkdirSync(directory, { recursive: true }); const now = new Date(), date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`; fs.appendFileSync(path.join(directory, `${date}.jsonl`), JSON.stringify(record) + '\n', { encoding: 'utf8', mode: 0o600 }); } catch { /* Diagnostic disk failures must not block the IDE. */ }
}

async function run(payload, { env = process.env, argv = process.argv.slice(2), fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  if (env.KB_KNOWLEDGE_CONTEXT === '0' || !payload || payload.hook_event_name !== 'UserPromptSubmit') return {};
  const client = clientFrom(argv), requestId = `context-${crypto.randomUUID()}`, started = Date.now();
  const dataDir = path.resolve(env.KB_DATA_DIR || path.join(os.homedir(), '.project-knowledge-v5'));
  if (typeof payload.cwd !== 'string' || !path.isAbsolute(payload.cwd) || typeof payload.prompt !== 'string' || !payload.prompt.trim() || payload.prompt.length > 131072) return {};
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
  let result;
  try {
    const endpoint = JSON.parse(fs.readFileSync(path.join(dataDir, 'runtime-endpoint.json'), 'utf8'));
    if (endpoint.schema !== 'project-knowledge/runtime-endpoint/v1' || !Number.isInteger(endpoint.pid) || endpoint.pid <= 0 || !Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535 || !['127.0.0.1', 'localhost', '::1'].includes(endpoint.host)) throw new Error('CONTEXT_IDENTITY_MISMATCH');
    const base = new URL(`http://${endpoint.host === '::1' ? '[::1]' : endpoint.host}:${endpoint.port}`);
    const options = { redirect: 'error', signal: controller.signal };
    const identityResponse = await fetchImpl(new URL('/api/runtime/identity', base), options);
    const identity = await boundedJson(identityResponse);
    if (!identityResponse.ok || identity.schema !== DATA_SCHEMA || identity.name !== 'project-knowledge' || identity.pid !== endpoint.pid || identity.port !== endpoint.port || identity.startedAt !== endpoint.startedAt || typeof identity.dataDir !== 'string' || normalize(identity.dataDir) !== normalize(dataDir)) throw new Error('CONTEXT_IDENTITY_MISMATCH');
    const response = await fetchImpl(new URL('/api/engine/context', base), { ...options, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repoPath: payload.cwd, query: payload.prompt, client, sessionId: payload.session_id, turnId: payload.turn_id, requestId }) });
    result = await boundedJson(response);
    const code = typeof result.error === 'string' ? result.error : result.error?.code;
    if (response.status === 404 && code === 'PROJECT_NOT_FOUND') {
      log(dataDir, 'agent.context.skipped', { requestId, client, code, status: 'unregistered', durationMs: Date.now() - started });
      const message = '未识别到当前代码目录在运行中知识库的登记，本次未注入知识；这不代表知识库为空。已导入的项目请检查代码目录与引擎接线。';
      return { systemMessage: message, hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: message } };
    }
    if (!response.ok || result.ok !== true) throw new Error(/^[A-Z][A-Z0-9_]{0,79}$/.test(code || '') ? code : 'CONTEXT_UNAVAILABLE');
    if (result.requestId !== requestId || !Array.isArray(result.references) || !Array.isArray(result.memories) || !Array.isArray(result.facts) || typeof result.prompt !== 'string' || result.prompt.length > 8000 || !['ready', 'empty', 'file-fallback'].includes(result.status)) throw new Error('CONTEXT_INVALID_RESPONSE');
    const note = result.status === 'file-fallback' ? '知识向量检索暂不可用，本次使用当前文件事实。' : result.status === 'empty' ? '已查询当前知识范围，没有匹配知识或适用的已确认记忆。' : '';
    const warning = result.memoryStatus === 'pending' ? '部分已确认记忆文件待同步，本次未注入失效内容。' : '';
    const output = { ...(note || warning ? { systemMessage: [note, warning].filter(Boolean).join(' ') } : {}), hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: result.prompt || note } };
    Object.defineProperty(output, 'receipt', { value: { dataDir, requestId, client, projectId: result.projectId, status: result.status, factCount: result.facts.length, memoryCount: result.memories.length, durationMs: Date.now() - started } });
    return output;
  } catch (error) {
    const code = controller.signal.aborted ? 'CONTEXT_TIMEOUT' : /^[A-Z][A-Z0-9_]{0,79}$/.test(error.message || '') ? error.message : 'CONTEXT_UNAVAILABLE';
    log(dataDir, 'agent.context.failed', { requestId, client, projectId: result?.projectId, code, durationMs: Date.now() - started });
    const message = `知识库读取未完成（${code}），可继续开发；不要把本次失败当作没有相关知识。可在知识库系统状态查看日志。`;
    return { systemMessage: message, hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: message } };
  } finally { clearTimeout(timer); }
}

async function main() {
  process.stdin.setEncoding('utf8');
  let input = '', oversized = false;
  for await (const part of process.stdin) { if (input.length + part.length > 196608) oversized = true; else if (!oversized) input += part; }
  let payload; try { if (!oversized) payload = JSON.parse(input); } catch {}
  const result = await run(payload);
  await writeOutput(result);
}
async function writeOutput(result, writer = process.stdout) {
  await new Promise((resolve, reject) => writer.write(JSON.stringify(result) + '\n', error => error ? reject(error) : resolve()));
  if (result.receipt) log(result.receipt.dataDir, 'agent.context.output', result.receipt);
}
if (require.main === module) main().catch(() => { process.stdout.write('{}\n'); process.exitCode = 0; });
module.exports = { run, boundedJson, writeOutput };
