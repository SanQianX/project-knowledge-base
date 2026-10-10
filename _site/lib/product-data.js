const fs = require('fs');
const path = require('path');
const AtomicFile = require('./atomic-file');
const { DomainError } = require('./contracts');

const DATA_SCHEMA = 'project-knowledge/fresh-product-data/v1';

function initializeProductData(dataPath) {
  const marker = path.join(dataPath, 'product-data.json');
  if (fs.existsSync(marker)) {
    const value = AtomicFile.readJsonStrict(marker);
    if (value.schema !== DATA_SCHEMA) throw new DomainError('SCHEMA_UNSUPPORTED', '数据目录格式不受支持，请使用新的空目录重新导入项目。', { status: 409 });
    return;
  }
  // Old registries and unfinished claims must never become fresh product work.
  const oldData = ['settings.json', 'projects.json', 'projects', 'runtime', 'knowledge-engine', 'workbench', 'vectorhub', 'events', 'knowledge-store.json', 'ai-profiles.json', 'embedding-config.json'].some(name => {
    const file = path.join(dataPath, name);
    return fs.existsSync(file) && (!fs.statSync(file).isDirectory() || fs.readdirSync(file).length > 0);
  });
  if (oldData) throw new DomainError('SCHEMA_UNSUPPORTED', '不再迁移旧版知识库数据。请取消旧 KB_DATA_DIR 设置，或指定新的空数据目录，然后重新导入项目。', { status: 409 });
  AtomicFile.writeJsonAtomic(marker, { schema: DATA_SCHEMA, createdAt: new Date().toISOString() });
}

module.exports = { initializeProductData, DATA_SCHEMA };
