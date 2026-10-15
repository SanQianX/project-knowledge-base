'use strict';
const { WebSocketServer } = require('ws');
const { TextDecoder } = require('node:util');

function attachLiveGateway(server, runtime) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8192 });
  function target(route) {
    const url = new URL(route, 'http://local');
    if (url.origin !== 'http://local' || !route.startsWith('/') || route.length > 2048) throw new Error('INVALID_ROUTE');
    if ([...url.searchParams.keys()].some(k => !['after', 'projectId', 'level', 'component', 'event', 'q', 'operationId', 'runId', 'commitSha', 'limit', 'summary', 'jobId', 'since', 'streamCursor'].includes(k))) throw new Error('INVALID_QUERY');
    const bridge = runtime.moduleBridge;
    if (url.pathname === '/api/engine/progress') {
      if (bridge.engineCompatible === false) throw new Error('ENGINE_CONNECTION_PENDING');
      return `${bridge.engineUrl}/api/progress${url.search}`;
    }
    if (/^\/api\/terminal\/sessions\/[a-zA-Z0-9_-]+\/events$/.test(url.pathname)) return bridge._terminalApi(url.pathname) + url.search;
    if (url.pathname === '/api/logs/stream') return `http://${runtime.liveAddress}${route}`;
    throw new Error('INVALID_ROUTE');
  }
  server.on('upgrade', (req, socket, head) => {
    const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
    let hostname; try { hostname = new URL(`http://${req.headers.host}`).hostname; } catch { socket.destroy(); return; }
    if (req.url !== '/api/live' || !local || !['127.0.0.1', 'localhost', '[::1]'].includes(hostname) || req.headers.origin !== `http://${req.headers.host}`) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
  });
  wss.on('connection', ws => {
    const subscriptions = new Map();
    const send = payload => {
      if (ws.readyState !== 1) return;
      if (ws.bufferedAmount > 1024 * 1024) { ws.close(1013, 'slow consumer'); return; }
      ws.send(JSON.stringify(payload));
    };
    const stop = id => { subscriptions.get(id)?.abort(); subscriptions.delete(id); };
    ws.on('message', async bytes => {
      let message, controller;
      try {
        message = JSON.parse(String(bytes));
        if (typeof message?.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(message.id)) throw new Error('INVALID_SUBSCRIPTION');
        if (message.type === 'unsubscribe') { stop(message.id); return; }
        if (message.type !== 'subscribe' || subscriptions.size >= 8) throw new Error('INVALID_SUBSCRIPTION');
        const url = target(message.route); stop(message.id);
        controller = new AbortController(); subscriptions.set(message.id, controller);
        const deadline = setTimeout(() => controller.abort(), 3000);
        let upstream;
        try { upstream = await fetch(url, { signal: controller.signal, headers: message.after ? { 'Last-Event-ID': String(message.after).slice(0, 128) } : {} }); }
        finally { clearTimeout(deadline); }
        if (!upstream.ok || !upstream.headers.get('content-type')?.includes('text/event-stream')) throw new Error('UPSTREAM_UNAVAILABLE');
        send({ id: message.id, type: 'open' });
        const decoder = new TextDecoder(); let buffer = '';
        for await (const chunk of upstream.body) {
          buffer += decoder.decode(chunk, { stream: true });
          if (buffer.length > 2 * 1024 * 1024) throw new Error('EVENT_TOO_LARGE');
          let boundary;
          while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
            const block = buffer.slice(0, boundary.index); buffer = buffer.slice(boundary.index + boundary[0].length);
            let event = 'message', data = [], cursor;
            for (const line of block.split(/\r?\n/)) {
              const colon = line.indexOf(':'), key = colon < 0 ? line : line.slice(0, colon), value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
              if (key === 'event') event = value; else if (key === 'data') data.push(value); else if (key === 'id') cursor = value;
            }
            if (data.length && subscriptions.get(message.id) === controller) send({ type: 'event', id: message.id, event, data: data.join('\n'), cursor });
          }
        }
        if (!controller.signal.aborted) throw new Error('UPSTREAM_CLOSED');
      } catch {
        if (controller) { if (subscriptions.get(message.id) === controller) { stop(message.id); send({ type: 'error', id: message.id, code: 'STREAM_UNAVAILABLE' }); } }
        else send({ type: 'error', id: message?.id, code: 'INVALID_SUBSCRIPTION' });
      }
    });
    const heartbeat = setInterval(() => { if (ws.isAlive === false) return ws.terminate(); ws.isAlive = false; ws.ping(); }, 30000);
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('close', () => { clearInterval(heartbeat); for (const id of subscriptions.keys()) stop(id); });
  });
  return { close() { for (const ws of wss.clients) ws.terminate(); wss.close(); } };
}
module.exports = { attachLiveGateway };
