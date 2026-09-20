import { LocalDocumentIndex } from 'vectra';
import type { EmbeddingsModel } from 'vectra';
import { KbFolderWatcher } from './kb-sync';
import type { ProjectInfo, SearchOptions, SearchResponse, SyncOptions, UpsertDocumentOptions, VectorHubOptions } from './types';
/**
 * Multi-project vector retrieval hub built on Vectra.
 *
 * @remarks
 * The hub root folder holds one sub-folder per project; each sub-folder is a
 * self-contained `LocalDocumentIndex` (vectors + full text + catalog). The
 * hub layers project enumeration, isolated multi-project search (results
 * merged by score), and folder sync on top.
 *
 * This class is pure library code — no HTTP, no DOM — so it can be imported
 * into any Node process. The HTTP layer (`createServer`) and the visual
 * console (`ui/index.html`) are thin, optional attachments on top of it.
 *
 * ```ts
 * const hub = new VectorHub({
 *   rootPath: './data',
 *   embeddings: createMiniMaxEmbeddings(process.env.MINIMAX_API_KEY!),
 * });
 * const { results } = await hub.search('怎么接入向量检索', { maxResults: 5 });
 * ```
 */
export declare class VectorHub {
    private readonly _rootPath;
    private _embeddings;
    private readonly _storage;
    private readonly _indexes;
    constructor(options: VectorHubOptions);
    /**
     * Swaps the embeddings model at runtime and drops all cached project
     * indexes so new indexes pick up the new model.
     *
     * @remarks
     * Vectors from different models live in incompatible spaces. After
     * switching, existing indexes hold stale vectors and must be rebuilt
     * (delete + re-sync) — see the server layer's rebuild flow.
     */
    setEmbeddings(model: EmbeddingsModel | undefined): void;
    /** Absolute path of the hub root folder. */
    get rootPath(): string;
    /** The embeddings model every project index uses, when configured. */
    get embeddings(): EmbeddingsModel | undefined;
    /** Human-readable name of the embeddings model, when available. */
    get embeddingsModelName(): string | undefined;
    /**
     * Validates a project name. Project names become folder names inside the
     * hub root, so path separators and traversal fragments are rejected.
     */
    static isValidProjectName(name: string): boolean;
    /**
     * Returns (and caches) the document index for a project, creating the
     * wrapper lazily. Does not create the index on disk.
     * @param project Project (sub-folder) name.
     */
    getProjectIndex(project: string): LocalDocumentIndex;
    /**
     * Lists the projects (sub-folders) in the hub root with index stats.
     */
    listProjects(): Promise<ProjectInfo[]>;
    /**
     * Upserts a document into a project index, creating the index when the
     * project is indexed for the first time. Re-upserting unchanged content
     * is a no-op (Vectra's hash-based skip).
     */
    upsertDocument(options: UpsertDocumentOptions): Promise<void>;
    /**
     * Deletes a document from a project index.
     * @returns Whether the document existed and was deleted.
     */
    deleteDocument(project: string, uri: string): Promise<boolean>;
    /**
     * Searches the selected projects (default: every project with an index)
     * in parallel and merges the results by score.
     *
     * @remarks
     * Projects without an index are skipped and reported in
     * `projectsSkipped`; a project whose query fails is reported in `errors`
     * without failing the whole search.
     */
    search(query: string, options?: SearchOptions): Promise<SearchResponse>;
    /**
     * One-shot full sync of a source folder into a project index, with
     * document-type and frontmatter metadata (see `kb-sync`).
     * @returns Number of files tracked after the sync.
     */
    syncFolder(project: string, sourceDir: string, options?: SyncOptions): Promise<number>;
    /**
     * Starts a continuous watcher that keeps a project index in sync with a
     * source folder (initial full sync, then debounced incremental changes).
     * Metadata-aware. Keep the returned watcher alive; call `stop()` to end it.
     */
    watchFolder(project: string, sourceDir: string, options?: SyncOptions): Promise<KbFolderWatcher>;
    private _startWatcher;
    /**
     * Deletes a project's index folder (vectors, stored texts, catalog).
     * The project registration itself is managed by the server layer.
     */
    deleteProjectIndex(project: string): Promise<void>;
    /**
     * Recursive delete that works on every FileStorage backend — some
     * in-memory implementations do not cascade `deleteFolder`, so children
     * are removed bottom-up explicitly.
     */
    private _deleteFolderRecursive;
    private _requireEmbeddings;
    /**
     * Creates the project's folder entry explicitly. The real filesystem
     * creates parent directories on write, but in-memory storages such as
     * `VirtualFileStorage` only track folders they are told about — without
     * this call, `listProjects()` cannot see projects on those backends.
     */
    private _ensureProjectFolder;
    private _toResultItem;
}
