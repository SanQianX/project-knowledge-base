'use strict';

// 全新安装的知识库里没有维护登记。整个设置过程在浏览器里完成：
// 「自动维护」页登记仓库（路径由知识库解析）→ 登记工具 → 新建维护计划 → 运行一次，
// 运行详情里是真实工具的输出。再把第二个仓库登记进来，一份计划绑定两个仓库，各运行一次，
// 每次运行拿到的都是它自己仓库的路径。外壳在接口层的拒绝规则一并断言。
//
// A freshly installed knowledge base has no maintenance registration. The whole setup is done in the browser on
// the 自动维护 page: register a repository (the shell resolves its path), register a tool, create a plan, run it
// once and read the real tool output. A second repository is then registered, one plan is bound to both and runs
// once in each, every run receiving its own repository's path. The shell's refusals at the API level are asserted alongside.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createAiTeamUiFixture, cliOptions } = require('./helpers/ai-team-ui-fixture');
const { launchCdpBrowser, waitFor } = require('./helpers/cdp-browser');
const { findChrome } = require('./helpers/find-chrome');

async function until(read, predicate, label) {
  const deadline = Date.now() + 30_000;
  let value;
  while (Date.now() < deadline) {
    value = await read();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 125));
  }
  throw new Error('Timed out waiting for ' + label + '\n' + JSON.stringify(value));
}

async function main() {
  const options = cliOptions({ test: true });
  // Keep Windows known-folder discovery intact for Chrome: the fixture points HOME at its
  // sandbox, so the browser's environment is captured before it is created. The browser's
  // explicit user-data-dir still belongs to this fixture.
  const browserEnv = { ...process.env };
  const fixture = await createAiTeamUiFixture({ ...options, maintenance: false, pageRegistration: true, maintenanceTiming: { pollMs: 150 } });
  const [first, second, plain] = fixture.projects;
  // 第二个项目挂载了团队但还没登记：计划里可以直接勾选它，保存时自动登记。
  // The second project has the team mounted but is not registered yet: a plan may pick it and registers it on save.
  await fixture.call('projects/' + second.id + '/settings', { method: 'PUT', body: { requestId: 'mount-second', expectedRevision: 0, enabled: true } });
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
    const exists = selector => workflow('Boolean(doc.querySelector(' + JSON.stringify(selector) + '))');
    const list = selector => workflow('[...doc.querySelectorAll(' + JSON.stringify(selector) + ')].map(element => element.textContent.trim())');
    const checks = selector => workflow('[...doc.querySelectorAll(' + JSON.stringify(selector) + ')].map(input => [input.value, input.checked])');
    const optionsOf = selector => workflow('[...doc.querySelectorAll(' + JSON.stringify(selector + ' option') + ')].map(option => option.textContent)');
    const field = (form, name, value) => workflow(
      '(() => { const field = doc.getElementById(' + JSON.stringify(form) + ').elements.namedItem(' + JSON.stringify(name) + '); field.value = ' + JSON.stringify(value) + '; return field.value; })()'
    );
    // 像真实点击一样带上 change 事件：表单靠它更新提示 / fires change like a real click: the form updates its hints from it
    const check = (form, name, value, on) => workflow(
      '(() => { const input = [...doc.getElementById(' + JSON.stringify(form) + ').elements.namedItem(' + JSON.stringify(name) + ')].find(item => item.value === ' + JSON.stringify(value) + '); input.checked = ' + Boolean(on) + '; input.dispatchEvent(new Event("change", { bubbles: true })); return input.checked; })()'
    );
    const change = (form, name) => workflow('doc.getElementById(' + JSON.stringify(form) + ').elements.namedItem(' + JSON.stringify(name) + ').dispatchEvent(new Event("change"))');
    const shot = filename => browser.screenshot(path.join(options.dataDir, filename));
    const status = () => fixture.call('maintenance');
    const post = (route, body) => fixture.call('maintenance/' + route, { method: 'POST', body });
    const detail = runId => fixture.call('maintenance/runs/' + runId).then(value => value.run);
    const stored = () => JSON.parse(fs.readFileSync(path.join(fixture.workflowData, 'workflow', 'state.json'), 'utf8'));
    const terminal = run => run && !['queued', 'running'].includes(run.status);
    const firstPath = fs.realpathSync(fixture.registration.repo);
    const secondPath = fs.realpathSync(fixture.registration.secondRepo);

    await browser.setViewport(1440, 940);
    await page('document.querySelector(\'nav [data-view="team"]\').click()');
    await waitFor(() => has('#heading', '团队任务'), 'AI team frame in a newly installed knowledge base');

    // 未登记：页面上是登记表单，不再是文件路径。项目可以多选，列表来自知识库。
    // Unregistered: the page offers the registration form, not a file path. Several projects may be chosen; the list comes from the knowledge base.
    await click('#navMaintenance');
    await waitFor(() => exists('#maintenanceRepoForm'), 'registration form');
    const sharedBranchField = await exists('#maintenanceRepoForm input[name="branch"]');
    assert.equal(await has('#heading', '自动维护'), true);
    assert.equal(await has('#maintenance', 'maintenance.json'), false, 'the registry file is no longer something the user edits');
    assert.equal(await workflow('doc.querySelector("[data-maintenance-new]").disabled'), true, 'no plan can be created before registration');
    assert.equal(await workflow('doc.querySelector("[data-maintenance-tool-new]").disabled'), false, 'tools belong to the knowledge base and can be registered before any repository');
    assert.deepEqual(await list('#maintenanceRepoForm input[name=projects] + span'), [first.name, second.name, plain.name], 'the project list comes from the knowledge base');
    await shot('page-registration-empty.png');

    // ① 登记仓库：一个都不选会被拦住；页面只传项目，路径由知识库解析后交给模块。
    // ① Register the repository: choosing none is refused; the page sends only the project and the shell resolves the path for the module.
    await workflow('[...doc.querySelectorAll("#maintenanceRepoForm input[name=projects]")].forEach(input => { input.checked = false; })');
    await click('#maintenanceRepoForm button[type="submit"]');
    await waitFor(() => has('#maintenanceRepoForm [data-repo-error]', '请至少选择一个项目'), 'an empty selection is refused on the page');
    await check('maintenanceRepoForm', 'projects', first.id, true);
    await click('#maintenanceRepoForm button[type="submit"]');
    await waitFor(() => has('[data-repo-title]', first.name), 'repository registered from the page');
    const registered = await status();
    assert.equal(registered.configured, true);
    assert.equal(registered.repos.length, 1);
    const firstRepo = registered.repos[0];
    assert.equal(firstRepo.projectId, first.id);
    assert.equal(firstRepo.branch, 'main', 'a blank branch means the repository current branch');
    if (firstRepo.followCurrentBranch) {
      assert.equal(sharedBranchField, false, 'bulk registration needs no common branch');
      assert.equal(await has('[aria-labelledby="maintenanceReposTitle"]', '跟随当前分支'), true);
    }
    assert.equal(firstRepo.repoPath, firstPath, 'the path is the one the shell resolved for the project');
    assert.deepEqual(registered.tools, []);
    const afterRegistration = stored();
    assert.deepEqual(Object.keys(afterRegistration.maintenanceRepos), [firstRepo.repoId], 'the repository is stored under its own id');
    for (const key of ['maintenanceRegistry', 'maintenance']) assert.equal(key in afterRegistration, false, `${key} is a retired key`);
    assert.equal((afterRegistration.changes || []).some(item => item.kind === 'maintenance.registry-imported'), false, 'nothing was imported: the page is the source');
    assert.equal(await exists('#maintenanceRepoForm'), false, 'the inline form gives way to the repository list');
    assert.equal(await exists('[data-maintenance-repo-edit="' + firstRepo.repoId + '"]'), true, 'the registered repository can be edited');

    // ② 登记工具：相对路径被拒并说明原因，然后登记成功。
    // ② Register a tool: a relative path is refused with the reason, then the registration succeeds.
    await click('[data-maintenance-tool-new]');
    await waitFor(() => exists('#maintenanceToolForm'), 'tool dialog');
    await field('maintenanceToolForm', 'name', '示例格式整理器');
    await field('maintenanceToolForm', 'kind', 'apply');
    await change('maintenanceToolForm', 'kind');
    assert.equal(await workflow('doc.querySelector("[data-repair-fields]").hidden'), true, 'the repair command belongs to check-only tools');
    await field('maintenanceToolForm', 'program', 'tool.js');
    await field('maintenanceToolForm', 'args', fixture.registration.tool + '\nformat');
    await click('#maintenanceToolForm button[type="submit"]');
    await waitFor(() => has('#maintenanceToolError', '绝对路径'), 'a relative program path is refused with the reason');
    await shot('page-registration-tool-error.png');
    await field('maintenanceToolForm', 'program', process.execPath);
    await click('#maintenanceToolForm button[type="submit"]');
    await waitFor(() => has('.maintenance-tool', '示例格式整理器'), 'tool registered from the page');
    const [tool] = (await fixture.call('maintenance/tools')).tools;
    assert.equal(tool.kind, 'apply');
    assert.deepEqual(tool.phases.apply, fixture.registration.argv('format'), 'program and one-argument-per-line become the argument array');

    // 成员的模型是下拉：按档案分组，列出每个模型；外壳核对后把选中的模型原样交给模块。
    // A member's model is a dropdown: every model grouped under its profile; the shell verifies it and hands exactly that model to the module.
    await click('#navSettings');
    await waitFor(() => exists('#addMember'), 'team settings');
    await click('#addMember');
    await waitFor(() => has('#memberForm', '代码规范'), 'member editor');
    assert.equal(await workflow('Boolean(doc.querySelector(\'#memberForm input[name="model"]\'))'), false, 'the model is not a free-text field');
    assert.deepEqual(await optionsOf('#memberForm select[name="model"]'), ['不指定', '代码模型（model-code）', '代码模型专业版（model-code-pro）', 'model-code-air', 'model-docs'],
      'every model of every usable profile is offered, and nothing else');
    assert.deepEqual(await workflow('[...doc.querySelectorAll(\'#memberForm select[name="model"] optgroup\')].map(group => group.label)'), ['代码档案', '文档档案']);
    assert.equal(await has('#memberForm', '直接运行工具可以留空。由 Review Agent 执行的维护计划需要选模型。'), true);
    await field('memberForm', 'name', '页面登记成员');
    await field('memberForm', 'instructions', '按维护计划检查仓库。');
    await field('memberForm', 'model', 'model-code-pro');
    await click('#memberForm button[type="submit"]');
    await waitFor(() => has('#memberList', '页面登记成员'), 'member saved through the shell');
    const member = (await fixture.call('members')).members.find(item => item.name === '页面登记成员');
    assert.deepEqual([member.profileId, member.model], ['profile-code', 'model-code-pro'], 'the chosen model is stored, not the profile default');
    assert.equal(await has('#memberList', '代码档案 · 代码模型专业版（model-code-pro）'), true, 'the roster shows the chosen model');
    // 页面说了不算：不可用的档案、不在这个档案里的模型，都被外壳拒绝，已保存的不受影响。
    // The profile decides, never the page: an unusable profile or a model outside it is refused by the shell, and what is stored stays.
    for (const choice of [{ profileId: 'profile-disabled' }, { profileId: 'profile-no-key' }, { profileId: 'profile-unknown' },
      { profileId: 'profile-code', model: 'not-in-the-list' }, { profileId: 'profile-code', model: 'model-docs' }]) {
      await assert.rejects(fixture.call('members/' + member.memberId, { method: 'PATCH', body: { requestId: 'refuse-' + Object.values(choice).join('-'), ...choice } }),
        /400/, JSON.stringify(choice) + ' must be refused');
    }
    assert.equal((await fixture.call('members/' + member.memberId)).member.model, 'model-code-pro', 'refusals leave the stored model untouched');
    // 只给档案、不指定模型：用档案的默认模型 / a profile without a model choice means its default
    await fixture.call('members/' + member.memberId, { method: 'PATCH', body: { requestId: 'profile-only', profileId: 'profile-docs' } });
    assert.deepEqual((({ profileId, model }) => [profileId, model])((await fixture.call('members/' + member.memberId)).member), ['profile-docs', 'model-docs']);

    // ③ 新建维护计划，运行一次：详情里是页面上登记的工具的真实输出。
    // 目标仓库是复选框：已登记的仓库默认勾选；挂载了团队但还没登记的项目也在列表里，保存时才登记。
    // ③ Create a plan and run it once: the detail shows the real output of the tool registered from the page.
    // Targets are checkboxes: registered repositories are checked; a mounted but unregistered project is listed too and only registered on save.
    await click('#navMaintenance');
    await waitFor(() => workflow('!doc.querySelector("[data-maintenance-new]").disabled'), 'plan creation is enabled once a tool exists');
    await click('[data-maintenance-new]');
    await waitFor(() => has('#maintenanceDialogTitle', '新建计划'), 'plan dialog');
    assert.deepEqual(await checks('#maintenanceForm input[name=targets]'), [[firstRepo.repoId, true], ['project:' + second.id, false]],
      'registered repositories are checked, the mounted project is offered for registration on save');
    await field('maintenanceForm', 'title', '手动格式整理');
    await field('maintenanceForm', 'memberId', member.memberId);
    for (const mode of ['agent', 'tool']) {
      await field('maintenanceForm', 'executionMode', mode);
      await workflow('doc.getElementById("maintenanceForm").elements.executionMode.dispatchEvent(new Event("change", { bubbles: true }))');
      assert.equal(await workflow('doc.querySelector("[data-agent-options]").hidden'), mode === 'tool');
      if (mode === 'agent') {
        assert.equal(await has('[data-agent-model]', '本次使用成员的模型'), true);
        assert.equal(await workflow('doc.getElementById("maintenanceForm").elements.delivery.options[1].disabled'), true);
      }
    }
    await field('maintenanceForm', 'toolId', tool.id);
    await workflow('doc.getElementById("maintenanceForm").elements.enabled.checked = true');
    await click('#maintenanceForm button[type="submit"]');
    await waitFor(() => has('.maintenance-job', '手动格式整理'), 'plan saved');
    const single = (await status()).jobs[0];
    assert.equal(single.memberId, member.memberId);
    assert.deepEqual(single.repoIds, [firstRepo.repoId], 'a plan on the registered repository only');
    await click('[data-maintenance-run]');
    await waitFor(() => has('.maintenance-run', '已保留候选提交'), 'the tool registered from the page really ran');
    const listed = await until(async () => (await status()).runs[0], terminal, 'the run to finish');
    const finished = await detail(listed.runId);
    assert.equal(finished.status, 'succeeded', JSON.stringify(finished));
    assert.equal(finished.repoId, firstRepo.repoId);
    assert.deepEqual([finished.receipts[0].phase, finished.receipts[0].exitCode, finished.receipts[0].stdout.text.trim()], ['apply', 0, 'format completed']);
    await click('[data-maintenance-detail]');
    await waitFor(() => has('#maintenanceRunDetail', 'format completed'), 'run detail shows the real tool output');
    assert.equal(await has('#maintenanceRunDetail', first.name), true, 'the detail names the repository the run belonged to');
    if (firstRepo.followCurrentBranch) {
      assert.equal(finished.branch, 'main');
      assert.equal(await has('#maintenanceRunDetail', '本次分支'), true);
    }
    await shot('page-registration-run.png');
    await click('#maintenanceRunDetail [data-close]');

    if (firstRepo.workspaceTarget) {
      const knowledge = path.join(path.resolve(options.dataDir), 'knowledge', first.id);
      const worktree = path.join(knowledge, '.ai-team', 'worktrees', firstRepo.repoId);
      assert.equal((await status()).repos[0].workspace, worktree);
      assert.equal(fs.existsSync(path.join(worktree, '.git')), true);
      await click('[data-maintenance-repo-edit="' + firstRepo.repoId + '"]');
      await field('maintenanceRepoEditForm', 'remote', 'missing-local-remote');
      await click('#maintenanceRepoEditForm button[type="submit"]');
      await waitFor(() => has('[aria-labelledby="maintenanceReposTitle"]', 'missing-local-remote'), 'the synthetic remote to be saved');
      await click('[data-maintenance-run]');
      const failed = await until(async () => (await status()).runs.find(run => run.runId !== finished.runId), terminal, 'the fetch failure');
      assert.equal(failed.reason, 'git-fetch-failed');
      await waitFor(() => exists('[data-maintenance-detail="' + failed.runId + '"]'), 'the failed run in the history');
      await click('[data-maintenance-detail="' + failed.runId + '"]');
      await waitFor(() => has('#maintenanceRunDetail', '读取基线提交'), 'the failed stage in run details');
      assert.equal(await has('#maintenanceRunDetail', 'git fetch'), true);
      assert.equal(await has('#maintenanceRunDetail', 'Git 仓库或远端地址不可用'), true);
      assert.equal(await has('#maintenanceRunDetail', '尚未开始'), true);
      await click('#maintenanceRunDetail [data-close]');
      await click('[data-maintenance-repo-edit="' + firstRepo.repoId + '"]');
      await field('maintenanceRepoEditForm', 'remote', '');
      await click('#maintenanceRepoEditForm button[type="submit"]');
      await waitFor(async () => !(await exists('#maintenanceRepoDialog[open]')) && (await status()).repos[0].remote === null, 'the local baseline setting to be restored');
    }

    // 删除先确认，再执行。
    // Removal asks for confirmation first.
    await workflow('doc.defaultView.confirm = () => true');
    await click('[data-maintenance-delete]');
    await waitFor(() => workflow('!doc.querySelector(".maintenance-job")'), 'plan removed from the page');
    assert.deepEqual((await status()).jobs, []);
    await click('[data-maintenance-tool-delete]');
    await waitFor(() => workflow('!doc.querySelector(".maintenance-tool")'), 'tool removed from the page');
    assert.deepEqual((await fixture.call('maintenance/tools')).tools, []);

    // ④ 第二个仓库：工具参数里的占位符在运行时换成各自仓库的路径，所以一个工具能用于多个仓库。
    // ④ A second repository: placeholders in a tool's arguments become each repository's own path, so one tool serves many repositories.
    await click('[data-maintenance-tool-new]');
    await waitFor(() => exists('#maintenanceToolForm'), 'tool dialog');
    await field('maintenanceToolForm', 'name', '仓库定位器');
    await field('maintenanceToolForm', 'kind', 'apply');
    await change('maintenanceToolForm', 'kind');
    await field('maintenanceToolForm', 'program', process.execPath);
    await field('maintenanceToolForm', 'args', [fixture.registration.tool, 'where', '{repo}', '{workspace}', '{branch}'].join('\n'));
    await click('#maintenanceToolForm button[type="submit"]');
    await waitFor(() => has('.maintenance-tool', '仓库定位器'), 'tool registered from the page');
    const [locator] = (await fixture.call('maintenance/tools')).tools;
    assert.deepEqual(locator.phases.apply, fixture.registration.argv('where').concat(['{repo}', '{workspace}', '{branch}']), 'placeholders are stored as written');

    // 一份计划绑定两个仓库：已登记的那个，和挂载了团队、保存时才登记的那个。
    // One plan for two repositories: the registered one and the mounted one that is only registered on save.
    await click('[data-maintenance-new]');
    await waitFor(() => has('#maintenanceDialogTitle', '新建计划'), 'plan dialog');
    assert.equal(await workflow('doc.getElementById("maintenanceForm").elements.delivery.options[1].disabled'), true, 'pushing needs every target to allow it');
    await field('maintenanceForm', 'title', '两个仓库各定位一次');
    await field('maintenanceForm', 'memberId', member.memberId);
    await field('maintenanceForm', 'toolId', locator.id);
    await check('maintenanceForm', 'targets', firstRepo.repoId, true);
    await check('maintenanceForm', 'targets', 'project:' + second.id, true);
    assert.equal(await workflow('doc.getElementById("maintenanceDeliveryHint").textContent'),
      '「推送」需要每个目标仓库都开启「允许自动推送」。这些还没开：示例代码仓库、示例文档仓库', 'the form names the repositories that do not allow pushing');
    await workflow('doc.getElementById("maintenanceForm").elements.enabled.checked = true');
    await click('#maintenanceForm button[type="submit"]');
    await waitFor(() => has('.maintenance-job', '两个仓库各定位一次'), 'plan saved');
    await waitFor(() => workflow('doc.querySelectorAll("[data-repo-title]").length === 2'), 'the second repository registered on save');
    assert.deepEqual(await list('[data-repo-title]'), [first.name, second.name], 'both repositories are listed, named by their project');
    const bound = await status();
    assert.equal(bound.repos.length, 2);
    const secondRepo = bound.repos.find(item => item.projectId === second.id);
    assert.deepEqual([secondRepo.repoPath, secondRepo.branch, secondRepo.allowPush], [secondPath, 'main', false], 'a project registered on save uses its current branch and never pushes');
    assert.deepEqual(bound.jobs[0].repoIds, [firstRepo.repoId, secondRepo.repoId]);
    assert.deepEqual(stored().maintenanceJobs[bound.jobs[0].jobId].repoIds, [firstRepo.repoId, secondRepo.repoId], 'the plan stores both repositories');
    const planRow = await workflow('doc.querySelector(".maintenance-job").textContent');
    assert.ok(planRow.includes('目标仓库') && planRow.includes(first.name) && planRow.includes(second.name), 'the plan shows its target repositories');
    assert.equal(await exists('[data-maintenance-repo-delete="' + secondRepo.repoId + '"]'), true, 'the repository registered on save is listed like any other');
    await shot('page-registration-two-repos.png');
    // 目标不止一个时，不指定仓库的请求被拒绝，而不是随便挑一个。
    // With several targets a request naming no repository is refused instead of picking one.
    const planId = bound.jobs[0].jobId;
    await assert.rejects(post('runs', { requestId: 'run-ambiguous', jobId: planId }), /400/, 'a run must name its repository');
    await assert.rejects(post('control', { requestId: 'control-ambiguous', busy: true }), /400/, 'occupancy must name its repository');

    // 「运行一次」：两个仓库各排一次、各跑一次，工具每次拿到的都是它自己仓库的路径。
    // "Run once": one queued run in each repository, the tool receiving that repository's own path every time.
    await click('[data-maintenance-run]');
    const both = await until(async () => (await status()).runs.filter(run => run.jobId === planId), runs => runs.length === 2 && runs.every(terminal), 'a run in each repository');
    assert.deepEqual(both.map(run => run.repoId).sort(), [firstRepo.repoId, secondRepo.repoId].sort(), 'one run per target repository');
    const expected = { [firstRepo.repoId]: [first.id, firstPath], [secondRepo.repoId]: [second.id, secondPath] };
    for (const run of both) {
      const full = await detail(run.runId);
      const [projectId, repoPath] = expected[full.repoId];
      assert.equal(full.status, 'succeeded', JSON.stringify(full));
      assert.equal(full.delivery, 'no-changes', 'the locator only reads');
      assert.equal(full.projectId, projectId);
      const seen = JSON.parse(full.receipts[0].stdout.text);
      assert.equal(seen.repo, repoPath, 'the {repo} placeholder became this run\'s own repository');
      assert.equal(seen.branch, 'main', 'the {branch} placeholder became the target branch');
    }
    assert.deepEqual((await list('.maintenance-run strong')).slice(0, 2).sort(),
      [first.name + ' · 两个仓库各定位一次', second.name + ' · 两个仓库各定位一次'].sort(), 'each run is listed under its own repository');
    await shot('page-registration-two-runs.png');
    const secondRun = both.find(run => run.repoId === secondRepo.repoId);
    await click('[data-maintenance-detail="' + secondRun.runId + '"]');
    await waitFor(() => has('#maintenanceRunDetail', '两个仓库各定位一次'), 'run detail opens for the second repository');
    assert.equal(await has('#maintenanceRunDetail', second.name), true, 'the detail names the repository the run belonged to');
    // 工具输出是一行 JSON，里面的反斜杠是 JSON 的写法 / the tool's output is one JSON line, so its backslashes are JSON-escaped
    assert.equal(await has('#maintenanceRunDetail', JSON.stringify(secondPath).slice(1, -1)), true, 'the detail carries the real output of this repository\'s run');
    await click('#maintenanceRunDetail [data-close]');

    // 仍有计划使用的仓库删不掉：提示里列出是哪一份计划。计划删掉以后才能删，运行记录归档不丢。
    // A repository still used by a plan is not deleted and the plan is named. Once the plan is gone it can be deleted; its records are archived, never dropped.
    await click('[data-maintenance-repo-delete="' + secondRepo.repoId + '"]');
    await waitFor(() => has('#toast', '两个仓库各定位一次'), 'the refusal names the plan that still uses the repository');
    assert.equal(await exists('[data-repo-title="' + secondRepo.repoId + '"]'), true, 'the repository stays');
    await assert.rejects(post('repos/delete', { requestId: 'repo-in-use', repoId: secondRepo.repoId }),
      error => /409/.test(error.message) && error.message.includes('两个仓库各定位一次'), 'the API refuses the same way');
    await click('[data-maintenance-delete]');
    await waitFor(() => workflow('!doc.querySelector(".maintenance-job")'), 'plan removed from the page');
    assert.equal(await workflow('doc.querySelectorAll(".maintenance-run").length >= 3'), true, 'runs of both repositories are listed before the removal');
    await click('[data-maintenance-repo-delete="' + secondRepo.repoId + '"]');
    await waitFor(() => workflow('!doc.querySelector("[data-repo-title=\'' + secondRepo.repoId + '\']")'), 'repository removed from the page');
    const afterDelete = await status();
    assert.equal(afterDelete.repos.length, 1);
    assert.equal(afterDelete.repos[0].repoId, firstRepo.repoId);
    assert.equal(stored().maintenanceArchive[secondRepo.repoId].projectId, second.id, 'the removed repository\'s records are archived');
    assert.equal(stored().maintenanceArchive[secondRepo.repoId].runs.length, 1, 'its run is kept with it');
    // 归档的运行记录页面不再显示，这是确认框里说明过的行为
    // archived runs are no longer listed: the confirmation said so
    assert.equal(afterDelete.runs.some(run => run.repoId === secondRepo.repoId), false, 'the removed repository\'s runs are no longer listed');
    assert.equal((await list('.maintenance-run strong')).some(text => text.includes(second.name)), false, 'the page lists only what is still registered');
    assert.equal((await fixture.call('maintenance/tools')).tools.length, 1, 'tools belong to the knowledge base, not to a repository');

    // 外壳在接口层的规则：路径和令牌只来自外壳，没有 Git 仓库的项目登记不了。
    // The shell's rules at the API level: the path and the token come only from the shell, and a project without a Git repository cannot register.
    await assert.rejects(post('repos', { requestId: 'unknown-project', projectId: 'project-not-registered', repoPath: 'C:\\Windows' }),
      /404/, 'an unknown project is refused before the module is asked');
    await assert.rejects(post('repos', { requestId: 'not-a-repository', projectId: plain.id, branch: '', remote: '', allowPush: false }),
      error => /400/.test(error.message) && /Git 仓库/.test(error.message), 'a project directory that is not a Git root is refused');
    await post('repos', { requestId: 're-register', projectId: first.id, repoPath: 'C:\\Windows', branch: 'main', remote: '', allowPush: false });
    assert.equal((await status()).repos[0].repoPath, firstPath, 'a path supplied by the caller is ignored');
    if (firstRepo.followCurrentBranch) {
      // A previous fixed setting can be changed to follow the checkout by clearing its field.
      await waitFor(() => has('.repo-row .repo-main > p', 'main'), 'the fixed branch in the repository row');
      await click('[data-maintenance-repo-edit="' + firstRepo.repoId + '"]');
      await field('maintenanceRepoEditForm', 'branch', '');
      await click('#maintenanceRepoEditForm button[type="submit"]');
      await waitFor(async () => !(await exists('#maintenanceRepoDialog[open]')) && (await status()).repos[0].followCurrentBranch,
        'the existing repository to follow its current branch');
    }
    await assert.rejects(post('repos/update', { requestId: 'update-without-repository', branch: 'main', remote: '', allowPush: false }),
      /400/, 'an update names its repository');
    await assert.rejects(post('repos/update', { requestId: 'push-without-remote', repoId: firstRepo.repoId, branch: 'main', remote: '', allowPush: true }), /400/, 'pushing needs a remote name');
    await assert.rejects(post('repos/delete', { requestId: 'delete-unknown', repoId: 'repo-not-registered' }), /400/, 'an unknown repository is refused');
    const forged = await fetch(fixture.workflowUrl + '/api/workflow/v1/maintenance/repos', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-KB-Runtime-Token': 'forged-token' },
      body: JSON.stringify({ requestId: 'forged', projectId: first.id, repoPath: 'C:\\Windows', branch: 'main', remote: '', allowPush: false }),
    });
    assert.equal(forged.status, 403, 'the module itself trusts only the token the shell holds');
    // 被拒绝的请求必须变成错误响应，而不是让外壳进程退出的未处理拒绝。
    // 受信转发的路由由外壳回答（error.message）；其余路由把模块的回答原样透传（顶层 message）。
    // A refused request must become an error response, never an unhandled rejection that ends the shell process.
    // Trusted-forwarded routes are answered by the shell (error.message); the others pass the module's own answer through (top-level message).
    for (const [route, body] of [
      ['maintenance/repos', '{not json'], ['maintenance/repos/delete', '{not json'], ['maintenance/jobs/delete', '{not json'], ['members', '{not json'], ['workflow-tasks', '{not json'],
      ['members', JSON.stringify({ requestId: 'not-an-object', profileId: 42 })],
    ]) {
      const refused = await fetch(fixture.address + '/api/workflow/' + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      const payload = await refused.json().catch(() => null);
      assert.equal(refused.status, 400, `${route} answers a malformed request with 400: ${JSON.stringify(payload)}`);
      assert.ok(payload?.error?.message || (payload?.ok === false && typeof payload.message === 'string'), `${route}: the refusal carries a message for the page`);
    }
    assert.equal((await fetch(fixture.address + '/api/health')).status, 200, 'the shell is still serving after refusals');

    await browser.setViewport(390, 840);
    await waitFor(() => workflow('doc.documentElement.scrollWidth <= doc.defaultView.innerWidth'), 'narrow maintenance layout');
    await shot('page-registration-narrow.png');
    assert.deepEqual(browser.exceptions, []);
    console.log('ai-team-page-registration-test PASS (fresh instance: repository, tool and plan registered on the page; real run output; member model dropdown; a second repository registered on save, one plan on two repositories, a run in each with its own path; plan-named deletion refusal; shell refusals)');
  } finally {
    if (browser) await browser.close();
    await fixture.close();
  }
}

main().catch(error => { console.error(error.stack); process.exitCode = 1; });
