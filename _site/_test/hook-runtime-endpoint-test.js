// Run: node _site/_test/hook-runtime-endpoint-test.js

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { writeEndpoint } = require('../lib/runtime-endpoint');

const ROOT = path.resolve(__dirname, '..', '..');
const TRIGGER = path.join(ROOT, '_site', 'scripts', 'hook-trigger.js');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `kb-hook-runtime-${process.pid}-`));
const repo = fs.mkdtempSync(path.join(os.tmpdir(), `kb-hook-runtime-repo-${process.pid}-`));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function git(args) {
  return spawnSync('git', ['-C', repo, ...args], { encoding: 'utf-8', windowsHide: true });
}

(async () => {
  git(['init']);
  fs.writeFileSync(path.join(repo, 'README.md'), '# runtime endpoint\n', 'utf-8');
  git(['config', 'user.email', 'runtime@example.test']);
  git(['config', 'user.name', 'Runtime Test']);
  git(['add', 'README.md']);
  git(['commit', '-m', 'test']);

  let received = null;
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf-8');
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      received = { method: req.method, url: req.url, body: JSON.parse(body) };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  writeEndpoint(dataDir, { pid: process.pid, host: '127.0.0.1', port, mode: 'desktop' });

  const child = spawn(process.execPath, [
    TRIGGER,
    '--kb-root', ROOT,
    '--repo', repo,
    '--host', '127.0.0.1',
    '--port', '1',
  ], {
    cwd: ROOT,
    windowsHide: true,
    stdio: 'pipe',
    env: { ...process.env, KB_DATA_DIR: dataDir },
  });
  const exitCode = await new Promise(resolve => child.once('exit', resolve));
  assert(exitCode === 0, `hook trigger should exit 0, got ${exitCode}`);
  assert(received, 'hook trigger should use the live runtime endpoint instead of fallback port 1');
  assert(received.method === 'POST' && received.url === '/api/hooks/post-commit', 'unexpected hook request');
  assert(path.resolve(received.body.repoPath) === path.resolve(repo), 'hook request should contain repo path');

  await new Promise(resolve => server.close(resolve));
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
  console.log('hook-runtime-endpoint-test PASS');
})().catch(error => {
  console.error(error && error.stack || error);
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
  process.exit(1);
});
