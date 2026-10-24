'use strict';
// Shared primitives for the manual stable "next" candidate route.
//
// Two independent manual modes live in .github/workflows/publish.yml:
//
//   prepare      - builds a candidate tarball from one reviewed commit and
//                  records an immutable metadata receipt;
//   publish-next - publishes exactly those reviewed bytes to the "next" tag.
//
// Everything here is a pure function or a thin, injectable I/O helper so the
// offline tests can exercise the production logic without a network, without
// npm and without a GitHub runner.

const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { must } = require('../lib/safety.cjs');

const REPOSITORY = 'SanQianX/project-knowledge-base';
const WORKFLOW_PATH = '.github/workflows/publish.yml';
const WORKFLOW_REF_PREFIX = REPOSITORY + '/' + WORKFLOW_PATH + '@';
const CORE_PACKAGE = '@sanqianx/project-knowledge';
const DESKTOP_PACKAGE = '@sanqianx/project-knowledge-desktop';
const ALLOWED_PACKAGES = Object.freeze([CORE_PACKAGE, DESKTOP_PACKAGE]);
const REGISTRY = 'https://registry.npmjs.org';
const GITHUB_API = 'https://api.github.com';
const SHA40 = /^[a-f0-9]{40}$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const SRI = /^sha512-[A-Za-z0-9+/]{86}={0,2}$/;
const STABLE_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const RUN_ID = /^[1-9]\d{0,19}$/;

// The non-release CI matrix: three core jobs and three QA jobs. A candidate
// source is only acceptable when the CURRENT run of the CI workflow for that
// exact commit passed all six.
const REQUIRED_CI_JOBS = Object.freeze([
    'Core / Node 22.x / Linux',
    'Core / Node 24.x / Linux',
    'Core (web runtime) / Windows',
    'QA controller / Node 22.x / Linux',
    'QA controller / Node 24.x / Linux',
    'QA controller / Windows',
]);

function firstProblem(checks) {
    for (const { when, code, reason } of checks) {
        if (when)
            return { ok: false, code, reason };
    }
    return { ok: true };
}

function sha256Hex(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

function sriOf(buffer) {
    return 'sha512-' + crypto.createHash('sha512').update(buffer).digest('base64');
}

function readString(buffer, offset, length) {
    const slice = buffer.subarray(offset, offset + length);
    const end = slice.indexOf(0);
    return slice.toString('utf8', 0, end === -1 ? slice.length : end);
}

function parsePaxPath(data) {
    const text = data.toString('utf8');
    let out = null, index = 0;
    while (index < text.length) {
        const space = text.indexOf(' ', index);
        if (space === -1)
            break;
        const length = Number.parseInt(text.slice(index, space), 10);
        if (!Number.isFinite(length) || length <= 0)
            break;
        const record = text.slice(space + 1, index + length).replace(/\n$/, '');
        const eq = record.indexOf('=');
        if (eq > 0 && record.slice(0, eq) === 'path')
            out = record.slice(eq + 1);
        index += length;
    }
    return out;
}

// Minimal tar reader: npm tarballs are gzip streams of ustar entries. Only
// regular files and directories are reported; the package manifest is
// returned separately so the caller can bind name and version.
function readTarball(buffer) {
    const tar = zlib.gunzipSync(buffer);
    const files = [];
    let packageJson = null;
    let offset = 0, longName = null, paxName = null;
    while (offset + 512 <= tar.length) {
        const header = tar.subarray(offset, offset + 512);
        if (header.every(byte => byte === 0))
            break;
        const rawName = readString(header, 0, 100);
        const prefix = readString(header, 345, 155);
        const size = Number.parseInt(readString(header, 124, 12).trim() || '0', 8) || 0;
        const type = String.fromCharCode(header[156] || 0x30);
        const dataStart = offset + 512;
        const data = tar.subarray(dataStart, dataStart + size);
        offset = dataStart + Math.ceil(size / 512) * 512;
        if (type === 'L') {
            longName = data.toString('utf8').replace(/\0+$/, '');
            continue;
        }
        if (type === 'x' || type === 'X' || type === 'g') {
            const pax = parsePaxPath(data);
            if (pax)
                paxName = pax;
            continue;
        }
        const name = paxName || longName || (prefix ? prefix + '/' + rawName : rawName);
        paxName = null;
        longName = null;
        if (type === '5') {
            files.push({ path: name, type: 'directory', size: 0 });
            continue;
        }
        if (type !== '0' && type !== '\0' && type !== '7')
            continue;
        files.push({ path: name, type: 'file', size });
        if (name === 'package/package.json')
            packageJson = JSON.parse(data.toString('utf8'));
    }
    return { files, packageJson };
}

// A published tarball must not carry absolute paths, parent traversal or
// backslash separators, and every entry lives under the npm "package/" root.
function unsafePaths(files) {
    const bad = [];
    for (const file of files) {
        const name = file.path;
        if (name.startsWith('/') || name.includes('\\') || /^[A-Za-z]:/.test(name))
            bad.push(name);
        else if (name.split('/').some(segment => segment === '..' || segment === ''))
            bad.push(name);
        else if (!name.startsWith('package/'))
            bad.push(name);
    }
    return bad;
}

function relativePaths(files) {
    return files.filter(file => file.type === 'file').map(file => file.path.replace(/^package\//, ''));
}

// The candidate may only contain bytes that the reviewed commit actually
// tracks: a dirty worktree with stray files must never reach a tarball.
function untrackedPaths(packedPaths, trackedPaths) {
    const tracked = new Set(trackedPaths);
    return packedPaths.filter(name => !tracked.has(name));
}

async function registryDocument(packageName, suffix, fetchImpl) {
    const url = REGISTRY + '/' + encodeURIComponent(packageName) + suffix;
    const response = await fetchImpl(url, {
        headers: { accept: 'application/vnd.npm.install-v1+json, application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(20000),
    });
    if (response.status === 404)
        return null;
    must(response.ok, 'REGISTRY', 'Registry lookup failed (' + response.status + ')', 20);
    return response.json();
}

async function registryVersionMeta(packageName, version, fetchImpl) {
    return registryDocument(packageName, '/' + encodeURIComponent(version), fetchImpl);
}

async function registryDistTags(packageName, fetchImpl) {
    const document = await registryDocument(packageName, '', fetchImpl);
    must(document && document['dist-tags'], 'REGISTRY', 'Registry document has no dist-tags', 20);
    return document['dist-tags'];
}

// GitHub API access never leaks a response body: only the status code is
// reported, and the token travels in the request header only.
async function githubJson(apiPath, token, fetchImpl) {
    const headers = { accept: 'application/vnd.github+json' };
    if (token)
        headers.authorization = 'Bearer ' + token;
    const response = await fetchImpl(GITHUB_API + apiPath, { headers, signal: AbortSignal.timeout(20000) });
    must(response.ok, 'GITHUB_API', 'GitHub API lookup failed (' + response.status + ')', 20);
    return response.json();
}

function assertRunnerIdentity(env, eventName) {
    must(env.GITHUB_REPOSITORY === REPOSITORY, 'CI_IDENTITY', 'Only ' + REPOSITORY + ' may run this route');
    const ref = typeof env.GITHUB_WORKFLOW_REF === 'string' ? env.GITHUB_WORKFLOW_REF : '';
    must(ref.startsWith(WORKFLOW_REF_PREFIX), 'WORKFLOW_IDENTITY', 'The job must run from ' + WORKFLOW_PATH);
    must(eventName === 'workflow_dispatch', 'MANUAL_ONLY', 'This route only runs on a manual dispatch');
}

module.exports = {
    REPOSITORY, WORKFLOW_PATH, WORKFLOW_REF_PREFIX, CORE_PACKAGE, DESKTOP_PACKAGE, ALLOWED_PACKAGES,
    REGISTRY, GITHUB_API, SHA40, SHA256_HEX, SRI, STABLE_VERSION, RUN_ID, REQUIRED_CI_JOBS,
    firstProblem, sha256Hex, sriOf, readTarball, unsafePaths, relativePaths, untrackedPaths,
    registryVersionMeta, registryDistTags, githubJson, assertRunnerIdentity,
};
