// _site/_test/helpers/spawn-server.js
//
// Test helper: spawn _site/server.js with an isolated KB_DATA_DIR so each
// regression test runs against a fresh, empty user-data location. Without
// this, server.js would default to ~/.project-knowledge/ and tests would
// pollute (or read from) the real user data.
//
// Usage:
//   const { server, dataDir, cleanup } = require('./helpers/spawn-server');
//   const { server, dataDir, cleanup } = spawnServer({
//     root: ROOT,
//     port: 7891,
//     extraEnv: { KB_AUTOMATION_FAKE_CLAUDE: '1' },
//     tag: 'hook-trigger',
//   });
//   ...
//   cleanup();   // kills server + removes temp dataDir

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

function defaultDataDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `kb-data-${tag || 'test'}-${process.pid}-`));
}

function spawnServer({ root, port, host = '127.0.0.1', dataDir, extraEnv = {}, tag, stdio = ['ignore', 'pipe', 'pipe'], cwd }) {
  const dir = dataDir || defaultDataDir(tag);
  const child = spawn(process.execPath, [path.join(root, '_site', 'server.js')], {
    cwd: cwd || root,
    env: {
      ...process.env,
      KB_SITE_PORT: String(port),
      KB_SITE_HOST: host,
      KB_DATA_DIR: dir,
      KB_CLAUDE_RULES_DIR: dir,
      KB_SKIP_MIGRATION: '1',
      ...extraEnv,
    },
    stdio,
    windowsHide: true,
  });
  return {
    child,
    dataDir: dir,
    cleanup: async () => {
      try { child.kill(); } catch {}
      // Windows keeps data-dir handles alive until the child fully exits;
      // removing the directory before that races with EPERM.
      await new Promise(resolve => {
        const timer = setTimeout(resolve, 5000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
        if (child.exitCode !== null) { clearTimeout(timer); resolve(); }
      });
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    },
  };
}

module.exports = { spawnServer, defaultDataDir };
