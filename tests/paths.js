// tests/paths.js — 测试套件的中央路径助手 / central path helper for the suite.
// 所有测试对产品目录的定位都收口到这里：目录迁移只改这一处，
// 单个测试文件不再各自用 __dirname 向上跳。
// Every product-path anchor lives here so a layout move changes one file,
// not every test's __dirname hops.
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

module.exports = {
  ROOT,
  // 产品源码根（Phase 3 起为 src/）。/ Product source root (src/ from Phase 3 on).
  SRC: path.join(ROOT, '_site'),
  LIB: path.join(ROOT, '_site', 'lib'),
  SERVER_ENTRY: path.join(ROOT, '_site', 'lib', 'server-app.js'),
  SCRIPTS: path.join(ROOT, '_site', 'scripts'),
  // 浏览器静态资产（Phase 4 起为 resources/ui）。/ Served static assets.
  UI: path.join(ROOT, 'ui'),
  BIN: path.join(ROOT, 'bin'),
  PLUGINS: path.join(ROOT, 'plugins'),
  FIXTURES: path.join(__dirname, 'fixtures'),
  HELPERS: path.join(__dirname, 'helpers'),
};
