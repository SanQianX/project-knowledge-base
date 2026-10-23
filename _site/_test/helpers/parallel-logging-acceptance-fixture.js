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
const { makeRepo } = require('../fixtures/make-git-repos');

async function createLoggingAcceptanceFixture(options = {}) {
  const caseId = options.caseId || 'case';
  const dataDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), `pk-logging-acc-${caseId}-`));
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

module.exports = { createLoggingAcceptanceFixture, writeProjectLogs };
