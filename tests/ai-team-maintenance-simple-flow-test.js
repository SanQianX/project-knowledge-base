'use strict';

// 知识库托管的自动维护（Workflow 模块处于托管模式）在真实浏览器里的日常路径。
// 新建计划不改任何选项直接保存：得到 Agent 计划、默认提示词、默认「目标分支提交后」，并按模型自动建好负责的成员。
// 换一个模型保存：计划改指向对应成员，原成员不变。
// 旧版本留下的直接工具计划：页面给出「转为 Agent 计划」，一次保存后可运行。
//
// The everyday path of knowledge-base managed maintenance (the Workflow module in managed mode) in a real browser.
// Saving a new plan untouched yields an Agent plan with the default prompt and the default "after a commit" trigger,
// with a member auto-created for the chosen model. Picking another model re-points the plan and leaves the first
// member alone. A direct-tool plan left by an older version offers "convert to Agent plan" and runs after one save.

const assert = require('node:assert/strict');
const path = require('node:path');
const { createAiTeamUiFixture, cliOptions } = require('./helpers/ai-team-ui-fixture');
const { launchCdpBrowser, waitFor } = require('./helpers/cdp-browser');
const { findChrome } = require('./helpers/find-chrome');

async function main() {
  const options = cliOptions({ test: true });
  // 默认提示词以被测的 Workflow 为准 / the default prompt is whatever the Workflow under test defines
  const { DEFAULT_AGENT_PROMPT } = require(path.join(options.workflowRoot, 'src', 'maintenance-config'));
  // Chrome 的已知目录发现依赖原始环境：夹具把 HOME 指向沙箱，所以先保存浏览器环境。
  // Chrome's known-folder discovery needs the original environment: the fixture points HOME at its sandbox, so capture it first.
  const browserEnv = { ...process.env };
  const fixture = await createAiTeamUiFixture({
    ...options, maintenance: false, pageRegistration: true, managed: true, maintenanceTiming: { pollMs: 150 },
  });
  const [first] = fixture.projects;
  let browser;
  try {
    browser = await launchCdpBrowser({
      chrome: findChrome(), profileDir: fixture.browserProfile, url: fixture.address,
      launchAttempts: 1, width: 1440, height: 940, env: browserEnv,
    });
    const page = expression => browser.evaluate(expression);
    const workflow = expression => page(
      '(() => { const doc = document.querySelector("#workflowFrame")?.contentDocument; if (!doc) return null; return (' + expression + '); })()'
    );
    const click = selector => workflow('doc.querySelector(' + JSON.stringify(selector) + ').click()');
    const has = (selector, text) => workflow('doc.querySelector(' + JSON.stringify(selector) + ')?.textContent.includes(' + JSON.stringify(text) + ')');
    const field = (form, name, value) => workflow(
      '(() => { const field = doc.getElementById(' + JSON.stringify(form) + ').elements.namedItem(' + JSON.stringify(name) + '); field.value = ' + JSON.stringify(value) + '; return field.value; })()'
    );
    const list = selector => workflow('[...doc.querySelectorAll(' + JSON.stringify(selector) + ')].map(element => element.textContent.trim())');
    const formState = () => workflow(`(() => { const form = doc.getElementById("maintenanceForm"); return JSON.stringify({
      title: form.elements.title.value, tool: form.elements.toolId.value, model: form.elements.planModel.value,
      modelProfile: form.elements.planModel.selectedOptions[0].dataset.profile, trigger: form.elements.trigger.value,
      promptRequired: form.elements.prompt.required, advancedOpen: form.querySelector(".form-advanced").open, agent: form.elements.memberId.value,
    }); })()`).then(JSON.parse);
    const shot = filename => browser.screenshot(path.join(options.dataDir, filename));
    const status = () => fixture.call('maintenance');
    const members = async () => (await fixture.call('members')).members;
    const planForm = () => workflow('(() => { const form = doc.getElementById("maintenanceForm"); return JSON.stringify({ model: form.elements.planModel.value, trigger: form.elements.trigger.value, title: form.elements.title.value }); })()').then(JSON.parse);

    // 登记仓库和只检查工具的表单由 ai-team-page-registration-test 覆盖，这里直接经外壳登记。
    // The repository and tool forms are covered by ai-team-page-registration-test; here they are registered through the shell.
    const { repo } = await fixture.call('maintenance/repos', { method: 'POST', body: {
      requestId: 'simple-repo', projectId: first.id, branch: '', remote: '', allowPush: false,
    } });
    const { tool } = await fixture.call('maintenance/tools', { method: 'POST', body: {
      requestId: 'simple-tool', tool: { name: '接口文档检查', kind: 'review', check: fixture.registration.argv('check') },
    } });

    await browser.setViewport(1440, 940);
    await page('document.querySelector(\'nav [data-view="team"]\').click()');
    await waitFor(() => has('#heading', '团队任务'), 'AI team frame');
    await click('#navMaintenance');
    await waitFor(() => workflow('!doc.querySelector("[data-maintenance-new]").disabled'), 'plan creation is enabled');

    // ① 新建计划：常用的四项已经填好，其余收在「高级」里。
    // ① A new plan: the four everyday choices are prefilled and the rest sits under "advanced".
    await click('[data-maintenance-new]');
    await waitFor(() => has('#maintenanceDialogTitle', '新建计划'), 'plan dialog');
    assert.deepEqual(await formState(), {
      title: '接口文档检查', tool: tool.id, model: 'model-code', modelProfile: 'profile-code',
      trigger: 'commit', promptRequired: false, advancedOpen: false, agent: '',
    }, 'name, the only tool, a model and "after a commit" are prefilled; the prompt is optional and the rest is tucked away');
    assert.deepEqual(await list('#maintenanceForm select[name="planModel"] option'), ['代码模型（model-code）', '代码模型专业版（model-code-pro）', 'model-code-air', 'model-docs'],
      'every usable model is offered, and nothing else');
    assert.equal(await workflow('doc.querySelector("#maintenanceForm select[name=executionMode]") === null'), true);
    assert.equal(await workflow('doc.querySelector("#maintenanceForm .form-advanced").querySelector("textarea[name=prompt]").required'), false);
    await shot('simple-flow-new-plan.png');
    await click('#maintenanceForm button[type="submit"]');
    await waitFor(() => workflow('!doc.querySelector("#maintenanceDialog").open'), 'the plan dialog closes');

    const created = (await status()).jobs[0];
    assert.deepEqual([created.executionMode, created.prompt, created.trigger, created.enabled, created.agentAvailable, created.requiresAgentSetup],
      ['agent', DEFAULT_AGENT_PROMPT, { kind: 'commit' }, true, true, undefined], JSON.stringify(created));
    const agent = (await members()).find(item => item.memberId === created.memberId);
    assert.deepEqual([agent.name, agent.role, agent.profileId, agent.model], ['自动维护 · 代码模型（model-code）', 'reviewer', 'profile-code', 'model-code'],
      'the model is stored on a member created for it');
    await waitFor(() => workflow('[...doc.querySelectorAll(".maintenance-job .badge")].some(badge => badge.textContent === "已启用")'), 'the plan is ready on the page');
    assert.equal(repo.repoId, created.repoIds[0]);

    // ② 换一个模型：计划改指向对应成员，原来的成员保持不变。
    // ② Another model: the plan is re-pointed and the first member is left as it was.
    await click('[data-maintenance-edit]');
    await waitFor(() => has('#maintenanceDialogTitle', '编辑维护计划'), 'plan dialog');
    assert.deepEqual(await planForm(), { model: 'model-code', trigger: 'commit', title: '接口文档检查' }, 'the editor opens on what the plan has');
    await field('maintenanceForm', 'planModel', 'model-docs');
    await click('#maintenanceForm button[type="submit"]');
    await waitFor(async () => (await status()).jobs[0].memberId !== created.memberId, 'the plan to follow the new model');
    const rePointed = (await status()).jobs[0];
    const after = await members();
    const second = after.find(item => item.memberId === rePointed.memberId);
    assert.deepEqual([second.name, second.profileId, second.model], ['自动维护 · model-docs', 'profile-docs', 'model-docs']);
    assert.deepEqual([after.find(item => item.memberId === created.memberId).model, after.length], ['model-code', 4], 'one member per model; the seeded two are untouched');

    // ③ 成员弹窗：模型不再写「可选」，新成员默认选第一个可用的模型，其余收在「高级」里。
    // ③ The member dialog: the model is no longer "optional", a new member starts on the first usable model, the rest is under "advanced".
    await click('#navSettings');
    await waitFor(() => workflow('Boolean(doc.getElementById("addMember"))'), 'team settings');
    await click('#addMember');
    await waitFor(() => has('#memberForm', '代码规范'), 'member editor');
    assert.equal(await has('#memberForm', '模型（可选）'), false);
    assert.equal(await workflow('doc.querySelector(\'#memberForm select[name="model"]\').value'), 'model-code');
    assert.equal(await workflow('doc.querySelector("#memberForm .form-advanced").open'), false, 'role, instructions, memory groups and the enabled switch start collapsed');
    await shot('simple-flow-member.png');
    await workflow('doc.getElementById("memberDialog").close()');

    // ④ 旧版本留下的直接工具计划：先在非托管模式下建好，再切回托管模式。
    // ④ A direct-tool plan left by an older version: create it unmanaged, then return to managed mode.
    const legacyMember = (await members()).find(item => item.name === '维护 Agent');
    await fixture.restartWorkflow({ managed: false });
    const { job: legacy } = await fixture.call('maintenance/jobs', { method: 'POST', body: {
      requestId: 'legacy-plan', title: '提交后文档检查', memberId: legacyMember.memberId, toolId: tool.id,
      trigger: { kind: 'commit' }, enabled: true, delivery: 'candidate',
    } });
    await fixture.restartWorkflow({ managed: true });
    await click('#navMaintenance');
    await waitFor(() => workflow('[...doc.querySelectorAll(".maintenance-job")].some(row => row.textContent.includes("待转为 Agent"))'), 'the old plan is parked with a way forward');
    assert.equal(await workflow('doc.querySelector("[data-maintenance-fix]").dataset.maintenanceFix'), legacy.jobId,
      'the action button belongs to the old plan');
    assert.equal(await workflow('doc.querySelector(\'[data-maintenance-run="' + legacy.jobId + '"]\').disabled'), true,
      'the old plan cannot run before the conversion');
    await shot('simple-flow-legacy-plan.png');
    await click('[data-maintenance-fix]');
    await waitFor(() => has('#maintenanceDialogTitle', '转为 Agent 计划'), 'the conversion dialog');
    assert.deepEqual(await planForm(), { model: 'model-docs', trigger: 'commit', title: '提交后文档检查' },
      'the conversion keeps the plan\'s own trigger and offers the model the latest plan used');
    await click('#maintenanceForm button[type="submit"]');
    await waitFor(async () => (await status()).jobs.find(item => item.jobId === legacy.jobId)?.executionMode === 'agent', 'the plan converted');
    const converted = (await status()).jobs.find(item => item.jobId === legacy.jobId);
    assert.deepEqual([converted.executionMode, converted.prompt, converted.trigger, converted.enabled, converted.agentAvailable, converted.requiresAgentSetup, converted.memberId],
      ['agent', DEFAULT_AGENT_PROMPT, { kind: 'commit' }, true, true, undefined, second.memberId], JSON.stringify(converted));
    await waitFor(() => workflow('!doc.querySelector(\'[data-maintenance-run="' + legacy.jobId + '"]\').disabled'),
      'the converted plan can run');
    await shot('simple-flow-converted.png');
    console.log('ai-team-maintenance-simple-flow-test PASS (managed: prefilled plan with a model, model re-pointing, member dialog, one-click conversion of an old plan)');
  } finally {
    if (browser) await browser.close();
    await fixture.close();
  }
}

main().catch(error => { console.error(error.stack); process.exitCode = 1; });
