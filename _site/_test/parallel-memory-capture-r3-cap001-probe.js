'use strict';
// _site/_test/parallel-memory-capture-r3-cap001-probe.js
//
// CAP-001 三能力独立 — the external-Agent integration case of
// qa-autopilot/config/test-cases.json.
//
//   steps:    检查 Knowledge Integration、Automatic Context、Development Capture。
//   expected: 检测到命令不等于已安装。/ 三能力分别真实验证。
//   evidence: 实际命令与退出码 / UI、接口、磁盘对应证据 / 源HEAD、文件哈希、测试夹具ID
//
// WHAT IS REAL HERE
//
//   * the product server is the real one, on its own port, with its own data
//     dir, its own knowledge dir and its own Bridge journal home;
//   * the browser is a real Chrome (CDP) with its own profile;
//   * the "接入" action is a real click on the real UI control, and the
//     product really runs the real native client CLI (`claude plugin
//     marketplace add` + `claude plugin install`) against an ISOLATED home
//     directory — not a stub, not a dry run;
//   * the three capabilities are then verified INDEPENDENTLY, each against
//     its own artefact on disk: the installed plugin (Knowledge
//     Integration), the plugin's own pre-read files (Automatic Context) and
//     the Bridge hook entries (Development Capture).
//
//   The developer's real HOME is digested before and after the run and the
//   comparison is part of the evidence: nothing may leak out of the isolated
//   home.
//
// WHY THIS FILE IS NOT NAMED *-test.js
//
//   The case needs the native Claude Code CLI to exist on the machine. The
//   offline CI suite collects every *_test.js and would report a false
//   failure on a runner without that CLI, so the case runs through the
//   product probe entry point (qa-autopilot/tools/product-probes/) instead.

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

const { startCapHarness, ROOT } = require('./helpers/parallel-memory-capture-r3-cap-shell');

const EVIDENCE = process.env.PK_TEST_EVIDENCE_DIR ? path.resolve(process.env.PK_TEST_EVIDENCE_DIR) : null;
const CLIENT = 'claude';

function gitHead() {
  try {
    return execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim();
  } catch { return null; }
}

function repoFileHashes(files) {
  return files.map(file => {
    const full = path.join(ROOT, file);
    let sha256 = null;
    try {
      sha256 = require('node:crypto').createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    } catch { sha256 = null; }
    return { file, exists: fs.existsSync(full), sha256 };
  });
}

async function main() {
  const harness = await startCapHarness({ tag: 'cap001', evidenceDir: EVIDENCE || undefined });
  const evidence = [];
  try {
    // ------------------------------------------------------------------
    // 1. The real UI, before anything is installed.
    // ------------------------------------------------------------------
    await harness.openSystemDrawer();
    const rowBefore = await harness.agentRow(CLIENT);
    assert.ok(rowBefore, `the ${CLIENT} row must be rendered: ${JSON.stringify(await harness.agentRows())}`);
    const statusBefore = await harness.settledStatus();
    const clientBefore = harness.statusClient(statusBefore, CLIENT);
    assert.ok(clientBefore, `the ${CLIENT} status must be reported: ${JSON.stringify(statusBefore)}`);

    // "检测到命令" is the product's own wording for "the CLI is on PATH".
    // It is exactly what must NOT be mistaken for "the client is connected".
    assert.equal(clientBefore.available, true, 'the native CLI really is detected');
    assert.equal(rowBefore.details.join(' ').includes('检测到命令'), true, `the row must show the detected command: ${JSON.stringify(rowBefore)}`);
    assert.notEqual(rowBefore.badge, '已接入', 'a detected command must not read as an installed client');
    assert.equal(rowBefore.badge, '未接入', `the row must read as not connected: ${JSON.stringify(rowBefore)}`);
    assert.notEqual(clientBefore.knowledgeIntegration.state, 'installed', 'Knowledge Integration is not installed yet');
    assert.notEqual(clientBefore.automaticContext.configured, true, 'Automatic Context is not configured yet');
    assert.notEqual(clientBefore.developmentCapture.installed, true, 'Development Capture is not installed yet');
    assert.equal(clientBefore.summary, 'disconnected', 'the product must not report the client as connected');
    if (harness.evidence) await harness.browser.screenshot(path.join(harness.evidence, 'cap001-before.png'));

    // ------------------------------------------------------------------
    // 2. The real 接入 click on the real UI.
    // ------------------------------------------------------------------
    await harness.nativeClick(`[data-agent-switch="install"][data-agent-client="${CLIENT}"]`);
    await harness.waitFor(
      () => harness.run("document.getElementById('agentCaptureFeedback').textContent.trim().length > 0 && !document.getElementById('agentCaptureFeedback').textContent.includes('正在接入')"),
      'the 接入 action answers in the UI',
      180000,
    );
    const feedback = await harness.feedback();
    const installCall = await harness.lastInstallCall();
    assert.ok(installCall, 'the UI really sent an install request');
    assert.equal(installCall.status, 200, `the install request answers 200: ${JSON.stringify(installCall)}`);
    assert.equal(installCall.response.complete, true, `the install must complete: ${JSON.stringify(installCall.response)}`);
    const operationId = installCall.response.operationId;
    assert.ok(operationId, 'the install must report an operation id');

    // ------------------------------------------------------------------
    // 3. The three capabilities, each verified on its own artefact.
    // ------------------------------------------------------------------
    const statusAfter = await harness.settledStatus();
    const clientAfter = harness.statusClient(statusAfter, CLIENT);
    assert.ok(clientAfter, `the ${CLIENT} status must be reported after the install`);
    await harness.waitFor(
      () => harness.run(`(() => { const row = [...document.querySelectorAll('#agentCaptureList .agent-capture-row')].find(item => item.querySelector('[data-agent-switch]') && item.querySelector('[data-agent-switch]').dataset.agentClient === ${JSON.stringify(CLIENT)}); return Boolean(row) && row.querySelector('.status').textContent === '已接入'; })()`),
      'the row shows the client as connected',
      90000,
    );
    const rowAfter = await harness.agentRow(CLIENT);
    assert.equal(rowAfter.badge, '已接入', `the row must read as connected: ${JSON.stringify(rowAfter)}`);
    assert.equal(rowAfter.switch.action, 'uninstall', 'the switch must offer the removal now');

    // (a) Knowledge Integration — the real plugin really is installed.
    const plugin = harness.pluginEvidence();
    assert.equal(plugin.installedVersion, '5.0.24', `the plugin version must be the shipped one: ${JSON.stringify(plugin.installedPlugins)}`);
    assert.equal(plugin.installPathExists, true, 'the installed plugin directory really exists');
    assert.equal(clientAfter.knowledgeIntegration.state, 'installed', 'the product reports Knowledge Integration as installed');

    // (b) Automatic Context — the plugin's own pre-read files are really
    //     the product's files, byte for byte.
    assert.equal(plugin.allFilesIdentical, true, `the pre-read files must be identical: ${JSON.stringify(plugin.files)}`);
    assert.equal(clientAfter.automaticContext.configured, true, 'the product reports Automatic Context as configured');
    assert.equal(clientAfter.automaticContext.state, 'configured', `the product reports the Automatic Context state: ${JSON.stringify(clientAfter.automaticContext)}`);

    // (c) Development Capture — the real Bridge hook entries really point at
    //     a Bridge entry that exists on disk.
    const hooks = harness.ownedHookEntries();
    const events = [...new Set(hooks.map(entry => entry.event))].sort();
    assert.deepEqual(events, ['Stop', 'UserPromptSubmit'], `both capture events must be wired: ${JSON.stringify(hooks)}`);
    for (const event of events) {
      const owned = hooks.filter(entry => entry.event === event);
      assert.equal(owned.length, 1, `the ${event} hook must exist exactly once: ${JSON.stringify(owned)}`);
      assert.equal(owned[0].shimExists, true, `the ${event} hook must point at a real Bridge entry: ${JSON.stringify(owned[0])}`);
    }
    assert.equal(clientAfter.developmentCapture.installed, true, 'the product reports Development Capture as installed');
    assert.equal(clientAfter.summary, 'connected', 'the product reports the client as connected');

    // The real commands the product ran, with their real exit codes, read
    // from the product's own diagnostics log.
    const commandLog = await harness.productApi('GET', '/api/logs?q=integration.command_completed&pageSize=50');
    assert.equal(commandLog.status, 200, `the diagnostics log must be readable: ${JSON.stringify(commandLog.body)}`);
    const commands = (commandLog.body.entries || [])
      .filter(entry => String(entry.event || '').includes('integration.command'))
      .map(entry => ({
        event: entry.event,
        level: entry.level,
        client: entry.context && entry.context.client ? entry.context.client : null,
        status: entry.context && entry.context.status !== undefined ? entry.context.status : null,
        argumentCount: entry.context && entry.context.argumentCount !== undefined ? entry.context.argumentCount : null,
        argsHash: entry.context && entry.context.argsHash ? entry.context.argsHash : null,
      }));
    assert.ok(commands.length > 0, 'the product must record the native commands it really ran');
    assert.equal(commands.every(entry => entry.status === 0), true, `every native command must have exited 0: ${JSON.stringify(commands)}`);

    // ------------------------------------------------------------------
    // 4. Nothing leaked into the developer's real home.
    //
    // The developer's own Claude Code and Codex sessions run while the case
    // runs, so transcripts, logs and caches change on their own. The claim
    // that matters is therefore about the client's CONFIGURATION surface —
    // the files an integration writes into — and about every changed file
    // outside the known runtime set, which must be empty.
    // ------------------------------------------------------------------
    const configAfter = harness.digestRealClientConfigs();
    const configComparison = harness.compareConfigSurface(harness.realHomeBefore, configAfter);
    assert.equal(configComparison.byteIdentical, true, `the real client configuration must be untouched: ${JSON.stringify({ changedFiles: configComparison.changedFiles, changedDirs: configComparison.changedDirs })}`);

    const treeComparison = harness.compareRealTrees(harness.realTreesBefore, harness.digestRealClientTrees());
    assert.deepEqual(treeComparison.leaks, [], `nothing outside the runtime set may change in the real home: ${JSON.stringify(treeComparison.leaks)}`);
    assert.deepEqual(treeComparison.configChanges, [], `no configuration file may change in the real home: ${JSON.stringify(treeComparison.configChanges)}`);

    if (harness.evidence) await harness.browser.screenshot(path.join(harness.evidence, 'cap001-after.png'));

    evidence.push({
      case: 'CAP-001',
      fixture: { tag: 'cap001', fixtureDir: harness.fixture, isolatedHome: harness.homeDir, port: Number(harness.base.split(':').pop()) },
      source: { repoRoot: ROOT, gitHead: gitHead(), pluginFiles: repoFileHashes(['plugins/project-knowledge/hooks/claude.json', 'plugins/project-knowledge/scripts/context-hook.cjs', 'plugins/project-knowledge/.mcp.json', 'plugins/project-knowledge/.claude-plugin/plugin.json']) },
      before: {
        ui: { badge: rowBefore.badge, details: rowBefore.details, switch: rowBefore.switch },
        api: { available: clientBefore.available, configFound: clientBefore.configFound, summary: clientBefore.summary, knowledgeIntegration: clientBefore.knowledgeIntegration, automaticContext: clientBefore.automaticContext, developmentCapture: clientBefore.developmentCapture },
        claim: 'the command is detected, nothing is installed',
      },
      action: {
        control: `[data-agent-switch="install"][data-agent-client="${CLIENT}"]`,
        realClick: true,
        feedback,
        request: installCall.request,
        httpStatus: installCall.status,
        operationId,
        complete: installCall.response.complete,
      },
      after: {
        ui: { badge: rowAfter.badge, details: rowAfter.details, switch: rowAfter.switch },
        api: { summary: clientAfter.summary, knowledgeIntegration: clientAfter.knowledgeIntegration, automaticContext: clientAfter.automaticContext, developmentCapture: clientAfter.developmentCapture },
      },
      capabilities: {
        knowledgeIntegration: { state: clientAfter.knowledgeIntegration.state, installedVersion: plugin.installedVersion, installPath: plugin.installPath, installPathExists: plugin.installPathExists, marketplaceSource: plugin.marketplaceSource, installedPluginsFile: plugin.indexFile },
        automaticContext: { state: clientAfter.automaticContext.state, configured: clientAfter.automaticContext.configured, files: plugin.files, allFilesIdentical: plugin.allFilesIdentical },
        developmentCapture: { state: clientAfter.developmentCapture.state, installed: clientAfter.developmentCapture.installed, ownedHookEntries: hooks, events },
      },
      nativeCommands: commands,
      realHomeIsolation: {
        configuration: {
          byteIdentical: configComparison.byteIdentical,
          changedFiles: configComparison.changedFiles,
          changedDirs: configComparison.changedDirs,
        },
        tree: {
          leaks: treeComparison.leaks,
          configChanges: treeComparison.configChanges,
          runtimeChangeCount: treeComparison.runtimeChanges,
          changed: treeComparison.changed,
        },
        scopeLabel: 'honest: the developer\'s own live client sessions keep writing transcripts and caches in the real home while the case runs; the isolation claim is about the client configuration surface and about every changed file outside the known runtime set',
      },
      scopeLabel: 'honest: the native client CLI really ran against an isolated home; no model turn was performed',
    });

    if (harness.evidence) {
      fs.mkdirSync(harness.evidence, { recursive: true });
      fs.writeFileSync(path.join(harness.evidence, 'cap001-three-capabilities.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    }

    console.log('parallel-memory-capture-r3-cap001-probe PASS (the detected command was not an installed client; after the real 接入 click the three capabilities are verified independently on disk)');
  } finally {
    await harness.cleanup();
  }
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
