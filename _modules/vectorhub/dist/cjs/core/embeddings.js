"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createMiniMaxEmbeddings = createMiniMaxEmbeddings;
exports.createOpenAIEmbeddings = createOpenAIEmbeddings;
const vectra_1 = require("vectra");
/**
 * Creates a MiniMax embeddings model (`embo-01`, 1536 dims).
 *
 * @remarks
 * Accepts both pay-as-you-go API keys and Coding/Token Plan subscription
 * keys (`sk-cp-...`); plan usage deducts from the subscription's quota.
 */
function createMiniMaxEmbeddings(apiKey, options) {
    return new vectra_1.MiniMaxEmbeddings({ apiKey, ...options });
}
/**
 * Creates an OpenAI-compatible embeddings model.
 *
 * @remarks
 * Works with OpenAI, Azure-style deployments via options, or any
 * OpenAI-compatible endpoint (`endpoint` option).
 */
function createOpenAIEmbeddings(options) {
    return new vectra_1.OpenAIEmbeddings(options);
}
//# sourceMappingURL=embeddings.js.map