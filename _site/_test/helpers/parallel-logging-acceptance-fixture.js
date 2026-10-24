'use strict';
// P-LOG-ACCEPTANCE-01 lane-exclusive fixture (prefix parallel-logging-acceptance-*).
//
// Builds an isolated product data dir with N registered projects and
// pre-written structured log records, mirroring helpers/logging-ui-fixture.js
// (read-only reference) but with multi-project isolation support for
// LOG-003/LOG-005/LOG-006. All directories live under the lane temp root the
// driver installed into TEMP/TMP/TMPDIR (D:/SanQian.Xu/.project-knowledge-test-temp),
// never the developer's real HOME.

const fs = require('node:fs');
const path = require('node:path');
const { StorageLayout } = require('../../lib/storage-layout');
const { SettingsStore } = require('../../lib/settings-store');
const { ProjectRegistryStore } = require('../../lib/project-registry-store');
const { ProjectStore } = require('../../lib/project-store');
const { Logger } = require('../../lib/structured-logger');
const { controlPath } = require('../../lib/runtime-control');
const { makeRepo } = require('../fixtures/make-git-repos');

// The product's runtime-control listens on a filesystem unix socket at
// <dataDir>/runtime-control.sock on POSIX (runtime-control.js:14; Windows uses
// a hashed named pipe). Linux sun_path allows 107 chars (macOS 103), so the
// dataDir path this fixture builds under os.tmpdir() must leave room for the
// 21-char socket name. CI 40075242420 (linux24): the old 'pk-logging-acc-'
// prefix made the logfixr2-normal dataDir 88 chars -> a 109-char socket ->
// net.listen refused it, the server exited 1 before the health gate with empty
// pipes, and normalhook timed out. 'pk-la-' keeps every lane case <= 100 even
// on the CI temp root (/home/runner/work/_temp, 23 chars).
const POSIX_SOCKET_CHAR_LIMIT = 103; // strictest common budget (macOS); all lane cases fit

function assertPosixSocketBudget(dataDir) {
  if (process.platform === 'win32') return dataDir; // named pipe, no sun_path
  const socketPath = controlPath(dataDir);
  if (socketPath.length > POSIX_SOCKET_CHAR_LIMIT) {
    throw new Error(`fixture dataDir makes the POSIX control socket ${socketPath.length} chars (limit ${POSIX_SOCKET_CHAR_LIMIT}): ${dataDir}`);
  }
  return dataDir;
}

async function createLoggingAcceptanceFixture(options = {}) {
  const caseId = options.caseId || 'case';
  const dataDir = assertPosixSocketBudget(fs.mkdtempSync(path.join(require('node:os').tmpdir(), `pk-la-${caseId}-`)));
  if (options.freshProduct !== false) require('../../lib/product-data').initializeProductData(dataDir);
  const knowledgeRoot = path.join(dataDir, 'knowledge-root');
  fs.mkdirSync(knowledgeRoot, { recursive: true });
  const layout = new StorageLayout({ dataDir });
  const settingsStore = new SettingsStore({ layout });
  const registryStore = new ProjectRegistryStore({ layout });
  const projectStore = new ProjectStore({ layout });

  await settingsStore.initialize({
    knowledge: { rootPath: knowledgeRoot },
    logging: { levels: ['trace', 'debug', 'info', 'warn', 'error', 'fatal'], retentionDays: 365, maxTotalSizeMB: 2048 },
  });
  await registryStore.initialize();

  const projects = [];
  for (const spec of options.projects || []) {
    const repo = makeRepo({ kind: 'one-commit' });
    const knowledgePath = path.join(knowledgeRoot, spec.projectId);
    fs.mkdirSync(knowledgePath, { recursive: true });
    await projectStore.create(spec.projectId, {
      displayName: spec.displayName,
      storageName: spec.projectId,
      repoPath: repo.path,
      knowledgePath,
    }, {
      trackingStartCommit: repo.headCommit,
      lastAnalyzedCommit: repo.headCommit,
      hook: { managedVersion: 2, migrationVersion: 2, lastVerifiedAt: new Date().toISOString() },
      index: { dirty: false, generation: 1 },
    });
    await registryStore.add(spec.projectId, { displayName: spec.displayName });
    projects.push({ projectId: spec.projectId, displayName: spec.displayName, repo, knowledgePath, headCommit: repo.headCommit });
  }

  const settings = settingsStore.read().logging;
  const logger = new Logger({ layout, settingsProvider: () => settings });

  return {
    caseId,
    dataDir,
    layout,
    projects,
    logger,
    cleanup() {
      for (const project of projects) { try { project.repo.cleanup(); } catch {} }
      try { fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {}
    },
  };
}

// Fixture-time log writer: records carry the caller's fields verbatim so
// write-time redaction (LOG-006) happens through the real normalizeRecord path.
async function writeProjectLogs(logger, projectId, records) {
  for (const record of records) {
    await logger.log(record.level || 'info', record.event, record.message, {
      projectId,
      projectSlug: projectId,
      projectDisplayName: record.projectDisplayName || projectId,
      operationId: record.operationId || '',
      component: record.component || 'acceptance-driver',
      commitSha: record.commitSha || '',
      context: record.context || {},
      ...(record.error ? { error: record.error } : {}),
    });
  }
}

module.exports = { createLoggingAcceptanceFixture, writeProjectLogs, assertPosixSocketBudget, POSIX_SOCKET_CHAR_LIMIT };
