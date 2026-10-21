'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { atomicJSON, hash, must, noLinks } = require('../lib/safety.cjs');
const { git } = require('../lib/git.cjs');
function inventory(cfg) {
    const files = git({ ...cfg, repoRoot: cfg.sourceRoot }, ['ls-files', '-z']).split('\0').filter(Boolean);
    const entries = [], locators = [], apis = [];
    for (const file of files) {
        const full = path.join(cfg.sourceRoot, file);
        if (!fs.existsSync(full))
            continue;
        noLinks(cfg.sourceRoot, full);
        const st = fs.lstatSync(full);
        if (!st.isFile())
            continue;
        const entry = { file, bytes: st.size, sha256: hash(fs.readFileSync(full)), category: file.startsWith('_site/_test/') ? 'existing-test' : file.startsWith('_modules/') ? 'vendored-runtime' : file.startsWith('plugins/') ? 'integration' : 'source-or-document' };
        entries.push(entry);
        if (file === 'ui/index.html' || file === 'ui/product.js' || file === '_site/lib/server-app.js') {
            const text = fs.readFileSync(full, 'utf8'), lines = text.split(/\r?\n/);
            lines.forEach((line, i) => {
                for (const m of line.matchAll(/\bid="([A-Za-z0-9_-]+)"/g))
                    locators.push({ selector: '#' + m[1], file, line: i + 1 });
                for (const m of line.matchAll(/["'`]((?:\/api\/)[A-Za-z0-9_/${}.:?=&+%-]+)/g))
                    apis.push({ pattern: m[1], file, line: i + 1, verified: 'lexical-reference-only' });
            });
        }
    }
    const result = { schema: 1, at: new Date().toISOString(), sourceHead: git({ ...cfg, repoRoot: cfg.sourceRoot }, ['rev-parse', 'HEAD']), entries, locators, apis, note: 'Inventory is not dead-code proof. Dynamic entry points must be audited separately.' };
    atomicJSON(path.join(cfg.qaRoot, 'reports', 'runs', 'inventory-' + Date.now() + '.json'), result);
    return { files: entries.length, tests: entries.filter(e => e.category === 'existing-test').length, locators: locators.length, apiReferences: apis.length };
}
module.exports = { inventory };
