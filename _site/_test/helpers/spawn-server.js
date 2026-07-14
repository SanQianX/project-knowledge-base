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
  // Pre-create projects.json so hasMigrated() returns true on server startup.
  // Without this, server.js would migrate the user's REAL projects.json from
  // <pkg>/projects.json into the temp data dir, polluting the test with
  // fixtures from the host environment. Tests that need an empty registry
  // get one; tests that need a populated one can overwrite the file. Only
  // create it if the caller hasn't already populated the file.
  try {
    if (!fs.existsSync(path.join(dir, 'projects.json'))) {
      fs.writeFileSync(path.join(dir, 'projects.json'), '{}\n', 'utf-8');
    }
  } catch {}
  const child = spawn(process.execPath, [path.join(root, '_site', 'server.js')], {
    cwd: cwd || root,
    env: {
      ...process.env,
      KB_SITE_PORT: String(port),
      KB_SITE_HOST: host,
      KB_DATA_DIR: dir,
      KB_CLAUDE_RULES_DIR: dir,
      ...extraEnv,
    },
    stdio,
    windowsHide: true,
  });
  return {
    child,
    dataDir: dir,
    cleanup: () => {
      try { child.kill(); } catch {}
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    },
  };
}

module.exports = { spawnServer, defaultDataDir };
