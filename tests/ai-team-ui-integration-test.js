'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { createAiTeamUiFixture, cliOptions } = require('./helpers/ai-team-ui-fixture');
const { launchCdpBrowser, waitFor } = require('./helpers/cdp-browser');
const { findChrome } = require('./helpers/find-chrome');

async function main() {
  const options = cliOptions({ test: true, defaultMaintenance: true });
  // Keep Windows known-folder discovery intact for Chrome. The browser's
  // explicit user-data-dir still belongs to this fixture.
  const browserEnv = { ...process.env };
  const fixture = await createAiTeamUiFixture(options);
  let browser;
  try {
    const disallowed = await fetch(fixture.address + '/api/integrations/status');
    assert.equal(disallowed.status, 403, 'the preview never inspects daily client integrations');
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
    const shot = filename => browser.screenshot(path.join(options.dataDir, filename));

    // 等不到的时候把页面当时的样子带出来：是页面坏了还是标记写错了，一眼能分清。
    // On a miss, bring back what the frame showed: a broken page and a wrong marker are told apart at once.
    const settle = async (read, label) => {
      try { return await waitFor(read, label); }
      catch (error) {
        const shown = await workflow('JSON.stringify({ heading: doc.getElementById("heading")?.textContent, settings: doc.getElementById("settings")?.innerHTML.slice(0, 300) })').catch(() => null);
        error.message += '\n--- frame at the miss ---\n' + shown + '\n--- console ---\n' + JSON.stringify(browser.consoleErrors.map(item => item.text).slice(-4));
        throw error;
      }
    };
    await browser.setViewport(1440, 940);
    await page('document.querySelector(\'nav [data-view="team"]\').click()');
    if (options.emptyTeam) {
      assert.equal((await fixture.call('team')).status, 'empty');
      // 标题是页面里写死的，说明不了脚本已经跑起来；等任务列表真的渲染出来再操作
      // The heading is static markup and says nothing about the script; wait for the task list to be really rendered before acting
      await settle(() => has('#taskList', '没有匹配的任务'), 'AI team frame in a newly installed knowledge base');
      await click('#navSettings');
      await settle(() => has('#teamForm', '创建团队'), 'first-team creation form');
      await shot('create-team.png');
      await field('teamForm', 'name', '首次建队验收');
      await click('#teamForm button[type="submit"]');
      await waitFor(() => has('#teamName', '首次建队验收'), 'team saved through Workflow');
      assert.equal((await fixture.call('team')).team.name, '首次建队验收');
      assert.equal(await workflow('Boolean(doc.getElementById("teamForm"))'), false);
      const duplicate = await fetch(fixture.address + '/api/workflow/team', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: 'duplicate-team-check', name: '第二团队' }),
      });
      assert.equal(duplicate.status, 409, 'the current Workflow contract rejects a second default team');
      assert.deepEqual(browser.exceptions, []);
      console.log('ai-team-ui-integration-test PASS (empty team UI, real creation, existing team view, duplicate rejected)');
      return;
    }
    await waitFor(() => has('#taskList', fixture.task.title), 'render a task through the real Workflow proxy');
    assert.equal(await workflow('doc.body.dataset.embed'), '1');
    assert.equal(await has('#teamName', '维护团队'), true);
    await click('#taskList [data-task]');
    await waitFor(() => workflow('doc.querySelectorAll("#detail .subnav [data-tab]").length === 3'), 'task detail and Review tabs');
    await shot('tasks.png');

    await click('#start');
    assert.equal(await workflow('doc.getElementById("promptDialog").open'), true);
    await click('#closeDialog');
    await click('#navSettings');
    await waitFor(() => workflow('Boolean(doc.getElementById("projectForm"))'), 'project editor over core project directory');
    assert.equal(await workflow('doc.querySelector("#projectPicker option").textContent'), '示例代码仓库');
    assert.equal(await workflow('doc.getElementById("projectForm").elements.autoDispatch.checked'), true);
    await shot('settings.png');

    await click('#addMember');
    await waitFor(() => has('#memberForm', '代码规范'), 'memory directory in member editor');
    // 模型是下拉，不再是自由文本：按档案分组，列出每个已启用且凭据已配置的档案下的模型；「不指定」排在最后。
    // The model is a dropdown, no longer free text: every model under the enabled profiles with configured credentials, "none" last.
    assert.equal(await workflow('Boolean(doc.querySelector(\'#memberForm input[name="model"]\'))'), false);
    assert.deepEqual(
      await workflow('[...doc.querySelectorAll(\'#memberForm select[name="model"] option\')].map(option => option.textContent)'),
      ['代码模型（model-code）', '代码模型专业版（model-code-pro）', 'model-code-air', 'model-docs', '不指定'],
    );
    await field('memberForm', 'name', '验证维护成员');
    await field('memberForm', 'instructions', '先检查文档，再记录结果。');
    await field('memberForm', 'model', 'model-docs');
    await workflow('doc.querySelector(\'#memberForm input[value="group-docs"]\').checked = true');
    await shot('member.png');
    await click('#memberForm button[type="submit"]');
    await waitFor(() => has('#memberList', '验证维护成员'), 'new member persisted');
    const member = (await fixture.call('members')).members.find(item => item.name === '验证维护成员');
    assert.deepEqual(member.memoryGroupIds, ['group-docs']);
    assert.equal(member.instructions, '先检查文档，再记录结果。');
    // 外壳核对模型属于所选档案后，把它原样交给模块；不可用的选择被拒绝，已保存的不受影响。
    // The shell verifies the model belongs to the chosen profile and hands it to the module as chosen; an unusable choice is refused and leaves what is stored.
    assert.deepEqual([member.profileId, member.model], ['profile-docs', 'model-docs']);
    assert.equal(await has('#memberList', '文档档案 · model-docs'), true, 'the roster names the chosen model');
    await assert.rejects(fixture.call('members/' + member.memberId, {
      method: 'PATCH', body: { requestId: 'refuse-disabled-profile', profileId: 'profile-disabled' },
    }), /400/);
    assert.equal((await fixture.call('members/' + member.memberId)).member.model, 'model-docs');
    await click('[data-edit-member="' + member.memberId + '"]');
    await field('memberForm', 'instructions', '按项目工具配置更新文档。');
    await click('#memberForm button[type="submit"]');
    await waitFor(() => has('#memberList', '按项目工具配置更新文档。'), 'edited member persisted');
    assert.equal((await fixture.call('members/' + member.memberId)).member.instructions, '按项目工具配置更新文档。');

    const project1 = fixture.projects[0].id;
    const project2 = fixture.projects[1].id;
    await workflow('(() => {const select = doc.getElementById("projectPicker");select.value = ' + JSON.stringify(project2) + ';select.dispatchEvent(new Event("change"));return select.value;})()');
    await waitFor(() => has('#projectForm', '未启用'), 'newly picked project shows persisted settings');
    await workflow('doc.getElementById("projectForm").elements.enabled.checked = true');
    await field('projectForm', 'leaderMemberId', member.memberId);
    await workflow('doc.querySelector(' + JSON.stringify('[name="developerMemberIds"][value="' + member.memberId + '"]') + ').checked = true');
    await click('#projectForm button[type="submit"]');
    await waitFor(() => has('#projectForm', '已启用'), 'project setting saved');
    const settings = (await fixture.call('projects/' + project2 + '/settings')).settings;
    assert.equal(settings.leaderMemberId, member.memberId);
    assert.deepEqual(settings.developerMemberIds, [member.memberId]);
    assert.equal((await fixture.call('projects/' + project1 + '/settings')).settings.substantiveCodeReview, false);

    await fixture.call('projects/' + project2 + '/settings', {
      method: 'PUT', body: { requestId: 'external-settings-edit', expectedRevision: settings.revision, reminders: false },
    });
    await click('#projectForm button[type="submit"]');
    await waitFor(() => has('#projectError', '配置已更新'), 'stale editor does not overwrite newer version');
    await click('#projectError button');
    await waitFor(() => workflow('doc.querySelector("#projectForm button[type=submit]")?.disabled === false'), 'reload updated config');
    assert.equal((await fixture.call('projects/' + project2 + '/settings')).settings.reminders, false);

    await click('#navMaintenance');
    if (fixture.maintenance) {
      await waitFor(() => has('[data-repo-title]', '示例代码仓库'), 'actual registered repository in the knowledge-base frame');
      assert.equal(await has('#heading', '自动维护'), true, 'the tab is named for what it does');
      // 0.2.3 登记文件里的工具列在页面上，可以编辑和删除；仓库可以修改设置。占用、运行这些操作都针对一个仓库。
      // The tools from the 0.2.3 registration file are listed for editing and removal; a repository's settings can be edited.
      // Occupancy and runs each address one repository.
      await waitFor(() => has('.maintenance-tool', '示例代码规则'), 'tools imported from the 0.2.3 file are listed');
      assert.equal(await workflow('doc.querySelectorAll(".maintenance-tool").length'), 6, 'every imported tool is listed');
      assert.equal(await workflow('Boolean(doc.querySelector("[data-maintenance-repo-edit]"))'), true);
      const registeredRepoId = (await fixture.call('maintenance')).repos[0].repoId;
      assert.equal(await workflow('doc.querySelector("[data-maintenance-busy]").dataset.maintenanceBusy'), registeredRepoId,
        'the occupancy button addresses its repository');
      await click('[data-maintenance-new]');
      await waitFor(() => has('#maintenanceDialogTitle', '新建计划'), 'maintenance creation dialog');
      await field('maintenanceForm', 'title', '每日格式整理');
      await field('maintenanceForm', 'memberId', member.memberId);
      await field('maintenanceForm', 'toolId', 'format');
      await field('maintenanceForm', 'trigger', 'daily');
      await workflow('doc.getElementById("maintenanceForm").elements.trigger.dispatchEvent(new Event("change"))');
      assert.equal(await workflow('doc.getElementById("maintenanceTimeField").hidden'), false);
      await field('maintenanceForm', 'at', '09:00');
      await workflow('doc.getElementById("maintenanceForm").elements.enabled.checked = true');
      await shot('maintenance-task-form.png');
      await click('#maintenanceForm button[type="submit"]');
      await waitFor(() => has('.maintenance-job', '验证维护成员'), 'saved member is visible on the scheduled plan');
      assert.equal(await has('.maintenance-job', '每天 09:00'), true);
      assert.equal(await has('.maintenance-job', '示例代码仓库'), true, 'the plan shows the repository it is bound to');
      const job = (await fixture.call('maintenance')).jobs[0];
      assert.equal(job.memberId, member.memberId);
      assert.deepEqual(job.trigger, { kind: 'daily', at: '09:00' });
      assert.equal(job.delivery, 'candidate');
      assert.deepEqual(job.repoIds, [registeredRepoId], 'a plan saved without a choice covers the registered repositories');

      await click('[data-maintenance-busy]');
      await waitFor(() => has('[data-maintenance-busy]', '释放开发占用'), 'developer occupancy is persisted');
      await click('[data-maintenance-run]');
      await waitFor(() => has('.maintenance-run', '已排队'), 'manual run is queued during development');
      await shot('maintenance-queued.png');
      await click('[data-maintenance-busy]');
      await waitFor(() => has('.maintenance-run', '已保留候选提交'), 'registered tool really commits in the isolated worktree');
      await shot('maintenance-light.png');
      await click('[data-maintenance-detail]');
      await waitFor(() => has('#maintenanceRunDetail', '候选提交'), 'record displays real candidate SHA');
      await click('.maintenance-receipt summary');
      assert.equal(await has('.maintenance-receipt pre', 'format completed'), true);
      await shot('maintenance-run-detail.png');
      await click('#maintenanceRunDetail [data-close]');
    } else {
      await waitFor(() => has('#maintenance', '登记仓库'), 'unconfigured maintenance offers registration on the page');
      assert.equal(await has('#maintenance', 'maintenance.json'), false, 'no registry file is shown to the user');
      assert.equal(await workflow('doc.querySelector("[data-maintenance-new]").disabled'), true, 'no plan can be created before a repository is registered');
    }
    await browser.setViewport(390, 840);
    await waitFor(() => workflow('doc.documentElement.scrollWidth <= doc.defaultView.innerWidth'), 'narrow maintenance layout');
    assert.equal(await workflow('doc.querySelector("#navMaintenance").getBoundingClientRect().width > 0'), true);
    await browser.setViewport(1440, 940);
    await click('#navSettings');
    await waitFor(() => has('#memberList', '验证维护成员'), 'team settings return from maintenance');

    await page(`(() => {
      const input = document.querySelector('input[data-token="accent"]');
      input.value = '#3a775a';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await waitFor(() => workflow('doc.documentElement.style.getPropertyValue("--accent") === "#3a775a"'), 'parent live skin applies inside Workflow');
    await page('document.getElementById("themeToggle").click()');
    await waitFor(() => workflow('doc.documentElement.dataset.theme === "dark"'), 'parent dark mode applies inside Workflow');
    await shot('settings-dark.png');

    await browser.setViewport(390, 840);
    assert.ok(await workflow('doc.defaultView.innerWidth >= 360'), 'the knowledge-base sidebar must leave a usable width for the embedded page');
    assert.equal(await workflow('doc.documentElement.scrollWidth <= doc.defaultView.innerWidth'), true);
    await shot('mobile.png');
    if (fixture.maintenance) {
      await click('#navMaintenance');
      await waitFor(() => has('.maintenance-run', '已保留候选提交'), 'actual runs render in dark mobile mode');
      assert.equal(await workflow('doc.documentElement.scrollWidth <= doc.defaultView.innerWidth'), true);
      await shot('maintenance-dark-mobile.png');
    }
    await click('#navTasks');
    assert.equal(await has('#taskList', fixture.task.title), true);

    if (options.designFile) {
      await browser.send('Page.navigate', { url: fixture.address + '/?maintenance-preview=1' });
      await waitFor(() => page('document.readyState === "complete" && Boolean(document.querySelector(\'nav [data-view="team"]\'))'), 'open design fixture');
      await page('document.querySelector(\'nav [data-view="team"]\').click()');
      await waitFor(() => has('#tk-page', '任务调度'), 'maintenance design mounts through the team frame');
      await browser.setViewport(1440, 940);
      await click('[data-action="simulate"]');
      await click('#tk-form button[type="submit"]');
      await waitFor(() => has('.tk-metrics', '1 排队'), 'busy repo queued while other repositories finish', 15000);
      await click('[data-nav="projects"]');
      await click('[data-action="toggle-development"][data-id="project-1"]');
      await waitFor(() => has('.tk-table tbody tr:first-child', '累计使用 6 次'), 'reuses the existing worktree');
      await click('[data-nav="runs"]');
      await waitFor(() => has('.tk-run-detail', '提交并推送完成'), 'resumed simulation finishes');
      await shot('maintenance-design.png');
      await click('[data-action="simulate"]');
      await field('tk-form', 'task', 'review-task');
      await workflow('doc.getElementById("tk-form").elements.task.dispatchEvent(new Event("change"))');
      await click('#tk-form button[type="submit"]');
      await waitFor(() => has('.tk-run-detail', '修复提交已生成'), 'commit Review and repair simulation');
      assert.ok(await has('.tk-run-detail', '复查通过'));
      await click('[data-action="simulate"]');
      await field('tk-form', 'task', 'docs-task');
      await workflow('doc.getElementById("tk-form").elements.task.dispatchEvent(new Event("change"))');
      await click('#tk-form button[type="submit"]');
      await waitFor(() => has('.tk-run-detail', '提交并推送完成'), 'documentation simulation');
      assert.ok(await has('.tk-run-detail', 'update_documents'));
    }
    assert.deepEqual(browser.exceptions, []);
    const maintenanceResult = fixture.maintenance ? 'real maintenance task, run and receipt' : 'unconfigured maintenance';
    console.log('ai-team-ui-integration-test PASS (shell proxy, team, members, project CAS, theme, mobile, ' + maintenanceResult + ')');
  } finally {
    if (browser) await browser.close();
    await fixture.close();
  }
}

main().catch(error => { console.error(error.stack); process.exitCode = 1; });
