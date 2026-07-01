// _site/_test/data-dir-migration-test.js
//
// Unit tests for _site/lib/data-dir.js:
//   1. getDataDir honors KB_DATA_DIR (absolute or ".").
//   2. Default dataDir is <homedir>/.project-knowledge when KB_DATA_DIR unset.
//   3. getDataDir creates the dir if missing; idempotent if it already exists.
//   4. hasMigrated is true iff <dataDir>/projects.json exists.
//   5. migrateFromLegacy copies projects.json / ai-profiles.json / knowledge-store.json /
//      logging.json / .jobs-log.json / claude-prompts.json / .hook-trigger-errors.log
//      from the legacy package root into <dataDir>.
//   6. migrateFromLegacy copies the projects/, logs/ dirs (recursively).
//   7. migrateFromLegacy copies the legacy <pkg>/_site/_ai/ dir to <dataDir>/_ai.
//   8. Migration is a no-op when <dataDir>/projects.json already exists.
//   9. Migration is a no-op when legacyRoot doesn't exist.
//  10. Migration is a no-op when legacyRoot == dataDir (safety check).
//  11. Migration does NOT overwrite existing destination files.
//  12. Migration is silent (no console output required) but accepts a logger.
//  13. _resetCache lets a test switch KB_DATA_DIR mid-process.

const fs = require('fs');
const os = require('os');
const path = require('path');
const dataDir = require('../lib/data-dir');

function assert(cond, msg) { if (!cond) throw new Error('ASSERT: ' + msg); }

function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} }

function freshSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `kb-data-dir-test-${process.pid}-${Date.now()}-`));
  return dir;
}

function writeLegacy(sandbox) {
  // Top-level files
  fs.writeFileSync(path.join(sandbox, 'projects.json'), '{"projA":{}}\n', 'utf-8');
  fs.writeFileSync(path.join(sandbox, 'ai-profiles.json'), '{"profiles":[]}\n', 'utf-8');
  fs.writeFileSync(path.join(sandbox, 'knowledge-store.json'), '{"rootPath":"/x"}\n', 'utf-8');
  fs.writeFileSync(path.join(sandbox, 'logging.json'), '{"retentionDays":7}\n', 'utf-8');
  fs.writeFileSync(path.join(sandbox, '.jobs-log.json'), '[]\n', 'utf-8');
  fs.writeFileSync(path.join(sandbox, 'claude-prompts.json'), '{}\n', 'utf-8');
  fs.writeFileSync(path.join(sandbox, '.hook-trigger-errors.log'), 'old line\n', 'utf-8');
  // projects/ dir with one KB
  fs.mkdirSync(path.join(sandbox, 'projects', 'kb-postcheck-agent', 'modules'), { recursive: true });
  fs.writeFileSync(path.join(sandbox, 'projects', 'kb-postcheck-agent', 'GOAL.md'), '# goal\n', 'utf-8');
  fs.writeFileSync(path.join(sandbox, 'projects', 'kb-postcheck-agent', 'modules', '00-index.md'), '# m\n', 'utf-8');
  // logs/ dir
  fs.mkdirSync(path.join(sandbox, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(sandbox, 'logs', '2026-06-21.log'), 'info hello\n', 'utf-8');
  // _site/_ai/ legacy location
  fs.mkdirSync(path.join(sandbox, '_site', '_ai', 'projA', 'runs'), { recursive: true });
  fs.writeFileSync(path.join(sandbox, '_site', '_ai', 'projA', 'runs', 'r1.json'), '{"id":"r1"}\n', 'utf-8');
}

(() => {
  // 1. KB_DATA_DIR (absolute) overrides default
  {
    const custom = freshSandbox();
    const saved = process.env.KB_DATA_DIR;
    process.env.KB_DATA_DIR = custom;
    dataDir._resetCache();
    try {
      const got = dataDir.getDataDir();
      assert(got === path.resolve(custom), `expected ${path.resolve(custom)}, got ${got}`);
      assert(fs.existsSync(got), 'getDataDir should create the dir if missing');
    } finally {
      process.env.KB_DATA_DIR = saved;
      dataDir._resetCache();
      rmrf(custom);
    }
  }

  // 2. KB_DATA_DIR="." (CWD-relative)
  {
    const cwd = freshSandbox();
    const saved = process.env.KB_DATA_DIR;
    process.env.KB_DATA_DIR = '.';
    dataDir._resetCache();
    const savedCwd = process.cwd();
    process.chdir(cwd);
    try {
      const got = dataDir.getDataDir();
      assert(got === path.resolve(cwd), `expected cwd ${path.resolve(cwd)}, got ${got}`);
    } finally {
      process.chdir(savedCwd);
      process.env.KB_DATA_DIR = saved;
      dataDir._resetCache();
      rmrf(cwd);
    }
  }

  // 3. Default dataDir is ~/.project-knowledge when env unset.
  {
    const saved = process.env.KB_DATA_DIR;
    delete process.env.KB_DATA_DIR;
    dataDir._resetCache();
    try {
      const got = dataDir.getDataDir();
      assert(got === path.join(os.homedir(), '.project-knowledge'),
        `default should be ~/.project-knowledge, got ${got}`);
    } finally {
      process.env.KB_DATA_DIR = saved;
      dataDir._resetCache();
    }
  }

  // 4. hasMigrated is true iff projects.json exists
  {
    const sandbox = freshSandbox();
    const saved = process.env.KB_DATA_DIR;
    process.env.KB_DATA_DIR = sandbox;
    dataDir._resetCache();
    try {
      assert(!dataDir.hasMigrated(), 'hasMigrated should be false when projects.json absent');
      fs.writeFileSync(path.join(sandbox, 'projects.json'), '{}', 'utf-8');
      assert(dataDir.hasMigrated(), 'hasMigrated should be true after projects.json is created');
    } finally {
      process.env.KB_DATA_DIR = saved;
      dataDir._resetCache();
      rmrf(sandbox);
    }
  }

  // 5-7. Migration copies files + dirs from legacyRoot.
  {
    const legacy = freshSandbox();
    const target = freshSandbox();
    writeLegacy(legacy);
    const saved = process.env.KB_DATA_DIR;
    process.env.KB_DATA_DIR = target;
    dataDir._resetCache();
    let loggedMsg = null;
    try {
      const result = dataDir.migrateFromLegacy({
        legacyRoot: legacy,
        logger: (m) => { loggedMsg = m; },
      });
      assert(result.ok, 'migrate should succeed: ' + JSON.stringify(result));
      assert(result.migrated, 'migrate should report migrated=true: ' + JSON.stringify(result));
      assert(result.files >= 7, `migrate should copy >=7 files, got ${result.files}`);
      assert(result.dirs >= 3, `migrate should copy >=3 dirs (projects, logs, _ai), got ${result.dirs}`);

      // Verify each expected file landed
      for (const f of dataDir.LEGACY_FILE_PATHS) {
        const to = path.join(target, f);
        assert(fs.existsSync(to), `expected ${f} in target after migration`);
      }
      // Verify each expected dir landed
      assert(fs.existsSync(path.join(target, 'projects', 'kb-postcheck-agent', 'GOAL.md')),
        'projects/<slug>/GOAL.md should be migrated');
      assert(fs.existsSync(path.join(target, 'logs', '2026-06-21.log')),
        'logs/2026-06-21.log should be migrated');
      // _site/_ai/ → _ai/
      assert(fs.existsSync(path.join(target, '_ai', 'projA', 'runs', 'r1.json')),
        '_site/_ai/projA/runs/r1.json should be migrated to _ai/projA/runs/r1.json');
      assert(loggedMsg, 'logger should be called when migration happens');
      assert(loggedMsg.includes(target), 'logger message should mention target dir');
    } finally {
      process.env.KB_DATA_DIR = saved;
      dataDir._resetCache();
      rmrf(legacy);
      rmrf(target);
    }
  }

  // 8. No-op when <dataDir>/projects.json already exists.
  {
    const legacy = freshSandbox();
    const target = freshSandbox();
    fs.writeFileSync(path.join(target, 'projects.json'), '{"already":true}\n', 'utf-8');
    fs.writeFileSync(path.join(legacy, 'projects.json'), '{"legacy":true}\n', 'utf-8');
    const saved = process.env.KB_DATA_DIR;
    process.env.KB_DATA_DIR = target;
    dataDir._resetCache();
    try {
      const result = dataDir.migrateFromLegacy({ legacyRoot: legacy });
      assert(!result.migrated, 'should NOT migrate when dataDir/projects.json exists');
      assert(result.reason === 'already migrated', `reason=${result.reason}`);
      // Make sure legacy projects.json wasn't copied.
      const destText = fs.readFileSync(path.join(target, 'projects.json'), 'utf-8');
      assert(destText.includes('already'), 'existing target file must not be overwritten');
    } finally {
      process.env.KB_DATA_DIR = saved;
      dataDir._resetCache();
      rmrf(legacy);
      rmrf(target);
    }
  }

  // 9. No-op when legacyRoot doesn't exist.
  {
    const target = freshSandbox();
    const fakeLegacy = path.join(target, 'no-such-dir');
    const saved = process.env.KB_DATA_DIR;
    process.env.KB_DATA_DIR = target;
    dataDir._resetCache();
    try {
      const result = dataDir.migrateFromLegacy({ legacyRoot: fakeLegacy });
      assert(result.ok, 'migrate should report ok');
      assert(!result.migrated, 'migrate should not report migrated when legacy missing');
      assert(result.reason === 'legacy root does not exist', `reason=${result.reason}`);
    } finally {
      process.env.KB_DATA_DIR = saved;
      dataDir._resetCache();
      rmrf(target);
    }
  }

  // 10. No-op when legacyRoot === dataDir (safety check).
  {
    const same = freshSandbox();
    fs.writeFileSync(path.join(same, 'projects.json'), '{"x":1}\n', 'utf-8');
    const saved = process.env.KB_DATA_DIR;
    process.env.KB_DATA_DIR = same;
    dataDir._resetCache();
    try {
      const result = dataDir.migrateFromLegacy({ legacyRoot: same });
      assert(!result.migrated, 'should not migrate when legacy equals dataDir');
      assert(result.reason === 'legacy root equals data dir', `reason=${result.reason}`);
    } finally {
      process.env.KB_DATA_DIR = saved;
      dataDir._resetCache();
      rmrf(same);
    }
  }

  // 11. Migration does NOT overwrite destination files (only copies if dest absent).
  {
    const legacy = freshSandbox();
    const target = freshSandbox();
    fs.writeFileSync(path.join(legacy, 'projects.json'), '{"fromLegacy":true}\n', 'utf-8');
    fs.writeFileSync(path.join(target, 'projects.json'), '{"fromTarget":true}\n', 'utf-8');
    const saved = process.env.KB_DATA_DIR;
    process.env.KB_DATA_DIR = target;
    dataDir._resetCache();
    try {
      // Even though projects.json exists in target (so hasMigrated returns true),
      // we explicitly verify: existing dest files are never clobbered.
      const result = dataDir.migrateFromLegacy({ legacyRoot: legacy });
      assert(!result.migrated, 'should report not migrated when target already has projects.json');
      const destText = fs.readFileSync(path.join(target, 'projects.json'), 'utf-8');
      assert(destText.includes('fromTarget'), 'target file must remain intact');
      assert(!destText.includes('fromLegacy'), 'legacy file must NOT have replaced target');
    } finally {
      process.env.KB_DATA_DIR = saved;
      dataDir._resetCache();
      rmrf(legacy);
      rmrf(target);
    }
  }

  // 12. Migration works without a logger (silent).
  {
    const legacy = freshSandbox();
    const target = freshSandbox();
    fs.writeFileSync(path.join(legacy, 'projects.json'), '{}', 'utf-8');
    fs.writeFileSync(path.join(legacy, 'ai-profiles.json'), '{}', 'utf-8');
    const saved = process.env.KB_DATA_DIR;
    process.env.KB_DATA_DIR = target;
    dataDir._resetCache();
    try {
      const result = dataDir.migrateFromLegacy({ legacyRoot: legacy });
      assert(result.ok && result.migrated, 'should migrate even without logger');
      assert(fs.existsSync(path.join(target, 'ai-profiles.json')), 'ai-profiles should be migrated');
    } finally {
      process.env.KB_DATA_DIR = saved;
      dataDir._resetCache();
      rmrf(legacy);
      rmrf(target);
    }
  }

  // 13. _resetCache makes a new KB_DATA_DIR take effect.
  {
    const a = freshSandbox();
    const b = freshSandbox();
    const saved = process.env.KB_DATA_DIR;
    process.env.KB_DATA_DIR = a;
    dataDir._resetCache();
    const first = dataDir.getDataDir();
    process.env.KB_DATA_DIR = b;
    // Without _resetCache, getDataDir still returns a (cached).
    const cached = dataDir.getDataDir();
    assert(cached === first, 'without reset, cached dir should win');
    dataDir._resetCache();
    const refreshed = dataDir.getDataDir();
    assert(refreshed === path.resolve(b), `after reset, should be ${b}, got ${refreshed}`);
    process.env.KB_DATA_DIR = saved;
    dataDir._resetCache();
    rmrf(a);
    rmrf(b);
  }

  // 14. KB_SKIP_MIGRATION=1 short-circuits even when legacy has data.
  {
    const legacy = freshSandbox();
    const target = freshSandbox();
    writeLegacy(legacy);
    const saved = process.env.KB_DATA_DIR;
    const savedSkip = process.env.KB_SKIP_MIGRATION;
    process.env.KB_DATA_DIR = target;
    process.env.KB_SKIP_MIGRATION = '1';
    dataDir._resetCache();
    try {
      const result = dataDir.migrateFromLegacy({ legacyRoot: legacy });
      assert(result.ok, 'skip should still report ok');
      assert(!result.migrated, 'skip should report not migrated');
      assert(result.reason === 'skipped via KB_SKIP_MIGRATION=1', `reason=${result.reason}`);
      assert(!fs.existsSync(path.join(target, 'projects.json')),
        'skip should leave target empty even though legacy had data');
    } finally {
      process.env.KB_DATA_DIR = saved;
      process.env.KB_SKIP_MIGRATION = savedSkip;
      dataDir._resetCache();
      rmrf(legacy);
      rmrf(target);
    }
  }

  console.log('data-dir-migration-test PASS');
})();
