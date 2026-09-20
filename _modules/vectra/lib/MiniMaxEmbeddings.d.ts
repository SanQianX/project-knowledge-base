import { EmbeddingsModel, EmbeddingsResponse } from "./types";
/**
 * Options for configuring a `MiniMaxEmbeddings` instance.
 */
export interface MiniMaxEmbeddingsOptions {
    /**
     * API key to use when calling the MiniMax API.
     * @remarks
     * Either a pay-as-you-go API key or a Coding/Token Plan subscription key
     * (`sk-cp-...`) can be used. Plan usage deducts from the subscription's
     * shared quota. A new API key can be created at https://platform.minimaxi.com.
     */
    apiKey: string;
    /**
     * Optional. Endpoint to use when calling the MiniMax API.
     * @remarks
     * Defaults to `https://api.minimax.cn` and should not include a trailing `/v1`
     * as the request path is appended automatically. Other known endpoints are
     * `https://api.minimaxi.com` (China) and `https://api.minimax.io` (international).
     */
    endpoint?: string;
    /**
     * Model to use for embeddings.
     * @remarks
     * Defaults to `embo-01`, which returns 1536 dimension vectors.
     */
    model?: string;
    /**
     * Optional. Maximum number of tokens that can be sent to the embedding model.
     * @remarks
     * The default is `500`.
     */
    maxTokens?: number;
    /**
     * Optional. Whether to log requests to the console.
     * @remarks
     * This is useful for debugging prompts and defaults to `false`.
     */
    logRequests?: boolean;
    /**
     * Optional. Retry policy to use when calling the MiniMax API.
     * @remarks
     * The default retry policy is `[2000, 5000]` which means that the first retry will be after
     * 2 seconds and the second retry will be after 5 seconds.
     */
    retryPolicy?: number[];
    /**
     * Optional. Request options to use when calling the MiniMax API.
     */
    requestConfig?: RequestInit;
}
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
export declare class MiniMaxEmbeddings implements EmbeddingsModel {
    private readonly UserAgent;
    readonly maxTokens: number;
    /**
     * Options the client was configured with.
     */
    readonly options: MiniMaxEmbeddingsOptions;
    /**
     * Creates a new `MiniMaxEmbeddings` instance.
     * @param options Options for configuring the client.
     */
    constructor(options: MiniMaxEmbeddingsOptions);
    /**
     * Gets the model being used for embeddings.
     */
    get model(): string;
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
    createEmbeddings(inputs: string | string[]): Promise<EmbeddingsResponse>;
    /**
     * @private
     */
    private post;
}
//# sourceMappingURL=MiniMaxEmbeddings.d.ts.map