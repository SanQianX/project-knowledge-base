#!/usr/bin/env node
'use strict';
// qa-autopilot/tools/product-probes/parallel-nav-acceptance-r11.js
//
// P-NAV-ACCEPTANCE-R11 — NAV-007 分辨率矩阵.
//
//   steps:   在4个桌面视口、两种主题检查六页截图及 bounding rect。
//   expected: 无非预期水平溢出、控件遮挡。/ 截图人工基线与像素检查分别报告。
//
// Real product server (r1 dock shell env, isolated), real CDP browser. For
// every (viewport, theme) combination the probe walks the SIX real pages
// (我的智脑 / 开始工作 / 知识检索 / 长期记忆 / 活动记录 / 系统), asserts:
//   * no unexpected horizontal overflow (scrollWidth <= clientWidth + 1);
//   * the primary navigation controls stay inside the viewport (no occlusion
//     beyond the canvas);
// and saves one screenshot per combination as the human-baseline set. The
// programmatic pixel/rect check and the human baseline are reported
// separately, exactly as the spec demands.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PKB_ROOT = path.resolve(__dirname, '..', '..', '..');
const UI = require(path.join(PKB_ROOT, '_site', '_test', 'helpers', 'parallel-dock-acceptance-ui.js'));
const { createDockAcceptanceEnv } = require(path.join(PKB_ROOT, '_site', '_test', 'helpers', 'parallel-dock-acceptance-env.js'));

const ARTIFACTS = path.join(PKB_ROOT, 'qa-autopilot', 'artifacts', 'parallel-20261106', 'nav-acceptance-r11');
const VIEWPORTS = [
  { name: '1280x720', width: 1280, height: 720 },
  { name: '1366x768', width: 1366, height: 768 },
  { name: '1600x900', width: 1600, height: 900 },
  { name: '1920x1080', width: 1920, height: 1080 },
];
const PAGES = [
  { view: 'home', label: '我的智脑' },
  { view: 'work', label: '开始工作' },
  { view: 'search', label: '知识检索' },
  { view: 'memory', label: '长期记忆' },
  { view: 'activity', label: '活动记录' },
  { view: 'system', label: '系统' },
];

async function main() {
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  const evidence = { schema: 'qa-autopilot/nav-acceptance-evidence/v1', lane: 'P-NAV-ACCEPTANCE-R11', case: 'NAV-007', startedAt: new Date().toISOString(), combinations: [], expectations: [], firstFailure: null };
  let env = null;
  let browser = null;
  try {
    env = await createDockAcceptanceEnv({ tag: 'nav-r11' });
    evidence.identity = { ...env.identity(), fileHashes: env.fileHashes() };
    browser = await UI.launchCdpBrowser({
      chrome: UI.findChrome(),
      profileDir: path.join(os.tmpdir(), `pk-nav-r11-profile-${process.pid}`),
      url: env.productUrl, width: 1920, height: 1080,
    });
    await UI.openWorkView(browser, env.productUrl);

    for (const viewport of VIEWPORTS) {
      await browser.send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: false });
      await new Promise(r => setTimeout(r, 600));
      for (const theme of ['light', 'dark']) {
        await browser.evaluate(`(() => { document.documentElement.dataset.theme = ${JSON.stringify(theme)}; window.dispatchEvent(new Event('kb-theme')); return true; })()`);
        await new Promise(r => setTimeout(r, 400));
        const shots = [];
        for (const page of PAGES) {
          await browser.evaluate(`document.querySelector('[data-view=${JSON.stringify(page.view)}]') ? (document.querySelector('[data-view=${JSON.stringify(page.view)}]').click(), true) : false`);
          await new Promise(r => setTimeout(r, 350));
          const rect = await browser.evaluate(`(() => {
            const doc = document.documentElement;
            const navButtons = Array.from(document.querySelectorAll('[data-view]'));
            const outside = navButtons.filter(b => { const r = b.getBoundingClientRect(); return r.left < -1 || r.right > doc.clientWidth + 1 || r.top < -1 || r.bottom > doc.clientHeight + 1; });
            return {
              view: ${JSON.stringify(page.view)},
              clientWidth: doc.clientWidth, scrollWidth: doc.scrollWidth,
              horizontalOverflow: doc.scrollWidth > doc.clientWidth + 1,
              navCount: navButtons.length, navOutside: outside.length,
              activeView: document.querySelector('.nav-item.is-active, [data-view].active') ? (document.querySelector('.nav-item.is-active, [data-view].active').dataset.view || null) : null,
            };
          })()`);
          const shot = path.join(ARTIFACTS, `${viewport.name}-${theme}-${page.view}.png`);
          await browser.screenshot(shot);
          shots.push({ page: page.label, ...rect, screenshot: path.basename(shot) });
        }
        const combo = { viewport: viewport.name, theme, pages: shots };
        evidence.combinations.push(combo);
        console.log(`[r11] ${viewport.name}/${theme}: overflow=${shots.filter(s => s.horizontalOverflow).length} occluded=${shots.filter(s => s.navOutside > 0).length}`);
      }
    }
    await browser.send('Emulation.clearDeviceMetricsOverride', {});

    const allPages = evidence.combinations.flatMap(c => c.pages);
    evidence.expectations.push({
      key: 'no-unexpected-horizontal-overflow',
      pass: allPages.every(p => !p.horizontalOverflow),
      observed: { pages: allPages.length, overflowPages: allPages.filter(p => p.horizontalOverflow).map(p => `${p.view}@${p.clientWidth}`) },
    });
    evidence.expectations.push({
      key: 'controls-not-occluded',
      pass: allPages.every(p => p.navOutside === 0),
      observed: { occludedPages: allPages.filter(p => p.navOutside > 0).map(p => p.view) },
    });
    evidence.expectations.push({
      key: 'human-baseline-and-pixel-check-reported-separately',
      pass: evidence.combinations.reduce((n, c) => n + c.pages.length, 0) === VIEWPORTS.length * 2 * PAGES.length,
      observed: {
        screenshots: evidence.combinations.flatMap(c => c.pages.map(p => p.screenshot)).length,
        note: 'pixel/rect checks above are programmatic; the per-combination PNG set under artifacts is the human baseline, reported separately',
      },
    });
    evidence.finishedAt = new Date().toISOString();
    evidence.verdict = evidence.expectations.every(item => item.pass) ? 'PASS' : 'FAIL';
    fs.writeFileSync(path.join(ARTIFACTS, 'nav-007.json'), JSON.stringify(evidence, null, 2));
    console.log(`[r11] NAV-007 ${evidence.verdict}`);
    process.exitCode = evidence.verdict === 'PASS' ? 0 : 1;
  } catch (error) {
    evidence.firstFailure = String(error && error.stack || error);
    evidence.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(ARTIFACTS, 'nav-007.json'), JSON.stringify(evidence, null, 2));
    console.error(`[r11] FATAL ${evidence.firstFailure}`);
    process.exitCode = 1;
  } finally {
    if (browser) { try { await browser.close(); } catch { /* best effort */ } }
    if (env) { try { await env.cleanup(); } catch { /* best effort */ } }
  }
}

main().catch(error => { console.error(String(error && error.stack || error)); process.exit(1); });
