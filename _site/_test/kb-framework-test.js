// Run: node _site/_test/kb-framework-test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), `kb-framework-${process.pid}-`));
process.env.KB_DATA_DIR = path.join(temp, 'data');
process.env.KB_SKIP_MIGRATION = '1';
require('../lib/data-dir')._resetCache();
const framework = require('../lib/kb-framework');

(() => {
  try {
    const fresh = path.join(temp, 'knowledge', 'fresh');
    const initialized = framework.initProjectDirs('fresh-project', fresh);
    assert.strictEqual(initialized.lazy, true);
    assert.deepStrictEqual(initialized.created, []);
    assert.deepStrictEqual(fs.readdirSync(fresh), [], 'fresh import must not create guessed/TODO Markdown or empty collection indexes');
    const second = framework.initProjectDirs('fresh-project', fresh);
    assert.deepStrictEqual(second.created, [], 'lazy directory declaration should be idempotent');
    assert.strictEqual(fs.existsSync(path.join(process.env.KB_DATA_DIR, '_ai', 'fresh-project')), false, 'unused AI workspace must not be created');

    const legacy = path.join(temp, 'knowledge', 'legacy');
    fs.mkdirSync(path.join(legacy, '_ai', 'runs'), { recursive: true });
    fs.mkdirSync(path.join(legacy, 'commits'), { recursive: true });
    fs.mkdirSync(path.join(legacy, 'features'), { recursive: true });
    fs.writeFileSync(path.join(legacy, 'README.md'), '# Legacy Project\n\nVerified legacy overview.\n', 'utf8');
    fs.writeFileSync(path.join(legacy, 'project-goal.md'), '# Legacy Goal\n\nA verified migrated goal.\n', 'utf8');
    fs.writeFileSync(path.join(legacy, 'project-analysis.md'), '# Legacy Analysis\n\nA verified architecture fact.\n', 'utf8');
    fs.writeFileSync(path.join(legacy, 'commits', 'old.md'), '# Old Commit\n\nVerified old change.\n', 'utf8');
    fs.writeFileSync(path.join(legacy, '_ai', 'runs', 'old.json'), '{"runId":"old"}\n', 'utf8');
    const migrated = framework.migrateToFramework({ slug: 'legacy-project', kbPath: legacy });
    assert.strictEqual(migrated.ok, true);
    assert(fs.existsSync(path.join(legacy, 'GOAL.md')));
    assert(fs.existsSync(path.join(legacy, 'ARCHITECTURE.md')));
    assert(fs.existsSync(path.join(legacy, 'changes', 'legacy-change-01.md')));
    assert(fs.existsSync(path.join(legacy, 'changes', '00-index.md')));
    assert(fs.existsSync(path.join(legacy, 'modules', '00-index.md')));
    assert.strictEqual(fs.existsSync(path.join(legacy, '_ai')), false, 'internal AI data must be removed from user knowledge root after migration');
    assert(fs.existsSync(path.join(process.env.KB_DATA_DIR, '_ai', 'legacy-project', 'runs', 'old.json')), 'legacy AI run should be preserved internally');
    const allMarkdown = [];
    const walk = current => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const target = path.join(current, entry.name);
        if (entry.isDirectory()) walk(target);
        else if (entry.name.endsWith('.md')) allMarkdown.push(fs.readFileSync(target, 'utf8'));
      }
    };
    walk(legacy);
    assert(!allMarkdown.some(text => /TODO: confirm|TODO: summarize/.test(text)), 'migration must not introduce TODO facts');
    console.log('kb-framework-test PASS');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
})();
