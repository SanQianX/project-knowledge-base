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
const runtimeControl = require('../../lib/runtime-control');
const runtimeEndpoint = require('../../lib/runtime-endpoint');

function defaultDataDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `kb-data-${tag || 'test'}-${process.pid}-`));
}

function spawnServer({ root, port, host = '127.0.0.1', dataDir, extraEnv = {}, tag, analysisOwner = 'legacy', stdio = ['ignore', 'pipe', 'pipe'], cwd }) {
  const dir = dataDir || defaultDataDir(tag);
  // Isolate the Bridge journal home too: the runtime registers a
  // 'project-knowledge' consumer at startup, and without this the test
  // server would write into the developer's real ~/.ai-coding-event-bridge.
  const bridgeHome = fs.mkdtempSync(path.join(os.tmpdir(), `kb-bridge-${tag || 'test'}-${process.pid}-`));
  // Legacy behavior tests characterize the retired writer in isolation. The
  // production entry point still defaults to engine ownership; product tests
  // explicitly request it and run the real module services.
  const entry = path.join(root, '_site', 'lib', 'server-app.js');
  const bootstrap = `const {startServer,installProcessHandlers}=require(${JSON.stringify(entry)});const instance=startServer({analysisOwner:${JSON.stringify(analysisOwner)}});installProcessHandlers(instance);instance.then(s=>process.stdout.write('Project Knowledge listening on http://'+s.host+':'+s.port+'\\n')).catch(()=>{process.exitCode=1});`;
  const child = spawn(process.execPath, ['-e', bootstrap], {
    cwd: cwd || root,
    env: {
      ...process.env,
      KB_SITE_PORT: String(port),
      KB_SITE_HOST: host,
      KB_DATA_DIR: dir,
      KB_CLAUDE_RULES_DIR: dir,
      KB_SKIP_MIGRATION: '1',
      // 测试隔离：禁止测试服务器向真实模块（terminal/vector-hub）登记项目
      KB_MODULES_REGISTER: '0',
      KB_MODULES_AUTOSTART: '0',
      AI_CODING_EVENT_BRIDGE_HOME: bridgeHome,
      ...extraEnv,
    },
    stdio,
    windowsHide: true,
  });
  return {
    child,
    dataDir: dir,
    bridgeHome,
    cleanup: async () => {
      // On Windows SIGTERM is a force kill. Drain owned background work via
      // the verified control channel first, so Git/Agent children release cwd.
      const live = runtimeEndpoint.readEndpoint(dir);
      if (live?.pid === child.pid && child.exitCode === null) {
        try { await runtimeControl.request(dir, { action: 'stop', pid: live.pid, port: live.port, startedAt: live.startedAt }, 10000); } catch {}
        await new Promise(resolve => {
          const timer = setTimeout(resolve, 1500);
          child.once('close', () => { clearTimeout(timer); resolve(); });
          if (child.exitCode !== null) { clearTimeout(timer); resolve(); }
        });
      }
      if (child.exitCode === null) try { child.kill(); } catch {}
      await new Promise(resolve => {
        const timer = setTimeout(resolve, 5000);
        child.once('close', () => { clearTimeout(timer); resolve(); });
        if (child.exitCode !== null) { clearTimeout(timer); resolve(); }
      });
      await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      await fs.promises.rm(bridgeHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

module.exports = { spawnServer, defaultDataDir };
