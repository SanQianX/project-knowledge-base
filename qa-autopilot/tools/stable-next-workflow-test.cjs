'use strict';
// Offline contract test for .github/workflows/publish.yml.
// The scan looks at CODE LINES ONLY: a comment that names a forbidden token
// (for example "NO NODE_AUTH_TOKEN") must not be able to hide or fake a
// finding. No network, no runner, no YAML parser: the file is inspected
// line by line.
// Run: node qa-autopilot/tools/stable-next-workflow-test.cjs

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const WORKFLOW = path.join(__dirname, '..', '..', '.github', 'workflows', 'publish.yml');
const raw = fs.readFileSync(WORKFLOW, 'utf8').replace(/\r\n?/g, '\n');
const code = raw.split('\n').filter(line => !line.trim().startsWith('#')).join('\n');

function jobBlock(name) {
    const lines = code.split('\n');
    const start = lines.findIndex(line => line === '  ' + name + ':');
    assert.ok(start >= 0, 'job ' + name + ' is missing');
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
        if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(lines[i])) {
            end = i;
            break;
        }
    }
    return lines.slice(start, end).join('\n');
}

// Every "run:" script of a job, with the "with:" blocks left out.
function runScripts(block) {
    const lines = block.split('\n');
    const scripts = [];
    let i = 0;
    while (i < lines.length) {
        const match = lines[i].match(/^(\s*)run:\s*(.*)$/);
        if (!match) {
            i++;
            continue;
        }
        const indent = match[1].length;
        if (match[2].trim() && match[2].trim() !== '|') {
            scripts.push(match[2]);
            i++;
            continue;
        }
        const body = [];
        let j = i + 1;
        while (j < lines.length) {
            const next = lines[j];
            if (next.trim() === '') {
                body.push(next);
                j++;
                continue;
            }
            if (next.match(/^\s*/)[0].length <= indent)
                break;
            body.push(next);
            j++;
        }
        scripts.push(body.join('\n'));
        i = j;
    }
    return scripts;
}

test('the RC trigger and command set are unchanged', () => {
    assert.ok(code.includes("'qa-rc/*'"), 'the qa-rc tag trigger must stay');
    assert.ok(code.includes('--tag next'), 'the RC publish must keep using the next tag');
    assert.ok(code.includes('--provenance'), 'the RC publish must keep its provenance flag');
    assert.ok(!code.includes("- 'v*'"), 'no stable version tag trigger may exist');
    // The house release guard reads the RAW file and requires this marker.
    assert.ok(raw.includes('RC_ONLY_DURING_QA'), 'the RC-only marker must stay');
    assert.ok(raw.includes('.github/workflows/publish.yml'), 'the workflow path marker must stay');
});

test('registry credentials stay out of the read-only jobs; write jobs gate the optional token behind a placeholder-only userconfig', () => {
    // The RC, assessment and prepare jobs remain strictly credential-free,
    // and no job may hand npm a credential through setup-node.
    for (const job of ['publish', 'auth-probe', 'stable-prepare']) {
        const block = jobBlock(job);
        assert.ok(!block.includes('NODE_AUTH_TOKEN'), job + ' must not reference NODE_AUTH_TOKEN');
        assert.ok(!block.includes('registry-url'), job + ' must not configure registry-url');
    }
    assert.ok(!code.includes('registry-url'), 'no setup-node registry-url may appear anywhere');
    assert.ok(!/\.npmrc/.test(code), 'no npmrc path may be hardcoded');
    const tokenEnv = 'NODE_AUTH_TOKEN: ${{ secrets.NPM_PUBLISH_TOKEN }}';
    const publishCommands = {
        'stable-publish-next': 'node qa-autopilot/tools/stable-next-publish.cjs publish',
        'stable-promote': 'node qa-autopilot/tools/stable-promote.cjs promote'
    };
    for (const [job, command] of Object.entries(publishCommands)) {
        const block = jobBlock(job);
        assert.deepEqual(
            block.split('\n').filter(line => line.trim().startsWith('NODE_AUTH_TOKEN:')).map(line => line.trim()),
            [tokenEnv],
            job + ' must consume the token only as the write step env reference');
        const write = runScripts(block).find(script => script.includes(command));
        assert.ok(write, job + ' must keep running ' + command);
        assert.ok(write.includes('if [ -n "$NODE_AUTH_TOKEN" ]; then'), job + ' must test the token for non-emptiness before any credential config');
        assert.ok(write.includes('export NPM_CONFIG_USERCONFIG="$(mktemp)"'), job + ' must locate the temporary userconfig with mktemp');
        assert.ok(write.includes("printf '%s\\n' '//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}' > \"$NPM_CONFIG_USERCONFIG\""),
            job + ' must write ONLY the npm placeholder line into the userconfig, never the token');
        assert.ok(write.includes(`trap 'rm -f "$NPM_CONFIG_USERCONFIG"' EXIT`), job + ' must remove the userconfig on exit');
        assert.ok(write.indexOf('if [ -n') < write.indexOf('NPM_CONFIG_USERCONFIG=') && write.indexOf('printf') < write.indexOf(command),
            job + ' must gate and write the config before the original tool command');
        const secretNames = [...block.matchAll(/secrets\.([A-Za-z_][A-Za-z0-9_]*)/g)].map(m => m[1]);
        assert.ok(secretNames.length > 0, job + ' must reference at least the github token');
        assert.ok(secretNames.every(name => name === 'GITHUB_TOKEN' || name === 'NPM_PUBLISH_TOKEN'),
            job + ' references a secret other than the github and publish tokens');
    }
});

test('the RC job keeps its environment gate and stays push only', () => {
    const block = jobBlock('publish');
    assert.ok(block.includes("github.event_name == 'push'"), 'the RC job must stay push only');
    assert.ok(block.includes('environment: npm-rc-gate'), 'the RC job must keep its environment');
    assert.ok(block.includes('id-token: write'), 'the RC job must keep id-token write');
});

test('the auth-probe job stays assessment only', () => {
    const block = jobBlock('auth-probe');
    assert.ok(!block.includes('environment:'), 'the auth-probe job must have no environment claim');
    assert.ok(!block.includes('npm publish'), 'the auth-probe job must never publish');
    assert.ok(!block.includes('stable-next-publish'), 'the auth-probe job must not reach the publish route');
    assert.ok(block.includes("inputs.mode == 'auth-probe'"), 'the auth-probe job must be mode gated');
});

test('the prepare job can never obtain a publishing identity', () => {
    const block = jobBlock('stable-prepare');
    assert.ok(!block.includes('id-token'), 'the prepare job must not request id-token');
    assert.ok(!block.includes('environment:'), 'the prepare job must have no environment claim');
    assert.ok(!block.includes('npm publish'), 'the prepare job must never publish');
    assert.ok(block.includes('contents: read'), 'the prepare job must request contents read');
    assert.ok(block.includes('actions: read'), 'the prepare job must request actions read');
});

test('the publish-next job holds the least necessary permissions and no environment', () => {
    const block = jobBlock('stable-publish-next');
    assert.ok(block.includes('contents: read'), 'the publish job must request contents read');
    assert.ok(block.includes('actions: read'), 'the publish job must request actions read');
    assert.ok(block.includes('id-token: write'), 'the publish job must request id-token write');
    assert.ok(!block.includes('environment:'), 'the publish job must have no environment claim');
    assert.ok(!block.includes('npm publish'), 'the publish job must not invoke npm publish directly');
});

test('every manual input reaches the shell through the environment only', () => {
    for (const job of ['stable-prepare', 'stable-publish-next']) {
        const block = jobBlock(job);
        for (const script of runScripts(block)) {
            assert.ok(!script.includes('${{'), job + ' interpolates a dispatch input inside a run script');
        }
        assert.ok(block.includes('${{ inputs.'), job + ' must read its inputs through env blocks');
    }
});

test('the two stable phases stay separate jobs', () => {
    const prepare = jobBlock('stable-prepare');
    const publish = jobBlock('stable-publish-next');
    assert.ok(!prepare.includes('stable-next-publish.cjs'), 'the prepare job must not publish');
    assert.ok(!publish.includes('stable-next-prepare.cjs'), 'the publish job must not rebuild');
    assert.ok(publish.includes('stable-next-publish.cjs verify-run'), 'the publish job must verify the prepare run first');
    assert.ok(publish.includes('stable-next-publish.cjs publish'), 'the publish job must publish through the reviewed route');
    assert.ok(publish.includes('actions/download-artifact@v4'), 'the publish job must download the prepared artifact');
    assert.ok(publish.includes('run-id:'), 'the publish job must bind the artifact to the supplied run id');
});

test('the manual modes are mutually exclusive and default to assessment', () => {
    assert.ok(code.includes("default: 'auth-probe'"), 'the default manual mode must stay auth-probe');
    assert.ok(code.includes("inputs.mode == 'stable-prepare'"), 'the prepare mode must be mode gated');
    assert.ok(code.includes("inputs.mode == 'stable-publish-next'"), 'the publish mode must be mode gated');
});

test('the reviewed hashes are caller supplied, never derived in the workflow', () => {
    const publish = jobBlock('stable-publish-next');
    assert.ok(publish.includes('EXPECTED_SHA256: ${{ inputs.expected_tarball_sha256 }}'), 'the reviewed sha256 must come from the caller');
    assert.ok(publish.includes('EXPECTED_SRI: ${{ inputs.expected_tarball_sri }}'), 'the reviewed integrity must come from the caller');
    assert.ok(publish.includes('REVIEWER: ${{ inputs.reviewer }}'), 'the reviewer identity must come from the caller');
    assert.ok(publish.includes('PREPARE_RUN_ID: ${{ inputs.prepare_run_id }}'), 'the prepare run id must come from the caller');
});
