'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { normalizeProject } = require('../../contracts');
const { readJson, writeJson } = require('./json-file');

const SCHEMA = 'agent-terminal-projects/v1';

// Registry of user-created workspaces. Each project binds a display name to
// an absolute local directory; its projectId doubles as the ContextResolver
// workspaceRef so sessions inherit project ownership for free.
class ProjectStore {
  constructor(options = {}) {
    if (!options.dataDir) throw new Error('ProjectStore dataDir is required');
    this.projectFile = options.projectFile || path.join(options.dataDir, 'projects.v1.json');
  }

  _read() { return readJson(this.projectFile, { schema: SCHEMA, projects: [] }); }
  _write(cfg) { writeJson(this.projectFile, cfg); }

  list() {
    return this._read().projects
      .slice()
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  }

  get(id) {
    return this._read().projects.find(item => item.id === id) || null;
  }

  create(input = {}) {
    const cfg = this._read();
    const rootPath = resolveExistingDirectory(input.rootPath);
    const project = normalizeProject({ ...input, rootPath }, generateProjectId(cfg));
    cfg.projects.push(project);
    this._write(cfg);
    return project;
  }

  rename(id, name) {
    return this.update(id, { name });
  }

  update(id, input = {}) {
    const cfg = this._read();
    const index = cfg.projects.findIndex(item => item.id === id);
    if (index < 0) throw Object.assign(new Error('project not found'), { status: 404 });
    const current = cfg.projects[index];
    const next = normalizeProject({
      ...current,
      ...Object.fromEntries(['name', 'defaultAiProfileId', 'defaultModel', 'defaultAgentId']
        .filter(key => Object.prototype.hasOwnProperty.call(input, key)).map(key => [key, input[key]])),
      rootPath: current.rootPath, createdAt: current.createdAt,
    }, current.id);
    next.updatedAt = new Date().toISOString();
    cfg.projects[index] = next;
    this._write(cfg);
    return next;
  }

  remove(id) {
    const cfg = this._read();
    if (!cfg.projects.some(item => item.id === id)) return false;
    cfg.projects = cfg.projects.filter(item => item.id !== id);
    this._write(cfg);
    return true;
  }

  toWorkspaceMap() {
    const map = {};
    for (const project of this.list()) map[project.id] = project.rootPath;
    return map;
  }
}

function generateProjectId(cfg) {
  const taken = new Set(cfg.projects.map(item => item.id));
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const id = `prj-${crypto.randomBytes(5).toString('hex')}`;
    if (!taken.has(id)) return id;
  }
  throw new Error('unable to allocate a project id');
}

function resolveExistingDirectory(rootPath) {
  const value = String(rootPath || '').trim();
  if (!value) throw Object.assign(new Error('project rootPath is required'), { status: 400 });
  let real;
  try {
    real = fs.realpathSync(path.resolve(value));
  } catch {
    throw Object.assign(new Error(`project directory does not exist: ${value}`), { status: 400 });
  }
  if (!fs.statSync(real).isDirectory()) {
    throw Object.assign(new Error(`project rootPath is not a directory: ${value}`), { status: 400 });
  }
  return real;
}

module.exports = { ProjectStore };
