const fs = require('fs');
const os = require('os');
const path = require('path');
const { StorageLayout } = require('../../lib/storage-layout');
const { SettingsStore } = require('../../lib/settings-store');
const { ProjectRegistryStore } = require('../../lib/project-registry-store');
const { ProjectStore } = require('../../lib/project-store');
const { Logger } = require('../../lib/structured-logger');
const { makeRepo } = require('../fixtures/make-git-repos');

async function createLoggingUiFixture(options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pk-logging-ui-" + process.pid + "-"));
  const knowledgeRoot = path.join(dataDir, "knowledge-root");
  fs.mkdirSync(knowledgeRoot, { recursive: true });
  const repo = makeRepo({ kind: "one-commit" });
  const layout = new StorageLayout({ dataDir });
  const settingsStore = new SettingsStore({ layout });
  const registryStore = new ProjectRegistryStore({ layout });
  const projectStore = new ProjectStore({ layout });
  const projectId = "visual-project";
  const knowledgePath = path.join(knowledgeRoot, projectId);
  fs.mkdirSync(knowledgePath, { recursive: true });

  await settingsStore.initialize({
    knowledge: { rootPath: knowledgeRoot },
    logging: {
      levels: ["trace", "debug", "info", "warn", "error", "fatal"],
      retentionDays: 365,
      maxTotalSizeMB: 2048,
    },
  });
  await registryStore.initialize();
  await projectStore.create(projectId, {
    displayName: "视觉检测知识库",
    storageName: projectId,
    repoPath: repo.path,
    knowledgePath,
  }, {
    trackingStartCommit: repo.headCommit,
    lastAnalyzedCommit: repo.headCommit,
    hook: { managedVersion: 2, migrationVersion: 2, lastVerifiedAt: new Date().toISOString() },
    index: { dirty: false, generation: 7 },
  });
  await registryStore.add(projectId, { displayName: "视觉检测知识库" });

  const logger = new Logger({
    layout,
    settingsProvider: () => settingsStore.read().logging,
  });
  const total = Number(options.totalLogs || 64);
  const levels = ["trace", "debug", "info", "warn", "error", "fatal"];
  for (let index = 0; index < total; index += 1) {
    const level = levels[index % levels.length];
    const operationId = index < 4 ? "op-flow-visual" : "op-" + String(index).padStart(3, "0");
    const input = {
      component: index % 2 ? "commit-reconciler" : "knowledge-promotion",
      projectId: index === 7 ? "deleted-project" : projectId,
      projectDisplayName: index === 7 ? "已删除的旧项目" : "视觉检测知识库",
      projectDeleted: index === 7,
      operationId,
      runId: "run-" + Math.floor(index / 4),
      commitSha: repo.headCommit,
      phase: ["scanning", "claim.created", "markdown.promoted", "index.applied"][index % 4],
      attempt: index % 3,
      durationMs: 17 + index * 13,
      context: {
        repoPath: index === 6 ? "C:\\Users\\Example User\\Documents\\very-long-workspace\\机器视觉项目\\source" : repo.path,
        fixture: index === 5 ? "<img src=x onerror=window.__xss=1>" : "safe",
      },
    };
    if (index === 3) {
      const validationError = Object.assign(new Error("模型输出校验失败 <script>window.__xss=1</script>"), { code: "VALIDATION_FAILED" });
      validationError.stack += "\n" + Array.from({ length: 24 }, (_, line) => "    at promotionStep" + line + " (C:\\Users\\Example User\\Documents\\very-long-workspace\\机器视觉项目\\promotion.js:" + (line + 10) + ":7)").join("\n");
      input.error = validationError;
    }
    await logger.log(level, "fixture.phase." + index, index === 5 ? "<img src=x onerror=window.__xss=1>" : "诊断事件 " + index, input);
  }
  await logger.close();

  return {
    dataDir,
    layout,
    projectId,
    repo,
    cleanup() {
      try { repo.cleanup(); } catch {}
      try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
    },
  };
}

module.exports = { createLoggingUiFixture };
