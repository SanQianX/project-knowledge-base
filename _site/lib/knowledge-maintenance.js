const fs = require('fs');
const path = require('path');
const { KnowledgeDatabase, FTS_SCHEMA_VERSION } = require('./knowledge-db');
const { isDerivedIndex } = require('./markdown-knowledge-indexer');

const MAINTENANCE_SCHEMA = 'project-knowledge/database-maintenance/v1';

function atomicJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, filePath);
}

function readJson(filePath) {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

function directoryStats(root) {
  const result = { bytes: 0, files: 0, sections: {} };
  if (!fs.existsSync(root)) return result;
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) {
        const bytes = fs.statSync(abs).size;
        const parts = path.relative(root, abs).replace(/\\/g, '/').split('/');
        const section = parts.length > 1 && parts[0].endsWith('.lance') ? parts[1] : parts[0];
        result.bytes += bytes;
        result.files += 1;
        result.sections[section] = (result.sections[section] || 0) + bytes;
      }
    }
  };
  walk(root);
  return result;
}

function compactRow(row) {
  return {
    schema_version: Number(row.schema_version || 1),
    record_id: String(row.record_id),
    space_id: String(row.space_id),
    entry_id: String(row.entry_id),
    entry_type: String(row.entry_type || 'document'),
    entry_version: Number(row.entry_version || 1),
    chunk_id: String(row.chunk_id),
    chunk_order: Number(row.chunk_order || 0),
    title: String(row.title || ''),
    heading_path: String(row.heading_path || ''),
    chunk_text: String(row.chunk_text || ''),
    // v4.0.0 duplicated chunk_text here. FTS v2 indexes chunk_text directly,
    // so retain only compact discovery metadata in the compatibility column.
    search_text: [row.title, row.heading_path].map(value => String(value || '').trim()).filter(Boolean).join('\n'),
    vector: Array.from(row.vector || [], Number),
    tags_json: String(row.tags_json || '[]'),
    source_paths_json: String(row.source_paths_json || '[]'),
    routes_json: String(row.routes_json || '[]'),
    symbols_json: String(row.symbols_json || '[]'),
    source_project_id: String(row.source_project_id || ''),
    source_commit: String(row.source_commit || ''),
    document_hash: String(row.document_hash || ''),
    content_hash: String(row.content_hash || ''),
    created_at: String(row.created_at || ''),
    updated_at: String(row.updated_at || ''),
  };
}

function probeText(rows) {
  for (const row of rows) {
    const match = String(row.chunk_text || '').match(/[\p{L}\p{N}_-]{2,16}/u);
    if (match) return { text: match[0], row };
  }
  return null;
}

class KnowledgeMaintenanceManager {
  constructor(options = {}) {
    if (!options.database) throw new Error('database is required');
    if (!options.dataDir) throw new Error('dataDir is required');
    this.database = options.database;
    this.dataDir = path.resolve(options.dataDir);
    this.dbPath = path.resolve(options.dbPath || this.database.dbPath);
    this.statePath = options.statePath || path.join(this.dataDir, 'knowledge-maintenance.json');
    this.backupRoot = options.backupRoot || path.join(this.dataDir, '_backup', 'knowledge-db');
  }

  state() {
    return readJson(this.statePath) || {
      schema: MAINTENANCE_SCHEMA,
      status: 'idle',
      running: false,
      startedAt: null,
      endedAt: null,
      lastBackupPath: null,
    };
  }

  save(patch) {
    const value = { ...this.state(), ...patch, schema: MAINTENANCE_SCHEMA };
    atomicJson(this.statePath, value);
    return value;
  }

  async inspect(options = {}) {
    const disk = directoryStats(this.dbPath);
    const maintenance = this.database.maintenanceState();
    const result = {
      ok: true,
      ...this.state(),
      exists: fs.existsSync(this.dbPath),
      dbPath: this.dbPath,
      bytes: disk.bytes,
      files: disk.files,
      sections: disk.sections,
      ftsSchemaVersion: maintenance.ftsSchemaVersion,
      ftsUpgradeRequired: maintenance.ftsUpgradeRequired === true,
      pendingOperations: maintenance.pendingOperations,
      pendingRows: maintenance.pendingRows,
      lastOptimizedAt: maintenance.lastOptimizedAt,
    };
    if (result.exists && options.openDatabase !== false) {
      result.rows = await this.database.count();
      result.versions = (await this.database.versions()).length;
      result.indices = await this.database.indexDetails();
    }
    result.rebuildRecommended = result.ftsUpgradeRequired || result.bytes >= 512 * 1024 * 1024;
    return result;
  }

  async verify(database, expectedRows, expectedRecordIds) {
    const count = await database.count();
    if (count !== expectedRows.length) throw new Error(`verification failed: expected ${expectedRows.length} rows, found ${count}`);
    const actualIds = (await database.allRows()).map(row => String(row.record_id)).sort();
    if (JSON.stringify(actualIds) !== JSON.stringify(expectedRecordIds)) throw new Error('verification failed: record id set changed');
    if (expectedRows.length) {
      const sample = expectedRows[0];
      const semantic = await database.vectorSearch(Array.from(sample.vector, Number), { spaceIds: [String(sample.space_id)], limit: 1 });
      if (!semantic.length || semantic[0].space_id !== sample.space_id) throw new Error('verification failed: vector search probe returned no result');
      const keywordProbe = probeText(expectedRows);
      if (keywordProbe) {
        const keyword = await database.fullTextSearch(keywordProbe.text, { spaceIds: [String(keywordProbe.row.space_id)], limit: 5 });
        if (!keyword.length) throw new Error('verification failed: keyword search probe returned no result');
      }
    }
    return { rows: count, vector: expectedRows.length > 0, keyword: !!probeText(expectedRows) };
  }

  assertManagedPath(target) {
    const resolved = path.resolve(target);
    const dataPrefix = `${this.dataDir}${path.sep}`.toLowerCase();
    if (!resolved.toLowerCase().startsWith(dataPrefix)) throw new Error(`refusing to modify path outside data directory: ${resolved}`);
    return resolved;
  }

  removeManaged(target) {
    const resolved = this.assertManagedPath(target);
    if (fs.existsSync(resolved)) fs.rmSync(resolved, { recursive: true, force: true });
  }

  async rebuild(options = {}) {
    if (!fs.existsSync(this.dbPath)) throw new Error(`knowledge database not found: ${this.dbPath}`);
    const keepBackup = options.keepBackup === true;
    const batchId = new Date().toISOString().replace(/[:.]/g, '-');
    const tempPath = this.assertManagedPath(`${this.dbPath}.rebuild-${batchId}`);
    const backupPath = this.assertManagedPath(path.join(this.backupRoot, `knowledge-${batchId}.lancedb`));
    const sourceSidecar = this.database.maintenancePath;
    const tempSidecar = `${tempPath}.maintenance.json`;
    const backupSidecar = `${backupPath}.maintenance.json`;
    let replacement = null;
    let swapped = false;
    this.save({ status: 'running', running: true, startedAt: new Date().toISOString(), endedAt: null, error: null });
    try {
      this.removeManaged(tempPath);
      if (fs.existsSync(tempSidecar)) fs.rmSync(tempSidecar, { force: true });
      const sourceRows = await this.database.allRows();
      const rows = sourceRows.filter(row => !isDerivedIndex(row.entry_id)).map(compactRow);
      const expectedRecordIds = rows.map(row => row.record_id).sort();
      const before = directoryStats(this.dbPath);

      replacement = new KnowledgeDatabase({ dbPath: tempPath, maintenancePath: tempSidecar });
      await replacement.addRows(rows);
      await replacement.ensureSearchIndexes();
      const verified = await this.verify(replacement, rows, expectedRecordIds);
      const compact = directoryStats(tempPath);
      await replacement.close();
      replacement = null;
      await this.database.close();

      fs.mkdirSync(path.dirname(backupPath), { recursive: true });
      fs.renameSync(this.dbPath, backupPath);
      if (fs.existsSync(sourceSidecar)) fs.renameSync(sourceSidecar, backupSidecar);
      try {
        fs.renameSync(tempPath, this.dbPath);
        if (fs.existsSync(tempSidecar)) fs.renameSync(tempSidecar, sourceSidecar);
        swapped = true;
      } catch (error) {
        if (fs.existsSync(this.dbPath)) this.removeManaged(this.dbPath);
        fs.renameSync(backupPath, this.dbPath);
        if (fs.existsSync(backupSidecar)) fs.renameSync(backupSidecar, sourceSidecar);
        throw error;
      }

      await this.database.open();
      if (await this.database.count() !== rows.length) throw new Error('post-swap verification failed');
      let backupRetained = keepBackup;
      if (!keepBackup) {
        try {
          this.removeManaged(backupPath);
          if (fs.existsSync(backupSidecar)) fs.rmSync(backupSidecar, { force: true });
        } catch {
          backupRetained = true;
        }
      }
      const after = directoryStats(this.dbPath);
      return this.save({
        status: 'completed',
        running: false,
        endedAt: new Date().toISOString(),
        beforeBytes: before.bytes,
        afterBytes: after.bytes,
        reclaimedBytes: Math.max(0, before.bytes - after.bytes),
        removedDerivedRows: sourceRows.length - rows.length,
        rows: rows.length,
        verified,
        ftsSchemaVersion: FTS_SCHEMA_VERSION,
        backupRetained,
        lastBackupPath: backupRetained ? backupPath : null,
        compactBuildBytes: compact.bytes,
      });
    } catch (error) {
      if (replacement) await replacement.close().catch(() => {});
      if (swapped && fs.existsSync(backupPath)) {
        await this.database.close().catch(() => {});
        const failedSwap = this.assertManagedPath(`${tempPath}.failed`);
        if (fs.existsSync(this.dbPath)) fs.renameSync(this.dbPath, failedSwap);
        if (fs.existsSync(sourceSidecar)) fs.renameSync(sourceSidecar, `${failedSwap}.maintenance.json`);
        fs.renameSync(backupPath, this.dbPath);
        if (fs.existsSync(backupSidecar)) fs.renameSync(backupSidecar, sourceSidecar);
        this.removeManaged(failedSwap);
        if (fs.existsSync(`${failedSwap}.maintenance.json`)) fs.rmSync(`${failedSwap}.maintenance.json`, { force: true });
      } else {
        if (!fs.existsSync(this.dbPath) && fs.existsSync(backupPath)) fs.renameSync(backupPath, this.dbPath);
        if (!fs.existsSync(sourceSidecar) && fs.existsSync(backupSidecar)) fs.renameSync(backupSidecar, sourceSidecar);
      }
      this.removeManaged(tempPath);
      if (fs.existsSync(tempSidecar)) fs.rmSync(tempSidecar, { force: true });
      await this.database.open().catch(() => {});
      this.save({ status: 'failed', running: false, endedAt: new Date().toISOString(), error: error.message });
      throw error;
    }
  }

  async rollbackBackup() {
    const current = this.state();
    const backupPath = current.lastBackupPath && this.assertManagedPath(current.lastBackupPath);
    if (!backupPath || !fs.existsSync(backupPath)) throw new Error('no retained database backup is available');
    const batchId = new Date().toISOString().replace(/[:.]/g, '-');
    const discarded = this.assertManagedPath(path.join(this.backupRoot, `discarded-${batchId}.lancedb`));
    const sourceSidecar = this.database.maintenancePath;
    const backupSidecar = `${backupPath}.maintenance.json`;
    const discardedSidecar = `${discarded}.maintenance.json`;
    await this.database.close();
    try {
      fs.renameSync(this.dbPath, discarded);
      if (fs.existsSync(sourceSidecar)) fs.renameSync(sourceSidecar, discardedSidecar);
      fs.renameSync(backupPath, this.dbPath);
      if (fs.existsSync(backupSidecar)) fs.renameSync(backupSidecar, sourceSidecar);
      await this.database.open();
      const rows = await this.database.count();
      this.removeManaged(discarded);
      if (fs.existsSync(discardedSidecar)) fs.rmSync(discardedSidecar, { force: true });
      return this.save({ status: 'rolled-back', running: false, endedAt: new Date().toISOString(), rows, lastBackupPath: null, backupRetained: false });
    } catch (error) {
      if (!fs.existsSync(this.dbPath) && fs.existsSync(discarded)) fs.renameSync(discarded, this.dbPath);
      if (!fs.existsSync(sourceSidecar) && fs.existsSync(discardedSidecar)) fs.renameSync(discardedSidecar, sourceSidecar);
      await this.database.open().catch(() => {});
      throw error;
    }
  }
}

module.exports = { KnowledgeMaintenanceManager, MAINTENANCE_SCHEMA, directoryStats, compactRow };
