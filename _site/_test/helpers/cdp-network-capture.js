'use strict';
// Records what the real UI actually sent and received over HTTP.
//
// The import id and the per-module wiring payload are decided by the running
// product, so reading the UI source cannot stand in for this evidence: the
// captured request body proves which import id travelled with the request,
// and the captured response body proves which statuses the product reported.

function parseJson(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function attachNetworkCapture(browser) {
  const requests = [];
  const byId = new Map();
  const onMessage = raw => {
    let message;
    try { message = JSON.parse(String(raw)); } catch { return; }
    const params = message.params || {};
    if (message.method === 'Network.requestWillBeSent') {
      const request = params.request || {};
      const entry = {
        id: params.requestId,
        method: request.method,
        url: request.url,
        postData: request.postData || '',
        body: parseJson(request.postData),
        status: null,
      };
      requests.push(entry);
      byId.set(params.requestId, entry);
      return;
    }
    if (message.method === 'Network.responseReceived' && byId.has(params.requestId)) {
      const response = params.response || {};
      byId.get(params.requestId).status = response.status === undefined ? null : response.status;
    }
  };
  browser.socket.on('message', onMessage);

  return {
    requests,
    async enable() { await browser.send('Network.enable'); },
    find(predicate) { return requests.filter(predicate); },
    lastApi(method, pathname) {
      const matches = requests.filter(entry => entry.method === method && entry.url.includes(pathname));
      return matches.length ? matches[matches.length - 1] : null;
    },
    async body(entry) {
      if (!entry) return null;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        try {
          const result = await browser.send('Network.getResponseBody', { requestId: entry.id });
          return parseJson(result.body);
        } catch {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
      return null;
    },
    detach() { browser.socket.off('message', onMessage); },
  };
}

module.exports = { attachNetworkCapture };
