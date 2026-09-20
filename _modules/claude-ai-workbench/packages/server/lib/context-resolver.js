'use strict';

const fs = require('fs');
const path = require('path');
const { normalizeContext } = require('../../contracts');

class ContextResolver {
  constructor(options = {}) {
    this.createMissing = options.createMissing === true;
    this.workspaces = new Map();
    for (const [ref, target] of Object.entries(options.workspaces || {})) this.register(ref, target);
  }

  register(ref, target) {
    if (!ref || !target) throw new Error('workspace ref and target are required');
    if (path.isAbsolute(String(ref))) throw new Error('workspaceRef must be an opaque server reference');
    this.workspaces.set(String(ref), path.resolve(String(target)));
  }

  unregister(ref) { return this.workspaces.delete(String(ref)); }

  resolve(input) {
    const context = normalizeContext(input);
    if (!context.workspaceRef) throw Object.assign(new Error('workspaceRef is required'), { status: 400 });
    if (path.isAbsolute(context.workspaceRef) || /[\\/]/.test(context.workspaceRef)) {
      throw Object.assign(new Error('absolute or path-like workspaceRef is not trusted'), { status: 403 });
    }
    const workspacePath = this.workspaces.get(context.workspaceRef);
    if (!workspacePath) throw Object.assign(new Error(`workspaceRef is not allowed: ${context.workspaceRef}`), { status: 403 });
    if (!fs.existsSync(workspacePath)) {
      if (!this.createMissing) throw Object.assign(new Error('workspace does not exist'), { status: 404 });
      fs.mkdirSync(workspacePath, { recursive: true });
    }
    const real = fs.realpathSync(workspacePath);
    if (!fs.statSync(real).isDirectory()) throw Object.assign(new Error('workspace is not a directory'), { status: 400 });
    return { context, workspacePath: real };
  }
}

module.exports = { ContextResolver };
