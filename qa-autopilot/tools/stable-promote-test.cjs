'use strict';
// Offline semantic tests for the manual "promote the accepted version to
// latest" route.
//
// The registry, the GitHub CI lookup and the npm CLI are injected, so no
// network, no npm and no runner is involved. The assertions are about the
// DECISIONS of the route: what it refuses, what it writes and what it
// records - never about the shape of its own source text.

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const C = require('./stable-next-common.cjs');
const P = require('./stable-promote.cjs');

const VERSION = '5.0.24';
const PREVIOUS = '5.0.23';
const SHA = 'a'.repeat(40);
const SRI = 'sha512-' + 'A'.repeat(86);
const tempRoots = [];

function tempRoot() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stable-promote-test-'));
    tempRoots.push(dir);
    return dir;
}

after(() => {
    for (const dir of tempRoots) {
        try { fs.rmSync(dir, { recursive: true, force: true }); }
        catch (error) { void error; }
    }
});

function envOf(over) {
    return Object.assign({
        GITHUB_REPOSITORY: C.REPOSITORY,
        GITHUB_WORKFLOW_REF: C.REPOSITORY + '/' + C.WORKFLOW_PATH + '@refs/heads/main',
        GITHUB_EVENT_NAME: 'workflow_dispatch',
        TARGET_PACKAGE: C.CORE_PACKAGE,
        EXPECTED_VERSION: VERSION,
        EXPECTED_SRI: SRI,
        EXPECTED_SOURCE_SHA: SHA,
        EXPECTED_CURRENT_LATEST: PREVIOUS,
        ACCEPTANCE_ACK: P.ACCEPTANCE_ACK,
        REVIEWER: 'release-reviewer',
        RUNNER_TEMP: tempRoot(),
    }, over || {});
}

function inputsOf(over) {
    return P.readInputs(envOf(over));
}

function stateOf(over) {
    return Object.assign({
        packageName: C.CORE_PACKAGE,
        version: VERSION,
        versionExists: true,
        integrity: SRI,
        latest: PREVIOUS,
        next: VERSION,
    }, over || {});
}

// The public registry, reduced to the two documents this route reads.
function registryFetch(state) {
    return async (url) => {
        const target = String(url);
        if (target.endsWith('/' + encodeURIComponent(state.version))) {
            if (!state.versionExists)
                return { ok: false, status: 404, json: async () => ({ error: 'not found' }) };
            return { ok: true, status: 200, json: async () => ({ name: state.packageName, version: state.version, dist: { integrity: state.integrity } }) };
        }
        return { ok: true, status: 200, json: async () => ({ name: state.packageName, 'dist-tags': { latest: state.latest, next: state.next } }) };
    };
}

// The current CI run of the reviewed commit.
function ciStatus(status, jobs) {
    return async () => ({
        status: status || 'PASS',
        sha: SHA,
        jobs: jobs === undefined ? C.REQUIRED_CI_JOBS.map(name => ({ name, conclusion: 'success' })) : jobs,
    });
}

// The npm CLI, reduced to the one command this route is allowed to run.
function npmRunner(state, result) {
    const calls = [];
    const runner = (args) => {
        calls.push(args);
        if (state && !result)
            state.latest = state.version;
        return Object.assign({ status: 0, stdout: 'npm notice ok', stderr: '' }, result || {});
    };
    runner.calls = calls;
    return runner;
}

function codeOf(verdict) {
    return verdict.ok ? null : verdict.code;
}

function receiptOf(env) {
    return JSON.parse(fs.readFileSync(path.join(env.RUNNER_TEMP, 'stable-promotion', P.RECEIPT_NAME), 'utf8'));
}

test('a promotion request cannot downgrade the reviewed latest baseline', async () => {
    await assert.rejects(P.check({
        env: envOf({ EXPECTED_VERSION: '5.0.22', EXPECTED_CURRENT_LATEST: '5.0.23' }),
        fetchImpl: registryFetch(stateOf()), ciStatus: ciStatus(), npmVersion: '11.21.1',
    }), error => error.code === 'DOWNGRADE_DISALLOWED');
});

test('an npm authentication failure stores codes without tokens or challenge URLs', async () => {
    const env = envOf(), state = stateOf();
    const runner = npmRunner(state, {
        status: 1, stdout: 'fake-secret-never-store',
        stderr: 'npm error code EOTP https://auth.example.invalid/challenge/private-state',
    });
    await assert.rejects(P.promote({
        env, fetchImpl: registryFetch(state), ciStatus: ciStatus(),
        npmVersion: '11.21.1', runNpm: runner,
    }), error => error.code === 'DIST_TAG_FAILED');
    const directory = path.join(env.RUNNER_TEMP, 'stable-promotion');
    assert.deepStrictEqual(fs.readdirSync(directory), ['promotion-command.json']);
    const text = fs.readFileSync(path.join(directory, 'promotion-command.json'), 'utf8');
    assert.deepStrictEqual(JSON.parse(text).errorCodes, ['EOTP']);
    assert.ok(!text.includes('fake-secret') && !text.includes('https://'));
    assert.strictEqual(runner.calls.length, 1);
});

test('a complete manual promotion request passes every precondition', async () => {
    const state = stateOf();
    const result = await P.check({
        env: envOf(),
        fetchImpl: registryFetch(state),
        ciStatus: ciStatus(),
        npmVersion: '11.21.1',
    });
    assert.equal(result.status, 'READY_TO_PROMOTE');
    assert.equal(result.written, false);
    assert.equal(result.latest, PREVIOUS);
    assert.equal(result.next, VERSION);
});

test('only this repository, this workflow file and a manual dispatch may promote', () => {
    assert.equal(codeOf(P.checkPromotionInputs(inputsOf({ GITHUB_REPOSITORY: 'someone/else' }))), 'CI_IDENTITY');
    assert.equal(codeOf(P.checkPromotionInputs(inputsOf({ GITHUB_WORKFLOW_REF: C.REPOSITORY + '/.github/workflows/ci.yml@refs/heads/main' }))), 'WORKFLOW_IDENTITY');
    assert.equal(codeOf(P.checkPromotionInputs(inputsOf({ GITHUB_EVENT_NAME: 'push' }))), 'MANUAL_ONLY');
});

test('only the core package may be promoted', () => {
    assert.equal(codeOf(P.checkPromotionInputs(inputsOf({ TARGET_PACKAGE: '@sanqianx/claude-ai-workbench' }))), 'PACKAGE_NAME');
    assert.equal(codeOf(P.checkPromotionInputs(inputsOf({ TARGET_PACKAGE: '@sanqianx/project-knowledge-desktop' }))), 'PACKAGE_NAME');
    assert.equal(codeOf(P.checkPromotionInputs(inputsOf({ TARGET_PACKAGE: '' }))), 'PACKAGE_NAME');
});

test('the version, the commit and the integrity must be exact', () => {
    assert.equal(codeOf(P.checkPromotionInputs(inputsOf({ EXPECTED_VERSION: 'v5.0.24' }))), 'VERSION_SEMVER');
    assert.equal(codeOf(P.checkPromotionInputs(inputsOf({ EXPECTED_SOURCE_SHA: 'abc' }))), 'SHA_FORMAT');
    assert.equal(codeOf(P.checkPromotionInputs(inputsOf({ EXPECTED_SRI: 'sha256-abc' }))), 'SRI_FORMAT');
});

test('the reviewer and the exact acceptance attestation are required', () => {
    assert.equal(codeOf(P.checkPromotionInputs(inputsOf({ REVIEWER: '' }))), 'REVIEWER_REQUIRED');
    assert.equal(codeOf(P.checkPromotionInputs(inputsOf({ ACCEPTANCE_ACK: 'accepted' }))), 'ACCEPTANCE_ACK');
    assert.equal(codeOf(P.checkPromotionInputs(inputsOf({ ACCEPTANCE_ACK: 'official-next-install-ui-restart-passed-extra' }))), 'ACCEPTANCE_ACK');
    assert.equal(codeOf(P.checkPromotionInputs(inputsOf({ EXPECTED_CURRENT_LATEST: '' }))), 'LATEST_BASELINE_FORMAT');
});

test('every current non-release CI job must have succeeded on the reviewed commit', () => {
    const incomplete = C.REQUIRED_CI_JOBS.slice(0, -1).map(name => ({ name, conclusion: 'success' }));
    assert.equal(codeOf(P.checkCiGate({ ciStatus: 'PASS', jobs: incomplete })), 'CI_JOBS_INCOMPLETE');
    assert.equal(codeOf(P.checkCiGate({ ciStatus: 'FAIL', jobs: C.REQUIRED_CI_JOBS.map(name => ({ name, conclusion: 'success' })) })), 'CI_NOT_GREEN');
    assert.equal(codeOf(P.checkCiGate({ ciStatus: 'PASS', jobs: C.REQUIRED_CI_JOBS.map(name => ({ name, conclusion: 'success' })) })), null);
});

test('a red or incomplete CI run stops the promotion', async () => {
    const state = stateOf();
    await assert.rejects(
        () => P.check({ env: envOf(), fetchImpl: registryFetch(state), ciStatus: ciStatus('FAIL'), npmVersion: '11.21.1' }),
        error => error.code === 'CI_NOT_GREEN');
    await assert.rejects(
        () => P.check({ env: envOf(), fetchImpl: registryFetch(state), ciStatus: ciStatus('PASS', [{ name: C.REQUIRED_CI_JOBS[0], conclusion: 'success' }]), npmVersion: '11.21.1' }),
        error => error.code === 'CI_JOBS_INCOMPLETE');
});

test('the candidate must be published under next with the reviewed integrity', async () => {
    const missing = stateOf({ versionExists: false });
    await assert.rejects(
        () => P.check({ env: envOf(), fetchImpl: registryFetch(missing), ciStatus: ciStatus(), npmVersion: '11.21.1' }),
        error => error.code === 'VERSION_MISSING');
    const wrongBytes = stateOf({ integrity: 'sha512-' + 'B'.repeat(86) });
    await assert.rejects(
        () => P.check({ env: envOf(), fetchImpl: registryFetch(wrongBytes), ciStatus: ciStatus(), npmVersion: '11.21.1' }),
        error => error.code === 'INTEGRITY_MISMATCH');
    const notNext = stateOf({ next: PREVIOUS });
    await assert.rejects(
        () => P.check({ env: envOf(), fetchImpl: registryFetch(notNext), ciStatus: ciStatus(), npmVersion: '11.21.1' }),
        error => error.code === 'NEXT_MISMATCH');
});

test('a latest that moved since the review stops the promotion', async () => {
    const moved = stateOf({ latest: '5.0.22' });
    await assert.rejects(
        () => P.check({ env: envOf(), fetchImpl: registryFetch(moved), ciStatus: ciStatus(), npmVersion: '11.21.1' }),
        error => error.code === 'LATEST_CHANGED');
});

test('the npm CLI must be able to use OIDC for a dist-tag write', () => {
    assert.equal(codeOf(P.checkNpmVersion({ npmVersion: '11.21.0' })), null);
    assert.equal(codeOf(P.checkNpmVersion({ npmVersion: '11.21.1' })), null);
    assert.equal(codeOf(P.checkNpmVersion({ npmVersion: '12.2.0' })), null);
    assert.equal(codeOf(P.checkNpmVersion({ npmVersion: '11.20.0' })), 'NPM_VERSION_UNSUPPORTED');
    assert.equal(codeOf(P.checkNpmVersion({ npmVersion: '12.1.0' })), 'NPM_VERSION_UNSUPPORTED');
    assert.equal(codeOf(P.checkNpmVersion({ npmVersion: '10.9.0' })), 'NPM_VERSION_UNSUPPORTED');
    assert.equal(codeOf(P.checkNpmVersion({ npmVersion: 'unknown' })), 'NPM_VERSION_FORMAT');
});

test('an old npm CLI stops the promotion', async () => {
    const state = stateOf();
    await assert.rejects(
        () => P.check({ env: envOf(), fetchImpl: registryFetch(state), ciStatus: ciStatus(), npmVersion: '11.20.0' }),
        error => error.code === 'NPM_VERSION_UNSUPPORTED');
});

test('an already promoted latest reconciles without any write', async () => {
    const state = stateOf({ latest: VERSION });
    const env = envOf();
    const npm = npmRunner(state);
    const receipt = await P.promote({
        env,
        fetchImpl: registryFetch(state),
        ciStatus: ciStatus(),
        npmVersion: '11.21.1',
        runNpm: npm,
        pollAttempts: 1,
        pollDelayMs: 0,
    });
    assert.equal(npm.calls.length, 0, 'a reconciliation must not run the npm CLI');
    assert.equal(receipt.status, 'ALREADY_PROMOTED_VERIFIED');
    assert.equal(receipt.written, false);
    assert.equal(receipt.distTagGrant, 'NOT_EXERCISED_BY_THIS_RUN');
});

test('the promotion writes latest exactly once and records the result', async () => {
    const state = stateOf();
    const env = envOf();
    const npm = npmRunner(state);
    const receipt = await P.promote({
        env,
        fetchImpl: registryFetch(state),
        ciStatus: ciStatus(),
        npmVersion: '11.21.1',
        runNpm: npm,
        pollAttempts: 2,
        pollDelayMs: 0,
    });
    assert.equal(npm.calls.length, 1);
    assert.deepEqual(npm.calls[0], ['dist-tag', 'add', C.CORE_PACKAGE + '@' + VERSION, 'latest']);
    assert.equal(receipt.status, 'PROMOTED_LATEST');
    assert.equal(receipt.written, true);
    assert.equal(receipt.distTagGrant, 'EXERCISED_BY_THIS_WRITE');
    assert.equal(receipt.observed.latest, VERSION);
    assert.equal(receipt.baseline.latest, PREVIOUS);
    assert.equal(receipt.observed.next, VERSION);
    assert.equal(receipt.integrity, SRI);
    assert.equal(receipt.integrityUnchanged, true);
});

test('the recorded receipt carries metadata only and never a token', async () => {
    const state = stateOf();
    const env = envOf();
    await P.promote({
        env,
        fetchImpl: registryFetch(state),
        ciStatus: ciStatus(),
        npmVersion: '11.21.1',
        runNpm: npmRunner(state),
        pollAttempts: 2,
        pollDelayMs: 0,
    });
    const receipt = receiptOf(env);
    assert.equal(receipt.schema, P.PROMOTION_SCHEMA);
    assert.equal(receipt.acceptance.kind, 'human-attestation');
    assert.equal(receipt.acceptance.ack, P.ACCEPTANCE_ACK);
    assert.ok(/human attestation/i.test(receipt.acceptance.note));
    const serialized = JSON.stringify(receipt);
    assert.ok(!/token|authorization|_authToken|bearer/i.test(serialized), 'the receipt must not carry a credential');
});

test('a failing npm CLI writes nothing and claims no promotion', async () => {
    const state = stateOf();
    const env = envOf();
    await assert.rejects(
        () => P.promote({
            env,
            fetchImpl: registryFetch(state),
            ciStatus: ciStatus(),
            npmVersion: '11.21.1',
            runNpm: npmRunner(state, { status: 1, stderr: 'E403 insufficient permissions to publish' }),
            pollAttempts: 1,
            pollDelayMs: 0,
        }),
        error => error.code === 'DIST_TAG_FAILED');
    assert.equal(fs.existsSync(path.join(env.RUNNER_TEMP, 'stable-promotion', P.RECEIPT_NAME)), false);
    assert.equal(state.latest, PREVIOUS, 'the registry must not have changed');
});

test('a write that did not move latest is refused after the fact', async () => {
    const state = stateOf();
    const env = envOf();
    await assert.rejects(
        () => P.promote({
            env,
            fetchImpl: registryFetch(state),
            ciStatus: ciStatus(),
            npmVersion: '11.21.1',
            runNpm: npmRunner(null, { status: 0 }),
            pollAttempts: 1,
            pollDelayMs: 0,
        }),
        error => error.code === 'LATEST_NOT_MOVED');
});

test('a write that moved next is refused: this route never moves next', async () => {
    const state = stateOf();
    const env = envOf();
    const npm = (args) => {
        state.latest = state.version;
        state.next = PREVIOUS;
        return { status: 0, stdout: '', stderr: '' };
    };
    await assert.rejects(
        () => P.promote({
            env,
            fetchImpl: registryFetch(state),
            ciStatus: ciStatus(),
            npmVersion: '11.21.1',
            runNpm: npm,
            pollAttempts: 1,
            pollDelayMs: 0,
        }),
        error => error.code === 'NEXT_MOVED');
});

test('a write that changed the published bytes is refused', async () => {
    const state = stateOf();
    const env = envOf();
    const npm = (args) => {
        state.latest = state.version;
        state.integrity = 'sha512-' + 'C'.repeat(86);
        return { status: 0, stdout: '', stderr: '' };
    };
    await assert.rejects(
        () => P.promote({
            env,
            fetchImpl: registryFetch(state),
            ciStatus: ciStatus(),
            npmVersion: '11.21.1',
            runNpm: npm,
            pollAttempts: 1,
            pollDelayMs: 0,
        }),
        error => error.code === 'INTEGRITY_CHANGED');
});
