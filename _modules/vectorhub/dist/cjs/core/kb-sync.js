"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.KbFolderWatcher = void 0;
exports.inferDocType = inferDocType;
exports.parseFrontmatter = parseFrontmatter;
exports.extractMetadata = extractMetadata;
exports.buildDocument = buildDocument;
exports.syncSourceFolder = syncSourceFolder;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
/**
 * Classifies a file by its path relative to the source root.
 *
 * Rules (minimal-kb layout):
 * - root GOAL.md / ARCHITECTURE.md / README.md
 * - changes/00-index.md → change-index, changes/* → change
 * - modules/00-index.md → module-index, modules/* → module
 * - anything else → first directory name, or 'doc' at the root
 */
function inferDocType(absFilePath, rootDir) {
    const rel = node_path_1.default.relative(node_path_1.default.resolve(rootDir), node_path_1.default.resolve(absFilePath));
    const parts = rel.split(/[\\/]/).filter((p) => p.length > 0 && p != '.');
    const base = (parts[parts.length - 1] ?? '').toLowerCase();
    if (parts.length <= 1) {
        if (base == 'goal.md')
            return 'goal';
        if (base == 'architecture.md')
            return 'architecture';
        if (base == 'readme.md')
            return 'readme';
        return 'doc';
    }
    const firstDir = parts[0].toLowerCase();
    if (firstDir == 'changes') {
        return base == '00-index.md' ? 'change-index' : 'change';
    }
    if (firstDir == 'modules') {
        return base == '00-index.md' ? 'module-index' : 'module';
    }
    return 'doc';
}
/**
 * Minimal YAML frontmatter parser: `key: value`, inline `[a, b]` lists, and
 * block lists (`- item` lines). Comments and nesting are not supported —
 * the minimal-kb schema needs neither.
 */
function parseFrontmatter(text) {
    if (!text.startsWith('---')) {
        return { meta: {}, body: text, frontmatterLength: 0 };
    }
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const lines = text.split(eol);
    // lines[0] is the opening '---' (possibly with trailing spaces).
    let closeIndex = -1;
    for (let i = 1; i < lines.length; i++) {
        if (/^---\s*$/.test(lines[i])) {
            closeIndex = i;
            break;
        }
    }
    if (closeIndex < 0) {
        return { meta: {}, body: text, frontmatterLength: 0 };
    }
    const meta = {};
    let currentKey = null;
    for (let i = 1; i < closeIndex; i++) {
        const line = lines[i];
        const listMatch = /^\s+-\s+(.*)$/.exec(line);
        if (listMatch && currentKey) {
            const existing = meta[currentKey];
            const value = listMatch[1].trim().replace(/^['"]|['"]$/g, '');
            if (Array.isArray(existing)) {
                existing.push(value);
            }
            else {
                meta[currentKey] = existing != undefined ? [existing, value] : [value];
            }
            continue;
        }
        const kv = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
        if (kv) {
            const key = kv[1];
            const raw = kv[2].trim();
            currentKey = key;
            if (raw == '') {
                // Might be followed by a block list; leave undefined for now.
                meta[key] = [];
            }
            else if (raw.startsWith('[') && raw.endsWith(']')) {
                meta[key] = raw
                    .slice(1, -1)
                    .split(',')
                    .map((v) => v.trim().replace(/^['"]|['"]$/g, ''))
                    .filter((v) => v.length > 0);
            }
            else {
                meta[key] = raw.replace(/^['"]|['"]$/g, '');
            }
        }
    }
    const body = lines.slice(closeIndex + 1).join(eol).replace(/^\r?\n/, '');
    const frontmatterLength = text.length - body.length - (text.length > 0 && body.length == 0 ? 0 : 0);
    return { meta, body, frontmatterLength };
}
/**
 * Frontmatter keys promoted to chunk metadata. Arrays are comma-joined —
 * Vectra metadata values must be scalars.
 */
const PROMOTED_KEYS = ['title', 'status', 'commit', 'date', 'module', 'tags', 'affectedModules'];
/** Derives chunk metadata for a file from its type and frontmatter. */
function extractMetadata(docType, frontmatter) {
    const metadata = { docType };
    for (const key of PROMOTED_KEYS) {
        const value = frontmatter[key];
        if (value == undefined) {
            continue;
        }
        const scalar = Array.isArray(value) ? value.filter((v) => v.length > 0).join(', ') : value;
        if (typeof scalar == 'string' && scalar.length > 0) {
            if (key == 'affectedModules') {
                metadata.modules = scalar;
            }
            else {
                metadata[key] = scalar;
            }
        }
    }
    return metadata;
}
/** Reads one file and returns what should be indexed: body text + metadata. */
function buildDocument(absFilePath, rootDir, text) {
    const parsed = parseFrontmatter(text);
    const docType = inferDocType(absFilePath, rootDir);
    return {
        uri: node_path_1.default.resolve(absFilePath),
        text: parsed.body,
        metadata: extractMetadata(docType, parsed.meta),
    };
}
async function* walkFiles(dir, extensions) {
    let entries;
    try {
        entries = await node_fs_1.default.promises.readdir(dir, { withFileTypes: true });
    }
    catch {
        return;
    }
    for (const entry of entries) {
        if (entry.name.startsWith('.')) {
            continue;
        }
        const full = node_path_1.default.join(dir, entry.name);
        if (entry.isDirectory()) {
            yield* walkFiles(full, extensions);
        }
        else if (entry.isFile() && extensions.has(node_path_1.default.extname(entry.name).toLowerCase())) {
            yield full;
        }
    }
}
/**
 * Full sync of a source folder into a document index with metadata. Files
 * absent from disk are removed from the index (Vectra's hash-based skip
 * makes unchanged files a no-op).
 */
async function syncSourceFolder(index, sourceDir, extensions = ['.md', '.txt', '.html']) {
    const root = node_path_1.default.resolve(sourceDir);
    const exts = new Set(extensions.map((e) => e.toLowerCase()));
    const diskFiles = new Set();
    for await (const file of walkFiles(root, exts)) {
        diskFiles.add(file);
        const text = await node_fs_1.default.promises.readFile(file, 'utf8');
        const doc = buildDocument(file, root, text);
        await index.upsertDocument(doc.uri, doc.text, node_path_1.default.extname(file).slice(1).toLowerCase(), doc.metadata);
    }
    // Delete indexed documents whose file no longer exists.
    let deleted = 0;
    const documents = await index.listDocuments();
    for (const document of documents) {
        if (!diskFiles.has(document.uri)) {
            await index.deleteDocument(document.uri);
            deleted++;
        }
    }
    return { filesTracked: diskFiles.size, deleted };
}
/**
 * Watches a source folder and keeps the index in sync (initial full sync on
 * start, then debounced incremental add/change/delete). Replaces Vectra's
 * FolderWatcher for paths that need metadata.
 */
class KbFolderWatcher {
    index;
    sourceDir;
    options;
    _watcher = null;
    _stopped = false;
    _tracked = 0;
    _pending = new Map();
    constructor(index, sourceDir, options = {}) {
        this.index = index;
        this.sourceDir = sourceDir;
        this.options = options;
    }
    get isRunning() {
        return this._watcher != null;
    }
    get trackedFileCount() {
        return this._tracked;
    }
    async start() {
        const result = await syncSourceFolder(this.index, this.sourceDir, this.options.extensions);
        this._tracked = result.filesTracked;
        if (this._stopped) {
            return;
        }
        // recursive: true is supported on Windows and macOS; on Linux it
        // falls back to watching the top level only (per-project knowledge
        // bases are shallow enough for v1).
        this._watcher = node_fs_1.default.watch(this.sourceDir, { recursive: true }, (_event, filename) => {
            const relative = String(filename ?? '');
            if (!relative || node_path_1.default.basename(relative).startsWith('.')) {
                return;
            }
            this._schedule(node_path_1.default.join(this.sourceDir, relative));
        });
    }
    async stop() {
        this._stopped = true;
        for (const timer of this._pending.values()) {
            clearTimeout(timer);
        }
        this._pending.clear();
        this._watcher?.close();
        this._watcher = null;
    }
    _schedule(absPath) {
        const existing = this._pending.get(absPath);
        if (existing) {
            clearTimeout(existing);
        }
        const timer = setTimeout(() => {
            this._pending.delete(absPath);
            void this._syncFile(absPath);
        }, this.options.debounceMs ?? 500);
        this._pending.set(absPath, timer);
    }
    async _syncFile(absPath) {
        const exts = new Set((this.options.extensions ?? ['.md', '.txt', '.html']).map((e) => e.toLowerCase()));
        try {
            const stat = await node_fs_1.default.promises.stat(absPath);
            if (!stat.isFile() || !exts.has(node_path_1.default.extname(absPath).toLowerCase())) {
                return;
            }
            const text = await node_fs_1.default.promises.readFile(absPath, 'utf8');
            const doc = buildDocument(absPath, this.sourceDir, text);
            await this.index.upsertDocument(doc.uri, doc.text, node_path_1.default.extname(absPath).slice(1).toLowerCase(), doc.metadata);
        }
        catch {
            // File vanished between event and sync — treat as delete.
            try {
                await this.index.deleteDocument(node_path_1.default.resolve(absPath));
            }
            catch {
                /* nothing to delete */
            }
        }
    }
}
exports.KbFolderWatcher = KbFolderWatcher;
//# sourceMappingURL=kb-sync.js.map