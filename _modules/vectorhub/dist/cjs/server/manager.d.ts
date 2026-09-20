import { VectorHub } from '../core/hub';
import type { EmbeddingsModel } from 'vectra';
/**
 * Embedding provider + data/sync settings persisted in the global config
 * file (`~/.vector-hub/config.json` by default — deliberately OUTSIDE the
 * data directory so switching the data root keeps registrations).
 */
export interface HubSettings {
    provider: 'minimax' | 'openai';
    apiKey: string;
    /** Model name. Defaults to `embo-01` (minimax) or `text-embedding-3-small` (openai). */
    model?: string;
    /** OpenAI-compatible base endpoint (openai provider only). */
    endpoint?: string;
    /** Data directory holding the per-project indexes. Default `./data`. */
    rootPath?: string;
    /** File extensions synced from source folders. Default `['.md', '.txt', '.html']`. */
    extensions?: string[];
    /** Watch debounce in ms. Default 500. */
    debounceMs?: number;
}
/**
 * A project registered through import / the UI. API-written projects may
 * have no registration entry and therefore cannot be auto-rebuilt.
 */
export interface ProjectRegistration {
    sourceDir?: string;
    watch?: boolean;
}
export interface HubConfigFile {
    settings?: HubSettings;
    projects?: Record<string, ProjectRegistration>;
}
export interface RebuildStatus {
    running: boolean;
    /** Projects to rebuild (those with a registered sourceDir). */
    total: number;
    done: number;
    currentProject?: string;
    /** Indexed projects without a sourceDir — cannot be rebuilt automatically. */
    manual: string[];
    errors: {
        project: string;
        message: string;
    }[];
    startedAt?: number;
    finishedAt?: number;
}
export interface EmbeddingsFactory {
    (settings: HubSettings): EmbeddingsModel;
}
export interface HubManagerOptions {
    /** CLI `--root` override; wins over the configured rootPath. */
    rootPath?: string;
    /** Config file location override (tests). Defaults to `~/.vector-hub/config.json`. */
    configPath?: string;
    /** Embeddings factory override (tests / mock mode). */
    embeddingsFactory?: EmbeddingsFactory;
}
export declare const DEFAULT_EXTENSIONS: string[];
/**
 * Owns the `VectorHub` lifecycle for the server: persisted settings, embeddings
 * hot-swap, folder imports, watchers, data-directory switching, and index
 * rebuilds after a model change.
 */
export declare class HubManager {
    hub: VectorHub;
    readonly configPath: string;
    private _config;
    private readonly _watchers;
    private readonly _embeddingsFactory;
    private readonly _cliRootPath?;
    private _rebuild;
    private constructor();
    /**
     * Loads (or creates) the manager. Resolution order:
     * settings from the global config file → `MINIMAX_API_KEY` env → unconfigured
     * (server still starts; UI guides setup). Data root resolution:
     * CLI `--root` → configured `settings.rootPath` → `./data`.
     *
     * Legacy `data/hub.json` files are migrated to the global config on first run.
     */
    static load(options?: HubManagerOptions): Promise<HubManager>;
    /** Current settings (as persisted). Undefined while no API key is configured. */
    get settings(): HubSettings | undefined;
    /** Effective sync extensions. */
    get extensions(): string[];
    /** Effective watch debounce. */
    get debounceMs(): number;
    /** Project registrations from the config file. */
    get registrations(): Record<string, ProjectRegistration>;
    /** Live rebuild progress. */
    get rebuildStatus(): RebuildStatus;
    /**
     * Saves settings and applies them:
     * - embeddings identity change → hot-swap model + auto rebuild indexed projects
     * - rootPath change → hot-switch data directory (watchers stopped and resumed)
     *
     * @returns The rebuild status if a rebuild was triggered, else undefined.
     */
    saveSettings(next: HubSettings): Promise<RebuildStatus | undefined>;
    /**
     * Switches the data directory at runtime: stops watchers, points the hub
     * at the new root (indexes there are simply absent until re-synced), and
     * resumes watchers for registered projects. The old directory is untouched.
     */
    private _switchRoot;
    /**
     * Imports a local folder as a project: resolves the real path, registers
     * the mapping, syncs the folder into the index, and optionally starts a
     * continuous watcher.
     */
    import(sourceDir: string, projectName?: string, watch?: boolean): Promise<{
        project: string;
        filesTracked: number;
    }>;
    /**
     * Deletes a project: stops its watcher, removes its index and its
     * registration. The source folder on disk is never touched.
     */
    deleteProject(project: string): Promise<void>;
    /** Restores watchers for projects registered with `watch: true`. */
    resumeWatchers(): Promise<void>;
    isWatching(project: string): boolean;
    private _startWatcher;
    private _stopWatcher;
    /**
     * Rebuilds every indexed project that has a registered sourceDir with the
     * current (new) embeddings model. Indexed projects without a sourceDir
     * are reported as `manual`.
     */
    private _rebuildAll;
    private _modelKey;
    private _saveConfig;
}
export declare function defaultConfigPath(): string;
/** Deterministic embeddings for tests — 64-dim hashed bag-of-words. */
export declare function createMockEmbeddings(): EmbeddingsModel & {
    model: string;
};
