const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  SCHEMAS,
  LOG_LEVELS,
  REDACTION_KEY_PATTERN,
  REDACTED_VALUE,
  FIELD_LIMITS,
  DomainError,
  createId,
} = require('./contracts');
const { StorageLayout } = require('./storage-layout');
const AtomicFile = require('./atomic-file');

const SCHEMA = SCHEMAS.log;
const LEVELS = new Set(LOG_LEVELS);
const DEFAULT_SEGMENT_MAX_BYTES = 50 * 1024 * 1024;
const DEFAULT_RETENTION_DAYS = 365;
const DEFAULT_MAX_TOTAL_SIZE_MB = 2048;
const CURSOR_VERSION = 1;
const TERMINAL_EVENTS = /\.(?:completed|failed|cancelled)$/;

function utcDay(date = new Date()) { return date.toISOString().slice(0, 10); }

function defaultConfig(appRoot) {
  return {
    schema: SCHEMA,
    rootPath: path.join(path.resolve(appRoot), 'logs'),
    retentionDays: DEFAULT_RETENTION_DAYS,
    maxTotalSizeMB: DEFAULT_MAX_TOTAL_SIZE_MB,
    levels: ['info', 'warn', 'error', 'fatal'],
    configured: false,
  };
}

function normalizeConfig(input, appRoot) {
  const source = input && typeof input === 'object' ? input : {};
  const levels = Array.isArray(source.levels) ? source.levels.filter(level => LEVELS.has(level)) : [];
  return {
    schema: SCHEMA,
    rootPath: path.join(path.resolve(appRoot), 'logs'),
    retentionDays: Number.isInteger(source.retentionDays) && source.retentionDays >= 0 ? source.retentionDays : DEFAULT_RETENTION_DAYS,
    maxTotalSizeMB: Number.isFinite(source.maxTotalSizeMB) && source.maxTotalSizeMB > 0 ? Number(source.maxTotalSizeMB) : DEFAULT_MAX_TOTAL_SIZE_MB,
    levels: levels.length ? [...new Set(levels)] : ['info', 'warn', 'error', 'fatal'],
    configured: source.configured === true,
  };
}

function readConfig(configPath, appRoot) {
  if (!fs.existsSync(configPath)) return defaultConfig(appRoot);
  try { return normalizeConfig(JSON.parse(fs.readFileSync(configPath, 'utf8')), appRoot); }
  catch (error) { throw new DomainError('DATA_CORRUPT', 'Logging configuration is corrupt.', { status: 500, cause: error }); }
}

function writeConfig(configPath, appRoot, config) {
  const normalized = normalizeConfig({ ...(config || {}), configured: true }, appRoot);
  AtomicFile.writeJsonAtomic(configPath, normalized);
  return normalized;
}

function boundedString(value, limit = FIELD_LIMITS.contextString) {
  const text = String(value == null ? '' : value);
  return text.length > limit ? `${text.slice(0, limit)}…[truncated:${text.length - limit}]` : text;
}

function redactString(value, secrets = []) {
  let text = boundedString(value);
  for (const secret of secrets || []) {
    if (typeof secret === 'string' && secret.length >= 4) text = text.split(secret).join(REDACTED_VALUE);
  }
  text = text
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/=:-]+/gi, `$1 ${REDACTED_VALUE}`)
    .replace(/([?&](?:api[-_]?key|token|access_token|auth|secret)=)[^&#\s]+/gi, `$1${REDACTED_VALUE}`)
    .replace(/(https?:\/\/[^\s/:@]+:)[^\s/@]+@/gi, `$1${REDACTED_VALUE}@`);
  return text;
}

function redactValue(value, options = {}, key = '', seen = new WeakSet()) {
  const secrets = options.secrets || [];
  if (REDACTION_KEY_PATTERN.test(key) || /(?:headers?|prompt|diff|requestBody|responseBody)/i.test(key)) return REDACTED_VALUE;
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return redactString(value, secrets);
  if (value instanceof Error) return serializeError(value, options, seen);
  if (typeof value !== 'object') return redactString(value, secrets);
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 200).map(item => redactValue(item, options, '', seen));
  const output = {};
  for (const [childKey, child] of Object.entries(value)) output[childKey] = redactValue(child, options, childKey, seen);
  return output;
}

function serializeError(error, options = {}, seen = new WeakSet()) {
  if (!error) return null;
  if (seen.has(error)) return { name: 'Error', message: '[Circular error]' };
  seen.add(error);
  const out = {
    name: boundedString(error.name || 'Error', 256),
    code: boundedString(error.code || '', 256),
    message: redactString(boundedString(error.message || error, FIELD_LIMITS.message), options.secrets),
    stack: redactString(boundedString(error.stack || '', FIELD_LIMITS.stack), options.secrets),
  };
  if (error.cause) out.cause = error.cause instanceof Error
    ? serializeError(error.cause, options, seen)
    : redactValue(error.cause, options, 'cause', seen);
  return out;
}

function normalizeRecord(entry, options = {}) {
  const context = entry.context && typeof entry.context === 'object' ? entry.context : (entry.meta && typeof entry.meta === 'object' ? entry.meta : {});
  const record = {
    schema: SCHEMA,
    id: entry.id || createId('log'),
    ts: entry.ts || new Date().toISOString(),
    level: LEVELS.has(entry.level) ? entry.level : 'info',
    component: boundedString(entry.component || entry.source || 'app', 256),
    event: boundedString(entry.event || 'message', 256),
    message: redactString(boundedString(entry.message || '', FIELD_LIMITS.message), options.secrets),
    projectId: boundedString(entry.projectId || '', 128),
    projectSlug: boundedString(entry.projectSlug || '', 128),
    projectDisplayName: boundedString(entry.projectDisplayName || '', 256),
    projectDeleted: entry.projectDeleted === true,
    operationId: boundedString(entry.operationId || '', 128),
    jobId: boundedString(entry.jobId || '', 128),
    runId: boundedString(entry.runId || '', 128),
    commitSha: boundedString(entry.commitSha || entry.commitHash || '', 128),
    phase: boundedString(entry.phase || '', 128),
    attempt: Number.isFinite(entry.attempt) ? Number(entry.attempt) : 0,
    durationMs: Number.isFinite(entry.durationMs) ? Number(entry.durationMs) : 0,
    error: entry.error ? serializeError(entry.error, options) : null,
    context: redactValue(context, options, 'context'),
  };
  return record;
}

function segmentPath(directory, day, segment = 0) {
  return path.join(directory, segment ? `${day}.${String(segment).padStart(3, '0')}.jsonl` : `${day}.jsonl`);
}

function selectWritableSegment(directory, day, maxBytes, incomingBytes) {
  fs.mkdirSync(directory, { recursive: true });
  let segment = 0;
  while (true) {
    const candidate = segmentPath(directory, day, segment);
    const size = fs.existsSync(candidate) ? fs.statSync(candidate).size : 0;
    if (!size || size + incomingBytes <= maxBytes) return candidate;
    segment += 1;
  }
}

function appendRecordSync(directory, record, options = {}) {
  const line = `${JSON.stringify(record)}\n`;
  const bytes = Buffer.byteLength(line);
  const filePath = selectWritableSegment(directory, utcDay(new Date(record.ts)), options.segmentMaxBytes || DEFAULT_SEGMENT_MAX_BYTES, bytes);
  const fd = fs.openSync(filePath, 'a', 0o600);
  try {
    fs.writeFileSync(fd, line, 'utf8');
    if (options.flush !== false) fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  return filePath;
}

class Logger {
  constructor(options = {}) {
    this.layout = options.layout || new StorageLayout(options);
    this.settingsProvider = options.settingsProvider || (() => defaultConfig(this.layout.getDataDir()));
    this.scope = options.scope || 'app';
    this.projectId = options.projectId || '';
    this.baseContext = options.context || {};
    this.segmentMaxBytes = options.segmentMaxBytes || DEFAULT_SEGMENT_MAX_BYTES;
    this.secrets = options.secrets || [];
    this.secretsProvider = typeof options.secretsProvider === 'function' ? options.secretsProvider : null;
    this.stderr = options.stderr || process.stderr;
    this.queue = Promise.resolve();
    this.health = { status: 'ok', lastError: null, failedAt: '', suppressedLevels: [] };
  }

  child(context = {}) {
    return new Logger({
      layout: this.layout,
      settingsProvider: this.settingsProvider,
      scope: context.scope || this.scope,
      projectId: context.projectId || this.projectId,
      context: { ...this.baseContext, ...context },
      segmentMaxBytes: this.segmentMaxBytes,
      secrets: this.secrets,
      secretsProvider: this.secretsProvider,
      stderr: this.stderr,
    });
  }

  currentSecrets() {
    let dynamic = [];
    try { dynamic = this.secretsProvider ? this.secretsProvider() : []; }
    catch { dynamic = []; }
    return [...new Set([...this.secrets, ...(Array.isArray(dynamic) ? dynamic : [])]
      .filter(secret => typeof secret === 'string' && secret.length >= 4))];
  }

  directoryFor(record) {
    if (this.scope === 'hooks') return this.layout.getLogPath('hooks');
    const projectId = record.projectId || this.projectId;
    return projectId ? this.layout.getLogPath('project', projectId) : this.layout.getLogPath('app');
  }

  isEnabled(level) {
    const config = normalizeConfig(this.settingsProvider() || {}, this.layout.getDataDir());
    return config.levels.includes(level) && !this.health.suppressedLevels.includes(level);
  }

  log(level, event, message, input = {}) {
    if (!LEVELS.has(level)) throw new DomainError('INVALID_ARGUMENT', `Invalid log level: ${level}.`);
    if (!this.isEnabled(level)) return Promise.resolve(null);
    const merged = { ...this.baseContext, ...(input || {}) };
    const secrets = this.currentSecrets();
    const record = normalizeRecord({ ...merged, level, event, message, projectId: merged.projectId || this.projectId, context: merged.context || merged.meta || {} }, { secrets });
    const operation = async () => {
      try {
        const file = appendRecordSync(this.directoryFor(record), record, { segmentMaxBytes: this.segmentMaxBytes });
        return { file, record };
      } catch (error) {
        this.health = { status: 'degraded', lastError: serializeError(error, { secrets }), failedAt: new Date().toISOString(), suppressedLevels: ['trace', 'debug'] };
        const fallback = normalizeRecord({ ...record, error: record.error || error }, { secrets });
        try { this.stderr.write(`[project-knowledge logger fallback] ${JSON.stringify(fallback)}\n`); } catch {
          // stderr is the logger's final fallback; health remains degraded for API inspection.
        }
        return null;
      }
    };
    this.queue = this.queue.then(operation, operation);
    return this.queue;
  }

  trace(event, message, context) { return this.log('trace', event, message, context); }
  debug(event, message, context) { return this.log('debug', event, message, context); }
  info(event, message, context) { return this.log('info', event, message, context); }
  warn(event, message, context) { return this.log('warn', event, message, context); }
  error(event, message, context) { return this.log('error', event, message, context); }
  fatal(event, message, context) { return this.log('fatal', event, message, context); }
  flush() { return this.queue; }
  close() { return this.flush(); }
  getHealth() { return JSON.parse(JSON.stringify(this.health)); }
}

function parseSegmentDate(fileName) {
  const match = String(fileName).match(/^(\d{4}-\d{2}-\d{2})(?:\.\d{3})?\.(?:jsonl|log)$/);
  return match ? match[1] : '';
}

function parseLine(line, sourceFile) {
  try {
    const parsed = JSON.parse(line);
    if (!parsed || !parsed.ts) return null;
    if (parsed.schema === SCHEMA) return { ...parsed, file: sourceFile };
    return normalizeRecord({
      ts: parsed.ts,
      level: parsed.level,
      event: parsed.event,
      message: parsed.message,
      component: parsed.source || 'legacy',
      projectSlug: parsed.projectSlug,
      jobId: parsed.jobId,
      runId: parsed.runId,
      context: parsed.meta || {},
    });
  } catch { return null; }
}

function encodeCursor(value) { return Buffer.from(JSON.stringify(value)).toString('base64url'); }
function decodeCursor(value) {
  try { return JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8')); }
  catch { throw new DomainError('INVALID_ARGUMENT', 'Invalid log cursor.', { status: 400 }); }
}

function filterFingerprint(filters) {
  const stable = {};
  for (const key of ['from', 'to', 'levels', 'projectId', 'component', 'event', 'commitSha', 'operationId', 'q', 'pageSize']) stable[key] = filters[key] || '';
  return crypto.createHash('sha256').update(JSON.stringify(stable)).digest('hex').slice(0, 20);
}

class LogRepository {
  constructor(options = {}) {
    this.layout = options.layout || new StorageLayout(options);
    this.settingsProvider = options.settingsProvider || (() => defaultConfig(this.layout.getDataDir()));
    this.secrets = options.secrets || [];
    this.secretsProvider = typeof options.secretsProvider === 'function' ? options.secretsProvider : null;
  }

  currentSecrets() {
    let dynamic = [];
    try { dynamic = this.secretsProvider ? this.secretsProvider() : []; }
    catch { dynamic = []; }
    return [...new Set([...this.secrets, ...(Array.isArray(dynamic) ? dynamic : [])]
      .filter(secret => typeof secret === 'string' && secret.length >= 4))];
  }

  listSegments() {
    const root = path.join(this.layout.getDataDir(), 'logs');
    if (!fs.existsSync(root)) return [];
    const output = [];
    const visit = directory => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) visit(absolute);
        else if (entry.isFile() && /\.(?:jsonl|log)$/.test(entry.name) && parseSegmentDate(entry.name)) {
          const stat = fs.statSync(absolute);
          output.push({ path: absolute, relative: path.relative(root, absolute).replace(/\\/g, '/'), date: parseSegmentDate(entry.name), size: stat.size, mtimeMs: stat.mtimeMs });
        }
      }
    };
    visit(root);
    return output.sort((a, b) => b.date.localeCompare(a.date) || b.relative.localeCompare(a.relative));
  }

  matches(record, filters) {
    if (filters.from && String(record.ts).slice(0, 10) < filters.from) return false;
    if (filters.to && String(record.ts).slice(0, 10) > filters.to) return false;
    const levels = Array.isArray(filters.levels) ? filters.levels : String(filters.levels || '').split(',').filter(Boolean);
    if (levels.length && !levels.includes(record.level)) return false;
    if (filters.projectId && filters.projectId !== record.projectId) return false;
    if (filters.component && filters.component !== record.component) return false;
    if (filters.event && filters.event !== record.event) return false;
    if (filters.commitSha && filters.commitSha !== record.commitSha) return false;
    if (filters.operationId && filters.operationId !== record.operationId) return false;
    if (filters.q) {
      const haystack = `${record.message} ${record.event} ${record.component} ${record.projectId} ${record.projectSlug} ${record.commitSha} ${record.operationId} ${JSON.stringify(record.context || {})}`.toLowerCase();
      if (!haystack.includes(String(filters.q).toLowerCase())) return false;
    }
    return true;
  }

  query(input = {}) {
    const today = utcDay();
    const defaultFrom = utcDay(new Date(Date.now() - 6 * 24 * 60 * 60 * 1000));
    const filters = { ...input, from: input.from || defaultFrom, to: input.to || today };
    const secrets = this.currentSecrets();
    const pageSize = Math.max(1, Math.min(Number(input.pageSize || 100), 1000));
    const fingerprint = filterFingerprint(filters);
    const segments = this.listSegments().filter(segment => (!filters.from || segment.date >= filters.from) && (!filters.to || segment.date <= filters.to));
    let segmentIndex = 0;
    let lineIndex = 0;
    if (input.cursor) {
      const cursor = decodeCursor(input.cursor);
      if (cursor.v !== CURSOR_VERSION || cursor.f !== fingerprint) throw new DomainError('INVALID_ARGUMENT', 'Log cursor does not match current filters.', { status: 409, retryable: true });
      segmentIndex = segments.findIndex(segment => segment.relative === cursor.s);
      if (segmentIndex < 0) throw new DomainError('INVALID_ARGUMENT', 'Log cursor expired.', { status: 409, retryable: true });
      lineIndex = Number(cursor.i || 0);
    }
    const entries = [];
    let nextCursor = null;
    for (let si = segmentIndex; si < segments.length; si += 1) {
      const segment = segments[si];
      const lines = fs.readFileSync(segment.path, 'utf8').split(/\r?\n/).filter(Boolean).reverse();
      const start = si === segmentIndex ? lineIndex : 0;
      for (let li = start; li < lines.length; li += 1) {
        const record = parseLine(lines[li], segment.relative);
        if (!record || !this.matches(record, filters)) continue;
        entries.push(redactValue(record, { secrets }));
        if (entries.length >= pageSize) {
          if (li + 1 < lines.length) nextCursor = encodeCursor({ v: CURSOR_VERSION, f: fingerprint, s: segment.relative, i: li + 1 });
          else if (si + 1 < segments.length) nextCursor = encodeCursor({ v: CURSOR_VERSION, f: fingerprint, s: segments[si + 1].relative, i: 0 });
          return { entries, nextCursor, pageSize, from: filters.from, to: filters.to, counts: this.countLevels(entries) };
        }
      }
    }
    return { entries, nextCursor, pageSize, from: filters.from, to: filters.to, counts: this.countLevels(entries) };
  }

  countLevels(entries) {
    return Object.fromEntries(LOG_LEVELS.map(level => [level, entries.filter(entry => entry.level === level).length]));
  }

  cleanup(input = {}) {
    const config = normalizeConfig({ ...this.settingsProvider(), ...input }, this.layout.getDataDir());
    const segments = this.listSegments();
    const today = utcDay();
    const deleted = [];
    let releasedBytes = 0;
    const remove = segment => {
      fs.unlinkSync(segment.path);
      deleted.push(segment.relative);
      releasedBytes += segment.size;
    };
    if (config.retentionDays > 0) {
      const cutoff = utcDay(new Date(Date.now() - config.retentionDays * 24 * 60 * 60 * 1000));
      for (const segment of segments) if (segment.date < cutoff && segment.date !== today && fs.existsSync(segment.path)) remove(segment);
    }
    let remaining = this.listSegments();
    const maxBytes = config.maxTotalSizeMB * 1024 * 1024;
    let totalBytes = remaining.reduce((sum, segment) => sum + segment.size, 0);
    if (totalBytes > maxBytes) {
      const protectedDate = utcDay(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000));
      const candidates = remaining
        .filter(segment => segment.date !== today)
        .map(segment => ({ ...segment, important: this.segmentContainsImportant(segment.path) }))
        .sort((a, b) => Number(a.important) - Number(b.important) || a.date.localeCompare(b.date) || a.relative.localeCompare(b.relative));
      for (const segment of candidates) {
        if (totalBytes <= maxBytes) break;
        if (segment.important && segment.date >= protectedDate) continue;
        if (!fs.existsSync(segment.path)) continue;
        remove(segment);
        totalBytes -= segment.size;
      }
    }
    return { deleted, releasedBytes, totalBytes, maxBytes, degraded: totalBytes > maxBytes };
  }

  segmentContainsImportant(filePath) {
    const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean);
    return lines.some(line => {
      const record = parseLine(line, '');
      return record && ['warn', 'error', 'fatal'].includes(record.level);
    });
  }

  exportToFile(filePath, filters = {}) {
    let cursor = '';
    let count = 0;
    const secrets = this.currentSecrets();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const fd = fs.openSync(filePath, 'w', 0o600);
    try {
      do {
        const page = this.query({ ...filters, cursor, pageSize: 1000 });
        for (const entry of page.entries) {
          fs.writeFileSync(fd, `${JSON.stringify(redactValue(entry, { secrets }))}\n`, 'utf8');
          count += 1;
        }
        cursor = page.nextCursor || '';
      } while (cursor);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    return { filePath, count };
  }

  findOrphanedOperations(filters = {}) {
    const starts = new Map();
    const completed = new Set();
    let cursor = '';
    do {
      const page = this.query({ ...filters, cursor, pageSize: 1000 });
      for (const entry of page.entries) {
        if (!entry.operationId) continue;
        if (/\.started$/.test(entry.event)) starts.set(entry.operationId, entry);
        if (TERMINAL_EVENTS.test(entry.event)) completed.add(entry.operationId);
      }
      cursor = page.nextCursor || '';
    } while (cursor);
    return [...starts.entries()].filter(([operationId]) => !completed.has(operationId)).map(([, entry]) => entry);
  }
}

// Transitional synchronous adapters used by server.js until T10 wires the
// long-lived Logger and SettingsStore instances.
function appendLog(configPath, appRoot, entry) {
  const cfg = readConfig(configPath, appRoot);
  const level = LEVELS.has(entry.level) ? entry.level : 'info';
  if (!cfg.levels.includes(level)) return null;
  const record = normalizeRecord({
    ...entry,
    level,
    component: entry.component || entry.source || 'server',
    context: entry.context || entry.meta || {},
  });
  const file = appendRecordSync(path.join(cfg.rootPath, 'app'), record);
  return { file, record };
}

function readLogs(configPath, appRoot, filters = {}) {
  const layout = new StorageLayout({ dataDir: appRoot });
  const repository = new LogRepository({ layout, settingsProvider: () => readConfig(configPath, appRoot) });
  const result = repository.query({
    from: filters.from || filters.dateFrom || '',
    to: filters.to || filters.dateTo || '',
    levels: filters.levels || (filters.level && filters.level !== 'all' ? [filters.level] : []),
    projectId: filters.projectId || '',
    component: filters.component || (filters.source && filters.source !== 'all' ? filters.source : ''),
    event: filters.event || '',
    commitSha: filters.commitSha || '',
    operationId: filters.operationId || '',
    q: filters.q || '',
    pageSize: filters.pageSize || filters.limit || 500,
    cursor: filters.cursor || '',
  });
  if (filters.returnPage) return result;
  if (filters.projectSlug && filters.projectSlug !== 'all') return result.entries.filter(entry => entry.projectSlug === filters.projectSlug);
  return result.entries;
}

module.exports = {
  SCHEMA,
  LEVELS,
  DEFAULT_SEGMENT_MAX_BYTES,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_MAX_TOTAL_SIZE_MB,
  Logger,
  LogRepository,
  defaultConfig,
  normalizeConfig,
  readConfig,
  writeConfig,
  appendLog,
  readLogs,
  normalizeRecord,
  redactString,
  redactValue,
  serializeError,
  parseLine,
};
