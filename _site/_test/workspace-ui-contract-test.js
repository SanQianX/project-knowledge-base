const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'ui', 'index.html'), 'utf8');
const server = fs.readFileSync(path.join(ROOT, '_site', 'server.js'), 'utf8');
const template = html.split('<script>')[0];

assert(template.includes('data-workspace-shell'), 'workspace shell contract is missing');
assert(template.includes('data-project-list'), 'project list contract is missing');
assert(
  template.includes('@contextmenu.prevent="openProjectContextMenu($event, p.slug)"'),
  'project removal must start from a project-list context menu',
);
assert(template.includes('data-project-context-menu'), 'project context menu is missing');
assert(template.includes('@click="openRemoveProject(projectContextMenu.slug)"'), 'context-menu removal action is not wired');
assert.strictEqual((template.match(/data-remove-project-dialog/g) || []).length, 1, 'remove dialog must render exactly once');

for (const section of ['ai', 'automation', 'relations', 'knowledge', 'model', 'logs', 'client']) {
  assert(template.includes(`data-settings-section="${section}"`), `settings section missing: ${section}`);
}
assert(template.includes('data-settings-drawer'), 'settings drawer contract is missing');
assert(template.includes('data-import-drawer'), 'import drawer contract is missing');
assert(template.includes('form.useTeamKnowledge'), 'team knowledge binding must remain in the import flow');

assert(template.includes('data-git-account-drawer'), 'Git account drawer contract is missing');
assert(template.includes("selectGitLoginProvider('github')"), 'GitHub provider selection is missing');
assert(template.includes("selectGitLoginProvider('gitea')"), 'Gitea provider selection is missing');
assert(template.includes('startGithubOAuth'), 'GitHub Device Flow action is missing');
assert(template.includes('startGiteaOAuth'), 'Gitea OAuth action is missing');

assert(template.includes('@click="onAttachImage"'), 'Claude image attachment is missing');
assert(template.includes('@click="toggleModeMenu"'), 'Claude permission mode is missing');
assert(template.includes('tokenUsagePercent'), 'Claude token usage is missing');
assert(template.includes('@click="toggleSlashMenu"'), 'Claude slash menu is missing');

assert(!template.includes('@click="validateGit('), 'manual Git validation must not render');
assert(!template.includes('@click.prevent="installHook('), 'manual Hook installation must not render');
assert(!template.includes('@click.prevent="uninstallHook('), 'manual Hook removal must not render');

assert(server.includes('function projectHasRunningJobs('), 'backend project running-job guard is missing');
assert(
  server.includes('claudeCliRunner.ACTIVE_STATES.has(session.state)'),
  'project removal guard must derive activity from the persisted session state',
);
assert(
  /projectHasRunningJobs\(slug\)[\s\S]{0,500}status:\s*409/.test(server),
  'project removal must reject active projects with HTTP 409',
);

console.log('workspace UI contract test passed');
