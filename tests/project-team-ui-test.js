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

async function createTeamViaSettings(harness, projectId, group) {
  const inFrame = (fn, ...args) => harness.run(`(${fn})(document.getElementById('workflowFrame').contentDocument, ...${JSON.stringify(args)})`);
  // Atomic wait-and-click: the frame re-renders on async data loads, so a
  // one-shot probe races a redraw that swaps the node between check and click.
  const click = selector => harness.waitFor(() => inFrame((doc, target) => {
    const node = doc.querySelector(target);
    if (!node || node.disabled || !node.getClientRects().length) return false;
    node.click();
    return true;
  }, selector), `control clickable: ${selector}`);
  await harness.nativeClick('nav [data-view="projects"]');
  const createTeam = `[data-project-team="${projectId}"] [data-go="team"]`;
  // Atomic wait-and-click: the project list re-renders after async loads, so
  // a separate waitFor+click races a redraw that swaps the node out.
  await harness.waitFor(() => harness.run(`(selector => { const node = document.querySelector(selector); if (!node || node.disabled || !node.getClientRects().length) return false; node.click(); return true; })(${JSON.stringify(createTeam)})`), 'create-team entry clickable');
  // P4a workbench: the workbench opens on the tasks view; the empty-team
  // creation form lives on the settings view. Wait for the app's startup probe to
  // settle FIRST — clicking inside a frame that is about to be reloaded lands
  // in the dying document and the fresh one boots back to the tasks view.
  await harness.waitFor(() => inFrame(doc => doc && doc.querySelector('#serviceText') && !doc.querySelector('#serviceText').textContent.includes('正在连接')), 'workbench settled');
  await click('#navSettings');
  await harness.waitFor(() => inFrame((doc, name) => {
    const form = doc?.querySelector('#teamForm');
    const submit = form?.querySelector('button[type="submit"]');
    if (!submit || submit.disabled || !submit.getClientRects().length) return false;
    form.elements.name.value = name;
    submit.click();
    return true;
  }, teamName), 'submit the first-team form');
  await harness.waitFor(() => inFrame(doc => Boolean(doc?.querySelector('#addMember'))), 'member management after team creation');
  const team = await harness.productApi('GET', workflowApi + '/team');
  assert.equal(team.body.team.name, teamName, 'the form creates the named team');

  // Default roster: the module seeds developer + reviewer.
  let members = (await harness.productApi('GET', workflowApi + '/members')).body.members;
  assert.deepEqual(members.map(m => m.role).sort(), ['developer', 'reviewer']);

  // Bind the engine memory group to the reviewer member (the wizard step
  // moved to API-level configuration in the P4a settings surface).
  const reviewer = members.find(m => m.role === 'reviewer');
  const patched = await harness.productApi('PATCH', workflowApi + '/members/' + reviewer.memberId, { requestId: 'bind-memory', memoryGroupIds: [group.id], expectedRevision: reviewer.revision });
  assert.equal(patched.status, 200, JSON.stringify(patched.body).slice(0, 200));
  members = (await harness.productApi('GET', workflowApi + '/members')).body.members;
  assert.deepEqual(members.find(m => m.memberId === reviewer.memberId).memoryGroupIds, [group.id]);

  // Mount the project (API level; the chip/dialog UI flow stays covered
  // by the beta detach section below with the shell's own controls).
  const put = await harness.productApi('PUT', `${workflowApi}/projects/${projectId}/settings`, { requestId: 'mount-alpha', enabled: true });
  assert.equal(put.status, 200);
  const overview = await harness.productApi('GET', workflowApi + '/overview');
  assert.ok(overview.body.projects.some(p => p.projectId === projectId && p.enabled), 'mounted project is enabled in the workflow overview');

  // Third member via the API (the P4a member form interaction is covered
  // by the workflow module's own headless render gate; this E2E keeps the
  // business chain stable).
  const added = await harness.productApi('POST', workflowApi + '/members', { requestId: 'add-third', name: 'C++ Review', role: 'release-docs', instructions: '检查 clang-tidy 收据' });
  assert.equal(added.status, 201);
  const updated = await harness.productApi('GET', workflowApi + '/members');
  assert.equal(updated.body.members.length, 3);
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
    await createTeamViaSettings(harness, alpha, group);

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
    // The mount verdict is asserted on the SERVER state (the chip text is a
    // shell render detail; the business chain is the settings flip).
    await harness.waitFor(async () => (await productApi('GET', betaSettings)).body.settings.enabled === true, 'beta enabled after attach');
    await assertSettings(true);
    await harness.reload();
    await openProjects();
    await harness.nativeClick(`${teamTag} button`);
    await harness.nativeClick('#appDialogActions button.primary');
    await harness.waitFor(async () => (await productApi('GET', betaSettings)).body.settings.enabled === false, 'beta disabled after detach');
    await assertSettings(false);
    console.log('project-team-ui-test PASS (team creation, roster, memory binding, project mount/detach)');
  } finally { await harness.cleanup(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
