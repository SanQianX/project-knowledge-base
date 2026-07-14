const fs = require('fs');
const path = require('path');
const lancedb = require('@lancedb/lancedb');
const {
  KNOWLEDGE_TABLE,
  EMBEDDING_DIMENSIONS,
  knowledgeChunkSchema,
  normalizeKnowledgeChunk,
  decodeKnowledgeChunk,
} = require('./knowledge-schema');

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function inPredicate(column, values) {
  const clean = Array.from(new Set((values || []).map(value => String(value).trim()).filter(Boolean)));
  if (!clean.length) throw new Error(`${column} filter must not be empty`);
  return `${column} IN (${clean.map(sqlString).join(', ')})`;
}

class KnowledgeDatabase {
  constructor(options = {}) {
    if (!options.dbPath) throw new Error('dbPath is required');
    this.dbPath = path.resolve(options.dbPath);
    this.tableName = options.tableName || KNOWLEDGE_TABLE;
    this.dimensions = options.dimensions || EMBEDDING_DIMENSIONS;
    this.connection = null;
    this.table = null;
  }

  async open() {
    if (this.table) return this;
    fs.mkdirSync(this.dbPath, { recursive: true });
    this.connection = await lancedb.connect(this.dbPath);
    const names = await this.connection.tableNames();
    this.table = names.includes(this.tableName)
      ? await this.connection.openTable(this.tableName)
      : await this.connection.createEmptyTable(this.tableName, knowledgeChunkSchema(this.dimensions));
    return this;
  }

  async close() {
    this.table = null;
    if (this.connection) this.connection.close();
    this.connection = null;
  }

  async count(spaceIds = null) {
    await this.open();
    return this.table.countRows(spaceIds ? inPredicate('space_id', spaceIds) : undefined);
  }

  async rowsForEntry(spaceId, entryId) {
    await this.open();
    const rows = await this.table.query()
      .where(`space_id = ${sqlString(spaceId)} AND entry_id = ${sqlString(entryId)}`)
      .toArray();
    return rows.map(decodeKnowledgeChunk);
  }

  async replaceEntry(spaceId, entryId, chunks) {
    await this.open();
    if (!Array.isArray(chunks) || chunks.length === 0) {
      const result = await this.deleteEntry(spaceId, entryId);
      return { ok: true, action: 'deleted', deleted: result.deleted || 0, upserted: 0 };
    }
    const now = new Date().toISOString();
    const existing = await this.rowsForEntry(spaceId, entryId);
    const existingById = new Map(existing.map(row => [row.record_id, row]));
    const normalized = chunks.map(chunk => normalizeKnowledgeChunk({ ...chunk, spaceId, entryId }, {
      dimensions: this.dimensions,
      now,
    })).map(row => ({
      ...row,
      created_at: existingById.get(row.record_id)?.created_at || row.created_at,
    }));

    const unchanged = existing.length === normalized.length && normalized.every(row => {
      const old = existingById.get(row.record_id);
      return old && old.content_hash === row.content_hash && old.source_commit === row.source_commit;
    });
    if (unchanged) return { ok: true, action: 'unchanged', upserted: 0, deleted: 0, total: normalized.length };

    await this.table.mergeInsert('record_id')
      .whenMatchedUpdateAll()
      .whenNotMatchedInsertAll()
      .execute(normalized);

    const keep = new Set(normalized.map(row => row.record_id));
    const stale = existing.filter(row => !keep.has(row.record_id));
    if (stale.length) {
      await this.table.delete(`record_id IN (${stale.map(row => sqlString(row.record_id)).join(', ')})`);
    }
    return { ok: true, action: existing.length ? 'updated' : 'created', upserted: normalized.length, deleted: stale.length, total: normalized.length };
  }

  async deleteEntry(spaceId, entryId) {
    await this.open();
    const before = await this.table.countRows(`space_id = ${sqlString(spaceId)} AND entry_id = ${sqlString(entryId)}`);
    if (before) await this.table.delete(`space_id = ${sqlString(spaceId)} AND entry_id = ${sqlString(entryId)}`);
    return { ok: true, deleted: before };
  }

  async deleteSpace(spaceId) {
    await this.open();
    const before = await this.table.countRows(`space_id = ${sqlString(spaceId)}`);
    if (before) await this.table.delete(`space_id = ${sqlString(spaceId)}`);
    return { ok: true, deleted: before };
  }

  async vectorSearch(vector, options = {}) {
    await this.open();
    const spaceIds = options.spaceIds || [];
    const limit = Math.max(1, Math.min(Number(options.limit || 10), 100));
    const query = this.table.query()
      .nearestTo(Array.from(vector || [], Number))
      .column('vector')
      .distanceType('cosine')
      .where(inPredicate('space_id', spaceIds))
      .limit(limit);
    const rows = await query.toArray();
    return rows.map(decodeKnowledgeChunk);
  }
}

module.exports = { KnowledgeDatabase, sqlString, inPredicate };
