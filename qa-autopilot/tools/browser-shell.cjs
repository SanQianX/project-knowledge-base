'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { must, readJSON, atomicJSON, ownedRun, setRunStatus, isolatedEnv, runLogged, commandSync } = require('../lib/safety.cjs');
const { snapshot, assertRepo } = require('../lib/git.cjs');
async function child(cfg, run, evidence) {
    const assert = require('node:assert/strict');
    const { spawnServer } = require(path.join(cfg.repoRoot, '_site/_test/helpers/spawn-server.js'));
    const { findChrome } = require(path.join(cfg.repoRoot, '_site/_test/helpers/find-chrome.js'));
    const { launchCdpBrowser, waitFor } = require(path.join(cfg.repoRoot, '_site/_test/helpers/cdp-browser.js'));
    const offline = http.createServer((req, res) => { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: { code: 'QA_OFFLINE', message: 'Intentional isolated module fixture' } })); });
    await new Promise(resolve => offline.listen(0, '127.0.0.1', resolve));
    const offlineUrl = 'http://127.0.0.1:' + offline.address().port;
    const reserve = http.createServer();
    await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
    const port = reserve.address().port;
    await new Promise(resolve => reserve.close(resolve));
    const server = spawnServer({ root: cfg.repoRoot, port, dataDir: path.join(run, 'data'), analysisOwner: 'engine', tag: 'qa-native-pointer', extraEnv: { KB_MODULES_REGISTER: '1', KB_TERMINAL_URL: offlineUrl, KB_VECTORHUB_URL: offlineUrl, KB_EVENTBRIDGE_URL: offlineUrl, KB_KNOWLEDGE_ENGINE_URL: offlineUrl } });
    let browser, stdout = '', stderr = '';
    server.child.stdout.on('data', b => { stdout += b; });
    server.child.stderr.on('data', b => { stderr += b; });
    const api = async (url) => { const r = await fetch('http://127.0.0.1:' + port + url, { signal: AbortSignal.timeout(5000) }); assert.ok(r.ok); return r.json(); };
    const results = [];
    try {
        await waitFor(async () => { try {
            return (await api('/api/health')).ok;
        }
        catch {
            return false;
        } }, 'isolated server', 20000);
        browser = await launchCdpBrowser({ chrome: findChrome(), profileDir: path.join(run, 'browser'), url: 'http://127.0.0.1:' + port, width: 1920, height: 1080 });
        async function click(selector) {
            await waitFor(() => browser.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});return !!e&&!e.disabled&&e.getBoundingClientRect().width>0;})()`), 'clickable ' + selector);
            const p = await browser.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();const x=r.left+r.width/2,y=r.top+r.height/2;const t=document.elementFromPoint(x,y);if(!t||!(t===e||e.contains(t)))throw Error('Occluded control');return {x,y};})()`);
            await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p });
            await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...p, button: 'left', clickCount: 1 });
            await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...p, button: 'left', clickCount: 1 });
        }
        async function fill(selector, value) {
            await click(selector);
            await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
            await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
            await browser.send('Input.insertText', { text: value });
        }
        await waitFor(() => browser.evaluate("document.querySelector('#homeContent').textContent.length>0"), 'home data');
        for (const [width, height] of [[1920, 1080], [1440, 900], [1366, 768], [2560, 1440]]) {
            await browser.setViewport(width, height);
            for (const theme of ['light', 'dark']) {
                if (await browser.evaluate('document.documentElement.dataset.theme') !== theme)
                    await click('#themeToggle');
                for (const view of ['home', 'work', 'search', 'memory', 'projects', 'activity']) {
                    await click(`[data-view="${view}"]`);
                    assert.equal(await browser.evaluate(`document.querySelector('#view-${view}').classList.contains('active')`), true);
                    assert.equal(await browser.evaluate('document.documentElement.scrollWidth>innerWidth+1'), false, 'page overflow');
                    await browser.screenshot(path.join(evidence, `${width}x${height}-${theme}-${view}.png`));
                    results.push({ caseId: 'UI-SHELL-' + view, viewport: [width, height], theme, status: 'PASS' });
                }
            }
        }
        await browser.setViewport(1920, 1080);
        await click('[data-view="projects"]');
        await click('#createDomain');
        await fill('#domainForm input[name="name"]', 'QA Native Pointer Domain');
        await click('#domainForm button[type="submit"]');
        await waitFor(() => browser.evaluate("!document.querySelector('#domainDialog').open&&document.querySelector('#projectTree').textContent.includes('QA Native Pointer Domain')"), 'domain persisted');
        const repo = path.join(run, 'repo with spaces'), knowledge = path.join(run, 'knowledge-root');
        fs.mkdirSync(repo);
        fs.mkdirSync(knowledge);
        const git = args => commandSync(cfg.tools.git || 'git', args, { cwd: repo, env: process.env });
        git(['init', '-q']);
        git(['config', 'user.name', 'QA Fixture']);
        git(['config', 'user.email', 'qa@local.invalid']);
        fs.writeFileSync(path.join(repo, 'README.md'), '# QA fixture\n');
        git(['add', 'README.md']);
        git(['commit', '-qm', 'baseline']);
        const baseline = git(['rev-parse', 'HEAD']);
        await click('#openSystem');
        await fill('#knowledgeRoot', knowledge);
        await click('#saveBrainSettings');
        await click('#closeSystem');
        await click('.view.active [data-action="import"]');
        await fill('#importCode', repo);
        await fill('#importName', 'QA Native Project');
        await fill('#importKnowledge', path.join(knowledge, 'project'));
        await waitFor(() => browser.evaluate("!document.querySelector('#confirmImport').disabled"), 'ready preflight', 15000);
        await click('#confirmImport');
        await waitFor(() => browser.evaluate("!document.querySelector('#importDialog').open&&document.querySelector('#projectDetail').textContent.includes('QA Native Project')"), 'real import', 30000);
        const rows = (await api('/api/projects/aggregated')).projects;
        assert.equal(rows.length, 1);
        assert.equal(git(['rev-parse', 'HEAD']), baseline);
        assert.ok(fs.existsSync(path.join(repo, '.git/hooks/post-commit')));
        assert.ok(Object.values(rows[0].modules).every(m => !m.registered), 'offline modules must remain unregistered');
        assert.equal(browser.exceptions.length, 0);
        await browser.screenshot(path.join(evidence, 'import-result.png'));
        return { status: 'PASS', mode: 'REAL_BROWSER_SHELL_MOCK_MODULES', realModel: false, results, importVerified: true, visualApproval: false };
    }
    catch (e) {
        if (browser)
            try {
                await browser.screenshot(path.join(evidence, 'first-failure.png'));
            }
            catch { }
        throw e;
    }
    finally {
        const redact = require('../lib/safety.cjs').redact;
        fs.writeFileSync(path.join(evidence, 'server.stdout.log'), redact(stdout));
        fs.writeFileSync(path.join(evidence, 'server.stderr.log'), redact(stderr));
        await browser?.close();
        await server.cleanup();
        offline.closeAllConnections();
        await new Promise(resolve => offline.close(resolve));
    }
}
async function main() {
    const cfg = readJSON(process.argv[2]);
    assertRepo(cfg, false);
    must(fs.realpathSync(cfg.repoRoot) !== fs.realpathSync(cfg.sourceRoot), 'ORIGINAL_WORKTREE', 'Browser tests require the isolated clone.');
    if (process.argv[3] === '--child') {
        const r = await child(cfg, process.argv[4], process.argv[5]);
        atomicJSON(path.join(process.argv[5], 'browser-result.json'), r);
        return;
    }
    const run = ownedRun(cfg.qaRoot, 'browser-' + Date.now()), evidence = path.join(cfg.qaRoot, 'artifacts', path.basename(run));
    fs.mkdirSync(evidence, { recursive: true });
    const before = snapshot(cfg);
    const result = await runLogged(cfg.tools.node, [__filename, process.argv[2], '--child', run, evidence], { cwd: cfg.repoRoot, env: isolatedEnv(run), logDir: evidence, timeoutMs: 300000 });
    const after = snapshot(cfg);
    const status = result.code === 0 && !result.timedOut && before.fingerprint === after.fingerprint ? 'PASS' : 'FAIL';
    const receipt = { schema: 1, kind: 'browser-shell', status, head: before.head, fingerprint: before.fingerprint, mode: 'REAL_BROWSER_SHELL_MOCK_MODULES', realModel: false, visualApproval: false, details: path.join(evidence, 'browser-result.json'), exitCode: result.code };
    atomicJSON(path.join(evidence, 'receipt.json'), receipt);
    setRunStatus(run, status === 'PASS' ? 'PASSED' : 'FAILED');
    console.log(JSON.stringify(receipt, null, 2));
    if (status !== 'PASS')
        process.exitCode = 10;
}
if (require.main === module)
    main().catch(e => { console.error(require('../lib/safety.cjs').redact(e.stack)); process.exitCode = 10; });
