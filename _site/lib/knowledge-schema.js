const crypto = require('crypto');
const arrow = require('apache-arrow');

const KNOWLEDGE_DB_SCHEMA_VERSION = 1;
const KNOWLEDGE_TABLE = 'knowledge_chunks';
const EMBEDDING_DIMENSIONS = 512;

function field(name, type, nullable = false) {
  return new arrow.Field(name, type, nullable);
}

function knowledgeChunkSchema(dimensions = EMBEDDING_DIMENSIONS) {
  return new arrow.Schema([
    field('schema_version', new arrow.Int32()),
    field('record_id', new arrow.Utf8()),
    field('space_id', new arrow.Utf8()),
    field('entry_id', new arrow.Utf8()),
    field('entry_type', new arrow.Utf8()),
    field('entry_version', new arrow.Int32()),
    field('chunk_id', new arrow.Utf8()),
    field('chunk_order', new arrow.Int32()),
    field('title', new arrow.Utf8()),
    field('heading_path', new arrow.Utf8()),
    field('chunk_text', new arrow.Utf8()),
    field('search_text', new arrow.Utf8()),
    field('vector', new arrow.FixedSizeList(dimensions, field('item', new arrow.Float32()))),
    field('tags_json', new arrow.Utf8()),
    field('source_paths_json', new arrow.Utf8()),
    field('routes_json', new arrow.Utf8()),
    field('symbols_json', new arrow.Utf8()),
    field('source_project_id', new arrow.Utf8()),
    field('source_commit', new arrow.Utf8()),
    field('document_hash', new arrow.Utf8()),
    field('content_hash', new arrow.Utf8()),
    field('created_at', new arrow.Utf8()),
    field('updated_at', new arrow.Utf8()),
  ]);
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function requiredText(value, name) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

function jsonArray(value) {
  return JSON.stringify(Array.isArray(value) ? value.map(item => String(item)) : []);
}

function normalizeVector(value, dimensions = EMBEDDING_DIMENSIONS) {
  const vector = Array.from(value || [], Number);
  if (vector.length !== dimensions || vector.some(item => !Number.isFinite(item))) {
    throw new Error(`vector must contain exactly ${dimensions} finite numbers`);
  }
  return vector;
}

function normalizeKnowledgeChunk(input, options = {}) {
  const dimensions = options.dimensions || EMBEDDING_DIMENSIONS;
  const now = options.now || new Date().toISOString();
  const spaceId = requiredText(input.spaceId || input.space_id, 'spaceId');
  const entryId = requiredText(input.entryId || input.entry_id, 'entryId');
  const chunkOrder = Number.isInteger(input.chunkOrder) ? input.chunkOrder : Number(input.chunk_order || 0);
  if (!Number.isInteger(chunkOrder) || chunkOrder < 0) throw new Error('chunkOrder must be a non-negative integer');
  const chunkText = requiredText(input.chunkText || input.chunk_text, 'chunkText');
  const contentHash = String(input.contentHash || input.content_hash || sha256(chunkText));
  const chunkId = String(input.chunkId || input.chunk_id || `${entryId}:${chunkOrder}`);

  return {
    schema_version: KNOWLEDGE_DB_SCHEMA_VERSION,
    record_id: `${spaceId}:${chunkId}`,
    space_id: spaceId,
    entry_id: entryId,
    entry_type: String(input.entryType || input.entry_type || 'document'),
    entry_version: Number.isInteger(input.entryVersion) ? input.entryVersion : Number(input.entry_version || 1),
    chunk_id: chunkId,
    chunk_order: chunkOrder,
    title: String(input.title || ''),
    heading_path: Array.isArray(input.headingPath) ? input.headingPath.join(' > ') : String(input.heading_path || ''),
    chunk_text: chunkText,
    search_text: String(input.searchText || input.search_text || `${input.title || ''}\n${chunkText}`).trim(),
    vector: normalizeVector(input.vector, dimensions),
    tags_json: jsonArray(input.tags),
    source_paths_json: jsonArray(input.sourcePaths || input.source_paths),
    routes_json: jsonArray(input.routes),
    symbols_json: jsonArray(input.symbols),
    source_project_id: String(input.sourceProjectId || input.source_project_id || ''),
    source_commit: String(input.sourceCommit || input.source_commit || ''),
    document_hash: String(input.documentHash || input.document_hash || contentHash),
    content_hash: contentHash,
    created_at: String(input.createdAt || input.created_at || now),
    updated_at: String(input.updatedAt || input.updated_at || now),
  };
}

function decodeKnowledgeChunk(row) {
  const parse = (value) => {
    try { return JSON.parse(value || '[]'); } catch { return []; }
  };
  return {
    ...row,
    tags: parse(row.tags_json),
    sourcePaths: parse(row.source_paths_json),
    routes: parse(row.routes_json),
    symbols: parse(row.symbols_json),
  };
}

module.exports = {
  KNOWLEDGE_DB_SCHEMA_VERSION,
  KNOWLEDGE_TABLE,
  EMBEDDING_DIMENSIONS,
  knowledgeChunkSchema,
  normalizeKnowledgeChunk,
  decodeKnowledgeChunk,
  sha256,
};
