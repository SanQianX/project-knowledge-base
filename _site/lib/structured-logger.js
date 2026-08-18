const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
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
const CURSOR_VERSION = 2;
const DEFAULT_PAGE_SIZE = 500;
const MAX_PAGE_SIZE = 5000;
const REVERSE_CHUNK_BYTES = 64 * 1024;
const TERMINAL_EVENTS = /\.(?:completed|failed|cancelled)$/;

function localDay(date = new Date()) {
  const value = date instanceof Date ? date : new Date(date);
  const valid = Number.isNaN(value.getTime()) ? new Date() : value;
  const year = valid.getFullYear();
  const month = String(valid.getMonth() + 1).padStart(2, '0');
  const day = String(valid.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function defaultConfig(appRoot) {
  return {
    schema: SCHEMA,
    rootPath: path.join(path.resolve(appRoot), 'logs'),
    levels: [...LOG_LEVELS],
    configured: false,
  };
}

function normalizeConfig(input, appRoot) {
  const source = input && typeof input === 'object' ? input : {};
  const levels = Array.isArray(source.levels) ? source.levels.filter(level => LEVELS.has(level)) : [];
  return {
    schema: SCHEMA,
    rootPath: path.join(path.resolve(appRoot), 'logs'),
    levels: levels.length ? [...new Set(levels)] : [...LOG_LEVELS],
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
  return text
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/=:-]+/gi, `$1 ${REDACTED_VALUE}`)
    .replace(/([?&](?:api[-_]?key|token|access_token|auth|secret)=)[^&#\s]+/gi, `$1${REDACTED_VALUE}`)
    .replace(/(https?:\/\/[^\s/:@]+:)[^\s/@]+@/gi, `$1${REDACTED_VALUE}@`);
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
  const output = {
    name: boundedString(error.name || 'Error', 256),
    code: boundedString(error.code || '', 256),
    message: redactString(boundedString(error.message || error, FIELD_LIMITS.message), options.secrets),
    stack: redactString(boundedString(error.stack || '', FIELD_LIMITS.stack), options.secrets),
  };
  if (error.cause) output.cause = error.cause instanceof Error
    ? serializeError(error.cause, options, seen)
    : redactValue(error.cause, options, 'cause', seen);
  return output;
}

function normalizeRecord(entry, options = {}) {
  const context = entry.context && typeof entry.context === 'object'
    ? entry.context
    : (entry.meta && typeof entry.meta === 'object' ? entry.meta : {});
  return {
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
}

function appendRecordSync(directory, record, options = {}) {
  fs.mkdirSync(directory, { recursive: true });
  const filePath = path.join(directory, `${localDay(record.ts)}.jsonl`);
  const line = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8');
  const fd = fs.openSync(filePath, 'a', 0o600);
  try {
    fs.writeSync(fd, line, 0, line.length, null);
    if (options.flush !== false) fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return filePath;
}

function createLoggerCore(stderr) {
  return {
    queue: Promise.resolve(),
    health: { status: 'ok', lastError: null, failedAt: '', suppressedLevels: [] },
    events: new EventEmitter(),
    stderr,
  };
}

class Logger {
  constructor(options = {}) {
    this.layout = options.layout || new StorageLayout(options);
    this.settingsProvider = options.settingsProvider || (() => defaultConfig(this.layout.getDataDir()));
    this.projectId = options.projectId || '';
    this.baseContext = Object.freeze({ ...(options.context || {}) });
    this.secrets = options.secrets || [];
    this.secretsProvider = typeof options.secretsProvider === 'function' ? options.secretsProvider : null;
    this.core = options.core || createLoggerCore(options.stderr || process.stderr);
  }

  child(context = {}) {
    return new Logger({
      layout: this.layout,
      settingsProvider: this.settingsProvider,
      projectId: context.projectId || this.projectId,
      context: { ...this.baseContext, ...context },
      secrets: this.secrets,
      secretsProvider: this.secretsProvider,
      core: this.core,
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
    const projectId = record.projectId || this.projectId;
    return projectId ? this.layout.getLogPath('project', projectId) : this.layout.getLogPath('system');
  }

  isEnabled(level) {
    const config = normalizeConfig(this.settingsProvider() || {}, this.layout.getDataDir());
    return config.levels.includes(level) && !this.core.health.suppressedLevels.includes(level);
  }

  log(level, event, message, input = {}) {
    if (!LEVELS.has(level)) throw new DomainError('INVALID_ARGUMENT', `Invalid log level: ${level}.`);
    if (!this.isEnabled(level)) return Promise.resolve(null);
    const merged = { ...this.baseContext, ...(input || {}) };
    const secrets = this.currentSecrets();
    const record = normalizeRecord({
      ...merged,
      level,
      event,
      message,
      projectId: merged.projectId || this.projectId,
      context: merged.context || merged.meta || {},
    }, { secrets });
    const operation = async () => {
      try {
        const file = appendRecordSync(this.directoryFor(record), record);
        for (const listener of this.core.events.listeners('log-appended')) {
          try { listener(record); }
          catch {
            // Subscribers are observers and cannot affect durable logging.
          }
        }
        return { file, record };
      } catch (error) {
        this.core.health.status = 'degraded';
        this.core.health.lastError = serializeError(error, { secrets });
        this.core.health.failedAt = new Date().toISOString();
        this.core.health.suppressedLevels = ['trace', 'debug'];
        const fallback = normalizeRecord({ ...record, error: record.error || error }, { secrets });
        try { this.core.stderr.write(`[project-knowledge logger fallback] ${JSON.stringify(fallback)}\n`); }
        catch {
          // stderr is the logger's final non-recursive fallback.
        }
        return null;
      }
    };
    this.core.queue = this.core.queue.then(operation, operation);
    return this.core.queue;
  }

  trace(event, message, context) { return this.log('trace', event, message, context); }
  debug(event, message, context) { return this.log('debug', event, message, context); }
  info(event, message, context) { return this.log('info', event, message, context); }
  warn(event, message, context) { return this.log('warn', event, message, context); }
  error(event, message, context) { return this.log('error', event, message, context); }
  fatal(event, message, context) { return this.log('fatal', event, message, context); }
  subscribe(listener) {
    if (typeof listener !== 'function') throw new DomainError('INVALID_ARGUMENT', 'Log subscriber must be a function.');
    this.core.events.on('log-appended', listener);
    return () => this.core.events.off('log-appended', listener);
  }
  flush() { return this.core.queue; }
  close() { return this.flush(); }
  getHealth() { return JSON.parse(JSON.stringify(this.core.health)); }
}

function parseLogDate(fileName) {
  const match = String(fileName).match(/^(\d{4}-\d{2}-\d{2})(?:\.\d{3})?\.(?:jsonl|log)$/);
  return match ? match[1] : '';
}

function parseLine(line, sourceFile) {
  try {
    const parsed = JSON.parse(line);
    if (!parsed || !parsed.ts) return null;
    if (parsed.schema === SCHEMA) return { ...parsed, file: sourceFile };
    return {
      ...normalizeRecord({
        ts: parsed.ts,
        level: parsed.level,
        event: parsed.event,
        message: parsed.message,
        component: parsed.source || parsed.component || 'legacy',
        projectId: parsed.projectId,
        projectSlug: parsed.projectSlug,
        projectDisplayName: parsed.projectDisplayName,
        operationId: parsed.operationId,
        jobId: parsed.jobId,
        runId: parsed.runId,
        commitSha: parsed.commitSha || parsed.commitHash,
        context: parsed.meta || parsed.context || {},
      }),
      file: sourceFile,
    };
  } catch {
    return null;
  }
}

function encodeCursor(value) { return Buffer.from(JSON.stringify(value)).toString('base64url'); }
function decodeCursor(value) {
  try { return JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8')); }
  catch { throw new DomainError('INVALID_ARGUMENT', 'Invalid log cursor.', { status: 400 }); }
}

function filterFingerprint(filters) {
  const stable = {};
  for (const key of ['from', 'to', 'levels', 'scope', 'projectId', 'component', 'event', 'commitSha', 'operationId', 'q', 'pageSize']) stable[key] = filters[key] || '';
  return crypto.createHash('sha256').update(JSON.stringify(stable)).digest('hex').slice(0, 20);
}

function readPreviousLine(fd, endOffset) {
  let end = Math.max(0, Number(endOffset || 0));
  const one = Buffer.allocUnsafe(1);
  while (end > 0) {
    fs.readSync(fd, one, 0, 1, end - 1);
    if (one[0] !== 0x0a && one[0] !== 0x0d) break;
    end -= 1;
  }
  if (end === 0) return null;
  let cursor = end;
  while (cursor > 0) {
    const start = Math.max(0, cursor - REVERSE_CHUNK_BYTES);
    const buffer = Buffer.allocUnsafe(cursor - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    for (let index = buffer.length - 1; index >= 0; index -= 1) {
      if (buffer[index] === 0x0a) {
        const lineStart = start + index + 1;
        const lineBuffer = Buffer.allocUnsafe(end - lineStart);
        fs.readSync(fd, lineBuffer, 0, lineBuffer.length, lineStart);
        return { line: lineBuffer.toString('utf8').replace(/\r$/, ''), nextOffset: lineStart };
      }
    }
    cursor = start;
  }
  const lineBuffer = Buffer.allocUnsafe(end);
  fs.readSync(fd, lineBuffer, 0, end, 0);
  return { line: lineBuffer.toString('utf8').replace(/\r$/, ''), nextOffset: 0 };
}

class LogRepository {
  constructor(options = {}) {
    this.layout = options.layout || new StorageLayout(options);
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

  listSources() {
    const root = path.join(this.layout.getDataDir(), 'logs');
    if (!fs.existsSync(root)) return [];
    const output = [];
    const visit = directory => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) visit(absolute);
        else if (entry.isFile() && parseLogDate(entry.name)) {
          const stat = fs.statSync(absolute);
          output.push({
            path: absolute,
            relative: path.relative(root, absolute).replace(/\\/g, '/'),
            date: parseLogDate(entry.name),
            size: stat.size,
          });
        }
      }
    };
    visit(root);
    return output.sort((left, right) => left.relative.localeCompare(right.relative));
  }

  matches(record, filters) {
    const recordDay = localDay(record.ts);
    if (filters.from && recordDay < filters.from) return false;
    if (filters.to && recordDay > filters.to) return false;
    const levels = Array.isArray(filters.levels) ? filters.levels : String(filters.levels || '').split(',').filter(Boolean);
    if (levels.length && !levels.includes(record.level)) return false;
    if (filters.scope === 'system' && record.projectId) return false;
    if (filters.scope === 'project' && !record.projectId) return false;
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

  cursorExpired(message = 'Log cursor expired; restart the query.') {
    return new DomainError('LOG_CURSOR_EXPIRED', message, { status: 409, retryable: true });
  }

  query(input = {}) {
    const today = localDay();
    const pageSize = Math.max(1, Math.min(Number(input.pageSize || DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE));
    const filters = { ...input, from: input.from || today, to: input.to || today, pageSize };
    const fingerprint = filterFingerprint(filters);
    const root = path.join(this.layout.getDataDir(), 'logs');
    let states;
    if (input.cursor) {
      const cursor = decodeCursor(input.cursor);
      if (cursor.v !== CURSOR_VERSION || cursor.f !== fingerprint || !Array.isArray(cursor.sources)) {
        throw this.cursorExpired('Log cursor does not match the current filters.');
      }
      states = cursor.sources.map(source => {
        const filePath = path.resolve(root, source.path);
        const relative = path.relative(root, filePath);
        if (relative.startsWith('..') || path.isAbsolute(relative) || !fs.existsSync(filePath)) throw this.cursorExpired();
        const size = fs.statSync(filePath).size;
        if (size < source.limit || source.offset > source.limit) throw this.cursorExpired();
        return { path: filePath, relative: source.path, limit: source.limit, offset: source.offset };
      });
    } else {
      states = this.listSources()
        .filter(source => source.date >= filters.from && source.date <= filters.to)
        .map(source => ({ path: source.path, relative: source.relative, limit: source.size, offset: source.size }));
    }

    const openStates = states.map(state => ({ ...state, fd: fs.openSync(state.path, 'r') }));
    const candidates = [];
    const loadCandidate = state => {
      while (state.offset > 0) {
        const previous = readPreviousLine(state.fd, state.offset);
        if (!previous) { state.offset = 0; return; }
        const record = parseLine(previous.line, state.relative);
        if (!record || !this.matches(record, filters)) {
          state.offset = previous.nextOffset;
          continue;
        }
        candidates.push({ state, record, nextOffset: previous.nextOffset });
        return;
      }
    };

    try {
      for (const state of openStates) loadCandidate(state);
      const entries = [];
      while (entries.length < pageSize && candidates.length) {
        candidates.sort((left, right) => String(right.record.ts).localeCompare(String(left.record.ts))
          || String(right.record.id).localeCompare(String(left.record.id))
          || right.state.relative.localeCompare(left.state.relative));
        const selected = candidates.shift();
        entries.push(redactValue(selected.record, { secrets: this.currentSecrets() }));
        selected.state.offset = selected.nextOffset;
        loadCandidate(selected.state);
      }
      const nextCursor = candidates.length
        ? encodeCursor({
          v: CURSOR_VERSION,
          f: fingerprint,
          sources: openStates.map(state => ({ path: state.relative, limit: state.limit, offset: state.offset })),
        })
        : null;
      return {
        entries,
        nextCursor,
        pageSize,
        from: filters.from,
        to: filters.to,
        counts: this.countLevels(entries),
      };
    } finally {
      for (const state of openStates) fs.closeSync(state.fd);
    }
  }

  countLevels(entries) {
    return Object.fromEntries(LOG_LEVELS.map(level => [level, entries.filter(entry => entry.level === level).length]));
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
          fs.writeSync(fd, `${JSON.stringify(redactValue(entry, { secrets }))}\n`, null, 'utf8');
          count += 1;
        }
        cursor = page.nextCursor || '';
      } while (cursor);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return { filePath, count };
  }

  findOrphanedOperations(filters = {}) {
    const starts = new Map();
    const completed = new Set();
    let cursor = '';
    let inspected = 0;
    const maxEntries = Math.max(1, Math.min(Number(filters.maxEntries || 10000), 50000));
    do {
      const page = this.query({ ...filters, cursor, pageSize: Math.min(1000, maxEntries - inspected) });
      for (const entry of page.entries) {
        inspected += 1;
        if (!entry.operationId) continue;
        if (/\.started$/.test(entry.event)) starts.set(entry.operationId, entry);
        if (TERMINAL_EVENTS.test(entry.event)) completed.add(entry.operationId);
      }
      cursor = inspected < maxEntries ? (page.nextCursor || '') : '';
    } while (cursor);
    return [...starts.entries()].filter(([operationId]) => !completed.has(operationId)).map(([, entry]) => entry);
  }
}

function appendLog(configPath, appRoot, entry) {
  const config = readConfig(configPath, appRoot);
  const level = LEVELS.has(entry.level) ? entry.level : 'info';
  if (!config.levels.includes(level)) return null;
  const record = normalizeRecord({
    ...entry,
    level,
    component: entry.component || entry.source || 'server',
    context: entry.context || entry.meta || {},
  });
  const file = appendRecordSync(path.join(config.rootPath, 'system'), record);
  return { file, record };
}

function readLogs(configPath, appRoot, filters = {}) {
  const layout = new StorageLayout({ dataDir: appRoot });
  const repository = new LogRepository({ layout });
  const result = repository.query({
    from: filters.from || filters.dateFrom || '',
    to: filters.to || filters.dateTo || '',
    levels: filters.levels || (filters.level && filters.level !== 'all' ? [filters.level] : []),
    scope: filters.scope || '',
    projectId: filters.projectId || '',
    component: filters.component || (filters.source && filters.source !== 'all' ? filters.source : ''),
    event: filters.event || '',
    commitSha: filters.commitSha || '',
    operationId: filters.operationId || '',
    q: filters.q || '',
    pageSize: filters.pageSize || filters.limit || DEFAULT_PAGE_SIZE,
    cursor: filters.cursor || '',
  });
  if (filters.returnPage) return result;
  if (filters.projectSlug && filters.projectSlug !== 'all') return result.entries.filter(entry => entry.projectSlug === filters.projectSlug);
  return result.entries;
}

module.exports = {
  SCHEMA,
  LEVELS,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  Logger,
  LogRepository,
  defaultConfig,
  normalizeConfig,
  readConfig,
  writeConfig,
  appendLog,
  readLogs,
  normalizeRecord,
  appendRecordSync,
  redactString,
  redactValue,
  serializeError,
  parseLine,
  localDay,
  readPreviousLine,
};
