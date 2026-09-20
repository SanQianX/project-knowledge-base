"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.HubManager = exports.DEFAULT_EXTENSIONS = void 0;
exports.defaultConfigPath = defaultConfigPath;
exports.createMockEmbeddings = createMockEmbeddings;
const node_fs_1 = __importDefault(require("node:fs"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const hub_1 = require("../core/hub");
const embeddings_1 = require("../core/embeddings");
exports.DEFAULT_EXTENSIONS = ['.md', '.txt', '.html'];
const DEFAULT_MODELS = {
    minimax: 'embo-01',
    openai: 'text-embedding-3-small',
};
/**
 * Owns the `VectorHub` lifecycle for the server: persisted settings, embeddings
 * hot-swap, folder imports, watchers, data-directory switching, and index
 * rebuilds after a model change.
 */
class HubManager {
    hub;
    configPath;
    _config = {};
    _watchers = new Map();
    _embeddingsFactory;
    _cliRootPath;
    _rebuild = { running: false, total: 0, done: 0, manual: [], errors: [] };
    constructor(options, hub, config) {
        this.configPath = options.configPath ?? defaultConfigPath();
        this._cliRootPath = options.rootPath;
        this._embeddingsFactory = options.embeddingsFactory ?? defaultEmbeddingsFactory;
        this._config = config;
        this.hub = hub;
    }
    /**
     * Loads (or creates) the manager. Resolution order:
     * settings from the global config file → `MINIMAX_API_KEY` env → unconfigured
     * (server still starts; UI guides setup). Data root resolution:
     * CLI `--root` → configured `settings.rootPath` → `./data`.
     *
     * Legacy `data/hub.json` files are migrated to the global config on first run.
     */
    static async load(options = {}) {
        const configPath = options.configPath ?? defaultConfigPath();
        let config = {};
        let migrated = false;
        try {
            config = JSON.parse(await node_fs_1.default.promises.readFile(configPath, 'utf8'));
        }
        catch {
            // No global config yet — check for a legacy config inside the data dir.
            const cliRoot = options.rootPath ?? process.env.VECTOR_HUB_ROOT ?? './data';
            const legacyPath = node_path_1.default.join(node_path_1.default.resolve(cliRoot), 'hub.json');
            try {
                config = JSON.parse(await node_fs_1.default.promises.readFile(legacyPath, 'utf8'));
                migrated = true;
            }
            catch {
                // Fresh install.
            }
        }
        const settings = config.settings?.apiKey
            ? normalizeSettings(config.settings)
            : process.env.MINIMAX_API_KEY
                ? normalizeSettings({ provider: 'minimax', apiKey: process.env.MINIMAX_API_KEY })
                : undefined;
        const rootPath = node_path_1.default.resolve(options.rootPath ?? config.settings?.rootPath ?? process.env.VECTOR_HUB_ROOT ?? './data');
        const factory = options.embeddingsFactory ?? defaultEmbeddingsFactory;
        const hub = new hub_1.VectorHub({
            rootPath,
            embeddings: settings ? factory(settings) : undefined,
        });
        const manager = new HubManager(options, hub, config);
        if (migrated || settings?.rootPath == undefined) {
            // Persist immediately: record the effective data root (and complete
            // the legacy migration) so the config is authoritative from now on.
            manager._config.settings = settings ? { ...settings, rootPath } : { provider: 'minimax', apiKey: '', rootPath };
            await manager._saveConfig();
            if (migrated) {
                console.log(`[vector-hub] migrated legacy config from ${legacyPathString(rootPath)} to ${configPath}`);
            }
        }
        return manager;
    }
    /** Current settings (as persisted). Undefined while no API key is configured. */
    get settings() {
        const persisted = this._config.settings;
        if (!persisted?.apiKey) {
            return undefined;
        }
        return normalizeSettings(persisted);
    }
    /** Effective sync extensions. */
    get extensions() {
        return this._config.settings?.extensions ?? exports.DEFAULT_EXTENSIONS;
    }
    /** Effective watch debounce. */
    get debounceMs() {
        return this._config.settings?.debounceMs ?? 500;
    }
    /** Project registrations from the config file. */
    get registrations() {
        return { ...this._config.projects };
    }
    /** Live rebuild progress. */
    get rebuildStatus() {
        return { ...this._rebuild };
    }
    /**
     * Saves settings and applies them:
     * - embeddings identity change → hot-swap model + auto rebuild indexed projects
     * - rootPath change → hot-switch data directory (watchers stopped and resumed)
     *
     * @returns The rebuild status if a rebuild was triggered, else undefined.
     */
    async saveSettings(next) {
        const normalized = normalizeSettings(next);
        const previousModelKey = this._modelKey(this.settings);
        const previousRoot = node_path_1.default.resolve(this._config.settings?.rootPath ?? this.hub.rootPath);
        const nextRoot = node_path_1.default.resolve(normalized.rootPath ?? previousRoot);
        const nextModelKey = this._modelKey(normalized);
        this._config.settings = { ...normalized, rootPath: nextRoot };
        await this._saveConfig();
        let rebuild;
        if (nextRoot != previousRoot) {
            await this._switchRoot(nextRoot);
        }
        if (nextModelKey != previousModelKey) {
            this.hub.setEmbeddings(normalized.apiKey ? this._embeddingsFactory(normalized) : undefined);
            const indexed = (await this.hub.listProjects()).filter((p) => p.hasIndex);
            if (indexed.length > 0) {
                void this._rebuildAll();
                rebuild = this._rebuild;
            }
        }
        else {
            // Same model: just refresh the instance (e.g. key rotation).
            this.hub.setEmbeddings(normalized.apiKey ? this._embeddingsFactory(normalized) : undefined);
        }
        return rebuild;
    }
    /**
     * Switches the data directory at runtime: stops watchers, points the hub
     * at the new root (indexes there are simply absent until re-synced), and
     * resumes watchers for registered projects. The old directory is untouched.
     */
    async _switchRoot(newRoot) {
        for (const project of [...this._watchers.keys()]) {
            await this._stopWatcher(project);
        }
        this.hub = new hub_1.VectorHub({ rootPath: newRoot });
        console.log(`[vector-hub] data directory switched to ${newRoot}`);
        await this.resumeWatchers();
    }
    /**
     * Imports a local folder as a project: resolves the real path, registers
     * the mapping, syncs the folder into the index, and optionally starts a
     * continuous watcher.
     */
    async import(sourceDir, projectName, watch) {
        const real = await node_fs_1.default.promises.realpath(sourceDir);
        const stat = await node_fs_1.default.promises.stat(real);
        if (!stat.isDirectory()) {
            throw new Error(`Not a folder: ${real}`);
        }
        const project = projectName?.trim() || node_path_1.default.basename(real);
        if (!hub_1.VectorHub.isValidProjectName(project)) {
            throw new Error(`Invalid project name derived from folder: '${project}'`);
        }
        this._config.projects = this._config.projects ?? {};
        this._config.projects[project] = { sourceDir: real, watch: watch ?? this._config.projects[project]?.watch };
        await this._saveConfig();
        const filesTracked = await this.hub.syncFolder(project, real, { extensions: this.extensions });
        if (watch) {
            await this._startWatcher(project, real);
        }
        return { project, filesTracked };
    }
    /**
     * Deletes a project: stops its watcher, removes its index and its
     * registration. The source folder on disk is never touched.
     */
    async deleteProject(project) {
        await this._stopWatcher(project);
        await this.hub.deleteProjectIndex(project);
        if (this._config.projects?.[project] != undefined) {
            delete this._config.projects[project];
            await this._saveConfig();
        }
    }
    /** Restores watchers for projects registered with `watch: true`. */
    async resumeWatchers() {
        for (const [project, registration] of Object.entries(this._config.projects ?? {})) {
            if (registration.watch && registration.sourceDir && !this._watchers.has(project)) {
                try {
                    await this._startWatcher(project, registration.sourceDir);
                }
                catch (err) {
                    console.error(`[vector-hub] failed to resume watcher for '${project}': ${err instanceof Error ? err.message : err}`);
                }
            }
        }
    }
    isWatching(project) {
        return this._watchers.has(project);
    }
    async _startWatcher(project, sourceDir) {
        await this._stopWatcher(project);
        const watcher = await this.hub.watchFolder(project, sourceDir, {
            extensions: this.extensions,
            debounceMs: this.debounceMs,
        });
        this._watchers.set(project, watcher);
    }
    async _stopWatcher(project) {
        const watcher = this._watchers.get(project);
        if (watcher) {
            this._watchers.delete(project);
            await watcher.stop().catch(() => undefined);
        }
    }
    /**
     * Rebuilds every indexed project that has a registered sourceDir with the
     * current (new) embeddings model. Indexed projects without a sourceDir
     * are reported as `manual`.
     */
    async _rebuildAll() {
        // Mark running synchronously so a caller that returns immediately
        // after triggering still observes the running state.
        this._rebuild = { running: true, total: 0, done: 0, manual: [], errors: [], startedAt: Date.now() };
        const projects = await this.hub.listProjects();
        const rebuildable = projects.filter((p) => p.hasIndex && this._config.projects?.[p.name]?.sourceDir);
        const manual = projects.filter((p) => p.hasIndex && !this._config.projects?.[p.name]?.sourceDir).map((p) => p.name);
        this._rebuild.total = rebuildable.length;
        this._rebuild.manual = manual;
        for (const { name } of rebuildable) {
            this._rebuild.currentProject = name;
            const sourceDir = this._config.projects[name].sourceDir;
            try {
                await this._stopWatcher(name);
                await this.hub.deleteProjectIndex(name);
                await this.hub.syncFolder(name, sourceDir, { extensions: this.extensions });
                if (this._config.projects[name].watch) {
                    await this._startWatcher(name, sourceDir);
                }
            }
            catch (err) {
                this._rebuild.errors.push({
                    project: name,
                    message: err instanceof Error ? err.message : String(err),
                });
            }
            this._rebuild.done++;
        }
        this._rebuild.running = false;
        this._rebuild.currentProject = undefined;
        this._rebuild.finishedAt = Date.now();
    }
    _modelKey(settings) {
        if (!settings) {
            return 'none';
        }
        return [
            settings.provider,
            settings.model ?? DEFAULT_MODELS[settings.provider],
            settings.endpoint ?? '',
        ].join('|');
    }
    async _saveConfig() {
        await node_fs_1.default.promises.mkdir(node_path_1.default.dirname(this.configPath), { recursive: true });
        await node_fs_1.default.promises.writeFile(this.configPath, JSON.stringify(this._config, null, 2), 'utf8');
    }
}
exports.HubManager = HubManager;
function legacyPathString(rootPath) {
    return node_path_1.default.join(rootPath, 'hub.json');
}
function defaultConfigPath() {
    const override = process.env.VECTOR_HUB_CONFIG;
    if (override) {
        return node_path_1.default.resolve(override);
    }
    return node_path_1.default.join(node_os_1.default.homedir(), '.vector-hub', 'config.json');
}
function normalizeSettings(settings) {
    if (settings.provider != 'minimax' && settings.provider != 'openai') {
        throw new Error(`Unknown provider: '${settings.provider}' (expected 'minimax' or 'openai')`);
    }
    const normalized = {
        provider: settings.provider,
        apiKey: settings.apiKey,
        model: settings.model?.trim() || undefined,
        endpoint: settings.endpoint?.trim() || undefined,
    };
    if (settings.rootPath?.trim()) {
        normalized.rootPath = settings.rootPath.trim();
    }
    if (Array.isArray(settings.extensions) && settings.extensions.length > 0) {
        normalized.extensions = settings.extensions.map((e) => (e.startsWith('.') ? e.toLowerCase() : `.${e.toLowerCase()}`));
    }
    if (Number.isFinite(settings.debounceMs) && settings.debounceMs > 0) {
        normalized.debounceMs = settings.debounceMs;
    }
    return normalized;
}
function defaultEmbeddingsFactory(settings) {
    if (process.env.VECTOR_HUB_EMBEDDINGS == 'mock') {
        // Hermetic mode for E2E/perf tests — deterministic bag-of-words vectors.
        return createMockEmbeddings();
    }
    if (settings.provider == 'minimax') {
        return (0, embeddings_1.createMiniMaxEmbeddings)(settings.apiKey, {
            model: settings.model,
            endpoint: settings.endpoint,
        });
    }
    return (0, embeddings_1.createOpenAIEmbeddings)({
        apiKey: settings.apiKey,
        model: settings.model ?? DEFAULT_MODELS.openai,
        endpoint: settings.endpoint,
    });
}
/** Deterministic embeddings for tests — 64-dim hashed bag-of-words. */
function createMockEmbeddings() {
    const model = {
        maxTokens: 500,
        model: 'mock-bow-64',
        async createEmbeddings(inputs) {
            const texts = Array.isArray(inputs) ? inputs : [inputs];
            return { status: 'success', output: texts.map((t) => bowEmbed(t)) };
        },
    };
    return model;
}
function bowEmbed(text) {
    const vector = new Array(64).fill(0);
    // Unicode-aware tokens (\W would drop CJK entirely and produce all-zero
    // vectors → NaN cosine scores in tests).
    for (const word of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
        if (word.length == 0) {
            continue;
        }
        let hash = 0;
        for (const ch of word) {
            hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
        }
        vector[hash % 64] += 1;
    }
    // reduce (not every()) — a narrowable every() would type the array as 0[]
    // and reject the fallback assignment below.
    if (vector.reduce((a, b) => a + b, 0) == 0) {
        // Token-less text still needs a non-zero vector to keep cosine defined.
        vector[0] = 1;
    }
    return vector;
}
//# sourceMappingURL=manager.js.map