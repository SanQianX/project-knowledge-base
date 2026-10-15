(() => {
  'use strict';
  const channels = new Map(); let socket, timer, sequence = 0, retries = 0;
  function send(value) { if (socket?.readyState === 1) socket.send(JSON.stringify(value)); }
  function subscribe(channel) { send({ type: 'subscribe', id: channel.id, route: channel.route, after: channel.lastEventId }); }
  function connect() {
    if (!channels.size || socket || !navigator.onLine) return;
    clearTimeout(timer);
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/live`); socket = ws;
    ws.onopen = () => { retries = 0; for (const channel of channels.values()) subscribe(channel); };
    ws.onmessage = event => {
      let data; try { data = JSON.parse(event.data); } catch { return; }
      const channel = channels.get(data.id); if (!channel) return;
      if (data.type === 'open') { channel.readyState = 1; channel.emit('open', {}); }
      else if (data.type === 'event') { if (data.cursor != null) channel.lastEventId = data.cursor; channel.emit(data.event, { data: data.data, lastEventId: channel.lastEventId }); }
      else if (data.type === 'error') {
        channel.readyState = 0; channel.emit('error', {}); clearTimeout(channel.retryTimer);
        channel.retryTimer = setTimeout(() => { if (channels.has(channel.id)) subscribe(channel); }, 1500);
      }
    };
    ws.onclose = () => {
      if (socket !== ws) return; socket = null;
      for (const channel of channels.values()) { channel.readyState = 0; channel.emit('error', {}); }
      if (channels.size) timer = setTimeout(connect, Math.min(1000 * 2 ** retries++, 15000));
    };
    ws.onerror = () => {};
  }
  class LiveEventSource {
    static CONNECTING = 0; static OPEN = 1; static CLOSED = 2;
    constructor(route) {
      this.id = `c${++sequence}`; this.route = route; this.readyState = 0; this.lastEventId = ''; this.listeners = new Map(); channels.set(this.id, this);
      connect(); if (socket?.readyState === 1) subscribe(this);
    }
    addEventListener(type, listener) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(listener); }
    removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
    emit(type, event) { for (const listener of this.listeners.get(type) || []) listener(event); this[`on${type}`]?.(event); }
    close() {
      if (this.readyState === 2) return; this.readyState = 2; clearTimeout(this.retryTimer); channels.delete(this.id); send({ type: 'unsubscribe', id: this.id });
      if (!channels.size) { clearTimeout(timer); const ws = socket; socket = null; ws?.close(); }
    }
  }
  window.addEventListener('online', connect);
  window.addEventListener('offline', () => { socket?.close(); });
  window.addEventListener('beforeunload', () => { for (const channel of [...channels.values()]) channel.close(); });
  window.KnowledgeLive = { EventSource: LiveEventSource, stats: () => ({ connections: socket ? 1 : 0, subscriptions: channels.size }) };
})();
