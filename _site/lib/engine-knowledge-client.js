'use strict';
const { DomainError } = require('./contracts');
const endpoint = require('./runtime-endpoint');
const control = require('./runtime-control');

class EngineKnowledgeClient {
  constructor({ layout, engineUrl, fetchImpl = fetch, timeoutMs = 20000 }) {
    this.layout = layout;
    this.engineUrl = engineUrl || process.env.KB_KNOWLEDGE_ENGINE_URL;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async json(url, options = {}) {
    let response;
    try { response = await this.fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs) }); }
    catch { throw new DomainError('ENGINE_UNAVAILABLE', '知识引擎连接失败或超时，请在系统状态中检查服务。', { status: 503 }); }
    let payload;
    try {
      const reader = response.body.getReader();
      const chunks = []; let size = 0;
      try {
        while (true) {
          const part = await reader.read(); if (part.done) break;
          size += part.value.byteLength;
          if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new Error('response limit'); }
          chunks.push(Buffer.from(part.value));
        }
      } finally { reader.releaseLock(); }
      payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('invalid envelope');
    } catch { throw new DomainError('ENGINE_INVALID_RESPONSE', '知识引擎返回了无效响应。', { status: 502 }); }
    if (!response.ok || payload.ok === false) {
      const code = /^[A-Z][A-Z0-9_]{0,79}$/.test(payload.error?.code || '') ? payload.error.code : 'ENGINE_REQUEST_FAILED';
      throw new DomainError(code, '知识引擎未完成读取，请检查项目接线或请求参数。', { status: response.ok ? 502 : response.status });
    }
    return payload;
  }

  async target(project) {
    if (this.engineUrl) {
      let url; try { url = new URL(this.engineUrl); } catch {}
      if (!url || !['http:', 'https:'].includes(url.protocol) || !endpoint.isLoopbackHost(url.hostname.replace(/^\[|\]$/g, '')) || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new DomainError('ENGINE_URL_INVALID', '知识引擎地址必须是无凭据的本机服务地址。');
      const health = await this.json(new URL('/api/health', url));
      const registered = await this.json(new URL('/api/projects', url));
      const match = registered.projects?.find(item => item.projectId === project.projectId && item.enabled !== false);
      if (health.name !== 'knowledge-engine' || health.dataSchemaVersion !== 3 || !match || !this.layout.pathsEqual(match.repoPath, project.repoPath) || !this.layout.pathsEqual(match.knowledgePath, project.knowledgePath)) throw new DomainError('ENGINE_IDENTITY_MISMATCH', '知识引擎与当前项目目录绑定不匹配。', { status: 409 });
      return { url, prefix: '/api' };
    }
    const live = endpoint.readLiveEndpoint(this.layout.getDataDir(), { removeStale: false });
    if (!live) throw new DomainError('ENGINE_UNAVAILABLE', '知识库服务尚未运行，请先启动 project-knowledge。', { status: 503 });
    const url = new URL(`http://${live.host.includes(':') ? `[${live.host}]` : live.host}:${live.port}`);
    const identity = await this.json(new URL('/api/runtime/identity', url));
    if (identity.schema !== control.SCHEMA || identity.name !== 'project-knowledge' || identity.pid !== live.pid || identity.port !== live.port || identity.startedAt !== live.startedAt || !identity.dataDir || !this.layout.pathsEqual(identity.dataDir, this.layout.getDataDir())) throw new DomainError('ENGINE_IDENTITY_MISMATCH', '知识库实例与当前数据目录不匹配，已拒绝读取。', { status: 409 });
    return { url, prefix: '/api/engine' };
  }

  async request(action, input, project) {
    if (!['search', 'ask', 'get', 'history'].includes(action)) throw new DomainError('INVALID_ARGUMENT', '仅支持知识读取操作。');
    if (input.scope !== undefined && !['project', 'domain', 'brain'].includes(input.scope)) throw new DomainError('INVALID_ARGUMENT', '知识范围必须是项目、领域或智脑。');
    const target = await this.target(project);
    // Forward only the read contract, never profiles, credentials or context objects.
    const body = { projectId: project.projectId };
    for (const key of ['query', 'limit', 'entryId', 'entry', 'scope', 'spaceId']) if (input[key] !== undefined) body[key] = input[key];
    if (body.spaceId === undefined && input.space !== undefined) body.spaceId = input.space;
    const result = await this.json(new URL(`${target.prefix}/${action}`, target.url), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const valid = action === 'get' ? Array.isArray(result.chunks) : Array.isArray(result.results);
    if (result.ok !== true || !valid || (action === 'ask' && (typeof result.answer !== 'string' || !Array.isArray(result.citations)))) throw new DomainError('ENGINE_INVALID_RESPONSE', '知识引擎返回了无效读取结果。', { status: 502 });
    return result;
  }
}
module.exports = { EngineKnowledgeClient };
