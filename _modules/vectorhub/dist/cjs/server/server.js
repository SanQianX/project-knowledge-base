"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createServer = createServer;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const folder_picker_1 = require("./folder-picker");
const kb_sync_1 = require("../core/kb-sync");
const vectra_1 = require("vectra");
/**
 * Creates a native `http.RequestListener` exposing the hub over REST.
 *
 * @remarks
 * Zero third-party dependencies. Use it standalone
 * (`http.createServer(createServer(manager)).listen(8787)`) or compose it
 * into an existing server. This endpoint set is the single retrieval path
 * shared by the visual console and by AI agents — anything that can reach
 * the server can query the hub identically.
 */
function createServer(manager, options) {
    const hub = manager.hub;
    const uiCandidates = [
        options?.uiPath,
        // dist/cjs/server/server.js → <package root>/ui/index.html
        node_path_1.default.resolve(__dirname, '../../../ui/index.html'),
        node_path_1.default.resolve(process.cwd(), 'ui/index.html'),
    ].filter((candidate) => candidate != undefined);
    return async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const route = `${req.method ?? 'GET'} ${url.pathname}`;
        try {
            switch (route) {
                case 'GET /':
                case 'GET /index.html':
                    return await serveUi(res, uiCandidates);
                case 'GET /vendor/marked.min.js':
                    return await serveStatic(res, node_path_1.default.resolve(node_path_1.default.dirname(uiCandidatesFallback(uiCandidates)), 'vendor', 'marked.min.js'), 'application/javascript; charset=utf-8');
                case 'GET /api/projects': {
                    const projects = await hub.listProjects();
                    const registrations = manager.registrations;
                    return sendJson(res, 200, {
                        projects: projects.map((project) => ({
                            ...project,
                            sourceDir: registrations[project.name]?.sourceDir,
                            watching: manager.isWatching(project.name),
                        })),
                    });
                }
                case 'GET /api/search': {
                    const query = url.searchParams.get('q');
                    if (!query) {
                        return sendJson(res, 400, { error: "Missing required query parameter 'q'." });
                    }
                    const projects = url.searchParams.get('projects')?.split(',').map((p) => p.trim()).filter(Boolean);
                    const docTypes = url.searchParams.get('docTypes')?.split(',').map((t) => t.trim()).filter(Boolean);
                    const response = await hub.search(query, {
                        projects,
                        docTypes,
                        maxResults: parseNumber(url.searchParams.get('maxResults')),
                        maxDocuments: parseNumber(url.searchParams.get('maxDocuments')),
                        minScore: parseNumber(url.searchParams.get('minScore')),
                        isBm25: url.searchParams.get('isBm25') == 'true',
                    });
                    return sendJson(res, 200, response);
                }
                case 'GET /api/document': {
                    const project = url.searchParams.get('project');
                    const uri = url.searchParams.get('uri');
                    if (!project || !uri) {
                        return sendJson(res, 400, { error: "Missing required query parameters 'project' and 'uri'." });
                    }
                    const document = await readDocument(manager, project, uri);
                    if (!document) {
                        return sendJson(res, 404, { error: 'Document not found in the project index or on disk.' });
                    }
                    return sendJson(res, 200, document);
                }
                case 'POST /api/documents': {
                    const body = await readJsonBody(req);
                    if (!body?.project || !body?.uri || typeof body.text != 'string') {
                        return sendJson(res, 400, { error: "Body must include 'project', 'uri' and 'text'." });
                    }
                    await hub.upsertDocument(body);
                    return sendJson(res, 200, { ok: true, project: body.project, uri: body.uri });
                }
                case 'DELETE /api/documents': {
                    const project = url.searchParams.get('project');
                    const uri = url.searchParams.get('uri');
                    if (!project || !uri) {
                        return sendJson(res, 400, { error: "Missing required query parameters 'project' and 'uri'." });
                    }
                    const deleted = await hub.deleteDocument(project, uri);
                    return sendJson(res, deleted ? 200 : 404, { ok: deleted });
                }
                case 'POST /api/sync': {
                    const body = await readJsonBody(req);
                    if (!body?.project || !body?.sourceDir) {
                        return sendJson(res, 400, { error: "Body must include 'project' and 'sourceDir'." });
                    }
                    const count = await hub.syncFolder(body.project, body.sourceDir, {
                        extensions: Array.isArray(body.extensions) ? body.extensions : undefined,
                    });
                    return sendJson(res, 200, { ok: true, project: body.project, filesTracked: count });
                }
                case 'GET /api/settings': {
                    const settings = manager.settings;
                    return sendJson(res, 200, {
                        configured: settings != undefined,
                        settings: settings
                            ? {
                                ...settings,
                                apiKey: maskApiKey(settings.apiKey),
                                rootPath: manager.hub.rootPath,
                                extensions: manager.extensions,
                                debounceMs: manager.debounceMs,
                            }
                            : { rootPath: manager.hub.rootPath, extensions: manager.extensions, debounceMs: manager.debounceMs },
                    });
                }
                case 'PUT /api/settings': {
                    const body = await readJsonBody(req);
                    if (body?.provider != 'minimax' && body?.provider != 'openai') {
                        return sendJson(res, 400, { error: "Body must include 'provider' of 'minimax' or 'openai'." });
                    }
                    if (typeof body.apiKey != 'string' || body.apiKey.trim().length == 0) {
                        return sendJson(res, 400, { error: "Body must include a non-empty 'apiKey'." });
                    }
                    // A masked key echoed back by the UI means "keep current".
                    const apiKey = body.apiKey.startsWith('****')
                        ? manager.settings?.apiKey ?? body.apiKey
                        : body.apiKey.trim();
                    const rebuild = await manager.saveSettings({
                        provider: body.provider,
                        apiKey,
                        model: typeof body.model == 'string' ? body.model : undefined,
                        endpoint: typeof body.endpoint == 'string' ? body.endpoint : undefined,
                        rootPath: typeof body.rootPath == 'string' && body.rootPath.trim().length > 0
                            ? body.rootPath
                            : manager.hub.rootPath,
                        extensions: Array.isArray(body.extensions)
                            ? body.extensions.filter((e) => typeof e == 'string' && e.trim().length > 0)
                            : manager.extensions,
                        debounceMs: parseFiniteNumber(body.debounceMs) ?? manager.debounceMs,
                    });
                    return sendJson(res, 200, { ok: true, rebuildTriggered: rebuild != undefined });
                }
                case 'GET /api/rebuild/status':
                    return sendJson(res, 200, manager.rebuildStatus);
                case 'POST /api/import': {
                    const body = await readJsonBody(req);
                    if (typeof body?.sourceDir != 'string' || body.sourceDir.trim().length == 0) {
                        return sendJson(res, 400, { error: "Body must include 'sourceDir'." });
                    }
                    const result = await manager.import(body.sourceDir, typeof body.projectName == 'string' ? body.projectName : undefined, body.watch === true);
                    return sendJson(res, 200, { ok: true, ...result });
                }
                case 'DELETE /api/project': {
                    const name = url.searchParams.get('name');
                    if (!name) {
                        return sendJson(res, 400, { error: "Missing required query parameter 'name'." });
                    }
                    await manager.deleteProject(name);
                    return sendJson(res, 200, { ok: true });
                }
                case 'GET /api/system/pick-folder': {
                    // Loopback-only and no CORS headers: prevents an arbitrary
                    // web page from triggering the native dialog and reading
                    // the selected local path.
                    if (!isLoopbackOrigin(req)) {
                        return sendJsonNoCors(res, 403, { error: 'Forbidden origin.' });
                    }
                    // E2E/hermetic mode: report unavailable so the UI falls
                    // back to manual path entry instead of popping a dialog.
                    if (process.env.VECTOR_HUB_DISABLE_PICKER == '1') {
                        return sendJsonNoCors(res, 501, { error: 'picker disabled for this environment' });
                    }
                    const result = await (0, folder_picker_1.pickFolder)();
                    return sendJsonNoCors(res, 200, result);
                }
                case 'GET /api/health': {
                    const projects = await hub.listProjects();
                    return sendJson(res, 200, {
                        ok: projects.every((project) => project.hasIndex),
                        projects,
                        embeddings: { model: hub.embeddingsModelName ?? 'not configured' },
                    });
                }
                default:
                    if (req.method == 'OPTIONS') {
                        return sendJson(res, 204, {});
                    }
                    return sendJson(res, 404, { error: `No route for ${route}` });
            }
        }
        catch (err) {
            const status = err.status;
            const message = err instanceof Error ? err.message : String(err);
            return sendJson(res, status ?? 500, { error: message });
        }
    };
}
async function serveUi(res, candidates) {
    for (const candidate of candidates) {
        if (node_fs_1.default.existsSync(candidate)) {
            const html = await node_fs_1.default.promises.readFile(candidate);
            res.writeHead(200, {
                'Content-Type': 'text/html; charset=utf-8',
                ...corsHeaders(),
            });
            res.end(html);
            return;
        }
    }
    sendJson(res, 500, { error: 'ui/index.html not found. Pass ServerOptions.uiPath.' });
}
async function serveStatic(res, filePath, contentType) {
    try {
        const content = await node_fs_1.default.promises.readFile(filePath);
        res.writeHead(200, { 'Content-Type': contentType, ...corsHeaders() });
        res.end(content);
    }
    catch {
        sendJson(res, 404, { error: `Not found: ${node_path_1.default.basename(filePath)}` });
    }
}
function uiCandidatesFallback(candidates) {
    return candidates[candidates.length - 1] ?? node_path_1.default.resolve(process.cwd(), 'ui', 'index.html');
}
function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
            if (chunks.length == 0) {
                return resolve(undefined);
            }
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            }
            catch (err) {
                reject(new Error(`Invalid JSON body: ${err instanceof Error ? err.message : String(err)}`));
            }
        });
        req.on('error', reject);
    });
}
function parseNumber(value) {
    if (value == undefined || value == '') {
        return undefined;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}
function parseFiniteNumber(value) {
    return typeof value == 'number' && Number.isFinite(value) ? value : undefined;
}
/**
 * Loads a document for the viewer drawer: prefers the live source file
 * (only when the uri lies under the project's registered source folder —
 * this is an arbitrary-file-read guard), falls back to the indexed copy.
 * Returns frontmatter-derived metadata alongside the body text.
 */
async function readDocument(manager, project, uri) {
    const registration = manager.registrations[project];
    let text = null;
    let sourceExists = false;
    if (registration?.sourceDir) {
        const root = node_path_1.default.resolve(registration.sourceDir);
        const target = node_path_1.default.resolve(uri);
        if (target.startsWith(root + node_path_1.default.sep) || target == root) {
            try {
                text = await node_fs_1.default.promises.readFile(target, 'utf8');
                sourceExists = true;
            }
            catch {
                // Source file gone — fall through to the indexed copy.
            }
        }
    }
    if (text == null) {
        try {
            const index = manager.hub.getProjectIndex(project);
            const documentId = await index.getDocumentId(uri);
            if (documentId) {
                text = await new vectra_1.LocalDocument(index, documentId, uri).loadText();
            }
        }
        catch {
            // Not indexed either.
        }
    }
    if (text == null) {
        return null;
    }
    const parsed = (0, kb_sync_1.parseFrontmatter)(text);
    const metadata = (0, kb_sync_1.extractMetadata)((0, kb_sync_1.inferDocType)(uri, registration?.sourceDir ?? node_path_1.default.dirname(uri)), parsed.meta);
    return {
        uri,
        text: parsed.body,
        frontmatterLength: parsed.frontmatterLength,
        sourceExists,
        ...metadata,
    };
}
function isLoopbackOrigin(req) {
    const origin = req.headers.origin;
    if (origin == undefined) {
        return true; // non-browser clients (curl, AI services) send no Origin
    }
    try {
        const { hostname } = new URL(origin);
        return hostname == 'localhost' || hostname == '127.0.0.1' || hostname == '[::1]' || hostname == '::1';
    }
    catch {
        return false;
    }
}
function maskApiKey(apiKey) {
    if (apiKey.length <= 4) {
        return '****';
    }
    return `****${apiKey.slice(-4)}`;
}
function corsHeaders() {
    return {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
    };
}
function sendJson(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders() });
    res.end(JSON.stringify(body));
}
function sendJsonNoCors(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
}
//# sourceMappingURL=server.js.map