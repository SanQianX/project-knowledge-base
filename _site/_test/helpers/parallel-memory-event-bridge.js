'use strict';
// _site/_test/helpers/parallel-memory-event-bridge.js
//
// Lane-owned stand-in for the event-bridge console.
//
// WHY THIS EXISTS (and why the shared module fixture cannot be used here):
// the product's module bridge sends the event-bridge project id to the
// knowledge engine as a `conversationBaselineCursors` key. The engine accepts
// only 'global' or `sha256:<64 hex>` as such a key. The real event-bridge
// console derives its project id from the Git workspace identity, which is
// exactly that `sha256:` form. The shared test fixture instead answers with
// `bridge-1`, which the engine rejects with 400 "会话跟踪基线无效。" and the
// project is never registered with the engine — so no memory run can happen.
//
// The shared helper is read-only for this lane, so this stand-in reproduces
// the real console's id derivation instead of inventing one: it calls the
// installed bridge package's own `resolveRepoContext`, the same function the
// product's bridge adapter calls.
//
// HONEST SCOPE LABEL: this is a stand-in for the event-bridge console. It
// serves the project registry and the journal high-watermark endpoints that
// the product's module bridge calls. It stores no conversation and writes no
// journal; the memory lane drives the engine's own conversation store
// directly, and it says so in its own report.

const http = require('node:http');
const path = require('node:path');
const { resolveRepoContext } = require('@sanqianx/ai-coding-event-bridge-console/src/bridge/core/repo-context');

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

async function createEventBridgeStandin({ tag = 'event-bridge' } = {}) {
  const state = { projects: [], requests: [] };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const raw = await readBody(req);
    let body = null;
    if (raw.length) { try { body = JSON.parse(raw.toString('utf8')); } catch { body = null; } }
    state.requests.push({ method: req.method, path: url.pathname + url.search, body, at: Date.now() });

    if (req.method === 'GET' && url.pathname === '/api/projects') {
      sendJson(res, 200, { projects: state.projects });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/projects') {
      const projectPath = String(body?.path || '');
      if (!projectPath) {
        sendJson(res, 400, { error: { code: 'PROJECT_PATH_REQUIRED', message: 'project path required' } });
        return;
      }
      if (state.projects.some(project => String(project.path).toLowerCase() === projectPath.toLowerCase())) {
        sendJson(res, 409, { error: { code: 'PROJECT_DUPLICATE', message: 'project path already imported' } });
        return;
      }
      let identity = null;
      let resolvedPath = projectPath;
      try {
        const context = await resolveRepoContext(projectPath);
        identity = context.repoIdentity;
        resolvedPath = context.projectPath || projectPath;
      } catch (error) {
        sendJson(res, 422, { error: { code: 'PROJECT_NOT_GIT', message: `not a Git work tree: ${projectPath}` } });
        return;
      }
      const project = {
        id: identity.workspaceId,
        name: path.basename(resolvedPath),
        path: projectPath,
        store: String(body?.store || ''),
        remote: identity.remote || null,
        auto: false,
        createdAt: new Date().toISOString(),
      };
      state.projects.push(project);
      sendJson(res, 201, { project });
      return;
    }
    if (req.method === 'DELETE' && url.pathname === '/api/projects') {
      const id = url.searchParams.get('id');
      state.projects = state.projects.filter(project => project.id !== id);
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/journal/high-watermark') {
      const journalId = url.searchParams.get('journalId') || 'global';
      // The lane writes no journal: the high watermark is always 0.
      sendJson(res, 200, { journalId, sequence: 0 });
      return;
    }
    sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: '未实现的模块接口' } });
  });

  return {
    kind: 'eventBridge',
    tag,
    state,
    requests: state.requests,
    url: null,
    async start() {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      this.url = `http://127.0.0.1:${server.address().port}`;
      return this.url;
    },
    countRequests(method, pathPrefix) {
      return state.requests.filter(entry => entry.method === method && (!pathPrefix || entry.path.startsWith(pathPrefix))).length;
    },
    async close() {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

module.exports = { createEventBridgeStandin };
