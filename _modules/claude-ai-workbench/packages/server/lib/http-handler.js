'use strict';

const { DEFAULT_API_PREFIX, cleanId } = require('../../contracts');
const { pickFolder: defaultPickFolder } = require('./folder-picker');

function createHttpHandler(service, options = {}) {
  const prefix = String(options.apiPrefix || DEFAULT_API_PREFIX).replace(/\/$/, '');
  // Stateless host capability — the picker module is required directly.
  const pickFolder = options.pickFolder || defaultPickFolder;
  return async function handle(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) return false;
    const path = url.pathname.slice(prefix.length) || '/';
    // System endpoints trigger host-native side effects (a modal folder
    // dialog) and answer with a local filesystem path. The API-wide CORS `*`
    // would let any website stack dialogs and read the choice, so they are
    // restricted to loopback origins — same-origin GETs and non-browser
    // clients send no Origin header at all and always pass.
    if (path.startsWith('/system/')) {
      const origin = req.headers.origin;
      if (origin && !isLoopbackOrigin(origin) && origin !== options.corsOrigin) {
        return json(res, 403, { ok: false, error: 'cross-origin access to system endpoints is not allowed' });
      }
      if (origin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
      }
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return true; }
    } else {
      setCors(req, res, options.corsOrigin);
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return true; }
    }
    try {
      if (req.method === 'GET' && path === '/health') return json(res, 200, service.health());
      // {path} on success, {path:null} when the user cancelled, 501 when the
      // host has no folder picker, 500 on real failures. `win=x,y,w,h` (the
      // calling browser window's screen rect) anchors the dialog so it opens
      // over the UI instead of the screen's top-left corner.
      if (req.method === 'GET' && path === '/system/pick-folder') {
        const parts = (url.searchParams.get('win') || '').split(',').map(Number);
        const windowRect = parts.length === 4 && parts.every(Number.isFinite)
          ? { x: parts[0], y: parts[1], width: parts[2], height: parts[3] }
          : undefined;
        return json(res, 200, await pickFolder({ windowRect }));
      }
      if (req.method === 'GET' && path === '/runtime') return json(res, 200, service.runtime());
      if (req.method === 'GET' && path === '/agents') return json(res, 200, service.listAgents());
      if (req.method === 'GET' && path === '/profiles') return json(res, 200, service.listProfiles());
      if (req.method === 'POST' && path === '/profiles') return json(res, 201, service.saveProfile(await body(req)));
      if (req.method === 'POST' && path === '/profiles/test') return json(res, 200, await service.testProfileDraft(await body(req)));
      if (req.method === 'POST' && path === '/profiles/detect-models') return json(res, 200, await service.detectProfileModels(await body(req)));

      if (path === '/projects' && req.method === 'GET') return json(res, 200, service.listProjects());
      if (path === '/projects' && req.method === 'POST') return json(res, 201, service.createProject(await body(req)));
      const projectMatch = path.match(/^\/projects\/([^/]+)$/);
      if (projectMatch) {
        const id = decode(projectMatch[1]);
        if (req.method === 'GET') return json(res, 200, service.getProject(id));
        if (req.method === 'PATCH') return json(res, 200, service.renameProject(id, await body(req)));
        if (req.method === 'DELETE') {
          service.removeProject(id, { keepSessions: url.searchParams.get('keepSessions') === '1' });
          res.writeHead(204); res.end(); return true;
        }
      }

      let match = path.match(/^\/profiles\/([^/]+)$/);
      if (match) {
        const id = decode(match[1]);
        if (req.method === 'GET') {
          const profile = service.getProfile(id);
          if (!profile) throw Object.assign(new Error('profile not found'), { status: 404 });
          return json(res, 200, profile);
        }
        if (req.method === 'PUT') return json(res, 200, service.saveProfile(await body(req), id));
        if (req.method === 'DELETE') {
          if (!service.deleteProfile(id)) throw Object.assign(new Error('profile not found'), { status: 404 });
          res.writeHead(204); res.end(); return true;
        }
      }

      match = path.match(/^\/profiles\/([^/]+)\/credential$/);
      if (match && req.method === 'PUT') {
        service.setCredential(decode(match[1]), await body(req));
        res.writeHead(204); res.end(); return true;
      }
      match = path.match(/^\/profiles\/([^/]+)\/test$/);
      if (match && req.method === 'POST') return json(res, 200, await service.testProfile(decode(match[1])));

      if (path === '/sessions' && req.method === 'GET') {
        const sessions = service.listSessions(url.searchParams.get('contextId'), {
          includeArchived: ['1', 'true'].includes(url.searchParams.get('archived')),
        });
        return json(res, 200, { sessions });
      }
      if (path === '/sessions' && req.method === 'POST') {
        const input = await body(req);
        const session = service.startSession(input.context, input.aiProfileId, input);
        return json(res, 201, { session });
      }

      match = path.match(/^\/sessions\/([^/]+)\/archive$/);
      if (match && req.method === 'PUT') return json(res, 200, service.archiveSession(decode(match[1])));
      if (match && req.method === 'DELETE') {
        service.restoreSession(decode(match[1]));
        res.writeHead(204); res.end(); return true;
      }

      match = path.match(/^\/sessions\/([^/]+)\/context-usage$/);
      if (match && req.method === 'GET') return json(res, 200, service.contextUsage(decode(match[1])));

      match = path.match(/^\/sessions\/([^/]+)$/);
      if (match && req.method === 'GET') return json(res, 200, service.loadSession(decode(match[1])));

      match = path.match(/^\/sessions\/([^/]+)\/events$/);
      if (match && req.method === 'GET') {
        const sessionId = decode(match[1]);
        const after = sequenceFromRequest(req, url);
        service.loadSession(sessionId);
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform',
          Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
          'Access-Control-Allow-Origin': options.corsOrigin || '*',
        });
        res.write(': claude-workbench stream\n\n');
        const unsubscribe = service.subscribe(sessionId, after, event => writeSse(res, event));
        const heartbeat = setInterval(() => { try { res.write(`: keepalive ${Date.now()}\n\n`); } catch {} }, 15000);
        heartbeat.unref && heartbeat.unref();
        let closed = false;
        const close = () => { if (closed) return; closed = true; clearInterval(heartbeat); try { unsubscribe(); } catch {} };
        req.on('close', close); req.on('error', close); res.on('close', close);
        return true;
      }

      match = path.match(/^\/sessions\/([^/]+)\/input$/);
      if (match && req.method === 'POST') {
        const input = await body(req, 32 * 1024 * 1024);
        return json(res, 202, await service.send(decode(match[1]), input.text, input.options, input.attachments));
      }
      match = path.match(/^\/sessions\/([^/]+)\/commands$/);
      if (match && req.method === 'GET') return json(res, 200, await service.listCommands(decode(match[1])));

      match = path.match(/^\/sessions\/([^/]+)\/attachments\/([^/]+)$/);
      if (match && req.method === 'GET') {
        const attachment = service.readAttachment(decode(match[1]), decode(match[2]));
        const headers = {
          'Content-Type': attachment.metadata.mediaType,
          'Content-Length': attachment.data.length,
          'Cache-Control': 'private, max-age=3600',
          'X-Content-Type-Options': 'nosniff',
        };
        // Images stay inline for the chat UI; anything textual is forced to
        // download so a crafted .html/.svg attachment can never render in the
        // page origin.
        if (!String(attachment.metadata.mediaType || '').startsWith('image/')) {
          const safeName = String(attachment.metadata.name || 'attachment').replace(/[^\w.\-]+/g, '_').slice(0, 100) || 'attachment';
          headers['Content-Disposition'] = `attachment; filename="${safeName}"`;
        }
        res.writeHead(200, headers);
        res.end(attachment.data);
        return true;
      }
      match = path.match(/^\/sessions\/([^/]+)\/permissions\/([^/]+)\/resolve$/);
      if (match && req.method === 'POST') {
        return json(res, 200, service.resolvePermission(decode(match[1]), decode(match[2]), await body(req)));
      }
      match = path.match(/^\/sessions\/([^/]+)\/abort$/);
      if (match && req.method === 'POST') return json(res, 202, service.abort(decode(match[1])));

      match = path.match(/^\/sessions\/([^/]+)\/permission-mode$/);
      if (match && req.method === 'PUT') {
        const input = await body(req);
        return json(res, 200, service.setPermissionMode(decode(match[1]), input.mode));
      }
      match = path.match(/^\/sessions\/([^/]+)\/selection$/);
      if (match && req.method === 'PUT') {
        const input = await body(req);
        return json(res, 200, service.updateSessionSelection(decode(match[1]), input.aiProfileId, input.model));
      }
      throw Object.assign(new Error('route not found'), { status: 404 });
    } catch (error) {
      if (res.headersSent) {
        if (!res.writableEnded) try { res.end(); } catch {}
        return true;
      }
      const status = Number(error.status) || (error.message === 'request body too large' ? 413 : 400);
      return json(res, status, { ok: false, error: safeError(error) });
    }
  };
}

function body(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0; let settled = false;
    req.on('data', chunk => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) { settled = true; reject(new Error('request body too large')); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(Object.assign(new Error('invalid JSON body'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function json(res, status, value) {
  const payload = status === 204 ? undefined : JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(payload);
  return true;
}
function writeSse(res, event) {
  res.write(`id: ${event.sequence}\n`);
  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}
function sequenceFromRequest(req, url) {
  const value = req.headers['last-event-id'] || url.searchParams.get('after') || 0;
  const parsed = Number(value); return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}
function setCors(req, res, origin) {
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Last-Event-ID');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
}
// `Origin` values a system endpoint may serve: the local machine itself
// (the app is same-origin already; a dev server on another loopback port is
// fine). `Origin: null` (sandboxed/data frames) and foreign hosts are not.
function isLoopbackOrigin(origin) {
  let parsed;
  try { parsed = new URL(origin); } catch { return false; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(parsed.hostname);
}
function decode(value) { try { return cleanId(decodeURIComponent(value)); } catch (error) { error.status = 400; throw error; } }
function safeError(error) { return String(error && error.message || 'request failed').replace(/[\r\n]+/g, ' ').slice(0, 500); }

module.exports = { createHttpHandler, body, writeSse, sequenceFromRequest };
