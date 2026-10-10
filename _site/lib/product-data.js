const fs = require('fs');
const path = require('path');
const AtomicFile = require('./atomic-file');
const { DomainError } = require('./contracts');

const DATA_SCHEMA = 'project-knowledge/fresh-product-data/v1';

function hasData(file) {
  return fs.existsSync(file) && (!fs.statSync(file).isDirectory() || fs.readdirSync(file).length > 0);
}

function initializeProductData(dataPath) {
  const marker = path.join(dataPath, 'product-data.json');
  if (fs.existsSync(marker)) {
    const value = AtomicFile.readJsonStrict(marker);
    if (value.schema !== DATA_SCHEMA) throw new DomainError('SCHEMA_UNSUPPORTED', '数据目录格式不受支持，请使用新的空目录重新导入项目。', { status: 409 });
    return;
  }
  // Old registries and unfinished claims must never become fresh product work.
  const oldData = ['settings.json', 'projects.json', 'projects', 'knowledge-engine', 'workbench', 'vectorhub', 'events', 'knowledge-store.json', 'ai-profiles.json', 'embedding-config.json']
    .filter(name => hasData(path.join(dataPath, name)));
  const runtimePath = path.join(dataPath, 'runtime');
  if (fs.existsSync(runtimePath)) {
    if (!fs.statSync(runtimePath).isDirectory()) oldData.push('runtime');
    else for (const name of fs.readdirSync(runtimePath)) {
      // Unregistered legacy chat records cannot be resumed by a fresh registry.
      // They are neither knowledge nor pending maintenance, and stay untouched.
      if (name !== 'claude-sessions' && hasData(path.join(runtimePath, name))) oldData.push(`runtime/${name}`);
    }
  }
  if (oldData.length) throw new DomainError('SCHEMA_UNSUPPORTED', `数据目录 ${dataPath} 包含旧版业务数据（${oldData.join('、')}）。新版不会迁移或删除它们；请将 KB_DATA_DIR 指向新的空目录，然后重新导入项目。`, { status: 409, details: { dataPath, entries: oldData } });
  AtomicFile.writeJsonAtomic(marker, { schema: DATA_SCHEMA, createdAt: new Date().toISOString() });
}

module.exports = { initializeProductData, DATA_SCHEMA };
