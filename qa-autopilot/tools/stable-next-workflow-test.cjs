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
        if (match[2].trim()) {
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

test('no registry credential or registry url is configured anywhere', () => {
    assert.ok(!code.includes('NODE_AUTH_TOKEN'), 'no NODE_AUTH_TOKEN may appear in code');
    assert.ok(!code.includes('registry-url'), 'no registry-url may appear in code');
    assert.ok(!/\.npmrc/.test(code), 'no npmrc may be written');
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
