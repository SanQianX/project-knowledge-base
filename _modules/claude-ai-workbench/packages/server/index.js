'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { configureWorkbench } = loadLegacyRuntime('runtime-config');
const { getDataDir } = loadLegacyRuntime('data-dir');
const { DEFAULT_API_PREFIX } = require('../contracts');
const { ProfileStore } = require('./lib/profile-store');
const { ContextResolver } = require('./lib/context-resolver');
const { WorkbenchService } = require('./lib/workbench-service');
const { AttachmentStore } = require('./lib/attachment-store');
const { ProjectStore } = require('./lib/project-store');
const { SessionArchiveStore } = require('./lib/session-archive-store');
const { AgentRegistry } = require('./lib/agent-registry');
const { createAgentDiscovery } = require('./lib/agent-discovery');
const { createModelDetection } = require('./lib/model-detection');
const { createCodexDriver } = require('./lib/drivers/codex-driver');
const { createOpenCodeDriver } = require('./lib/drivers/opencode-driver');
const { createZCodeDriver } = require('./lib/drivers/zcode-driver');
const { createHttpHandler } = require('./lib/http-handler');

function createWorkbenchServer(options = {}) {
  if (options.dataDir) configureWorkbench({ dataDir: options.dataDir });
  const dataDir = path.resolve(options.dataDir || getDataDir());
  const apiPrefix = options.apiPrefix || DEFAULT_API_PREFIX;
  const testRoot = path.join(dataDir, 'test-workspaces');
  const projects = options.projects || new ProjectStore({ dataDir });
  const sessionArchive = options.sessionArchive || new SessionArchiveStore({ dataDir });
  const workspaces = {
    'test-workspace-a': path.join(testRoot, 'context-a'),
    'test-workspace-b': path.join(testRoot, 'context-b'),
    'test-workspace-c': path.join(testRoot, 'context-c'),
    ...(options.workspaces || {}),
    ...projects.toWorkspaceMap(),
  };
  const profiles = options.profiles || new ProfileStore({ dataDir });
  const attachments = options.attachments || new AttachmentStore({ root: path.join(dataDir, 'attachments') });
  const contexts = options.contexts || new ContextResolver({ workspaces, createMissing: options.createMissingWorkspaces !== false });
  const claudeDriver = options.runner || loadLegacyRuntime('claude-cli-runner');
  const registry = options.registry || new AgentRegistry({
    drivers: {
      'claude-code': claudeDriver,
      ...(options.drivers || {
        codex: createCodexDriver(),
        opencode: createOpenCodeDriver(),
        zcode: createZCodeDriver(),
      }),
    },
  });
  const runner = registry.asRunner();
  const agentDiscovery = options.agentDiscovery || createAgentDiscovery({
    claudeProbe: () => {
      try {
        const executable = claudeDriver.findClaudeExecutableForSdk();
        return { available: Boolean(executable), version: null };
      } catch { return { available: false, version: null }; }
    },
  });
  const modelContextWindows = options.modelContextWindows || safeLoad('model-context-windows');
  const modelDetection = options.modelDetection || createModelDetection({
    contextLookup: modelContextWindows && modelContextWindows.lookupContextWindow,
  });
  const service = options.service || new WorkbenchService({
    runner, profiles, contexts, attachments, apiPrefix,
    projects, sessionArchive, agentDiscovery, modelContextWindows, modelDetection,
    testWorkspace: path.join(testRoot, 'profile-test'), auditFile: path.join(dataDir, 'audit.jsonl'),
    version: options.version || '0.3.0', maxSessions: options.maxSessions, maxConcurrentRuns: options.maxConcurrentRuns,
  });
  const handleApi = createHttpHandler(service, { apiPrefix, corsOrigin: options.corsOrigin });
  const distributionRoot = resolveDistributionRoot();
  const staticRoot = path.resolve(options.staticRoot || path.join(distributionRoot, 'apps', 'minimal-test-host'));
  const profileSettingsRoot = path.resolve(options.profileSettingsRoot || path.join(distributionRoot, 'apps', 'ai-profile-settings-host'));
  const terminalHostRoot = path.resolve(options.terminalHostRoot || path.join(distributionRoot, 'apps', 'claude-terminal-host'));
  const agentTerminalRoot = path.resolve(options.agentTerminalRoot || path.join(distributionRoot, 'apps', 'agent-terminal'));
  const packagesRoot = path.join(distributionRoot, 'packages');
  const referenceUiRoot = path.join(distributionRoot, 'docs', 'claude-ai-workbench-codex-kit-v2', 'claude-ai-workbench-codex-kit-v2', 'reference-ui');
  const server = http.createServer(async (req, res) => {
    if (await handleApi(req, res)) return;
    if (options.serveHost !== false && serveMappedAsset(req, res, '/reference-ui/', referenceUiRoot)) return;
    if (options.serveHost !== false && servePackageAsset(req, res, packagesRoot)) return;
    if (options.serveHost !== false && serveAppStatic(req, res, '/profile-settings/', profileSettingsRoot)) return;
    if (options.serveHost !== false && serveAppStatic(req, res, '/terminal/', terminalHostRoot)) return;
    if (options.serveHost !== false && serveAppStatic(req, res, '/agent-terminal/', agentTerminalRoot)) return;
    if (options.serveHost !== false && serveStatic(req, res, staticRoot)) return;
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: 'not found' }));
  });
  server.on('close', () => service.destroy());
  return { server, service, profiles, contexts, attachments, projects, sessionArchive, registry, agentDiscovery, apiPrefix, dataDir };
}

function serveMappedAsset(req, res, urlPrefix, assetRoot) {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (req.method !== 'GET' || !url.pathname.startsWith(urlPrefix)) return false;
  const relative = decodeURIComponent(url.pathname.slice(urlPrefix.length));
  const file = path.resolve(assetRoot, relative);
  if (!file.startsWith(`${assetRoot}${path.sep}`) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' }[path.extname(file)] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res); return true;
}

function loadLegacyRuntime(name) {
  const bundled = path.join(__dirname, 'legacy', 'src', 'backend', 'lib', name);
  if (fs.existsSync(`${bundled}.js`)) return require(bundled);
  return require(path.join(__dirname, '..', '..', 'src', 'backend', 'lib', name));
}

function safeLoad(name) {
  try { return loadLegacyRuntime(name); } catch { return null; }
}

function resolveDistributionRoot() {
  try { return path.dirname(require.resolve('claude-ai-workbench/package.json')); }
  catch { return path.resolve(__dirname, '..', '..'); }
}

function servePackageAsset(req, res, packagesRoot) {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (req.method !== 'GET' || !url.pathname.startsWith('/packages/')) return false;
  const relative = decodeURIComponent(url.pathname.slice('/packages/'.length));
  const file = path.resolve(packagesRoot, relative);
  if (!file.startsWith(`${packagesRoot}${path.sep}`) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  const type = path.extname(file) === '.css' ? 'text/css' : 'text/javascript';
  res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res); return true;
}

function serveStatic(req, res, root) {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (!['GET', 'HEAD'].includes(req.method)) return false;
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') { res.writeHead(302, { Location: '/terminal/' }); res.end(); return true; }
  if (!pathname.startsWith('/test-host/')) return false;
  const relative = pathname.slice('/test-host/'.length) || 'index.html';
  const file = path.resolve(root, relative);
  if (file !== root && !file.startsWith(`${root}${path.sep}`)) return false;
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' }[path.extname(file)] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' });
  if (req.method === 'HEAD') res.end(); else fs.createReadStream(file).pipe(res);
  return true;
}

function serveAppStatic(req, res, urlPrefix, root) {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (!['GET', 'HEAD'].includes(req.method)) return false;
  if (url.pathname === urlPrefix.slice(0, -1)) { res.writeHead(302, { Location: urlPrefix }); res.end(); return true; }
  if (!url.pathname.startsWith(urlPrefix)) return false;
  const relative = decodeURIComponent(url.pathname.slice(urlPrefix.length)) || 'index.html';
  const file = path.resolve(root, relative);
  if (file !== root && !file.startsWith(`${root}${path.sep}`)) return false;
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' }[path.extname(file)] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' });
  if (req.method === 'HEAD') res.end(); else fs.createReadStream(file).pipe(res);
  return true;
}

module.exports = {
  createWorkbenchServer, ProfileStore, ContextResolver, AttachmentStore, WorkbenchService, createHttpHandler,
  ProjectStore, SessionArchiveStore, AgentRegistry, createAgentDiscovery,
  createCodexDriver, createOpenCodeDriver, createZCodeDriver,
};
