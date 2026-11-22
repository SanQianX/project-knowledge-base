'use strict';

// Run with the pinned workflow package by default. PK_TEST_WORKFLOW_ENTRY
// and PK_TEST_PRODUCT_ROOT support testing a staged package.
const assert = require('node:assert/strict');
const path = require('node:path');
// The harness launches a separate browser via helpers/cdp-browser.
const { ROOT, startHarness, makeRepo } = require('./helpers/parallel-memory-shell');

const productRoot = path.resolve(process.env.PK_TEST_PRODUCT_ROOT || ROOT);
const candidateEntry = process.env.PK_TEST_WORKFLOW_ENTRY;
const workflowEntry = candidateEntry ? path.resolve(candidateEntry) : require.resolve('@sanqianx/ai-coding-workflow', { paths: [productRoot] });
const workflowApi = '/api/workflow';
const teamName = '工具链团队';

async function createWithWizard(harness, projectId, group) {
  const inFrame = (fn, ...args) => harness.run(`(${fn})(document.getElementById('workflowFrame').contentDocument, ...${JSON.stringify(args)})`);
  const click = async selector => assert.ok(await inFrame((doc, target) => {
    const node = doc.querySelector(target);
    if (!node || node.disabled || !node.getClientRects().length) return false;
    node.click();
    return true;
  }, selector), `available workflow control: ${selector}`);
  const change = (selector, value, eventType) => inFrame((doc, target, next, type) => {
    const node = doc.querySelector(target);
    node.value = next;
    node.dispatchEvent(new Event(type, { bubbles: true }));
  }, selector, value, eventType);

  await harness.nativeClick('nav [data-view="projects"]');
  const createTeam = `[data-project-team="${projectId}"] [data-go="team"]`;
  await harness.waitFor(() => harness.run(`Boolean(document.querySelector(${JSON.stringify(createTeam)}))`), 'create-team entry in the project list');
  await harness.nativeClick(createTeam);
  await harness.waitFor(() => inFrame(doc => Boolean(doc?.querySelector('#createTeamBtn'))), 'empty team page');
  await click('#createTeamBtn');
  await harness.waitFor(() => inFrame(doc => Boolean(doc?.querySelector('#wzAddMember'))), 'team wizard');
  await change('#wzTeamName', teamName, 'input');
  await click('[data-wizard-member="0"] [data-remove-member]');
  await click('#wzAddMember');
  await change('[data-wizard-member="1"] [data-member-field="role"]', 'release-docs', 'change');
  await click('#wzNext');
  const memory = `[data-wizard-memory="1"] input[value="${group.id}"]`;
  await harness.waitFor(() => inFrame((doc, selector) => Boolean(doc.querySelector(selector)), memory), 'member memory choices');
  await click(memory);
  await click('#wzNext');
  await harness.waitFor(() => inFrame(doc => Array.from(doc.querySelectorAll('[data-wiz="project"]')).length === 2), 'two projects with choices');
  const projectLabels = await inFrame(doc => Array.from(doc.querySelectorAll('[data-wiz="project"]'), input => {
    const label = input.closest('label');
    return { name: label.textContent.trim(), layout: doc.defaultView.getComputedStyle(label).flexDirection };
  }));
  assert.deepEqual(new Set(projectLabels.map(p => p.name)), new Set(['项目甲', '项目乙']));
  assert.ok(projectLabels.every(p => p.layout === 'row'));
  const projectCheck = `[data-wiz="project"][value="${projectId}"]`;
  await click(projectCheck);
  await click('#wzBack');
  assert.equal(await inFrame((doc, selector) => doc.querySelector(selector).checked, memory), true);
  await click('#wzNext');
  assert.equal(await inFrame((doc, selector) => doc.querySelector(selector).checked, projectCheck), true);
  await click('#wzCreate');
  await harness.waitFor(() => inFrame(doc => Boolean(doc.querySelector('#panel-members:not(.hidden) #addMember'))), 'persisted roster');
  const members = await harness.productApi('GET', workflowApi + '/members');
  assert.deepEqual(members.body.members.map(m => m.role), ['reviewer', 'release-docs']);
  assert.deepEqual(members.body.members[1].memoryGroupIds, [group.id]);
  assert.match(await inFrame(doc => doc.getElementById('panel-members').textContent), /自动维护待接入/);

  await click('#addMember');
  await change('#memberForm [data-member-field="name"]', 'C++ Review', 'input');
  await change('#memberForm [data-member-field="instructions"]', '检查 clang-tidy 收据', 'input');
  await click('#memberForm button[type="submit"]');
  await harness.waitFor(() => inFrame(doc => doc.querySelectorAll('.member-card[data-member]').length === 3), 'third member on the roster');
  const updated = await harness.productApi('GET', workflowApi + '/members');
  assert.equal(updated.body.members[2].instructions, '检查 clang-tidy 收据');
}

async function main() {
  const harness = await startHarness({ tag: 'project-team', productRoot, workflowEntry });
  const { productApi } = harness;
  try {
    const { projectId: alpha } = await harness.importProject(makeRepo(harness.fixture, 'alpha'), '项目甲');
    const { projectId: beta } = await harness.importProject(makeRepo(harness.fixture, 'beta'), '项目乙');
    const newGroup = await harness.engineApi('POST', '/api/memory-groups', { name: '团队规范' });
    assert.equal(newGroup.status, 200);
    const group = newGroup.body.group;
    const bind = await harness.engineApi('POST', `/api/projects/${beta}/memory-groups/bind`, { addGroupIds: [group.id] });
    assert.equal(bind.status, 200);
    await createWithWizard(harness, alpha, group);

    const betaSettings = workflowApi + `/projects/${beta}/settings`;
    const custom = { autoRecord: false, deliveryChecks: false, reminders: false, checkConfig: { source: 'project' } };
    const saved = await productApi('PUT', betaSettings, { requestId: 'configure-beta', enabled: false, ...custom });
    assert.equal(saved.status, 200);
    const teamControl = `[data-project-team="${beta}"]`;
    const teamTag = `${teamControl} .team-tag`;
    const attach = `${teamControl} [data-action="project-team"]`;
    const openProjects = async () => {
      await harness.nativeClick('nav [data-view="projects"]');
      await harness.waitFor(() => harness.run(`Boolean(document.querySelector(${JSON.stringify(attach)}))`), 'project team controls');
    };
    const assertSettings = async enabled => {
      const { body: { settings } } = await productApi('GET', betaSettings);
      assert.equal(settings.enabled, enabled);
      for (const [key, value] of Object.entries(custom)) assert.deepEqual(settings[key], value, key);
      const separate = await productApi('GET', workflowApi + `/projects/${alpha}/settings`);
      assert.equal(separate.body.settings.enabled, true);
      const groups = await harness.engineApi('GET', `/api/projects/${beta}/memory-groups`);
      assert.ok(groups.body.groups.some(g => g.id === group.id));
    };

    await openProjects();
    await harness.nativeClick(attach);
    await harness.nativeClick('#appDialogActions button.primary');
    await harness.waitFor(() => harness.run(`document.querySelector(${JSON.stringify(teamTag)})?.textContent.includes(${JSON.stringify(teamName)})`), 'mounted team chip');
    await assertSettings(true);
    await harness.reload();
    await openProjects();
    await harness.nativeClick(`${teamTag} button`);
    await harness.nativeClick('#appDialogActions button.primary');
    await harness.waitFor(() => harness.run(`Boolean(document.querySelector(${JSON.stringify(attach)})) && !document.querySelector(${JSON.stringify(teamTag)})`), 'detached team control');
    await assertSettings(false);
    console.log('project-team-ui-test PASS (wizard, roster, and project mount)');
  } finally { await harness.cleanup(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
