import http from 'node:http';
import type { HubManager } from './manager';
/**
 * Options for `createServer`.
 */
export interface VectorHubServerOptions {
    /**
     * Path to the visual console HTML file. Defaults to the bundled
     * `ui/index.html`, resolved from the package layout or the cwd.
     */
    uiPath?: string;
}
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
export declare function createServer(manager: HubManager, options?: VectorHubServerOptions): http.RequestListener;
