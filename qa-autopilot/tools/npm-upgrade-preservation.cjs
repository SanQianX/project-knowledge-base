'use strict';
// Seed an owned install, then verify the same data after npm replaces its package.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const envLib = require('../../desktop/test/release-preflight-5025-env.cjs');
const freePort = require('../../_site/_test/helpers/free-port');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function snapshot(root) {
  const result = {};
  const walk = (dir, relative = '') => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name), key = relative + entry.name;
      if (entry.isSymbolicLink()) throw Error('No links allowed in preservation data');
      if (entry.isDirectory()) walk(file, key + '/');
      else result[key] = sha(fs.readFileSync(file));
    }
  };
  walk(root);
  return result;
}

async function main() {
  const [mode, prefixArg, stateArg, expectedVersion] = process.argv.slice(2);
  if (!['seed', 'verify'].includes(mode) || !path.isAbsolute(prefixArg || '') || !path.isAbsolute(stateArg || '')) throw Error('Usage: npm-upgrade-preservation.cjs seed|verify <owned-prefix> <owned-state> [expected-version]');
  const prefix = path.resolve(prefixArg), root = path.resolve(stateArg);
  const source = path.resolve(__dirname, '../..');
  for (const target of [prefix, root]) {
    if (target === source || target.startsWith(source + path.sep)) throw Error('Use isolated directories outside the source checkout');
    for (const protectedRoot of [process.env.USERPROFILE, process.env.APPDATA, process.env.LOCALAPPDATA, process.env.ProgramFiles, process.env.NPM_CONFIG_PREFIX].filter(Boolean)) {
      if (target.toLowerCase().startsWith(path.resolve(protectedRoot).toLowerCase() + path.sep)) throw Error('The live user and installation roots are protected');
    }
  }
  fs.mkdirSync(root, { recursive: true });
  const core = path.join(prefix, 'node_modules', '@sanqianx', 'project-knowledge');
  const pkg = JSON.parse(fs.readFileSync(path.join(core, 'package.json')));
  assert.equal(pkg.name, '@sanqianx/project-knowledge');
  if (mode === 'verify') assert.equal(pkg.version, expectedVersion, 'installed official version');
  const data = path.join(root, 'data'), knowledge = path.join(root, 'user-knowledge');
  const receiptFile = path.join(root, 'preservation-baseline.json');
  let baseline;
  if (mode === 'verify') {
    baseline = JSON.parse(fs.readFileSync(receiptFile));
    assert.deepEqual(snapshot(data), baseline.data, 'npm installation preserves every existing data file byte');
    assert.deepEqual(snapshot(knowledge), baseline.knowledge, 'npm installation preserves every knowledge file byte');
  } else if (fs.existsSync(receiptFile) || (fs.existsSync(data) && fs.readdirSync(data).length)) throw Error('Seed requires a fresh owned state directory');
  envLib.hardenProcessEnv(root, { gui: false });
  const port = await freePort();
  assert(![5757, 5760, 5790, 8787, 8790].includes(port));
  const env = { ...process.env, KB_DATA_DIR: data, KB_SITE_HOST: '127.0.0.1', KB_SITE_PORT: String(port), KB_MODULES_AUTOSTART: '0', KB_MODULES_REGISTER: '0', KB_TERMINAL_URL: 'http://127.0.0.1:9', KB_VECTORHUB_URL: 'http://127.0.0.1:9', KB_EVENTBRIDGE_URL: 'http://127.0.0.1:9', KB_KNOWLEDGE_ENGINE_URL: 'http://127.0.0.1:9' };
  const log = fs.openSync(path.join(root, mode + '-server.log'), 'w');
  const child = spawn(process.execPath, [path.join(core, '_site/server.js')], { cwd: core, env, windowsHide: true, stdio: ['ignore', log, log] });
  const closed = new Promise(resolve => child.once('close', resolve));
  const api = async (method, route, body) => {
    const response = await fetch('http://127.0.0.1:' + port + route, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
    const value = await response.json();
    assert(response.ok, route + ': HTTP ' + response.status + ' ' + JSON.stringify(value));
    return value;
  };
  let selected;
  try {
    const deadline = Date.now() + 30000;
    let ready = false;
    while (Date.now() < deadline) {
      try { await api('GET', '/api/health'); ready = true; break; } catch { await delay(200); }
    }
    assert(ready, 'isolated product starts');
    if (mode === 'seed') {
      fs.mkdirSync(knowledge, { recursive: true });
      await api('PATCH', '/api/settings', { knowledge: { rootPath: knowledge } });
      await api('PATCH', '/api/appearance', { preset: 'steel', overrides: { light: { accent: '#123456' }, dark: { accent: '#654321' } } });
      const repo = path.join(root, 'fixture-repo'), projectKnowledge = path.join(knowledge, 'existing-project');
      fs.mkdirSync(repo); fs.mkdirSync(projectKnowledge);
      const git = args => {
        const r = spawnSync('git', ['-c', 'core.hooksPath=' + path.join(root, 'empty-hooks'), ...args], { cwd: repo, env, windowsHide: true, encoding: 'utf8' });
        assert.equal(r.status, 0, r.stderr);
      };
      git(['init', '-q', '-b', 'main']);
      fs.writeFileSync(path.join(repo, 'README.md'), '# Preservation fixture\n');
      git(['add', '.']); git(['-c', 'user.name=Release fixture', '-c', 'user.email=fixture@local.invalid', 'commit', '-qm', 'baseline']);
      const imported = await api('POST', '/api/projects/import', { localPath: repo, knowledgePath: projectKnowledge, displayName: 'preservation-fixture' });
      fs.writeFileSync(path.join(projectKnowledge, 'README.md'), '# Existing knowledge\n\nPreserve this exact text across npm upgrade.\n');
      const settings = (await api('GET', '/api/settings')).settings;
      selected = { projectId: imported.projectId, rootPath: settings.knowledge.rootPath, appearance: settings.appearance };
      assert(selected.projectId, 'project registration retained even with offline modules');
      fs.mkdirSync(path.join(data, 'workbench'), { recursive: true });
      fs.writeFileSync(path.join(data, 'workbench', 'custom-config.fixture.json'), '{"fixture":"opaque-user-config-preserved"}\n');
    } else {
      const settings = (await api('GET', '/api/settings')).settings;
      assert.equal(settings.knowledge.rootPath, baseline.selected.rootPath);
      assert.deepEqual(settings.appearance, baseline.selected.appearance);
      const state = await api('GET', '/api/state');
      assert(state.projects.some(project => (project.projectId || project.id) === baseline.selected.projectId), 'existing project remains registered after upgrade');
      assert.deepEqual(snapshot(knowledge), baseline.knowledge, 'startup preserves knowledge');
    }
  } finally {
    if (child.exitCode === null) {
      spawnSync(process.execPath, [path.join(core, 'bin/project-knowledge.js'), 'stop', '--data', data], { cwd: core, env, windowsHide: true, encoding: 'utf8', timeout: 20000 });
      await Promise.race([closed, delay(10000)]);
      if (child.exitCode === null) { child.kill(); await closed; }
    }
    fs.closeSync(log);
  }
  if (mode === 'seed') {
    fs.writeFileSync(receiptFile, JSON.stringify({ version: pkg.version, selected, data: snapshot(data), knowledge: snapshot(knowledge) }, null, 2) + '\n');
  } else {
    for (const file of ['settings.json', 'projects.json', 'projects/' + baseline.selected.projectId + '/config.json', 'workbench/custom-config.fixture.json']) assert.equal(snapshot(data)[file], baseline.data[file], 'persistent config remains unchanged: ' + file);
    assert.deepEqual(snapshot(knowledge), baseline.knowledge);
    fs.writeFileSync(path.join(root, 'preservation-acceptance.json'), JSON.stringify({ status: 'PASS', from: baseline.version, to: pkg.version, allDataBytesPreservedDuringInstall: true, settingsPreserved: true, projectPreserved: true, knowledgePreserved: true }, null, 2) + '\n');
  }
  console.log(JSON.stringify({ status: 'PASS', mode, version: pkg.version, root }));
}
main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
