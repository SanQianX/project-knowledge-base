'use strict';
// Offline positive/negative contract tests for stable-next-publish.cjs.
// Pure-function fixtures plus a fully mocked transport: no network, no
// registry, no GitHub, no npm, no publish. The end-to-end cases drive the
// production publish() with an injected fetch and an injected npm runner, so
// the reviewed-bytes binding, the reconcile path and the "latest unchanged"
// rule are exercised against real code.
// Run: node qa-autopilot/tools/stable-next-publish-test.cjs

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const g = require('./stable-next-publish.cjs');
const C = require('./stable-next-common.cjs');

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const VERSION = '5.0.25';
const RUN_ID = '40000000001';
const SRI_FIXTURE = 'sha512-' + Buffer.alloc(64, 7).toString('base64');

// A minimal ustar writer, enough to build a tarball with the same shape npm
// produces (entries under "package/").
function tarEntry(name, content, type) {
    const data = Buffer.from(content);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, 'utf8');
    header.write('000644 \0', 100, 8, 'utf8');
    header.write('000000 \0', 108, 8, 'utf8');
    header.write('000000 \0', 116, 8, 'utf8');
    header.write(data.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'utf8');
    header.write('00000000000\0', 136, 12, 'utf8');
    header.write('        ', 148, 8, 'utf8');
    header.write(type || '0', 156, 1, 'utf8');
    header.write('ustar\0' + '00', 257, 8, 'utf8');
    let sum = 0;
    for (const byte of header)
        sum += byte;
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'utf8');
    const padding = Buffer.alloc((512 - (data.length % 512)) % 512);
    return Buffer.concat([header, data, padding]);
}

function makeTarball(manifest, files) {
    const entries = [tarEntry('package/package.json', JSON.stringify(manifest))];
    for (const [name, body] of Object.entries(files || {}))
        entries.push(tarEntry('package/' + name, body));
    entries.push(Buffer.alloc(1024));
    return zlib.gunzipSync ? zlib.gzipSync(Buffer.concat(entries)) : Buffer.concat(entries);
}

function binding(over = {}) {
    return {
        repository: over.repository || C.REPOSITORY,
        workflowRef: over.workflowRef || (C.WORKFLOW_REF_PREFIX + 'main'),
        eventName: over.eventName || 'workflow_dispatch',
        expectedSha256: over.expectedSha256 || 'a'.repeat(64),
        expectedSRI: over.expectedSRI || SRI_FIXTURE,
        expectedSourceSha: over.expectedSourceSha || SHA_A,
        prepareRunId: over.prepareRunId || RUN_ID,
        reviewer: over.reviewer === undefined ? 'lead-reviewer' : over.reviewer,
        packageName: over.packageName || C.CORE_PACKAGE,
        expectedVersion: over.expectedVersion || VERSION,
    };
}

function prepareRun(over = {}) {
    return {
        status: 'completed',
        conclusion: 'success',
        event: 'workflow_dispatch',
        path: C.WORKFLOW_PATH,
        head_sha: SHA_A,
        head_repository: { full_name: C.REPOSITORY },
        ...over,
    };
}

function expectCode(name, verdict, code) {
    assert.strictEqual(verdict.ok, false, name + ' should fail');
    assert.strictEqual(verdict.code, code, name + ' expected ' + code + ' got ' + verdict.code + ' (' + verdict.reason + ')');
}

function artifactInput(over = {}) {
    return {
        receipt: over.receipt === undefined ? {
            schema: g.RECEIPT_SCHEMA,
            status: 'PREPARED_NOT_PUBLISHED',
            name: C.CORE_PACKAGE,
            version: VERSION,
            sourceSha: SHA_A,
            tarball: { file: 'pkg-5.0.25.tgz', sha256: 'a'.repeat(64), integrity: SRI_FIXTURE },
            files: ['package.json', 'ui/index.html'],
            baseline: { latest: '5.0.24', next: '5.0.24' },
        } : over.receipt,
        packageName: over.packageName || C.CORE_PACKAGE,
        expectedVersion: over.expectedVersion || VERSION,
        expectedSourceSha: over.expectedSourceSha || SHA_A,
        expectedSha256: over.expectedSha256 || 'a'.repeat(64),
        expectedSRI: over.expectedSRI || SRI_FIXTURE,
        tarballName: over.tarballName || 'pkg-5.0.25.tgz',
        actualSha256: over.actualSha256 || 'a'.repeat(64),
        actualSRI: over.actualSRI || SRI_FIXTURE,
        manifestFiles: over.manifestFiles || ['package.json', 'ui/index.html'],
        manifest: over.manifest === undefined ? { name: C.CORE_PACKAGE, version: VERSION } : over.manifest,
        unsafePaths: over.unsafePaths || [],
    };
}

test('publish accepts a fully valid manual binding', () => {
    const verdict = g.checkPublishBinding(binding());
    assert.strictEqual(verdict.ok, true, JSON.stringify(verdict));
});

test('publish refuses another repository', () => {
    expectCode('wrong repository', g.checkPublishBinding(binding({ repository: 'someone/else' })), 'CI_IDENTITY');
});

test('publish refuses another workflow file', () => {
    expectCode('wrong workflow', g.checkPublishBinding(binding({ workflowRef: C.REPOSITORY + '/.github/workflows/other.yml@main' })), 'WORKFLOW_IDENTITY');
});

test('publish refuses a non manual event', () => {
    expectCode('push event', g.checkPublishBinding(binding({ eventName: 'push' })), 'MANUAL_ONLY');
});

test('publish refuses malformed review hashes', () => {
    expectCode('sha256', g.checkPublishBinding(binding({ expectedSha256: 'abc' })), 'SHA256_FORMAT');
    expectCode('sri', g.checkPublishBinding(binding({ expectedSRI: 'sha512-short' })), 'SRI_FORMAT');
});

test('publish refuses a malformed source commit or run id', () => {
    expectCode('source sha', g.checkPublishBinding(binding({ expectedSourceSha: 'abc' })), 'SHA_FORMAT');
    expectCode('run id', g.checkPublishBinding(binding({ prepareRunId: 'abc' })), 'RUN_ID_FORMAT');
});

test('publish refuses an unreviewed artifact', () => {
    expectCode('reviewer', g.checkPublishBinding(binding({ reviewer: '  ' })), 'REVIEWER_REQUIRED');
});

test('publish refuses a prerelease version', () => {
    expectCode('version', g.checkPublishBinding(binding({ expectedVersion: '5.0.25-rc.1' })), 'VERSION_SEMVER');
});

test('publish refuses an unknown package', () => {
    expectCode('package', g.checkPublishBinding(binding({ packageName: '@sanqianx/other' })), 'PACKAGE_NAME');
});

test('publish refuses the unauthorized desktop package without blocking core', () => {
    expectCode('desktop', g.checkPublishBinding(binding({ packageName: C.DESKTOP_PACKAGE })), 'DESKTOP_IDENTITY_UNAUTHORIZED');
    assert.strictEqual(g.checkPublishBinding(binding({ packageName: C.CORE_PACKAGE })).ok, true);
});

test('publish accepts a successful prepare run of this workflow', () => {
    const verdict = g.checkPrepareRun({ run: prepareRun(), expectedSourceSha: SHA_A, prepareRunId: RUN_ID, currentRunId: '40000000002' });
    assert.strictEqual(verdict.ok, true, JSON.stringify(verdict));
});

test('publish refuses a missing, unfinished or failed prepare run', () => {
    expectCode('missing run', g.checkPrepareRun({ run: null, expectedSourceSha: SHA_A, prepareRunId: RUN_ID, currentRunId: '40000000002' }), 'RUN_MISSING');
    expectCode('not completed', g.checkPrepareRun({ run: prepareRun({ status: 'in_progress' }), expectedSourceSha: SHA_A, prepareRunId: RUN_ID, currentRunId: '40000000002' }), 'RUN_NOT_COMPLETED');
    expectCode('failed', g.checkPrepareRun({ run: prepareRun({ conclusion: 'failure' }), expectedSourceSha: SHA_A, prepareRunId: RUN_ID, currentRunId: '40000000002' }), 'RUN_NOT_SUCCESSFUL');
});

test('publish refuses a prepare run of another event, workflow or source', () => {
    expectCode('event', g.checkPrepareRun({ run: prepareRun({ event: 'push' }), expectedSourceSha: SHA_A, prepareRunId: RUN_ID, currentRunId: '40000000002' }), 'RUN_EVENT');
    expectCode('workflow', g.checkPrepareRun({ run: prepareRun({ path: '.github/workflows/ci.yml' }), expectedSourceSha: SHA_A, prepareRunId: RUN_ID, currentRunId: '40000000002' }), 'RUN_WORKFLOW');
    expectCode('source', g.checkPrepareRun({ run: prepareRun({ head_sha: SHA_B }), expectedSourceSha: SHA_A, prepareRunId: RUN_ID, currentRunId: '40000000002' }), 'RUN_SOURCE');
});

test('publish refuses a prepare run of another repository', () => {
    expectCode('repository', g.checkPrepareRun({ run: prepareRun({ head_repository: { full_name: 'someone/else' } }), expectedSourceSha: SHA_A, prepareRunId: RUN_ID, currentRunId: '40000000002' }), 'RUN_REPOSITORY');
});

test('publish refuses a run that publishes its own artifact', () => {
    expectCode('self', g.checkPrepareRun({ run: prepareRun(), expectedSourceSha: SHA_A, prepareRunId: RUN_ID, currentRunId: RUN_ID }), 'RUN_SELF');
});

test('the artifact directory must hold exactly the receipt and one tarball', () => {
    const ok = g.checkArtifactDirectory({ entries: [{ name: g.RECEIPT_NAME, kind: 'file' }, { name: 'pkg-5.0.25.tgz', kind: 'file' }] });
    assert.strictEqual(ok.ok, true, JSON.stringify(ok));
    expectCode('extra file', g.checkArtifactDirectory({ entries: [{ name: g.RECEIPT_NAME, kind: 'file' }, { name: 'pkg-5.0.25.tgz', kind: 'file' }, { name: 'extra.txt', kind: 'file' }] }), 'ARTIFACT_SHAPE');
    expectCode('directory', g.checkArtifactDirectory({ entries: [{ name: g.RECEIPT_NAME, kind: 'file' }, { name: 'pkg-5.0.25.tgz', kind: 'file' }, { name: 'sub', kind: 'directory' }] }), 'ARTIFACT_SHAPE');
    expectCode('receipt', g.checkArtifactDirectory({ entries: [{ name: 'pkg-5.0.25.tgz', kind: 'file' }, { name: 'other.tgz', kind: 'file' }] }), 'ARTIFACT_RECEIPT');
    expectCode('two tarballs', g.checkArtifactDirectory({ entries: [{ name: g.RECEIPT_NAME, kind: 'file' }, { name: 'a.tgz', kind: 'file' }, { name: 'b.tgz', kind: 'file' }] }), 'ARTIFACT_SHAPE');
    expectCode('path', g.checkArtifactDirectory({ entries: [{ name: g.RECEIPT_NAME, kind: 'file' }, { name: 'nested/pkg.tgz', kind: 'file' }] }), 'ARTIFACT_PATH');
});

test('the receipt, the review hashes and the tarball bytes must agree', () => {
    const verdict = g.checkArtifactBinding(artifactInput());
    assert.strictEqual(verdict.ok, true, JSON.stringify(verdict));
});

test('publish refuses a receipt of another schema or state', () => {
    expectCode('schema', g.checkArtifactBinding(artifactInput({ receipt: { schema: 'other/v1', status: 'PREPARED_NOT_PUBLISHED' } })), 'RECEIPT_SCHEMA');
    expectCode('status', g.checkArtifactBinding(artifactInput({ receipt: { schema: g.RECEIPT_SCHEMA, status: 'PUBLISHED' } })), 'RECEIPT_STATUS');
});

test('publish refuses a receipt of another name, version or source', () => {
    expectCode('name', g.checkArtifactBinding(artifactInput({ receipt: { schema: g.RECEIPT_SCHEMA, status: 'PREPARED_NOT_PUBLISHED', name: '@sanqianx/other', version: VERSION, sourceSha: SHA_A } })), 'RECEIPT_NAME');
    expectCode('version', g.checkArtifactBinding(artifactInput({ receipt: { schema: g.RECEIPT_SCHEMA, status: 'PREPARED_NOT_PUBLISHED', name: C.CORE_PACKAGE, version: '5.0.24', sourceSha: SHA_A } })), 'RECEIPT_VERSION');
    expectCode('source', g.checkArtifactBinding(artifactInput({ receipt: { schema: g.RECEIPT_SCHEMA, status: 'PREPARED_NOT_PUBLISHED', name: C.CORE_PACKAGE, version: VERSION, sourceSha: SHA_B } })), 'RECEIPT_SOURCE');
});

test('publish refuses a reviewed hash that differs from the prepared artifact', () => {
    expectCode('reviewed sha256', g.checkArtifactBinding(artifactInput({ expectedSha256: 'b'.repeat(64) })), 'REVIEW_SHA256');
    expectCode('reviewed sri', g.checkArtifactBinding(artifactInput({ expectedSRI: 'sha512-' + Buffer.alloc(64, 3).toString('base64') })), 'REVIEW_SRI');
});

test('publish refuses bytes that are not the reviewed tarball', () => {
    expectCode('bytes sha256', g.checkArtifactBinding(artifactInput({ actualSha256: 'c'.repeat(64) })), 'BYTES_SHA256');
    expectCode('bytes sri', g.checkArtifactBinding(artifactInput({ actualSRI: 'sha512-' + Buffer.alloc(64, 4).toString('base64') })), 'BYTES_SRI');
});

test('publish refuses a tarball whose manifest differs from the receipt file list', () => {
    expectCode('file count', g.checkArtifactBinding(artifactInput({ manifestFiles: ['package.json'] })), 'MANIFEST_FILES');
    expectCode('extra file', g.checkArtifactBinding(artifactInput({ manifestFiles: ['package.json', 'ui/index.html', 'ui/stray.html'] })), 'MANIFEST_FILES');
});

test('publish refuses an unsafe tarball path', () => {
    expectCode('unsafe path', g.checkArtifactBinding(artifactInput({ unsafePaths: ['package/../evil'] })), 'MANIFEST_UNSAFE');
});

test('publish refuses a tarball whose package.json does not match', () => {
    expectCode('manifest', g.checkArtifactBinding(artifactInput({ manifest: null })), 'MANIFEST_PACKAGE');
    expectCode('manifest name', g.checkArtifactBinding(artifactInput({ manifest: { name: '@sanqianx/other', version: VERSION } })), 'MANIFEST_NAME');
    expectCode('manifest version', g.checkArtifactBinding(artifactInput({ manifest: { name: C.CORE_PACKAGE, version: '5.0.24' } })), 'MANIFEST_VERSION');
});

test('the registry outcome must carry the reviewed integrity', () => {
    const ok = g.checkRegistryOutcome({
        meta: { name: C.CORE_PACKAGE, version: VERSION, dist: { integrity: SRI_FIXTURE } },
        packageName: C.CORE_PACKAGE,
        expectedVersion: VERSION,
        expectedSRI: SRI_FIXTURE,
        nextAfter: VERSION,
        latestAfter: '5.0.24',
        baselineLatest: '5.0.24',
        requireTags: true,
    });
    assert.strictEqual(ok.ok, true, JSON.stringify(ok));
    expectCode('no receipt', g.checkRegistryOutcome({ meta: null, packageName: C.CORE_PACKAGE, expectedVersion: VERSION, expectedSRI: SRI_FIXTURE, requireTags: true }), 'NO_RECEIPT');
    expectCode('integrity', g.checkRegistryOutcome({ meta: { name: C.CORE_PACKAGE, version: VERSION, dist: { integrity: 'sha512-' + Buffer.alloc(64, 9).toString('base64') } }, packageName: C.CORE_PACKAGE, expectedVersion: VERSION, expectedSRI: SRI_FIXTURE, requireTags: true }), 'INTEGRITY');
});

test('a publication must move next and must never move latest', () => {
    expectCode('next', g.checkRegistryOutcome({ meta: { name: C.CORE_PACKAGE, version: VERSION, dist: { integrity: SRI_FIXTURE } }, packageName: C.CORE_PACKAGE, expectedVersion: VERSION, expectedSRI: SRI_FIXTURE, nextAfter: '5.0.24', latestAfter: '5.0.24', baselineLatest: '5.0.24', requireTags: true }), 'NEXT_NOT_MOVED');
    expectCode('latest', g.checkRegistryOutcome({ meta: { name: C.CORE_PACKAGE, version: VERSION, dist: { integrity: SRI_FIXTURE } }, packageName: C.CORE_PACKAGE, expectedVersion: VERSION, expectedSRI: SRI_FIXTURE, nextAfter: VERSION, latestAfter: VERSION, baselineLatest: '5.0.24', requireTags: true }), 'LATEST_CHANGED');
});

test('a reconciliation is not judged by the dist-tag rules', () => {
    const verdict = g.checkRegistryOutcome({
        meta: { name: C.CORE_PACKAGE, version: VERSION, dist: { integrity: SRI_FIXTURE } },
        packageName: C.CORE_PACKAGE,
        expectedVersion: VERSION,
        expectedSRI: SRI_FIXTURE,
        nextAfter: '5.0.24',
        latestAfter: '5.0.24',
        baselineLatest: '5.0.24',
        requireTags: false,
    });
    assert.strictEqual(verdict.ok, true, JSON.stringify(verdict));
});

test('a drifted latest is judged before the transient states', () => {
    const meta = { name: C.CORE_PACKAGE, version: VERSION, dist: { integrity: SRI_FIXTURE } };
    const base = { packageName: C.CORE_PACKAGE, expectedVersion: VERSION, expectedSRI: SRI_FIXTURE, baselineLatest: '5.0.24', requireTags: true };
    // an absent metadata and a drifted latest: terminal, not a propagation
    const absent = g.classifyVisibility(Object.assign({}, base, { meta: null, tags: { next: VERSION, latest: '5.0.26' } }));
    assert.strictEqual(absent.status, 'TERMINAL');
    assert.strictEqual(absent.code, 'LATEST_CHANGED');
    // a stale next tag and a drifted latest: terminal, not a propagation
    const stale = g.classifyVisibility(Object.assign({}, base, { meta, tags: { next: '5.0.24', latest: '5.0.26' } }));
    assert.strictEqual(stale.status, 'TERMINAL');
    assert.strictEqual(stale.code, 'LATEST_CHANGED');
    // the same observations without a drift stay transient
    const propagating = g.classifyVisibility(Object.assign({}, base, { meta: null, tags: { next: VERSION, latest: '5.0.24' } }));
    assert.strictEqual(propagating.status, 'TRANSIENT');
    assert.strictEqual(propagating.code, 'NO_RECEIPT');
    // a reconciliation is never judged by the dist-tag rules
    const reconciliation = g.classifyVisibility(Object.assign({}, base, { meta, tags: { next: '5.0.24', latest: '5.0.26' }, requireTags: false }));
    assert.strictEqual(reconciliation.status, 'VISIBLE');
    // the outcome helper reports the drift before the stale next tag
    expectCode('drift', g.checkRegistryOutcome(Object.assign({}, base, { meta, nextAfter: '5.0.24', latestAfter: '5.0.26' })), 'LATEST_CHANGED');
});

// ---------------------------------------------------------------------------
// End-to-end cases with a fully mocked transport.
// ---------------------------------------------------------------------------

function scenario(options = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stable-next-'));
    const artifactDir = path.join(root, 'artifact');
    const runnerTemp = path.join(root, 'runner');
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.mkdirSync(runnerTemp, { recursive: true });

    const manifest = { name: C.CORE_PACKAGE, version: VERSION };
    const bytes = makeTarball(manifest, { 'ui/index.html': '<html></html>' });
    const sha256 = C.sha256Hex(bytes);
    const sri = C.sriOf(bytes);
    const tarballName = 'sanqianx-project-knowledge-' + VERSION + '.tgz';
    fs.writeFileSync(path.join(artifactDir, tarballName), bytes);
    fs.writeFileSync(path.join(artifactDir, g.RECEIPT_NAME), JSON.stringify({
        schema: g.RECEIPT_SCHEMA,
        status: 'PREPARED_NOT_PUBLISHED',
        name: C.CORE_PACKAGE,
        version: VERSION,
        sourceSha: SHA_A,
        tarball: { file: tarballName, bytes: bytes.length, sha256, integrity: sri },
        fileCount: 2,
        files: ['package.json', 'ui/index.html'],
        baseline: { latest: '5.0.24', next: '5.0.24' },
    }, null, 2));

    const env = {
        GITHUB_REPOSITORY: C.REPOSITORY,
        GITHUB_WORKFLOW_REF: C.WORKFLOW_REF_PREFIX + 'main',
        GITHUB_EVENT_NAME: 'workflow_dispatch',
        GITHUB_RUN_ID: '40000000002',
        RUNNER_TEMP: runnerTemp,
        TARGET_PACKAGE: C.CORE_PACKAGE,
        EXPECTED_VERSION: VERSION,
        EXPECTED_SHA256: options.sha256 || sha256,
        EXPECTED_SRI: options.sri || sri,
        EXPECTED_SOURCE_SHA: SHA_A,
        PREPARE_RUN_ID: RUN_ID,
        REVIEWER: 'lead-reviewer',
        ARTIFACT_DIR: artifactDir,
        GH_TOKEN: 'ghs_fixture_token_value',
    };

    const calls = { npm: [], fetch: [] };
    let versionLookups = 0;
    let tagLookups = 0;
    // The counts let a test prove that a terminal observation stops the route
    // at once, and that a transient one keeps it waiting.
    const counts = { metaPolls: 0, tagLookups: 0 };
    const fetchImpl = async (url) => {
        calls.fetch.push(String(url));
        const target = String(url);
        if (target.startsWith(C.GITHUB_API))
            return { ok: true, status: 200, json: async () => prepareRun() };
        if (target.endsWith('/' + VERSION)) {
            versionLookups += 1;
            if (versionLookups > 1) counts.metaPolls += 1;
            if (options.alreadyPublished)
                return { ok: true, status: 200, json: async () => ({ name: C.CORE_PACKAGE, version: VERSION, dist: { integrity: options.existingIntegrity || sri } }) };
            if (versionLookups === 1)
                return { ok: false, status: 404, json: async () => ({ error: 'Not found' }) };
            const step = options.metaSequence ? options.metaSequence[counts.metaPolls - 1] : 'ok';
            if (step === 'missing')
                return { ok: false, status: 404, json: async () => ({ error: 'Not found' }) };
            if (step === 'wrongIntegrity')
                return { ok: true, status: 200, json: async () => ({ name: C.CORE_PACKAGE, version: VERSION, dist: { integrity: 'sha512-' + Buffer.alloc(64, 9).toString('base64') } }) };
            return { ok: true, status: 200, json: async () => ({ name: C.CORE_PACKAGE, version: VERSION, dist: { integrity: sri } }) };
        }
        counts.tagLookups += 1;
        const next = options.nextSequence ? options.nextSequence[counts.tagLookups - 1] : (options.alreadyPublished ? '5.0.24' : VERSION);
        const latest = options.latestSequence ? options.latestSequence[counts.tagLookups - 1] : '5.0.24';
        return { ok: true, status: 200, json: async () => ({ 'dist-tags': { latest, next } }) };
    };

    const runNpm = (args) => {
        calls.npm.push(args);
        return { status: 0, stdout: 'npm notice published\n', stderr: '' };
    };

    return { root, artifactDir, runnerTemp, env, calls, counts, fetchImpl, runNpm, bytes, sha256, sri, tarballName };
}

test('publish publishes exactly the reviewed bytes to next only', async () => {
    const s = scenario();
    const receipt = await g.publish({ env: s.env, fetchImpl: s.fetchImpl, runNpm: s.runNpm });
    assert.strictEqual(receipt.status, 'PUBLISHED_NEXT');
    assert.strictEqual(receipt.name, C.CORE_PACKAGE);
    assert.strictEqual(receipt.version, VERSION);
    assert.strictEqual(receipt.tarball.sha256, s.sha256);
    assert.strictEqual(receipt.tarball.integrity, s.sri);
    assert.strictEqual(receipt.distTag, 'next');
    assert.strictEqual(receipt.latestUnchanged, true);
    assert.strictEqual(receipt.observed.latest, '5.0.24');
    assert.strictEqual(receipt.observed.next, VERSION);
    assert.strictEqual(s.calls.npm.length, 1);
    assert.deepStrictEqual(s.calls.npm[0].slice(2), ['--tag', 'next', '--access', 'public', '--provenance']);
    assert.strictEqual(s.calls.npm[0][0], 'publish');
    assert.strictEqual(path.basename(s.calls.npm[0][1]), s.tarballName);
    assert.ok(fs.existsSync(path.join(s.runnerTemp, 'stable-next', 'publication-receipt.json')));
});

test('publish never republishes an already published identical version', async () => {
    const s = scenario({ alreadyPublished: true });
    const receipt = await g.publish({ env: s.env, fetchImpl: s.fetchImpl, runNpm: s.runNpm });
    assert.strictEqual(receipt.status, 'ALREADY_PUBLISHED_VERIFIED');
    assert.strictEqual(s.calls.npm.length, 0);
    assert.strictEqual(receipt.observed.next, '5.0.24');
});

test('publish refuses a downloaded tarball that is not the reviewed one', async () => {
    const s = scenario();
    s.env.EXPECTED_SHA256 = 'b'.repeat(64);
    await assert.rejects(() => g.publish({ env: s.env, fetchImpl: s.fetchImpl, runNpm: s.runNpm }), error => {
        assert.ok(['REVIEW_SHA256', 'BYTES_SHA256'].includes(error.code), 'unexpected code ' + error.code);
        return true;
    });
    assert.strictEqual(s.calls.npm.length, 0);
});

test('the tar reader understands an npm shaped tarball', () => {
    const bytes = makeTarball({ name: C.CORE_PACKAGE, version: VERSION }, { 'ui/index.html': '<html></html>' });
    const parsed = C.readTarball(bytes);
    assert.strictEqual(parsed.packageJson.name, C.CORE_PACKAGE);
    assert.strictEqual(parsed.packageJson.version, VERSION);
    assert.deepStrictEqual(C.relativePaths(parsed.files).sort(), ['package.json', 'ui/index.html']);
    assert.deepStrictEqual(C.unsafePaths(parsed.files), []);
});

// ---------------------------------------------------------------------------
// The asynchronous visibility of a publication.
//
// The registry exposes the version metadata and the "next" tag one after the
// other. The route has to wait for BOTH: a metadata that is visible before the
// tag is a propagation state, not a failure.
// ---------------------------------------------------------------------------

test('the metadata may be visible before the next tag points at the candidate', async () => {
    const s = scenario({ nextSequence: ['5.0.24', '5.0.24', VERSION] });
    const receipt = await g.publish({ env: s.env, fetchImpl: s.fetchImpl, runNpm: s.runNpm, pollAttempts: 6, pollDelayMs: 0 });
    assert.strictEqual(s.calls.npm.length, 1, 'the route must publish exactly once');
    assert.strictEqual(receipt.status, 'PUBLISHED_NEXT');
    assert.strictEqual(receipt.observed.next, VERSION);
    assert.ok(receipt.visibility.attempts >= 3, 'the route must wait for the next tag, not only for the metadata');
    assert.strictEqual(receipt.visibility.observations[0].versionVisible, true, 'the metadata was visible before the tag');
    assert.strictEqual(receipt.visibility.observations[0].next, '5.0.24');
    assert.strictEqual(receipt.visibility.observations[receipt.visibility.observations.length - 1].next, VERSION);
});

test('the metadata may be absent for several polls before it appears', async () => {
    const s = scenario({ metaSequence: ['missing', 'missing', 'ok'] });
    const receipt = await g.publish({ env: s.env, fetchImpl: s.fetchImpl, runNpm: s.runNpm, pollAttempts: 6, pollDelayMs: 0 });
    assert.strictEqual(s.calls.npm.length, 1, 'the route must publish exactly once');
    assert.strictEqual(receipt.status, 'PUBLISHED_NEXT');
    assert.ok(receipt.visibility.attempts >= 3, 'the route must wait for the metadata to appear');
    assert.strictEqual(receipt.visibility.observations[0].versionVisible, false);
    assert.strictEqual(receipt.visibility.observations[receipt.visibility.observations.length - 1].versionVisible, true);
});

test('a registry artifact with another integrity stops the route at once', async () => {
    const s = scenario({ metaSequence: ['wrongIntegrity'] });
    await assert.rejects(() => g.publish({ env: s.env, fetchImpl: s.fetchImpl, runNpm: s.runNpm, pollAttempts: 6, pollDelayMs: 0 }), error => {
        assert.strictEqual(error.code, 'INTEGRITY');
        return true;
    });
    assert.strictEqual(s.calls.npm.length, 1, 'the route must publish exactly once and never retry');
    assert.strictEqual(s.counts.metaPolls, 1, 'a wrong artifact is terminal, not a propagation');
});

test('a latest that moved away from the baseline stops the route at once', async () => {
    const s = scenario({ latestSequence: ['5.0.26'] });
    await assert.rejects(() => g.publish({ env: s.env, fetchImpl: s.fetchImpl, runNpm: s.runNpm, pollAttempts: 6, pollDelayMs: 0 }), error => {
        assert.strictEqual(error.code, 'LATEST_CHANGED');
        return true;
    });
    assert.strictEqual(s.calls.npm.length, 1, 'the route must publish exactly once and never retry');
    assert.strictEqual(s.counts.metaPolls, 1, 'a drifted latest is terminal, not a propagation');
});

test('an absent metadata does not hide a latest that moved away from the baseline', async () => {
    const s = scenario({ metaSequence: ['missing', 'missing', 'missing'], latestSequence: ['5.0.26'] });
    await assert.rejects(() => g.publish({ env: s.env, fetchImpl: s.fetchImpl, runNpm: s.runNpm, pollAttempts: 6, pollDelayMs: 0 }), error => {
        assert.strictEqual(error.code, 'LATEST_CHANGED');
        return true;
    });
    assert.strictEqual(s.calls.npm.length, 1, 'the route must publish exactly once and never retry');
    assert.strictEqual(s.counts.metaPolls, 1, 'a drifted latest is terminal even when the metadata is absent');
});

test('a stale next tag does not hide a latest that moved away from the baseline', async () => {
    const s = scenario({ nextSequence: ['5.0.24'], latestSequence: ['5.0.26'] });
    await assert.rejects(() => g.publish({ env: s.env, fetchImpl: s.fetchImpl, runNpm: s.runNpm, pollAttempts: 6, pollDelayMs: 0 }), error => {
        assert.strictEqual(error.code, 'LATEST_CHANGED');
        return true;
    });
    assert.strictEqual(s.calls.npm.length, 1, 'the route must publish exactly once and never retry');
    assert.strictEqual(s.counts.metaPolls, 1, 'a drifted latest is terminal even when the next tag is stale');
});

test('an expired visibility deadline is recorded as pending and never as a pass', async () => {
    const s = scenario({ metaSequence: ['missing', 'missing', 'missing'] });
    await assert.rejects(() => g.publish({ env: s.env, fetchImpl: s.fetchImpl, runNpm: s.runNpm, pollAttempts: 3, pollDelayMs: 0 }), error => {
        assert.strictEqual(error.code, 'VISIBILITY_TIMEOUT');
        return true;
    });
    assert.strictEqual(s.calls.npm.length, 1, 'the route must publish exactly once and never retry');
    const receipt = JSON.parse(fs.readFileSync(path.join(s.runnerTemp, 'stable-next', 'publication-receipt.json'), 'utf8'));
    assert.strictEqual(receipt.status, 'PENDING_VISIBILITY');
    assert.strictEqual(receipt.verified, false, 'a pending publication is never a verified publication');
    assert.strictEqual(receipt.publishExitStatus, 0, 'the npm CLI did exit 0');
    assert.strictEqual(receipt.sourceSha, SHA_A);
    assert.strictEqual(receipt.tarball.sha256, s.sha256);
    assert.strictEqual(receipt.tarball.integrity, s.sri);
    assert.strictEqual(receipt.observed.versionVisible, false);
    assert.strictEqual(receipt.visibility.attempts, 3);
    assert.ok(receipt.visibility.observations.length > 0, 'the receipt must carry the observations');
    assert.ok(/NOT an authentication failure/i.test(receipt.note), 'the receipt must deny an authentication failure');
    assert.ok(/NOT verified/i.test(receipt.note), 'the receipt must deny a verified publication');
});

test('an occupied version is reconciled without a write and without waiting for a tag', async () => {
    const s = scenario({ alreadyPublished: true });
    const receipt = await g.publish({ env: s.env, fetchImpl: s.fetchImpl, runNpm: s.runNpm, pollAttempts: 6, pollDelayMs: 0 });
    assert.strictEqual(s.calls.npm.length, 0, 'an occupied version must not be published again');
    assert.strictEqual(receipt.status, 'ALREADY_PUBLISHED_VERIFIED');
    assert.strictEqual(receipt.observed.next, '5.0.24', 'a reconciliation never moves the next tag');
    assert.strictEqual(receipt.visibility.attempts, 1, 'a reconciliation needs no tag propagation');
});
