// _site/_test/helpers/parallel-nav-module-ui.js
//
// Test double for an embedded module UI (the Agent workbench, the knowledge
// index, the event bridge). The product embeds a module in an iframe and
// talks to it with the kb:* postMessage protocol; the module answers
// "kb:ready" and then receives kb:theme, kb:scope, kb:select-project and
// kb:visibility.
//
// This fixture is a real HTTP service: the product proxies the iframe
// request to it, the page it serves is the one the browser really loads, and
// the postMessage traffic is really delivered. It is NOT the real module
// UI — the cases that use it verify the SHELL side of the protocol (the
// shell must deliver kb:theme, must not re-send kb:select-project after a
// theme change, and must map the right project to the frame), so the
// substituted part is stated in the case report.
//
// The fixture also answers the module registry API the product calls when it
// registers a project, so the project→module mapping under test is a real
// registration round trip.

'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>module ui fixture</title></head>
<body>
<p>module ui fixture</p>
<script>
  // The messages the shell really sent to this frame, in order.
  window.__navMessages = [];
  window.addEventListener('message', function (event) {
    var data = event.data;
    if (!data || typeof data !== 'object') return;
    window.__navMessages.push({ type: String(data.type || ''), payload: data, at: Date.now() });
  });
  // The shell only starts talking to a frame after the frame announced
  // itself; that announcement is the "ready" edge of the protocol.
  window.parent.postMessage({ type: 'kb:ready' }, '*');
</script>
</body></html>`;

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function createModuleUiFixture({ tag = 'module-ui' } = {}) {
  const state = { pageLoads: 0, requests: [], projects: [], nextId: 1 };
  let server;

  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    let body = null;
    if (raw.length) { try { body = JSON.parse(raw.toString('utf8')); } catch { body = null; } }
    state.requests.push({ method: req.method, path: url.pathname + url.search, body, at: Date.now() });

    // The health probes the product uses to recognise a module. The same
    // double stands in for the knowledge index and the event bridge, so the
    // body carries both identity markers.
    if (req.method === 'GET' && url.pathname === '/api/claude-workbench/v1/health') {
      sendJson(res, 200, { status: 'ok', apiVersion: 'test-double' });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/health') {
      sendJson(res, 200, { ok: true, projects: state.projects.filter(project => project.sourceDir), registeredProjects: state.projects.filter(project => project.id).length });
      return;
    }

    // Navigation owns no real journals. An enabled engine can safely poll
    // this empty Bridge contract without reaching the production bridge.
    if (req.method === 'GET' && url.pathname === '/api/journals') {
      sendJson(res, 200, { journals: [] });
      return;
    }

    // The module registry API the product uses when it registers a project.
    if (req.method === 'GET' && url.pathname === '/api/claude-workbench/v1/projects') {
      sendJson(res, 200, { projects: state.projects });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/claude-workbench/v1/projects') {
      const id = `terminal-${state.nextId++}`;
      state.projects.push({ id, name: body?.name || id, rootPath: body?.rootPath || '' });
      sendJson(res, 201, { id, name: body?.name || id, rootPath: body?.rootPath || '' });
      return;
    }
    if (req.method === 'DELETE' && url.pathname.startsWith('/api/claude-workbench/v1/projects/')) {
      const id = decodeURIComponent(url.pathname.split('/').pop());
      state.projects = state.projects.filter(project => project.id !== id);
      res.writeHead(204); res.end();
      return;
    }
    // The knowledge-index registry: the product imports a project by name and
    // source directory, and lists the imported ones before importing again.
    if (req.method === 'GET' && url.pathname === '/api/projects') {
      sendJson(res, 200, { projects: state.projects.filter(project => project.sourceDir) });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/import') {
      const project = { name: body?.projectName || '', sourceDir: body?.sourceDir || '', hasIndex: true };
      state.projects.push(project);
      sendJson(res, 200, { ok: true, project: project.name });
      return;
    }
    // The vector contract subset the REAL engine's index step calls
    // (coordinator.js requestIndex -> POST /api/sync {project, sourceDir}).
    // The vector module is NOT the subject under test — this double keeps the
    // engine's index step off its built-in default vectorUrl (the LIVE
    // desktop hub on 127.0.0.1:8787); every request body is recorded so the
    // harness can assert project/sourceDir never leave the fixture.
    if (req.method === 'POST' && url.pathname === '/api/sync') {
      if (!body?.project || !body?.sourceDir) { sendJson(res, 400, { error: "Body must include 'project' and 'sourceDir'." }); return; }
      let filesTracked = 0;
      try {
        filesTracked = fs.readdirSync(body.sourceDir, { withFileTypes: true })
          .filter(entry => entry.isFile() && ['.md', '.txt', '.html'].includes(path.extname(entry.name).toLowerCase())).length;
      } catch { filesTracked = 0; }
      state.projects = state.projects.filter(project => project.name !== body.project);
      state.projects.push({ name: body.project, sourceDir: body.sourceDir, hasIndex: true });
      sendJson(res, 200, { ok: true, project: body.project, filesTracked });
      return;
    }
    if (req.method === 'DELETE' && url.pathname === '/api/project') {
      const name = url.searchParams.get('name');
      state.projects = state.projects.filter(project => project.name !== name);
      sendJson(res, 200, { ok: true });
      return;
    }
    // The development-event registry: the product registers a work tree and
    // reads the journal back by the id the registry answered with. The real
    // registry answers with the workspace id, and the engine only accepts
    // that shape as a session baseline key.
    if (req.method === 'POST' && url.pathname === '/api/projects') {
      const id = `sha256:${crypto.createHash('sha256').update(String(body?.path || '')).digest('hex')}`;
      state.projects.push({ id, path: body?.path || '', auto: false, store: body?.store || '' });
      sendJson(res, 201, { project: { id, path: body?.path || '' } });
      return;
    }
    if (req.method === 'DELETE' && url.pathname === '/api/projects') {
      const id = url.searchParams.get('id');
      state.projects = state.projects.filter(project => project.id !== id);
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method !== 'GET') {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    // Every other GET is an embedded UI document: count it, because a
    // reloaded frame is a rebuilt task for the module.
    state.pageLoads += 1;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(PAGE);
  });

  return {
    tag,
    state,
    /** How many times the embedded UI document was really served. */
    pageLoads: () => state.pageLoads,
    /** Every POST /api/sync body the engine really sent (vector stand-in evidence). */
    vectorSyncs: () => state.requests.filter(request => request.method === 'POST' && request.path === '/api/sync'),
    /** Every POST /api/import body (the engine's scope-registration vector call). */
    vectorImports: () => state.requests.filter(request => request.method === 'POST' && request.path === '/api/import'),
    async start() {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      this.url = `http://127.0.0.1:${server.address().port}`;
      return this.url;
    },
    async close() {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

module.exports = { createModuleUiFixture };
