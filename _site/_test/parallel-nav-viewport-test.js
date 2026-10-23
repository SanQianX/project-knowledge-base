'use strict';
// NAV-007 — 分辨率矩阵。
//
// The six pages of the shell must render without unintended horizontal
// overflow and without a control being covered, in four desktop viewports
// and in both themes.
//
// The regression drives the real product UI in a real browser against an
// isolated instance (own port, own data dir, own knowledge dir, own browser
// profile). Every viewport is a real CDP device metrics override, every page
// is opened by a real pointer click on the real navigation control, and every
// screenshot is a real PNG of the real rendered page.
//
// The two kinds of evidence are kept apart on purpose:
//
//   * The geometry evidence is machine checked: the bounding rect of every
//     visible control, the horizontal overflow of every container, and the
//     hit test of every control that proves nothing stands in front of it.
//     These assertions decide the exit code of this test.
//   * The screenshot evidence is for a human reviewer. This repository holds
//     no approved visual baseline for the product, so the test does NOT
//     compare the screenshots against a baseline and does NOT claim a
//     baseline match. It writes the screenshots, their pixel statistics and
//     an index, and the human review of that material stays an open item.
//
// Screenshots are written to PK_TEST_EVIDENCE_DIR when the batch sets it, so
// this tracked file stays free of machine-specific paths.

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const { startHarness, makeRepo } = require('./helpers/parallel-nav-shell');

const EVIDENCE = process.env.PK_TEST_EVIDENCE_DIR ? path.resolve(process.env.PK_TEST_EVIDENCE_DIR) : null;

const VIEWPORTS = [
  { name: '1366x768', width: 1366, height: 768 },
  { name: '1440x900', width: 1440, height: 900 },
  { name: '1600x900', width: 1600, height: 900 },
  { name: '1920x1080', width: 1920, height: 1080 },
];

const THEMES = ['light', 'dark'];

const PAGES = [
  { key: 'home', view: 'home' },
  { key: 'work', view: 'work' },
  { key: 'search', view: 'search' },
  { key: 'memory', view: 'memory' },
  { key: 'projects', view: 'projects' },
  { key: 'activity', view: 'activity' },
];

/**
 * The bounding rect evidence of the rendered page: the overflow of every
 * container and the rect and hit test of every visible control.
 */
const geometry = harness => harness.run(`(() => {
  const active = document.querySelector('.view.active');
  const doc = document.documentElement;
  const describe = el => {
    const parts = [];
    if (el.id) parts.push('#' + el.id);
    if (el.className && typeof el.className === 'string') parts.push('.' + el.className.trim().split(/\\s+/).join('.'));
    return el.tagName.toLowerCase() + parts.join('');
  };
  const overflowing = [];
  for (const el of document.querySelectorAll('html, body, .app, .sidebar, main, .content, .view, .topbar')) {
    const style = getComputedStyle(el);
    if (style.display === 'none') continue;
    if (el.scrollWidth > el.clientWidth + 1) {
      overflowing.push({ element: describe(el), scrollWidth: el.scrollWidth, clientWidth: el.clientWidth });
    }
  }
  const controls = [];
  for (const el of document.querySelectorAll('button, select, input, textarea, a[href]')) {
    if (el.closest('iframe')) continue;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    // The part of the control the user can really see. A control that
    // crosses the lower edge of the viewport is not covered: the page
    // scrolls, and the visible part of it must be reachable.
    const visibleLeft = Math.max(rect.left, 0);
    const visibleRight = Math.min(rect.right, innerWidth);
    const visibleTop = Math.max(rect.top, 0);
    const visibleBottom = Math.min(rect.bottom, innerHeight);
    const visibleWidth = Math.round(visibleRight - visibleLeft);
    const visibleHeight = Math.round(visibleBottom - visibleTop);
    const inViewport = visibleWidth > 0 && visibleHeight > 0;
    let covered = false;
    let coveredBy = '';
    let hitX = 0;
    let hitY = 0;
    if (inViewport) {
      // The hit test runs on the centre of the VISIBLE part of the control.
      // The centre of the whole control may lie below the fold, where the
      // browser reports no element at all - that is a scroll position, not
      // an occlusion.
      hitX = Math.round((visibleLeft + visibleRight) / 2);
      hitY = Math.round((visibleTop + visibleBottom) / 2);
      const hit = document.elementFromPoint(hitX, hitY);
      covered = !(hit && (hit === el || el.contains(hit) || el.contains(hit.parentElement)));
      coveredBy = hit ? (hit.id || hit.tagName) : 'nothing';
    }
    controls.push({
      element: describe(el),
      id: el.id || '',
      label: (el.textContent || '').trim().slice(0, 24),
      left: Math.round(rect.left), right: Math.round(rect.right),
      top: Math.round(rect.top), bottom: Math.round(rect.bottom),
      width: Math.round(rect.width), height: Math.round(rect.height),
      visibleWidth, visibleHeight,
      hitX, hitY,
      belowFold: rect.top >= innerHeight,
      outsideHorizontally: rect.left < -1 || rect.right > innerWidth + 1,
      inViewport,
      covered,
      coveredBy,
    });
  }
  return {
    viewport: { width: innerWidth, height: innerHeight },
    theme: document.documentElement.dataset.theme || '',
    activeView: active ? active.id : '',
    docScrollWidth: doc.scrollWidth,
    docClientWidth: doc.clientWidth,
    viewScrollWidth: active ? active.scrollWidth : 0,
    viewClientWidth: active ? active.clientWidth : 0,
    overflowing,
    controls,
  };
})()`);

/**
 * The pixel statistics of a real screenshot. The PNG is decoded by the
 * browser itself, so the numbers come from the rendered pixels and not from
 * the DOM.
 */
async function pixelStats(harness, base64) {
  return harness.run(`(async () => {
    const img = new Image();
    img.src = 'data:image/png;base64,${base64}';
    await img.decode();
    // The picture is sampled on a small grid: the browser still decodes the
    // real PNG, but the statistics cost a fraction of a full-size scan.
    const canvas = document.createElement('canvas');
    canvas.width = 96;
    canvas.height = 54;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let sum = 0;
    const buckets = new Set();
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      sum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
      buckets.add(((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4));
    }
    const pixels = data.length / 4;
    return {
      width: img.naturalWidth,
      height: img.naturalHeight,
      sampledWidth: canvas.width,
      sampledHeight: canvas.height,
      meanLuminance: Math.round((sum / pixels) * 100) / 100,
      distinctColors: buckets.size,
    };
  })()`);
}

/**
 * One line per control: the geometry the case really measured. The runner
 * shows only the last lines of a failure, so a dump of the whole array would
 * hide the control that matters behind the tail of the list.
 */
const controlSummary = control => `${control.element}${control.id ? '#' + control.id : ''} "${control.label}" rect=[${control.left},${control.top} ${control.right},${control.bottom}] visible=${control.visibleWidth}x${control.visibleHeight} hit=(${control.hitX},${control.hitY}) coveredBy=${control.coveredBy}`;

const overflowSummary = entry => `${entry.element} scrollWidth=${entry.scrollWidth} clientWidth=${entry.clientWidth}`;

async function ensureTheme(harness, theme) {
  const current = await harness.run("document.documentElement.dataset.theme || ''");
  if (current === theme) return;
  await harness.nativeClick('#themeToggle');
  await harness.waitFor(
    () => harness.run(`document.documentElement.dataset.theme === ${JSON.stringify(theme)}`),
    `the shell shows the ${theme} theme`,
  );
}

async function main() {
  const harness = await startHarness({ tag: 'nav007', evidenceDir: EVIDENCE || undefined });
  const index = [];
  try {
    const repo = makeRepo(harness.fixture, 'nav007-a');
    await harness.importProject(repo, 'NAV007 甲');
    await harness.requestRegistryRefresh();
    await harness.waitFor(
      () => harness.run("document.getElementById('homeContent').textContent.includes('NAV007 甲')"),
      'the imported project is listed',
      20000,
    );

    for (const viewport of VIEWPORTS) {
      await harness.setViewport(viewport.width, viewport.height);
      for (const theme of THEMES) {
        await ensureTheme(harness, theme);
        for (const page of PAGES) {
          await harness.nativeClick(`nav [data-view="${page.view}"]`);
          await harness.waitFor(
            () => harness.run(`document.getElementById('view-${page.view}').classList.contains('active')`),
            `the ${page.view} view is open`,
            10000,
          );
          // The module views fill their frame asynchronously; the shell
          // chrome is laid out already, so one frame of settling is enough
          // for the rects to be final.
          await harness.wait(300);

          const info = await geometry(harness);
          const label = `${viewport.name}-${theme}-${page.key}`;
          const where = `${label} viewport=${info.viewport.width}x${info.viewport.height} theme=${info.theme} view=${info.activeView}`;

          // The page that is open is the page the matrix asked for.
          assert.equal(info.activeView, `view-${page.view}`, `the open page is the one under test: ${where}`);
          // The theme under test is the theme the page really shows.
          assert.equal(info.theme, theme, `the page really shows the ${theme} theme: ${where}`);

          // NAV-007 expected 1: no unintended horizontal overflow.
          assert.equal(info.overflowing.length, 0, `no container overflows horizontally: ${where} ${info.overflowing.map(overflowSummary).join(' | ')}`);
          assert.ok(info.docScrollWidth <= info.docClientWidth + 1, `the document does not scroll sideways: ${where} ${info.docScrollWidth}/${info.docClientWidth}`);
          assert.ok(info.viewScrollWidth <= info.viewClientWidth + 1, `the open page does not scroll sideways: ${where} ${info.viewScrollWidth}/${info.viewClientWidth}`);
          const outside = info.controls.filter(control => control.outsideHorizontally);
          assert.equal(outside.length, 0, `no visible control leaves the viewport sideways: ${where} ${outside.map(controlSummary).join(' | ')}`);

          // NAV-007 expected 1 (continued): no control is covered by another.
          const covered = info.controls.filter(control => control.covered);
          assert.equal(covered.length, 0, `no visible control is covered: ${where} ${covered.map(controlSummary).join(' | ')}`);

          // The page really has content: the controls of the open view exist.
          assert.ok(info.controls.length > 0, `the open page exposes controls: ${where} ${info.controls.length} controls`);

          // The screenshot of the real page, and its real pixels.
          const shot = await harness.browser.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
          const file = path.join(harness.evidence, `nav007-${label}.png`);
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
          const pixels = await pixelStats(harness, shot.data);
          assert.equal(pixels.width, viewport.width, `the screenshot has the viewport width: ${where}`);
          assert.equal(pixels.height, viewport.height, `the screenshot has the viewport height: ${where}`);
          assert.ok(pixels.distinctColors >= 3, `the screenshot shows a rendered page, not a blank surface: ${where} ${JSON.stringify(pixels)}`);

          index.push({
            case: 'NAV-007',
            label,
            viewport: { width: viewport.width, height: viewport.height },
            theme,
            page: page.key,
            screenshot: path.basename(file),
            pixels,
            controls: info.controls.length,
            docScrollWidth: info.docScrollWidth,
            docClientWidth: info.docClientWidth,
          });
        }
      }
    }

    assert.equal(index.length, VIEWPORTS.length * THEMES.length * PAGES.length, 'the whole matrix was captured');

    // The theme really repaints the page: the dark screenshots are darker
    // than the light ones of the same page and viewport.
    for (const viewport of VIEWPORTS) {
      for (const page of PAGES) {
        const light = index.find(entry => entry.viewport.width === viewport.width && entry.theme === 'light' && entry.page === page.key);
        const dark = index.find(entry => entry.viewport.width === viewport.width && entry.theme === 'dark' && entry.page === page.key);
        assert.ok(light && dark, `the matrix holds both themes of the page: ${viewport.name}/${page.key}`);
        assert.ok(dark.pixels.meanLuminance < light.pixels.meanLuminance, `the dark theme really repaints the page: ${viewport.name}/${page.key} ${dark.pixels.meanLuminance} vs ${light.pixels.meanLuminance}`);
      }
    }

    // The screenshots and their pixel statistics are written for the human
    // reviewer. No visual baseline exists in this repository, so no baseline
    // match is claimed here; the review stays an open item.
    fs.writeFileSync(
      path.join(harness.evidence, 'nav007-screenshot-index.json'),
      `${JSON.stringify({
        case: 'NAV-007',
        generatedBy: '_site/_test/parallel-nav-viewport-test.js',
        matrix: { viewports: VIEWPORTS, themes: THEMES, pages: PAGES.map(page => page.key) },
        humanBaseline: {
          state: 'PENDING_HUMAN_REVIEW',
          note: '本仓库没有已批准的产品视觉基线，本用例只产出截图与像素统计，不声称基线一致；人工审阅未完成。',
        },
        screenshots: index,
      }, null, 2)}\n`,
      'utf8',
    );

    assert.equal(harness.browser.exceptions.length, 0, `no uncaught product JavaScript exceptions: ${JSON.stringify(harness.browser.exceptions)}`);

    console.log(`parallel-nav-viewport-test PASS (${index.length} screenshots of ${VIEWPORTS.length} viewports x ${THEMES.length} themes x ${PAGES.length} pages, no horizontal overflow, no covered control; the human baseline review stays open)`);
  } finally {
    await harness.cleanup();
  }
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
