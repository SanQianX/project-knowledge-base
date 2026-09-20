import type { LocalDocumentIndex } from 'vectra';
/**
 * Metadata-aware folder synchronization for structured knowledge bases.
 *
 * Vectra's own FolderWatcher syncs plain text only — frontmatter and document
 * types never reach the index. This module layers that in:
 * - `inferDocType` classifies files by path (goal / architecture / change /
 *   module / index / …) using the minimal-kb layout conventions.
 * - `parseFrontmatter` extracts the YAML header (tags, affectedModules,
 *   commit, date, module, title, status) into scalar chunk metadata.
 * - `syncSourceFolder` / `KbFolderWatcher` upsert/delete documents with the
 *   derived metadata, replacing the bare FolderWatcher in the sync path.
 *
 * Indexed text is the frontmatter-stripped body, so chunk startPos/endPos
 * alignment is 1:1 with the rendered body shown in the document drawer.
 */
/** Path-derived document type (stored as chunk metadata `docType`). */
export type KbDocType = 'goal' | 'architecture' | 'readme' | 'change' | 'change-index' | 'module' | 'module-index' | 'doc';
/**
 * Classifies a file by its path relative to the source root.
 *
 * Rules (minimal-kb layout):
 * - root GOAL.md / ARCHITECTURE.md / README.md
 * - changes/00-index.md → change-index, changes/* → change
 * - modules/00-index.md → module-index, modules/* → module
 * - anything else → first directory name, or 'doc' at the root
 */
export declare function inferDocType(absFilePath: string, rootDir: string): KbDocType;
export interface ParsedFrontmatter {
    /** Raw key → scalar or list values (lists keep their array form here). */
    meta: Record<string, string | string[]>;
    /** Text after the closing `---`, leading newline stripped. */
    body: string;
    /** Number of characters the frontmatter block occupied (incl. delimiters). */
    frontmatterLength: number;
}
/**
 * Minimal YAML frontmatter parser: `key: value`, inline `[a, b]` lists, and
 * block lists (`- item` lines). Comments and nesting are not supported —
 * the minimal-kb schema needs neither.
 */
export declare function parseFrontmatter(text: string): ParsedFrontmatter;
export interface KbDocumentMetadata {
    docType: KbDocType;
    title?: string;
    status?: string;
    commit?: string;
    date?: string;
    module?: string;
    tags?: string;
    modules?: string;
    [key: string]: string | number | boolean | undefined;
}
/** Derives chunk metadata for a file from its type and frontmatter. */
export declare function extractMetadata(docType: KbDocType, frontmatter: ParsedFrontmatter['meta']): KbDocumentMetadata;
/** Reads one file and returns what should be indexed: body text + metadata. */
export declare function buildDocument(absFilePath: string, rootDir: string, text: string): {
    uri: string;
    text: string;
    metadata: KbDocumentMetadata;
};
export interface SyncFolderResult {
    /** Files present after the sync. */
    filesTracked: number;
    /** Documents removed because their file disappeared. */
    deleted: number;
}
/**
 * Full sync of a source folder into a document index with metadata. Files
 * absent from disk are removed from the index (Vectra's hash-based skip
 * makes unchanged files a no-op).
 */
export declare function syncSourceFolder(index: LocalDocumentIndex, sourceDir: string, extensions?: string[]): Promise<SyncFolderResult>;
/**
 * Watches a source folder and keeps the index in sync (initial full sync on
 * start, then debounced incremental add/change/delete). Replaces Vectra's
 * FolderWatcher for paths that need metadata.
 */
export declare class KbFolderWatcher {
    private readonly index;
    private readonly sourceDir;
    private readonly options;
    private _watcher;
    private _stopped;
    private _tracked;
    private readonly _pending;
    constructor(index: LocalDocumentIndex, sourceDir: string, options?: {
        extensions?: string[];
        debounceMs?: number;
    });
    get isRunning(): boolean;
    get trackedFileCount(): number;
    start(): Promise<void>;
    stop(): Promise<void>;
    private _schedule;
    private _syncFile;
}
