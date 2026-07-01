const fs = require('fs');
const path = require('path');

const SCHEMA = 'logging/v1';
const LEVELS = new Set(['info', 'warn', 'error']);

function defaultConfig(appRoot) {
  return {
    schema: SCHEMA,
    rootPath: path.join(appRoot, 'logs'),
    retentionDays: 30,
    levels: ['info', 'warn', 'error'],
    configured: false,
  };
}

function normalizeConfig(input, appRoot) {
  const source = input && typeof input === 'object' ? input : {};
  const levels = Array.isArray(source.levels)
    ? source.levels.filter(level => LEVELS.has(level))
    : ['info', 'warn', 'error'];
  return {
    schema: SCHEMA,
    rootPath: path.resolve(source.rootPath || path.join(appRoot, 'logs')),
    retentionDays: Number.isInteger(source.retentionDays) && source.retentionDays > 0 ? source.retentionDays : 30,
    levels: levels.length ? levels : ['info', 'warn', 'error'],
    configured: source.configured === true,
  };
}

function readConfig(configPath, appRoot) {
  if (!fs.existsSync(configPath)) return defaultConfig(appRoot);
  try {
    return normalizeConfig(JSON.parse(fs.readFileSync(configPath, 'utf-8')), appRoot);
  } catch {
    return defaultConfig(appRoot);
  }
}

function writeConfig(configPath, appRoot, config) {
  const normalized = normalizeConfig({ ...config, configured: true }, appRoot);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.mkdirSync(normalized.rootPath, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(normalized, null, 2) + '\n', 'utf-8');
  return normalized;
}

function dayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function appendLog(configPath, appRoot, entry) {
  const cfg = readConfig(configPath, appRoot);
  const level = LEVELS.has(entry.level) ? entry.level : 'info';
  if (!cfg.levels.includes(level)) return null;
  fs.mkdirSync(cfg.rootPath, { recursive: true });
  const record = {
    ts: entry.ts || new Date().toISOString(),
    level,
    projectSlug: entry.projectSlug || '',
    source: entry.source || 'app',
    event: entry.event || 'message',
    message: entry.message || '',
    jobId: entry.jobId || '',
    runId: entry.runId || '',
    meta: entry.meta && typeof entry.meta === 'object' ? entry.meta : {},
  };
  const file = path.join(cfg.rootPath, `${dayKey(new Date(record.ts))}.log`);
  fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf-8');
  return { file, record };
}

function parseLogLine(line) {
  try {
    const parsed = JSON.parse(line);
    if (parsed && parsed.ts && parsed.level && parsed.message != null) return parsed;
  } catch {}
  return null;
}

function readLogs(configPath, appRoot, filters = {}) {
  const cfg = readConfig(configPath, appRoot);
  let files = [];
  try { files = fs.readdirSync(cfg.rootPath).filter(file => file.endsWith('.log')).sort(); } catch { return []; }
  const dateFrom = filters.dateFrom || '';
  const dateTo = filters.dateTo || '';
  const q = String(filters.q || '').toLowerCase();
  const out = [];
  for (const file of files) {
    const date = file.replace(/\.log$/, '');
    if (dateFrom && date < dateFrom) continue;
    if (dateTo && date > dateTo) continue;
    const abs = path.join(cfg.rootPath, file);
    const lines = fs.readFileSync(abs, 'utf-8').split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      const record = parseLogLine(line);
      if (!record) continue;
      if (filters.level && filters.level !== 'all' && record.level !== filters.level) continue;
      if (filters.projectSlug && filters.projectSlug !== 'all' && record.projectSlug !== filters.projectSlug) continue;
      if (filters.source && filters.source !== 'all' && record.source !== filters.source) continue;
      if (q) {
        const haystack = `${record.message} ${record.event} ${record.projectSlug} ${record.source} ${JSON.stringify(record.meta || {})}`.toLowerCase();
        if (!haystack.includes(q)) continue;
      }
      out.push({ ...record, file });
    }
  }
  return out.sort((a, b) => String(b.ts).localeCompare(String(a.ts))).slice(0, filters.limit || 500);
}

module.exports = {
  SCHEMA,
  LEVELS,
  defaultConfig,
  normalizeConfig,
  readConfig,
  writeConfig,
  appendLog,
  readLogs,
};
