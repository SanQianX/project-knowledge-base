'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const { resolveModuleUrl } = require('../lib/module-port-resolver');
const { ModuleBridge } = require('../lib/module-bridge');

const countingProbe = outcome => {
  const seen = [];
  return {
    probe: async url => { seen.push(url); return outcome; },
    get seen() { return seen; },
    get calls() { return seen.length; },
  };
};

const countingPortFree = isFree => {
  const seen = [];
  return {
    portFree: async port => { seen.push(port); return isFree(port); },
    get seen() { return seen; },
    get calls() { return seen.length; },
  };
};

(async () => {
  // A: healthy module on the preferred port is reused without any port scan.
  {
    const probe = countingProbe('module');
    const portFree = countingPortFree(() => false);
    const resolved = await resolveModuleUrl({ kind: 'terminal', preferredUrl: 'http://127.0.0.1:5760', explicit: false, portFree: portFree.portFree, probe: probe.probe });
    assert.equal(resolved.source, 'reused');
    assert.equal(resolved.url, 'http://127.0.0.1:5760');
    assert.equal(resolved.port, 5760);
    assert.deepEqual(probe.seen, ['http://127.0.0.1:5760']);
    assert.equal(portFree.calls, 0, 'reuse must never invoke portFree');
  }
  // B: foreign occupant on the preferred port moves the module to the next free port.
  {
    const probe = countingProbe('foreign');
    const portFree = countingPortFree(port => port === 5761);
    const resolved = await resolveModuleUrl({ kind: 'terminal', preferredUrl: 'http://127.0.0.1:5760', explicit: false, portFree: portFree.portFree, probe: probe.probe });
    assert.equal(resolved.source, 'dynamic');
    assert.equal(resolved.url, 'http://127.0.0.1:5761');
    assert.equal(resolved.port, 5761);
    assert.equal(resolved.offset, 1);
    assert.deepEqual(portFree.seen, [5760, 5761]);
  }
  // C: unreachable preferred port skips three busy ports before picking the fourth.
  {
    const probe = countingProbe('unreachable');
    const portFree = countingPortFree(port => port === 8790);
    const resolved = await resolveModuleUrl({ kind: 'vector-hub', preferredUrl: 'http://127.0.0.1:8787', explicit: false, portFree: portFree.portFree, probe: probe.probe });
    assert.equal(resolved.source, 'dynamic');
    assert.equal(resolved.url, 'http://127.0.0.1:8790');
    assert.equal(resolved.port, 8790);
    assert.equal(resolved.offset, 3);
    assert.deepEqual(portFree.seen, [8787, 8788, 8789, 8790]);
  }
  // D: exhausted scan range fails loudly with kind and port span in the message.
  {
    const probe = countingProbe('unreachable');
    const portFree = countingPortFree(() => false);
    await assert.rejects(
      () => resolveModuleUrl({ kind: 'event-bridge', preferredUrl: 'http://127.0.0.1:8790', explicit: false, portFree: portFree.portFree, probe: probe.probe }),
      error => {
        assert.equal(error.code, 'NO_FREE_MODULE_PORT');
        assert.ok(error.message.includes('event-bridge'), `message must name the module kind: ${error.message}`);
        assert.ok(error.message.includes('8790'), `message must name the first scanned port: ${error.message}`);
        assert.ok(error.message.includes('8809'), `message must name the last scanned port: ${error.message}`);
        return true;
      },
    );
    assert.equal(portFree.calls, 20, 'default scanRange must probe 20 consecutive ports before failing');
    assert.deepEqual(portFree.seen, Array.from({ length: 20 }, (_, index) => 8790 + index));
  }
  // E: an explicit external URL short-circuits before any probe or port scan.
  {
    const probe = countingProbe('module');
    const portFree = countingPortFree(() => true);
    const resolved = await resolveModuleUrl({ kind: 'knowledge-engine', preferredUrl: 'http://192.168.1.5:5790', explicit: true, portFree: portFree.portFree, probe: probe.probe });
    assert.equal(resolved.source, 'external');
    assert.equal(resolved.url, 'http://192.168.1.5:5790');
    assert.equal(probe.calls, 0, 'explicit external URL must never be probed');
    assert.equal(portFree.calls, 0, 'explicit external URL must never trigger a port scan');
  }
  // F: a preferred URL without an explicit port is rejected.
  {
    const probe = countingProbe('module');
    const portFree = countingPortFree(() => true);
    await assert.rejects(
      () => resolveModuleUrl({ kind: 'terminal', preferredUrl: 'http://127.0.0.1', explicit: false, portFree: portFree.portFree, probe: probe.probe }),
      error => { assert.equal(error.code, 'INVALID_MODULE_URL'); return true; },
    );
  }
  // G (integration): an HTTP service squatting on the preferred port with
  // 404 responses — exactly what happens when the shell's own fallback range
  // 5757..5776 lands on the terminal default 5760 — must not be misread as a
  // module and must not crash-loop: the bridge moves to the next free port.
  {
    const squatter = http.createServer((req, res) => { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'not found' })); });
    await new Promise(resolve => squatter.listen(0, '127.0.0.1', resolve));
    const squatterPort = squatter.address().port;
    const bridge = new ModuleBridge();
    // Isolate the terminal leg: everything else is explicit/external so the
    // resolution loop only probes the squatter port for the terminal kind.
    bridge.terminalUrl = `http://127.0.0.1:${squatterPort}`;
    bridge.explicitModuleUrls = { terminal: false, vectorHub: true, eventBridge: true, engine: true };
    try {
      await bridge._resolveManagedUrls();
      assert.equal(bridge.moduleUrlSources.terminal, 'dynamic', '404 squatter must force a dynamic move, never reuse');
      assert.equal(bridge.terminalUrl, `http://127.0.0.1:${squatterPort + 1}`, 'module moves to the port right after the squatter');
    } finally {
      squatter.closeAllConnections?.();
      await new Promise(resolve => squatter.close(resolve));
    }
  }
  console.log('module dynamic port test PASS');
})().catch(error => { console.error(error); process.exitCode = 1; });
