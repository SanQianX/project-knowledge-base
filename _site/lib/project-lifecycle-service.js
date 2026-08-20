const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { DomainError, createId } = require('./contracts');
const AtomicFile = require('./atomic-file');
const hookManagerDefault = require('./hook-manager');
const { resolveEffectiveAiProfile } = require('./ai-profile-resolver');

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
    this.bridgeAdapter = options.bridgeAdapter || null;
    this.fault = options.fault || (() => {});
  }

  // T06: pure preflight — does NOT mutate any state. Reports every
  // prerequisite the UI must show before the user clicks Import. Any
  // missing prerequisite is surfaced as a `problems[]` entry with an
  // actionable message and an `action` the UI can offer (e.g. a
  // "Configure knowledge root" link). The shape is intentionally flat so
  // the UI can render it directly without per-field branching.
  async preflightImport(input = {}) {
    const localPath = String(input.localPath || '').trim();
    const settings = this.settingsStore.read();
    const problems = [];
    const checks = {};
    let knowledgeRoot = '';
    try {
      knowledgeRoot = this.layout.getKnowledgeRootPath(settings);
    } catch (error) {
      if (error && error.code === 'INVALID_ARGUMENT') {
        problems.push({ code: 'KNOWLEDGE_ROOT_MISSING', message: 'Knowledge root is not configured.', action: 'CONFIGURE_KNOWLEDGE_ROOT' });
        checks.knowledgeRoot = { ok: false, reason: 'unconfigured' };
      } else {
        throw error;
      }
    }

    // Check 1: path exists and is a directory.
    if (!localPath) {
      problems.push({ code: 'PATH_REQUIRED', message: 'A local repository path is required.', action: 'CHOOSE_PATH' });
      checks.path = { ok: false, reason: 'missing' };
    } else if (!fs.existsSync(localPath) || !fs.statSync(localPath).isDirectory()) {
      problems.push({ code: 'PATH_MISSING', message: 'The selected path does not exist or is not a directory.', action: 'CHOOSE_PATH' });
      checks.path = { ok: false, reason: 'not-a-directory' };
    } else {
      checks.path = { ok: true };
    }

    // Check 2: git repository or can be initialized.
    let repoInspection = null;
    let plannedGitInit = false;
    if (checks.path.ok) {
      const inside = runGit(localPath, ['rev-parse', '--is-inside-work-tree'], { allowFailure: true });
      if (!inside.ok) {
        plannedGitInit = true;
        checks.git = { ok: false, status: 'non-git', plannedInit: true, message: 'Directory is not a Git repository. Import will run `git init` before proceeding.' };
      } else {
        const top = runGit(localPath, ['rev-parse', '--show-toplevel']);
        const head = runGit(localPath, ['rev-parse', '--verify', 'HEAD'], { allowFailure: true });
        const commonDir = runGit(localPath, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
        const branch = runGit(localPath, ['branch', '--show-current'], { allowFailure: true });
        repoInspection = {
          ok: true,
          repoPath: top.ok ? path.resolve(top.stdout) : path.resolve(localPath),
          commonDir: commonDir.ok ? path.resolve(commonDir.stdout) : '',
          headCommit: head.ok ? head.stdout : null,
          branch: branch.ok ? branch.stdout : '',
          emptyRepo: !head.ok,
        };
        checks.git = { ok: true, status: repoInspection.emptyRepo ? 'empty' : 'ok', repoPath: repoInspection.repoPath, commonDir: repoInspection.commonDir, headCommit: repoInspection.headCommit, branch: repoInspection.branch };
      }
    }

    // Check 3: knowledge root configured + writable.
    if (!knowledgeRoot) {
      problems.push({ code: 'KNOWLEDGE_ROOT_MISSING', message: 'Knowledge root is not configured.', action: 'CONFIGURE_KNOWLEDGE_ROOT' });
      checks.knowledgeRoot = { ok: false, reason: 'unconfigured' };
    } else if (!fs.existsSync(knowledgeRoot)) {
      try {
        fs.mkdirSync(knowledgeRoot, { recursive: true });
      } catch (error) {
        problems.push({ code: 'KNOWLEDGE_ROOT_NOT_WRITABLE', message: `Knowledge root is not writable: ${error.message}`, action: 'CONFIGURE_KNOWLEDGE_ROOT' });
        checks.knowledgeRoot = { ok: false, reason: 'not-writable', path: knowledgeRoot };
      }
      checks.knowledgeRoot = checks.knowledgeRoot || { ok: true, path: knowledgeRoot, created: true };
    } else {
      try {
        fs.accessSync(knowledgeRoot, fs.constants.W_OK);
        checks.knowledgeRoot = { ok: true, path: knowledgeRoot };
      } catch (error) {
        problems.push({ code: 'KNOWLEDGE_ROOT_NOT_WRITABLE', message: `Knowledge root is not writable: ${error.message}`, action: 'CONFIGURE_KNOWLEDGE_ROOT' });
        checks.knowledgeRoot = { ok: false, reason: 'not-writable', path: knowledgeRoot };
      }
    }

    // Check 4: effective AI profile availability.
    let aiProfile = null;
    try {
      const resolved = resolveEffectiveAiProfile(settings, { aiProfileId: input.aiProfileId || null });
      aiProfile = { id: resolved.profileId, source: resolved.source };
      checks.aiProfile = { ok: true, ...aiProfile };
    } catch (error) {
      if (error && error.code === 'AI_PROFILE_REQUIRED') {
        problems.push({ code: 'AI_PROFILE_REQUIRED', message: 'No usable AI profile is configured. Configure one before importing.', action: 'CONFIGURE_AI_PROFILE' });
        checks.aiProfile = { ok: false };
      } else {
        throw error;
      }
    }

    // Check 5: duplicate / already-managed project.
    if (repoInspection && repoInspection.ok) {
      for (const config of this.listConfigs()) {
        if (this.layout.pathsEqual(config.repoPath, repoInspection.repoPath)
          || (config.repoIdentity && config.repoIdentity.commonDir && repoInspection.commonDir
              && this.layout.pathsEqual(config.repoIdentity.commonDir, repoInspection.commonDir))) {
          problems.push({ code: 'DUPLICATE_PROJECT', message: 'This Git repository is already managed by another project.', action: 'OPEN_EXISTING_PROJECT', existingProjectId: config.projectId });
          checks.duplicate = { ok: false, existingProjectId: config.projectId };
          break;
        }
      }
      if (!checks.duplicate) checks.duplicate = { ok: true };
    }

    // Check 6: existing non-managed hook conflict.
    if (repoInspection && repoInspection.ok) {
      try {
        const hookStatus = this.hookManager.readHookStatus({ repoPath: repoInspection.repoPath });
        if (!hookStatus.kbManaged && hookStatus.reason && /third-party/i.test(hookStatus.reason)) {
          problems.push({ code: 'HOOK_CONFLICT', message: 'A third-party post-commit hook is installed. Project-Knowledge will not overwrite it.', action: 'INSPECT_HOOK' });
          checks.hook = { ok: false, reason: 'third-party' };
        } else if (!hookStatus.kbManaged && hookStatus.reason && /legacy managed hook/i.test(hookStatus.reason)) {
          // Legacy v1 hook: import will replace it; that's the migration
          // path (T03 case 2), not a conflict.
          checks.hook = { ok: true, reason: 'legacy-v1' };
        } else {
          checks.hook = { ok: true };
        }
      } catch (error) {
        checks.hook = { ok: true, reason: 'no-hooks-dir' };
      }
    }

    // Check 7: knowledge language selection (zh-CN / en-US).
    const requestedLanguage = input.knowledgeLanguage || 'zh-CN';
    if (!['zh-CN', 'en-US'].includes(requestedLanguage)) {
      problems.push({ code: 'KNOWLEDGE_LANGUAGE_INVALID', message: `knowledgeLanguage must be 'zh-CN' or 'en-US'; got '${requestedLanguage}'.`, action: 'CHOOSE_LANGUAGE' });
      checks.knowledgeLanguage = { ok: false, requested: requestedLanguage };
    } else {
      checks.knowledgeLanguage = { ok: true, value: requestedLanguage };
    }

    // Check 8: optional team binding compatibility.
    let teamBinding = null;
    if (input.teamBinding) {
      try {
        teamBinding = this.normalizeTeamBinding(input.teamBinding);
        if (!fs.existsSync(teamBinding.knowledgePath) || !fs.statSync(teamBinding.knowledgePath).isDirectory()) {
          problems.push({ code: 'TEAM_KB_MISSING', message: 'The selected team knowledge directory does not exist.', action: 'CHOOSE_TEAM_STORE' });
          checks.teamBinding = { ok: false, reason: 'missing' };
        } else {
          checks.teamBinding = { ok: true };
        }
      } catch (error) {
        problems.push({ code: 'TEAM_BINDING_INVALID', message: error.message, action: 'CHOOSE_TEAM_STORE' });
        checks.teamBinding = { ok: false };
      }
    }

    const ready = problems.length === 0;
    return {
      ok: ready,
      ready,
      plannedGitInit,
      problems,
      checks,
      effective: {
        aiProfile,
        knowledgeRoot: checks.knowledgeRoot && checks.knowledgeRoot.path || null,
        knowledgeLanguage: checks.knowledgeLanguage && checks.knowledgeLanguage.value || null,
        teamBinding: !!teamBinding,
      },
    };
  }

  transactionPath(operationId) { return this.layout.getRuntimePath('transactions', `${operationId}.json`); }
  deleteTransactionPath(projectId) { return this.layout.getRuntimePath('deletions', `${projectId}.json`); }

  readDeleteJournal(projectId) {
    return AtomicFile.readJsonStrict(this.deleteTransactionPath(projectId), {
      allowMissing: true,
      defaultValue: null,
      category: 'project-delete-transaction',
      validate: journal => {
        if (!journal || journal.schema !== 'project-delete-transaction/v1' || journal.projectId !== projectId || !journal.config || !journal.steps) {
          throw new DomainError('DATA_CORRUPT', 'Project delete transaction is corrupt.', { status: 500 });
        }
        return journal;
      },
    });
  }

  hasPendingDeletion(projectId) {
    const journal = this.readDeleteJournal(projectId);
    return Boolean(journal && journal.phase !== 'completed');
  }

  writeDeleteJournal(journal) {
    journal.updatedAt = new Date().toISOString();
    AtomicFile.writeJsonAtomic(this.deleteTransactionPath(journal.projectId), journal);
  }

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
      // Canonical workspace identity comes from the Bridge package; the old
      // PK-only { commonDir } shape is never written for new imports.
      const identityResult = this.bridgeAdapter && typeof this.bridgeAdapter.resolveRepoIdentity === 'function'
        ? await this.bridgeAdapter.resolveRepoIdentity(git.repoPath)
        : { status: 'unavailable', repoIdentity: null, reason: 'bridge-adapter-unavailable' };
      const repoIdentityV1 = identityResult.status === 'ok' ? identityResult.repoIdentity : null;
      const conversationBaseline = this.bridgeAdapter && typeof this.bridgeAdapter.getHighWatermark === 'function'
        ? await this.bridgeAdapter.getHighWatermark({ projectId, repoIdentity: repoIdentityV1, repoPath: git.repoPath })
        : { status: 'unavailable', cursor: null, reason: 'bridge-adapter-unavailable' };
      const stateInput = git.head
        ? { trackingStartCommit: git.head, trackingMode: 'normal' }
        : { trackingStartCommit: null, trackingMode: 'empty-repo' };
      stateInput.conversationBaselineCursor = conversationBaseline.cursor;
      stateInput.conversation = {
        lastConsumedCursor: conversationBaseline.cursor,
        captureStatus: conversationBaseline.status,
        lastError: conversationBaseline.status === 'captured' ? null : { reason: conversationBaseline.reason || 'unavailable' },
      };
      if (!repoIdentityV1) {
        stateInput.conversation.repoIdentityStatus = identityResult.reason || 'repo-identity-unavailable';
      }
      const created = await this.projectStore.create(projectId, {
        displayName, storageName, repoPath: git.repoPath, knowledgePath,
        enabled: true, aiProfileId: input.aiProfileId || null,
        knowledgeLanguage: input.knowledgeLanguage || 'zh-CN',
        teamBinding: team ? team.binding : null,
        repoIdentity: repoIdentityV1 || null,
      }, stateInput);
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
    let journal = this.readDeleteJournal(projectId);
    const operationId = journal && journal.operationId || options.operationId || createId('op');
    const log = this.logger.child ? this.logger.child({ component: 'project-lifecycle', operationId, projectId }) : this.logger;
    if (!journal) {
      if (await this.isProjectBusy(projectId)) throw new DomainError('PROJECT_BUSY', 'Project has an active reconciliation or AI run.', { status: 409, retryable: true, operationId });
      const config = this.projectStore.readConfig(projectId);
      if (options.deleteKnowledge === true && options.confirmationToken !== projectId) {
        throw new DomainError('INVALID_ARGUMENT', 'Explicit projectId confirmation is required to delete knowledge.', { status: 409, operationId });
      }
      journal = {
        schema: 'project-delete-transaction/v1',
        operationId,
        projectId,
        phase: 'tombstoned',
        requested: { deleteKnowledge: options.deleteKnowledge === true },
        config,
        steps: {
          hook: { completed: false },
          registry: { completed: false },
          metadata: { completed: false },
          knowledge: { completed: false },
        },
        startedAt: new Date().toISOString(),
      };
      this.writeDeleteJournal(journal);
      this.fault('delete-tombstoned', journal);
      await log.info?.('project.delete.started', 'Project delete transaction started.', { phase: 'tombstoned', context: { deleteKnowledge: journal.requested.deleteKnowledge } });
    } else {
      if (journal.phase === 'completed') {
        return { ok: true, operationId, projectId, ...journal.result, recovered: true };
      }
      if (Boolean(options.deleteKnowledge) !== Boolean(journal.requested.deleteKnowledge)) {
        throw new DomainError('IMMUTABLE_FIELD', 'A pending delete transaction cannot change deleteKnowledge.', { status: 409, operationId });
      }
      if (journal.requested.deleteKnowledge && options.confirmationToken !== projectId) {
        throw new DomainError('INVALID_ARGUMENT', 'Explicit projectId confirmation is required to resume knowledge deletion.', { status: 409, operationId });
      }
    }
    const config = journal.config;
    const perform = async (stepName, action) => {
      if (journal.steps[stepName].completed) return journal.steps[stepName].result;
      journal.phase = `${stepName}.running`;
      journal.failedStep = null;
      this.writeDeleteJournal(journal);
      this.fault(`delete-before-${stepName}`, journal);
      const result = await action();
      this.fault(`delete-after-${stepName}`, journal);
      journal.steps[stepName] = { completed: true, completedAt: new Date().toISOString(), result };
      journal.phase = `${stepName}.completed`;
      this.writeDeleteJournal(journal);
      return result;
    };
    try {
      const hook = await perform('hook', async () => {
        if (!fs.existsSync(config.repoPath)) return { ok: true, removed: false, reason: 'repository-missing' };
        return this.hookManager.uninstallHook({ repoPath: config.repoPath, projectId });
      });
      await perform('registry', async () => ({ removed: await this.registryStore.remove(projectId) }));
      await perform('metadata', async () => {
        const metadataDir = this.layout.getProjectMetadataDir(projectId);
        if (!fs.existsSync(metadataDir)) return { removed: false };
        fs.rmSync(metadataDir, { recursive: true, force: true });
        return { removed: true };
      });
      const knowledge = await perform('knowledge', async () => {
        if (!journal.requested.deleteKnowledge || config.teamBinding) return { removed: false, preserved: true };
        if (!fs.existsSync(config.knowledgePath)) return { removed: false, preserved: false };
        fs.rmSync(config.knowledgePath, { recursive: true, force: true });
        return { removed: true, preserved: false };
      });
      this.fault('delete-before-completed', journal);
      journal.phase = 'completed';
      journal.completedAt = new Date().toISOString();
      journal.result = {
        hook,
        removedKnowledge: knowledge.removed === true,
        knowledgePath: config.knowledgePath,
        externalKnowledgePreserved: knowledge.removed !== true,
      };
      this.writeDeleteJournal(journal);
      await log.info?.('project.delete.completed', 'Project delete transaction completed.', { phase: 'completed', context: { hook, externalKnowledgePreserved: journal.result.externalKnowledgePreserved } });
      return { ok: true, operationId, projectId, ...journal.result };
    } catch (error) {
      journal.failedStep = journal.phase;
      journal.phase = 'failed';
      journal.failedAt = new Date().toISOString();
      journal.error = { code: error.code || 'INVALID_ARGUMENT', message: String(error.message || error) };
      this.writeDeleteJournal(journal);
      await log.error?.('project.delete.failed', 'Project delete transaction stopped and can be retried.', { phase: journal.failedStep, error });
      if (error instanceof DomainError) throw error;
      throw new DomainError('MIGRATION_FAILED', 'Project delete transaction failed and can be retried.', { status: 500, operationId, retryable: true, cause: error });
    }
  }
}

module.exports = { ProjectLifecycleService, slugify, runGit };
