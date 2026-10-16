'use strict';
const { randomUUID } = require('node:crypto');

class RegistryEvents {
  constructor() { this.instanceId = randomUUID(); this.revision = 0; this.listeners = new Set(); }
  publish(areas = ['projects', 'brain', 'health']) {
    const event = { type: 'registry-changed', instanceId: this.instanceId, revision: ++this.revision, areas };
    for (const listener of this.listeners) { try { listener(event); } catch { /* disconnected client */ } }
  }
  subscribe(listener) {
    this.listeners.add(listener);
    listener({ type: 'registry-snapshot', instanceId: this.instanceId, revision: this.revision });
    return () => this.listeners.delete(listener);
  }
}
module.exports = { RegistryEvents };
