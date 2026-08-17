const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { DomainError, createId } = require('./contracts');
const AtomicFile = require('./atomic-file');
const hookManagerDefault = require('./hook-manager');

function slugify(value) {
  const slug = String(value || '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'project';
}

function runGit(repoPath, args, options = {}) {
  const result = spawnSync('git', ['-C', repoPath, ...args], {
    encoding: 'utf8', windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  if (result.status !== 0 && !options.allowFailure) {
    throw new DomainError('INVALID_ARGUMENT', 'Git operation failed.', { status: 400, details: { args: args.join(' '), exitCode: result.status, gitError: String(result.stderr || '').trim().slice(0, 1000) } });
  }
  return { ok: result.status === 0, stdout: String(result.stdout || '').trim(), stderr: String(result.stderr || '').trim(), status: result.status };
}

class ProjectLifecycleService {
  constructor(options = {}) {
    this.layout = options.layout;
    this.settingsStore = options.settingsStore;
    this.registryStore = options.registryStore;
    this.projectStore = options.projectStore;
    this.hookManager = options.hookManager || hookManagerDefault;
    this.triggerScriptPath = options.triggerScriptPath;
    this.logger = options.logger || { child() { return this; }, info() {}, warn() {}, error() {} };
    this.isProjectBusy = options.isProjectBusy || (() => false);
  }

  transactionPath(operationId) { return this.layout.getRuntimePath('transactions', `${operationId}.json`); }

  writeJournal(journal) {
    journal.updatedAt = new Date().toISOString();
    AtomicFile.writeJsonAtomic(this.transactionPath(journal.operationId), journal);
  }

  listConfigs() {
    const configs = [];
    for (const projectId of this.registryStore.listIds()) configs.push(this.projectStore.readConfig(projectId));
    return configs;
  }

  inspectOrInitializeGit(repoPath, journal) {
    const inside = runGit(repoPath, ['rev-parse', '--is-inside-work-tree'], { allowFailure: true });
    if (!inside.ok) {
      const initialized = runGit(repoPath, ['init']);
      journal.gitInitialized = initialized.ok;
    }
    const top = runGit(repoPath, ['rev-parse', '--show-toplevel']).stdout;
    const commonDir = runGit(repoPath, ['rev-parse', '--path-format=absolute', '--git-common-dir']).stdout;
    const head = runGit(repoPath, ['rev-parse', '--verify', 'HEAD'], { allowFailure: true });
    return { repoPath: path.resolve(top), commonDir: path.resolve(commonDir), head: head.ok ? head.stdout : null };
  }

  async importProject(input = {}) {
    const operationId = input.operationId || createId('op');
    const log = this.logger.child ? this.logger.child({ component: 'project-lifecycle', operationId }) : this.logger;
    const journal = { schema: 'project-import-transaction/v1', operationId, phase: 'started', created: {}, startedAt: new Date().toISOString() };
    this.writeJournal(journal);
    await log.info?.('project.import.started', 'Project import started.', { phase: 'validate' });
    try {
      const localPath = path.resolve(String(input.localPath || '').trim());
      if (!input.localPath || !fs.existsSync(localPath) || !fs.statSync(localPath).isDirectory()) throw new DomainError('INVALID_ARGUMENT', 'localPath must be an existing directory.', { status: 400, operationId });
      const settings = this.settingsStore.read();
      const knowledgeRoot = this.layout.getKnowledgeRootPath(settings);
      this.layout.validateKnowledgeRoot(knowledgeRoot);
      const git = this.inspectOrInitializeGit(localPath, journal);
      for (const config of this.listConfigs()) {
        if (this.layout.pathsEqual(config.repoPath, git.repoPath) || (config.repoIdentity && this.layout.pathsEqual(config.repoIdentity.commonDir, git.commonDir))) {
          throw new DomainError('INVALID_ARGUMENT', 'This Git repository is already imported.', { status: 409, operationId });
        }
      }
      const projectId = input.projectId || `project-${crypto.randomUUID()}`;
      const displayName = String(input.displayName || path.basename(git.repoPath));
      const storageName = input.storageName || `${slugify(displayName)}-${projectId.replace(/[^a-z0-9]/gi, '').slice(-6).toLowerCase()}`;
      const team = this.normalizeTeamBinding(input.teamBinding || input.teamKnowledgeBase);
      const knowledgePath = team ? team.knowledgePath : this.layout.resolveNewProjectKnowledgePath(storageName, settings);
      if (team) {
        if (!fs.existsSync(knowledgePath) || !fs.statSync(knowledgePath).isDirectory()) {
          throw new DomainError('INVALID_ARGUMENT', 'The selected team knowledge directory does not exist.', { status: 400, operationId });
        }
      } else {
        if (fs.existsSync(knowledgePath) && fs.readdirSync(knowledgePath).length > 0) throw new DomainError('MIGRATION_TARGET_CONFLICT', 'The project knowledge directory is not empty.', { status: 409, operationId });
        if (!fs.existsSync(knowledgePath)) {
          fs.mkdirSync(knowledgePath, { recursive: true });
          journal.created.knowledgeDirectory = knowledgePath;
        }
      }
      journal.phase = 'paths-prepared';
      journal.projectId = projectId;
      journal.repoPath = git.repoPath;
      journal.knowledgePath = knowledgePath;
      this.writeJournal(journal);
      const created = await this.projectStore.create(projectId, {
        displayName, storageName, repoPath: git.repoPath, knowledgePath,
        enabled: true, aiProfileId: input.aiProfileId || null,
        knowledgeLanguage: input.knowledgeLanguage || 'zh-CN',
        teamBinding: team ? team.binding : null,
        repoIdentity: { commonDir: git.commonDir },
      }, git.head ? { trackingStartCommit: git.head, trackingMode: 'normal' } : { trackingStartCommit: null, trackingMode: 'empty-repo' });
      journal.created.metadata = this.layout.getProjectMetadataDir(projectId);
      journal.phase = 'metadata-created';
      this.writeJournal(journal);
      const hook = this.hookManager.installHook({ repoPath: git.repoPath, projectId, triggerScriptPath: this.triggerScriptPath });
      journal.created.hookPath = hook.hookPath;
      journal.phase = 'hook-verified';
      this.writeJournal(journal);
      await this.registryStore.add(projectId, { createdAt: created.config.createdAt, displayNameSnapshot: displayName });
      journal.created.registry = true;
      journal.phase = 'completed';
      journal.completedAt = new Date().toISOString();
      this.writeJournal(journal);
      await log.info?.('project.import.completed', 'Project import completed.', { projectId, phase: 'registry-commit', durationMs: Date.now() - Date.parse(journal.startedAt) });
      return { ok: true, operationId, projectId, config: created.config, state: created.state, hook, gitInitialized: journal.gitInitialized === true };
    } catch (error) {
      const rollbackWarnings = await this.rollbackImport(journal);
      journal.phase = 'failed';
      journal.failedAt = new Date().toISOString();
      journal.error = { code: error.code || '', message: String(error.message || error) };
      journal.rollbackWarnings = rollbackWarnings;
      this.writeJournal(journal);
      await log.error?.('project.import.failed', 'Project import failed.', { projectId: journal.projectId || '', phase: journal.phase, error, context: { rollbackWarnings } });
      if (error instanceof DomainError) throw error;
      throw new DomainError('INVALID_ARGUMENT', 'Project import failed.', { status: 500, operationId, cause: error, details: { rollbackWarnings } });
    }
  }

  normalizeTeamBinding(input) {
    if (!input) return null;
    if (typeof input !== 'object' || Array.isArray(input)) throw new DomainError('INVALID_ARGUMENT', 'teamBinding must be an object.');
    const storePath = path.resolve(String(input.storePath || input.storeLocalPath || input.kbStorePath || '').trim());
    const rawSubdir = String(input.kbSubdir || input.path || '').trim().replace(/\\/g, '/');
    if (!String(input.storePath || input.storeLocalPath || input.kbStorePath || '').trim() || !rawSubdir) {
      throw new DomainError('INVALID_ARGUMENT', 'Team knowledge requires storePath and kbSubdir.');
    }
    if (path.isAbsolute(rawSubdir) || rawSubdir.split('/').some(part => !part || part === '.' || part === '..')) {
      throw new DomainError('PATH_OUTSIDE_ROOT', 'Team knowledge kbSubdir is invalid.', { status: 403 });
    }
    const knowledgePath = path.resolve(storePath, ...rawSubdir.split('/'));
    if (!this.layout.isPathInside(storePath, knowledgePath)) {
      throw new DomainError('PATH_OUTSIDE_ROOT', 'Team knowledge must stay inside the selected store.', { status: 403 });
    }
    const provider = String(input.provider || input.teamProvider || 'github').trim().toLowerCase();
    if (!['github', 'gitea'].includes(provider)) throw new DomainError('INVALID_ARGUMENT', 'Unsupported team knowledge provider.');
    return {
      knowledgePath,
      binding: {
        schema: 'team-binding/v1',
        provider,
        storePath,
        storeRemoteUrl: String(input.storeRemoteUrl || input.kbStoreRemoteUrl || input.cloneUrl || ''),
        storeId: String(input.storeId || input.kbStoreId || ''),
        storeFullName: String(input.storeFullName || input.kbStoreFullName || ''),
        branch: String(input.branch || input.defaultBranch || 'main'),
        kbId: String(input.kbId || path.basename(knowledgePath)),
        kbSlug: String(input.kbSlug || input.slug || path.basename(knowledgePath)),
        kbSubdir: rawSubdir,
        displayName: String(input.displayName || input.kbDisplayName || path.basename(knowledgePath)),
      },
    };
  }

  async rollbackImport(journal) {
    const warnings = [];
    if (journal.created.registry && journal.projectId) {
      try { await this.registryStore.remove(journal.projectId); } catch (error) { warnings.push(`registry:${error.message}`); }
    }
    if (journal.created.hookPath && journal.projectId && journal.repoPath) {
      try { this.hookManager.uninstallHook({ repoPath: journal.repoPath, projectId: journal.projectId }); } catch (error) { warnings.push(`hook:${error.message}`); }
    }
    if (journal.created.metadata && fs.existsSync(journal.created.metadata)) {
      try { fs.rmSync(journal.created.metadata, { recursive: true, force: true }); } catch (error) { warnings.push(`metadata:${error.message}`); }
    }
    if (journal.created.knowledgeDirectory && fs.existsSync(journal.created.knowledgeDirectory)) {
      try {
        if (fs.readdirSync(journal.created.knowledgeDirectory).length === 0) fs.rmdirSync(journal.created.knowledgeDirectory);
        else warnings.push('knowledge:ROLLBACK_ASSET_PRESERVED');
      } catch (error) { warnings.push(`knowledge:${error.message}`); }
    }
    if (journal.gitInitialized) warnings.push('git:ROLLBACK_ASSET_PRESERVED');
    return warnings;
  }

  async deleteProject(projectId, options = {}) {
    const operationId = options.operationId || createId('op');
    const log = this.logger.child ? this.logger.child({ component: 'project-lifecycle', operationId, projectId }) : this.logger;
    if (await this.isProjectBusy(projectId)) throw new DomainError('PROJECT_BUSY', 'Project has an active reconciliation or AI run.', { status: 409, retryable: true, operationId });
    const config = this.projectStore.readConfig(projectId);
    if (options.deleteKnowledge === true && options.confirmationToken !== projectId) {
      throw new DomainError('INVALID_ARGUMENT', 'Explicit projectId confirmation is required to delete knowledge.', { status: 409, operationId });
    }
    let hook;
    if (fs.existsSync(config.repoPath)) {
      hook = this.hookManager.uninstallHook({ repoPath: config.repoPath, projectId });
    } else {
      hook = { ok: true, removed: false, reason: 'repository-missing' };
    }
    await this.registryStore.remove(projectId);
    const metadataDir = this.layout.getProjectMetadataDir(projectId);
    if (fs.existsSync(metadataDir)) fs.rmSync(metadataDir, { recursive: true, force: true });
    let removedKnowledge = false;
    if (options.deleteKnowledge === true && !config.teamBinding) {
      if (fs.existsSync(config.knowledgePath)) {
        fs.rmSync(config.knowledgePath, { recursive: true, force: true });
        removedKnowledge = true;
      }
    }
    await log.info?.('project.delete.completed', 'Project deleted.', { phase: 'completed', context: { hook, externalKnowledgePreserved: !removedKnowledge } });
    return { ok: true, operationId, projectId, hook, removedKnowledge, knowledgePath: config.knowledgePath };
  }
}

module.exports = { ProjectLifecycleService, slugify, runGit };
