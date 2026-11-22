// tests/paths.js — 测试套件的中央路径助手 / central path helper for the suite.
// 所有测试对产品目录的定位都收口到这里：目录迁移只改这一处，
// 单个测试文件不再各自用 __dirname 向上跳。
// Every product-path anchor lives here so a layout move changes one file,
// not every test's __dirname hops.
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

module.exports = {
  ROOT,
  // 产品源码根，按域组织。/ Product source root, organized by domain.
  SRC: path.join(ROOT, 'src'),
  DOMAIN: domain => path.join(ROOT, 'src', domain),
  SERVER_ENTRY: path.join(ROOT, 'src', 'server', 'server-app.js'),
  SCRIPTS: path.join(ROOT, 'src', 'scripts'),
  // 浏览器静态资产（Phase 4 起为 resources/ui）。/ Served static assets.
  UI: path.join(ROOT, 'ui'),
  BIN: path.join(ROOT, 'bin'),
  PLUGINS: path.join(ROOT, 'plugins'),
  FIXTURES: path.join(__dirname, 'fixtures'),
  HELPERS: path.join(__dirname, 'helpers'),
};
