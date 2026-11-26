'use strict';

// 全新安装的知识库里没有维护登记文件。整个设置过程在浏览器里完成：
// 「自动维护」页登记仓库（路径由知识库解析）→ 登记工具 → 新建维护计划 → 运行一次，
// 运行详情里是真实工具的输出。外壳在接口层的拒绝规则一并断言。
//
// A freshly installed knowledge base has no maintenance registration file. The whole setup is
// done in the browser on the 自动维护 page: register the repository (the shell resolves its
// path), register a tool, create a plan, run it once and read the real tool output. The shell's
// refusals at the API level are asserted alongside.

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
    const optionsOf = selector => workflow('[...doc.querySelectorAll(' + JSON.stringify(selector + ' option') + ')].map(option => option.textContent)');
    const field = (form, name, value) => workflow(
      '(() => { const field = doc.getElementById(' + JSON.stringify(form) + ').elements.namedItem(' + JSON.stringify(name) + '); field.value = ' + JSON.stringify(value) + '; return field.value; })()'
    );
    const change = (form, name) => workflow('doc.getElementById(' + JSON.stringify(form) + ').elements.namedItem(' + JSON.stringify(name) + ').dispatchEvent(new Event("change"))');
    const shot = filename => browser.screenshot(path.join(options.dataDir, filename));
    const status = () => fixture.call('maintenance');
    const post = (route, body) => fixture.call('maintenance/' + route, { method: 'POST', body });
    const detail = runId => fixture.call('maintenance/runs/' + runId).then(value => value.run);
    const repoPath = fs.realpathSync(fixture.registration.repo);

    await browser.setViewport(1440, 940);
    await page('document.querySelector(\'nav [data-view="team"]\').click()');
    await waitFor(() => has('#heading', '团队任务'), 'AI team frame in a newly installed knowledge base');

    // 未登记：页面上是登记表单，不再是文件路径。
    // Unregistered: the page offers the registration form, not a file path.
    await click('#navMaintenance');
    await waitFor(() => exists('#maintenanceRepoForm'), 'registration form');
    assert.equal(await has('#heading', '自动维护'), true);
    assert.equal(await has('#maintenance', 'maintenance.json'), false, 'the registry file is no longer something the user edits');
    assert.equal(await exists('[data-maintenance-new]'), false, 'no plan can be created before registration');
    assert.equal(await workflow('doc.querySelector("[data-maintenance-tool-new]").disabled'), true, 'no tool can be registered before the repository');
    assert.deepEqual(await optionsOf('#maintenanceRepoForm select[name=projectId]'), ['示例代码仓库', '示例文档仓库'], 'the project list comes from the knowledge base');
    await shot('page-registration-empty.png');

    // ① 登记仓库：页面只传项目，路径由知识库解析后交给模块。
    // ① Register the repository: the page sends only the project; the shell resolves the path for the module.
    await click('#maintenanceRepoForm button[type="submit"]');
    await waitFor(() => has('#maintenanceRepoTitle', '示例代码仓库'), 'repository registered from the page');
    const registered = await status();
    assert.equal(registered.configured, true);
    assert.equal(registered.branch, 'main', 'a blank branch means the repository current branch');
    assert.equal(registered.repoPath, repoPath, 'the path is the one the shell resolved for the project');
    assert.deepEqual(registered.tools, []);
    const stored = JSON.parse(fs.readFileSync(path.join(fixture.workflowData, 'workflow', 'state.json'), 'utf8'));
    assert.equal(stored.maintenanceRegistry.importedFrom, null, 'nothing was imported: the page is the source');
    assert.equal(await exists('[data-maintenance-repo-edit]'), true, 'the registered repository can be edited');

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

    // 成员的模型是下拉，选项是知识库里可用的档案；外壳核对后把模型名交给模块。
    // A member's model is a dropdown of the knowledge base's usable profiles; the shell verifies it for the module.
    await click('#navSettings');
    await waitFor(() => exists('#addMember'), 'team settings');
    await click('#addMember');
    await waitFor(() => has('#memberForm', '代码规范'), 'member editor');
    assert.deepEqual(await optionsOf('#memberForm select[name=profileId]'), ['不指定', '代码档案 · model-code', '文档档案 · model-docs'], 'only enabled profiles with configured credentials are offered');
    assert.equal(await has('#memberForm', '目前只保存所选的模型'), true, 'the dialog says the reference is stored, not launched');
    await field('memberForm', 'name', '页面登记成员');
    await field('memberForm', 'instructions', '按维护计划检查仓库。');
    await field('memberForm', 'profileId', 'profile-code');
    await click('#memberForm button[type="submit"]');
    await waitFor(() => has('#memberList', '页面登记成员'), 'member saved through the shell');
    const member = (await fixture.call('members')).members.find(item => item.name === '页面登记成员');
    assert.deepEqual([member.profileId, member.model], ['profile-code', 'model-code']);
    assert.equal(await has('#memberList', '代码档案 · model-code'), true, 'the roster shows the model by its profile name');
    for (const profileId of ['profile-disabled', 'profile-no-key', 'profile-unknown']) {
      await assert.rejects(fixture.call('members/' + member.memberId, { method: 'PATCH', body: { requestId: 'refuse-' + profileId, profileId } }),
        /400/, `${profileId} must be refused`);
    }
    assert.equal((await fixture.call('members/' + member.memberId)).member.model, 'model-code', 'refusals leave the stored model untouched');

    // ③ 新建维护计划，运行一次：详情里是页面上登记的工具的真实输出。
    // ③ Create a plan and run it once: the detail shows the real output of the tool registered from the page.
    await click('#navMaintenance');
    await waitFor(() => workflow('!doc.querySelector("[data-maintenance-new]").disabled'), 'plan creation is enabled once a tool exists');
    await click('[data-maintenance-new]');
    await waitFor(() => has('#maintenanceDialogTitle', '新建维护计划'), 'plan dialog');
    await field('maintenanceForm', 'title', '手动格式整理');
    await field('maintenanceForm', 'memberId', member.memberId);
    await field('maintenanceForm', 'toolId', tool.id);
    await workflow('doc.getElementById("maintenanceForm").elements.enabled.checked = true');
    await click('#maintenanceForm button[type="submit"]');
    await waitFor(() => has('.maintenance-job', '手动格式整理'), 'plan saved');
    assert.equal((await status()).jobs[0].memberId, member.memberId);
    await click('[data-maintenance-run]');
    await waitFor(() => has('.maintenance-run', '已保留候选提交'), 'the tool registered from the page really ran');
    const listed = await until(async () => (await status()).runs[0], run => run && !['queued', 'running'].includes(run.status), 'the run to finish');
    const finished = await detail(listed.runId);
    assert.equal(finished.status, 'succeeded', JSON.stringify(finished));
    assert.deepEqual([finished.receipts[0].phase, finished.receipts[0].exitCode, finished.receipts[0].stdout.text.trim()], ['apply', 0, 'format completed']);
    await click('[data-maintenance-detail]');
    await waitFor(() => has('#maintenanceRunDetail', 'format completed'), 'run detail shows the real tool output');
    await shot('page-registration-run.png');
    await click('#maintenanceRunDetail [data-close]');

    // 删除先确认，再执行。
    // Removal asks for confirmation first.
    await workflow('doc.defaultView.confirm = () => true');
    await click('[data-maintenance-delete]');
    await waitFor(() => workflow('!doc.querySelector(".maintenance-job")'), 'plan removed from the page');
    assert.deepEqual((await status()).jobs, []);
    await click('[data-maintenance-tool-delete]');
    await waitFor(() => workflow('!doc.querySelector(".maintenance-tool")'), 'tool removed from the page');
    assert.deepEqual((await fixture.call('maintenance/tools')).tools, []);

    // 外壳在接口层的规则：路径和令牌只来自外壳，没有 Git 仓库的项目登记不了。
    // The shell's rules at the API level: the path and the token come only from the shell, and a project without a Git repository cannot register.
    await assert.rejects(post('repos', { requestId: 'unknown-project', projectId: 'project-not-registered', repoPath: 'C:\\Windows' }),
      /404/, 'an unknown project is refused before the module is asked');
    await assert.rejects(post('repos', { requestId: 'not-a-repository', projectId: fixture.projects[1].id, branch: '', remote: '', allowPush: false }),
      error => /400/.test(error.message) && /Git 仓库/.test(error.message), 'a project directory that is not a Git root is refused');
    await post('repos', { requestId: 're-register', projectId: fixture.projects[0].id, repoPath: 'C:\\Windows', branch: 'main', remote: '', allowPush: false });
    assert.equal((await status()).repoPath, repoPath, 'a path supplied by the caller is ignored');
    await assert.rejects(post('repos/update', { requestId: 'push-without-remote', branch: 'main', remote: '', allowPush: true }), /400/, 'pushing needs a remote name');
    const forged = await fetch(fixture.workflowUrl + '/api/workflow/v1/maintenance/repos', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-KB-Runtime-Token': 'forged-token' },
      body: JSON.stringify({ requestId: 'forged', projectId: fixture.projects[0].id, repoPath: 'C:\\Windows', branch: 'main', remote: '', allowPush: false }),
    });
    assert.equal(forged.status, 403, 'the module itself trusts only the token the shell holds');
    // 被拒绝的请求必须变成错误响应，而不是让外壳进程退出的未处理拒绝。
    // A refused request must become an error response, never an unhandled rejection that ends the shell process.
    for (const [route, body] of [
      ['maintenance/repos', '{not json'], ['members', '{not json'], ['workflow-tasks', '{not json'],
      ['members', JSON.stringify({ requestId: 'not-an-object', profileId: 42 })],
    ]) {
      const refused = await fetch(fixture.address + '/api/workflow/' + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      assert.equal(refused.status, 400, `${route} answers a malformed request with 400`);
      assert.ok((await refused.json()).error?.message, 'the refusal carries a message for the page');
    }
    assert.equal((await fetch(fixture.address + '/api/health')).status, 200, 'the shell is still serving after refusals');

    await browser.setViewport(390, 840);
    await waitFor(() => workflow('doc.documentElement.scrollWidth <= doc.defaultView.innerWidth'), 'narrow maintenance layout');
    await shot('page-registration-narrow.png');
    assert.deepEqual(browser.exceptions, []);
    console.log('ai-team-page-registration-test PASS (fresh instance: repository, tool and plan registered on the page; real run output; member model dropdown; shell refusals)');
  } finally {
    if (browser) await browser.close();
    await fixture.close();
  }
}

main().catch(error => { console.error(error.stack); process.exitCode = 1; });
