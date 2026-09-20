"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MiniMaxEmbeddings = void 0;
const internals_1 = require("./internals");
/**
 * An `EmbeddingsModel` for calling MiniMax hosted embedding models.
 * @remarks
 * The MiniMax embeddings API is not OpenAI-compatible. It expects a `texts`
 * array instead of `input`, requires a `type` of `db` or `query` to distinguish
 * documents being indexed from search queries, and returns the vectors in a
 * top-level `vectors` field. This class adapts that format to vectra's
 * `EmbeddingsModel` interface.
 *
 * Usage:
 * ```ts
 * const embeddings = new MiniMaxEmbeddings({ apiKey: process.env.MINIMAX_API_KEY! });
 * const docs = new LocalDocumentIndex({ folderPath: './my-index', embeddings });
 * ```
 */
class MiniMaxEmbeddings {
    /**
     * Creates a new `MiniMaxEmbeddings` instance.
     * @param options Options for configuring the client.
     */
    constructor(options) {
        this.UserAgent = 'AlphaWave';
        // Strip undefined keys before merging — callers commonly build options
        // objects with optional fields set to undefined, and Object.assign
        // would override the defaults below with those undefined values.
        const provided = Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined));
        this.options = Object.assign({
            endpoint: 'https://api.minimax.cn',
            model: 'embo-01',
            maxTokens: 500,
            retryPolicy: [2000, 5000],
        }, provided);
        // Cleanup endpoint
        let endpoint = this.options.endpoint.trim();
        if (endpoint.endsWith('/')) {
            endpoint = endpoint.substring(0, endpoint.length - 1);
        }
        this.options.endpoint = endpoint;
        this.maxTokens = this.options.maxTokens;
    }
    /**
     * Gets the model being used for embeddings.
     */
    get model() {
        return this.options.model;
    }
    /**
     * Creates embeddings for the given inputs using the MiniMax API.
     * @remarks
     * A string input is treated as a search query and an array input as
     * documents being indexed. This matches how `LocalDocumentIndex` calls the
     * model: a single query string for `queryDocuments()` and an array of
     * document chunks for `upsertDocument()`.
     * @param inputs Text inputs to create embeddings for.
     * @returns A `EmbeddingsResponse` with a status and the generated embeddings or a message when an error occurs.
     */
    createEmbeddings(inputs) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b, _c;
            if (this.options.logRequests) {
                console.log(internals_1.Colorize.title('EMBEDDINGS REQUEST:'));
                console.log(internals_1.Colorize.output(inputs));
            }
            const startTime = Date.now();
            const response = yield this.post(`${this.options.endpoint}/v1/embeddings`, {
                model: this.options.model,
                texts: Array.isArray(inputs) ? inputs : [inputs],
                type: typeof inputs == 'string' ? 'query' : 'db',
            });
            const data = yield response.json();
            if (this.options.logRequests) {
                console.log(internals_1.Colorize.title('RESPONSE:'));
                console.log(internals_1.Colorize.value('status', response.status));
                console.log(internals_1.Colorize.value('duration', Date.now() - startTime, 'ms'));
                console.log(internals_1.Colorize.output(data));
            }
            // Process response
            // The MiniMax API reports most errors with an HTTP 200 status and a
            // non-zero `base_resp.status_code` (e.g. 2013 for invalid params).
            if (response.status < 300 && ((_b = (_a = data.base_resp) === null || _a === void 0 ? void 0 : _a.status_code) !== null && _b !== void 0 ? _b : 0) == 0) {
                return {
                    status: 'success',
                    output: data.vectors,
                    model: this.options.model,
                    usage: data.total_tokens != undefined ? { total_tokens: data.total_tokens } : undefined,
                };
            }
            else if (response.status == 429) {
                return { status: 'rate_limited', message: `The embeddings API returned a rate limit error.` };
            }
            else {
                const message = ((_c = data.base_resp) === null || _c === void 0 ? void 0 : _c.status_code) != undefined ?
                    `The embeddings API returned an error code of ${data.base_resp.status_code}: ${data.base_resp.status_msg}` :
                    `The embeddings API returned an error status of ${response.status}: ${response.statusText}`;
                return { status: 'error', message };
            }
        });
    }
    /**
     * @private
     */
    post(url_1, body_1) {
        return __awaiter(this, arguments, void 0, function* (url, body, retryCount = 0) {
            var _a, _b;
            // Initialize headers from requestConfig
            const baseHeaders = new Headers((_b = (_a = this.options.requestConfig) === null || _a === void 0 ? void 0 : _a.headers) !== null && _b !== void 0 ? _b : {});
            // Set defaults if not already provided
            if (!baseHeaders.has('Content-Type')) {
                baseHeaders.set('Content-Type', 'application/json');
            }
            if (!baseHeaders.has('User-Agent')) {
                baseHeaders.set('User-Agent', this.UserAgent);
            }
            if (!baseHeaders.has('Authorization')) {
                baseHeaders.set('Authorization', `Bearer ${this.options.apiKey}`);
            }
            // Send request
            const response = yield fetch(url, Object.assign(Object.assign({}, this.options.requestConfig), { method: 'POST', headers: baseHeaders, body: JSON.stringify(body) }));
            // Check for rate limit error
            if (response.status == 429 && Array.isArray(this.options.retryPolicy) && retryCount < this.options.retryPolicy.length) {
                const delay = this.options.retryPolicy[retryCount];
                yield new Promise((resolve) => setTimeout(resolve, delay));
                return this.post(url, body, retryCount + 1);
            }
            else {
                return response;
            }
        });
    }
}
exports.MiniMaxEmbeddings = MiniMaxEmbeddings;
//# sourceMappingURL=MiniMaxEmbeddings.js.map