'use strict';
// P-LOG-ACCEPTANCE-01 lane-exclusive observation proxy (prefix
// parallel-logging-acceptance-*). The real product page points at this proxy;
// the proxy forwards to the isolated server. It exists only to observe and
// shape the network the real browser sees:
//   * count open connections per pathname prefix (LOG-004: the diagnostics
//     dialog's SSE stream must actually disconnect when the dialog closes);
//   * optionally delay a pathname prefix (LOG-008: the real 3s UI read timeout
//     fires against a slow /api/logs).
// SSE responses are piped unbuffered both ways - the page's EventSource
// behaves exactly as against the origin server.

const http = require('node:http');
const net = require('node:net');

// One fresh connection per forwarded request: avoids keep-alive reset races
// between the proxy and the isolated origin during bursty page loads.
const proxyAgent = new http.Agent({ keepAlive: false });

function createObservationProxy({ targetPort, targetHost = '127.0.0.1', port, host = '127.0.0.1' }) {
  const state = {
    activeByPrefix: new Map(),
    requests: [],
    upgrades: [],
    delays: new Map(),
    setDelay(prefix, ms) { if (ms === null) state.delays.delete(prefix); else state.delays.set(prefix, ms); },
    snapshot() {
      return {
        activeByPrefix: Object.fromEntries(state.activeByPrefix),
        requests: state.requests.slice(-200),
        upgrades: state.upgrades.slice(-200),
      };
    },
  };

  const server = http.createServer((req, res) => {
    const pathname = String(req.url || '').split('?')[0];
    const entry = { method: req.method, pathname, url: String(req.url || ''), openedAt: new Date().toISOString(), status: null, closedAt: null };
    state.requests.push(entry);
    for (const [prefix] of state.activeByPrefix) {
      if (pathname.startsWith(prefix)) state.activeByPrefix.set(prefix, state.activeByPrefix.get(prefix) + 1);
    }
    const trackedPrefix = [...state.activeByPrefix.keys()].find(prefix => pathname.startsWith(prefix));
    const closeTracking = () => {
      if (entry.closedAt) return;
      entry.closedAt = new Date().toISOString();
      if (trackedPrefix) state.activeByPrefix.set(trackedPrefix, Math.max(0, state.activeByPrefix.get(trackedPrefix) - 1));
    };
    res.on('close', closeTracking);

    const forward = () => {
      const upstream = http.request({ host: targetHost, port: targetPort, method: req.method, path: req.url, agent: proxyAgent, headers: { ...req.headers, host: `${targetHost}:${targetPort}` } }, upstreamRes => {
        entry.status = upstreamRes.statusCode;
        res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      });
      upstream.on('error', error => { entry.status = 502; entry.error = String(error.message || error); if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: { message: 'proxy upstream failure' } })); });
      req.pipe(upstream);
    };

    const delay = [...state.delays.entries()].find(([prefix]) => pathname.startsWith(prefix));
    if (delay) setTimeout(forward, delay[1]);
    else forward();
  });

  // WebSocket passthrough (the product page multiplexes /api/live over WS);
  // host/origin are rewritten to the target so the server's same-origin
  // security check still passes while the page stays pointed at the proxy.
  server.on('upgrade', (req, socket, head) => {
    const pathname = String(req.url || '').split('?')[0];
    const entry = { method: 'UPGRADE', pathname, url: String(req.url || ''), openedAt: new Date().toISOString(), closedAt: null };
    state.upgrades.push(entry);
    const target = `${targetHost}:${targetPort}`;
    const headers = [];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i].toLowerCase();
      const value = name === 'host' || name === 'origin' ? (name === 'host' ? target : `http://${target}`) : req.rawHeaders[i + 1];
      headers.push(`${req.rawHeaders[i]}: ${value}`);
    }
    const upstream = net.connect(targetPort, targetHost, () => {
      upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${headers.join('\r\n')}\r\n\r\n`);
      if (head && head.length) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    const kill = () => { entry.closedAt = entry.closedAt || new Date().toISOString(); socket.destroy(); upstream.destroy(); };
    socket.on('error', kill);
    upstream.on('error', kill);
    socket.on('close', kill);
    upstream.on('close', kill);
  });

  return new Promise(resolve => server.listen(port, host, () => resolve({
    port: server.address().port,
    url: `http://${host}:${server.address().port}`,
    state,
    trackPrefix(prefix) { state.activeByPrefix.set(prefix, 0); },
    setDelay(prefix, ms) { state.setDelay(prefix, ms); },
    async close() {
      server.closeAllConnections?.();
      await new Promise(done => server.close(done));
    },
  })));
}

module.exports = { createObservationProxy };
