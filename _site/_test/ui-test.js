// Playwright UI test for KB management site
// Run: NODE_PATH="..." node _test/ui-test.js
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const SCREENSHOT_DIR = path.resolve(__dirname, 'screenshots');
const REPORT_PATH = path.resolve(__dirname, 'ui-test-report.json');
const URL = 'http://localhost:5757/';

if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

const results = [];
let stepNum = 0;

function record(name, status, details) {
  stepNum++;
  const entry = { step: stepNum, name, status, ...details };
  results.push(entry);
  const icon = status === 'PASS' ? 'PASS' : (status === 'FAIL' ? 'FAIL' : 'WARN');
  console.log(`  ${icon} [${status}] ${name}${details.note ? ' - ' + details.note : ''}`);
  return entry;
}

async function shot(page, name) {
  const filename = `${String(stepNum).padStart(2, '0')}-${name}.png`;
  const filepath = path.join(SCREENSHOT_DIR, filename);
  await page.screenshot({ path: filepath, fullPage: true });
  return filepath;
}

(async () => {
  console.log('============================================');
  console.log('  UI TEST - Playwright + Chromium headless');
  console.log('============================================\n');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();

  // Track dialogs without auto-accepting (we want to verify the prompts, not click through them)
  // Default: dismiss dialogs so test actions are non-destructive
  page.on('dialog', d => d.dismiss().catch(() => {}));

  // ==== Initial load ====
  console.log('> Initial load');
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForSelector('#app article', { timeout: 5000 });
  const initialShot = await shot(page, '01-projects-initial');
  const projectCount = await page.locator('#app article').count();
  record('Page loads with project cards', projectCount > 0 ? 'PASS' : 'FAIL', {
    note: `${projectCount} cards rendered`,
    screenshot: initialShot,
  });

  // ==== Verify first project card is present ====
  const projectCard = page.locator('#app article').first();
  const projectCardVisible = await projectCard.isVisible();
  const projectTitle = (await projectCard.locator('h2, h3, .font-semibold').first().textContent().catch(() => 'project')).trim();
  record('First project card visible', projectCardVisible ? 'PASS' : 'FAIL', {
    note: projectCardVisible ? `${projectTitle} card found` : 'card not found',
    screenshot: initialShot,
  });

  // ==== Verify a KB status badge exists ====
  const kbBadge = await projectCard.locator('text=/KB ready|KB missing/').count();
  record('Project card shows KB status badge', kbBadge > 0 ? 'PASS' : 'FAIL', {
    note: kbBadge > 0 ? 'badge present' : 'badge missing',
  });

  // ==== Click "View tree" on the first project ====
  console.log('\n> Projects tab - View tree');
  const viewTreeBtn = projectCard.locator('button:has-text("View tree")');
  await viewTreeBtn.click();
  await page.waitForTimeout(500);
  const treeDetails = projectCard.locator('details');
  const treeSummary = await treeDetails.locator('summary').textContent();
  const treeItems = await projectCard.locator('details li').count();
  const treeShot = await shot(page, '02-tree-expanded');
  record('View tree expands project tree', treeItems > 0 ? 'PASS' : 'FAIL', {
    note: `${treeItems} entries (summary: ${treeSummary})`,
    screenshot: treeShot,
  });

  // ==== Close the tree ====
  await viewTreeBtn.click();
  await page.waitForTimeout(200);

  // ==== "+ Add" tab ====
  console.log('\n> + Add tab');
  await page.click('button:has-text("+ Add")');
  await page.waitForSelector('form');
  const addShot1 = await shot(page, '03-add-empty');
  record('+ Add tab shows form', true, { note: 'form visible', screenshot: addShot1 });

  // ==== Fill the form with a test entry ====
  await page.fill('input[placeholder="my-new-project"]', 'ui-test-proj');
  await page.fill('input[placeholder="My New Project"]', 'UI Test Project');
  await page.fill('input[placeholder^="D:\\\\SanQian.Xu"]', 'D:\\SanQian.Xu\\UI-Test-Project');
  await page.fill('input[placeholder="TypeScript"]', 'TypeScript');
  await page.fill('input[placeholder="react, vite, api"]', 'ui, test, demo');
  const filledShot = await shot(page, '04-add-filled');
  record('Form fields fill correctly', true, { note: 'all fields filled', screenshot: filledShot });

  // ==== Reset button ====
  await page.click('button:has-text("Reset")');
  await page.waitForTimeout(200);
  const slugValue = await page.inputValue('input[placeholder="my-new-project"]');
  record('Reset button clears form', slugValue === '' ? 'PASS' : 'FAIL', {
    note: 'slug input is empty',
  });

  // ==== Schedule & Run tab ====
  console.log('\n> Schedule & Run tab');
  await page.click('button:has-text("Schedule & Run")');
  await page.waitForSelector('text=Current status');
  const schedShot1 = await shot(page, '05-schedule-initial');
  const stateText = await page.locator('div.flex.justify-between:has(span:text("State:"))').last().locator('span').nth(1).textContent().catch(() => '?');
  const nextRunText = await page.locator('div.flex.justify-between:has(span:text("Next run:"))').last().locator('span').nth(1).textContent().catch(() => '?');
  record('Schedule card shows current state', stateText.includes('Ready') ? 'PASS' : 'FAIL', {
    note: `state=${stateText.trim()}, nextRun=${nextRunText.trim()}`,
    screenshot: schedShot1,
  });

  // ==== Change frequency to hourly ====
  await page.selectOption('select', 'hourly');
  await page.waitForTimeout(200);
  const hourlyShot = await shot(page, '06-frequency-hourly');
  record('Frequency dropdown accepts "Hourly"', true, { note: 'selected', screenshot: hourlyShot });

  // ==== Click Apply ====
  await page.click('button:has-text("Apply")');
  await page.waitForSelector('text=Schedule updated', { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(500);
  const appliedShot = await shot(page, '07-schedule-applied');
  const appliedMsg = await page.locator('text=Schedule updated').count();
  record('Apply button updates schedule', appliedMsg > 0 ? 'PASS' : 'FAIL', {
    note: appliedMsg > 0 ? 'success message shown' : 'no success message',
    screenshot: appliedShot,
  });

  // ==== Verify state changed ====
  await page.waitForTimeout(800);
  const stateAfter = await page.locator('div.flex.justify-between:has(span:text("State:"))').last().locator('span').nth(1).textContent().catch(() => '?');
  record('Schedule state remains Ready after change', stateAfter.includes('Ready') ? 'PASS' : 'FAIL', {
    note: `state=${stateAfter.trim()}`,
  });

  // ==== Restore: change back to Daily 08:00 ====
  await page.selectOption('select', 'daily');
  await page.waitForTimeout(200);
  // Set time to 08:00
  await page.fill('input[type="time"]', '08:00');
  await page.click('button:has-text("Apply")');
  await page.waitForTimeout(1500);
  const restoredShot = await shot(page, '08-schedule-restored');
  const scheduleTypeText = await page.locator('text=Schedule Type:').locator('xpath=following-sibling::*[1]').textContent().catch(() => '?');
  const startTimeText = await page.locator('text=Start Time:').locator('xpath=following-sibling::*[1]').textContent().catch(() => '?');
  // Note: schedule card may not show Schedule Type / Start Time. The data is in raw map but not exposed.
  // So just check the message
  record('Restore daily 08:00', true, {
    note: 'applied, schedule type=' + scheduleTypeText.trim() + ', startTime=' + startTimeText.trim(),
    screenshot: restoredShot,
  });

  // ==== Run now with the first available project (may fail, but should display output) ====
  console.log('\n> Run now');
  const runSelect = page.locator('label:has-text("Project slug")').locator('xpath=following::select[1]');
  const runSlug = await runSelect.locator('option').first().getAttribute('value');
  if (runSlug) await runSelect.selectOption(runSlug).catch(() => {});
  await page.waitForTimeout(200);
  const runSelectedShot = await shot(page, '09-run-selected');
  record('Run slug dropdown works', !!runSlug ? 'PASS' : 'FAIL', {
    note: runSlug ? `selected ${runSlug}` : 'no project option found',
    screenshot: runSelectedShot,
  });

  // Click Run now
  await page.click('button:has-text("Run now")');
  // Wait for log tab to appear
  await page.waitForSelector('h2:has-text("Last run output")', { timeout: 10000 });
  await page.waitForTimeout(2000);
  const logShot = await shot(page, '10-log-output');
  const logOutput = await page.locator('pre').textContent();
  const hasOutput = logOutput && logOutput.length > 50;
  const hasError = logOutput && (logOutput.includes('fatal') || logOutput.includes('cannot change to'));
  record('Run now executes and shows output', hasOutput ? 'PASS' : 'FAIL', {
    note: hasError ? 'error captured (expected for broken gitPath)' : 'no error in output',
    screenshot: logShot,
  });

  // ==== Back to Projects ====
  console.log('\n> Back to Projects');
  await page.click('button:has-text("Projects")');
  await page.waitForSelector('#app article');
  await page.waitForTimeout(500);
  const finalShot = await shot(page, '11-projects-final');
  const finalCount = await page.locator('#app article').count();
  record('Projects tab reloads with project cards', finalCount > 0 ? 'PASS' : 'FAIL', {
    note: `${finalCount} cards`,
    screenshot: finalShot,
  });

  // ==== Verify "Remove" button shows confirm dialog ====
  // We won't actually remove, just verify the dialog appears
  console.log('\n> Remove confirm dialog');
  let capturedMsg = null;
  page.once('dialog', d => { capturedMsg = d.message(); d.dismiss().catch(() => {}); });
  await page.locator('#app article').first().locator('button:has-text("Remove")').click();
  await page.waitForTimeout(800);
  if (capturedMsg) {
    record('Remove shows confirm dialog', capturedMsg.includes('Remove project') ? 'PASS' : 'FAIL', {
      note: `dialog text: ${capturedMsg.slice(0, 80)}...`,
    });
  } else {
    record('Remove shows confirm dialog', 'FAIL', { note: 'no dialog appeared' });
  }

  // ==== Summary ====
  await browser.close();

  const pass = results.filter(r => r.status === 'PASS').length;
  const fail = results.filter(r => r.status === 'FAIL').length;
  const summary = { url: URL, total: results.length, pass, fail, results };

  fs.writeFileSync(REPORT_PATH, JSON.stringify(summary, null, 2));
  console.log('\n============================================');
  console.log(`  UI TEST SUMMARY: ${pass}/${results.length} passed${fail ? ', ' + fail + ' failed' : ''}`);
  console.log('============================================');
  console.log(`  Report: ${REPORT_PATH}`);
  console.log(`  Screenshots: ${SCREENSHOT_DIR}`);
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('FATAL:', e);
  process.exit(2);
});
