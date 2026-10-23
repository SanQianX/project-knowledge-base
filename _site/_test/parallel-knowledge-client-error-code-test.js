'use strict';
// Parallel knowledge lane — regression for the engine error-code contract.
//
// The vendored knowledge-engine reports a failed read as { ok:false,
// error:'<CODE>' } with the code as a plain string. The product client used to
// read the code only from payload.error.code, so every genuine business
// failure was flattened into the generic ENGINE_REQUEST_FAILED and the real
// reason was lost for the shell and for the MCP tools.
//
// This file pins the contract on a real loopback HTTP server:
//   * the string envelope keeps its code;
//   * the object envelope keeps its code;
//   * an invalid code still falls back to ENGINE_REQUEST_FAILED;
//   * the HTTP status is preserved on the raised DomainError;
//   * a successful read is unchanged.
//
// It validates the CURRENT PRODUCT only. It never reads the Git history, the
// current HEAD, a remote repository or any pre-existing object, so it stays
// green after the fix is committed and in a shallow checkout or an exported
// tree without a .git directory.
//
// The historical red reproduction (the pre-fix client failing this matrix)
// was removed from this entry point on purpose: it depended on `git show
// HEAD:...`, which turns a fixed defect red the moment the fix lands. It is
// preserved as ignored evidence instead, together with a fixed snapshot of
// the pre-fix source, so the defect stays documented without the canonical
// regression depending on Git history:
//   qa-autopilot/artifacts/parallel-20261023/test-knowledge/legacy/
//
// Nothing here touches the live 5757/5790/8787/8790 endpoints or the real
// HOME: the entry point isolates itself before loading any product module.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const fixture = require('./helpers/parallel-knowledge-fixture');
fixture.isolateProcess();
const { StorageLayout } = require('../lib/storage-layout');
const { EngineKnowledgeClient } = require('../lib/engine-knowledge-client');

// --only=patched is accepted as an explicit alias of the default run. No
// other mode exists here: the historical --only=head mode was moved to the
// ignored legacy evidence and must not be reintroduced, because a canonical
// test that depends on Git history is red by construction after the fix is
// committed.
const LEGACY_HEAD_MODE = '--only=head';

function createEngineStub({ repoPath, knowledgePath, projectId, envelope }) {
  const server = http.createServer((req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.url === '/api/health') return send(200, { name: 'knowledge-engine', dataSchemaVersion: 3 });
    if (req.url === '/api/projects') {
      return send(200, { ok: true, projects: [{ projectId, enabled: true, repoPath, knowledgePath }] });
    }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        if (envelope.kind === 'success') return send(200, { ok: true, results: [], answer: 'ok', citations: [] });
        return send(envelope.status, envelope.body);
      });
      return;
    }
    return send(404, { ok: false, error: 'NOT_FOUND' });
  });
  return server;
}

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  fixture.assertAllowedPort(port, 'test engine port');
  return `http://127.0.0.1:${port}`;
}

const SCENARIOS = [
  {
    id: 'string-envelope-code-kept',
    envelope: { kind: 'failure', status: 403, body: { ok: false, error: 'PATH_OUTSIDE_ROOT' } },
    expectedCode: 'PATH_OUTSIDE_ROOT',
    expectedStatus: 403,
  },
  {
    id: 'object-envelope-code-kept',
    envelope: { kind: 'failure', status: 404, body: { ok: false, error: { code: 'PROJECT_NOT_FOUND' } } },
    expectedCode: 'PROJECT_NOT_FOUND',
    expectedStatus: 404,
  },
  {
    id: 'invalid-code-falls-back',
    envelope: { kind: 'failure', status: 500, body: { ok: false, error: 'not a valid code!' } },
    expectedCode: 'ENGINE_REQUEST_FAILED',
    expectedStatus: 500,
  },
  {
    id: 'ok-false-on-200-becomes-502',
    envelope: { kind: 'failure', status: 200, body: { ok: false, error: 'INVALID_ARGUMENT' } },
    expectedCode: 'INVALID_ARGUMENT',
    expectedStatus: 502,
  },
];

(async () => {
  const args = process.argv.slice(2);
  if (args.includes(LEGACY_HEAD_MODE)) {
    console.error(`${LEGACY_HEAD_MODE} was removed from this canonical entry point.`);
    console.error('The pre-fix red reproduction now lives in the ignored evidence:');
    console.error('  qa-autopilot/artifacts/parallel-20261023/test-knowledge/legacy/reproduce-pre-fix-client.js');
    console.error('It uses a fixed source snapshot, so the canonical regression never depends on Git history.');
    process.exitCode = 2;
    return;
  }

  const root = fixture.makeTempDir('parallel-knowledge-client');
  const layout = new StorageLayout({ dataDir: path.join(root, 'data') });
  const repoPath = path.join(root, 'repo');
  const knowledgePath = path.join(root, 'knowledge');
  fs.mkdirSync(repoPath, { recursive: true });
  fs.mkdirSync(knowledgePath, { recursive: true });
  const project = { projectId: 'project-client', repoPath, knowledgePath };
  const results = [];

  function record(caseId, status, detail) {
    results.push({ caseId, status, detail });
    console.log(`CASE ${caseId} ${status} ${JSON.stringify(detail)}`);
  }

  try {
    for (const scenario of SCENARIOS) {
      const server = createEngineStub({ ...project, envelope: scenario.envelope });
      const engineUrl = await listen(server);
      try {
        const client = new EngineKnowledgeClient({ layout, engineUrl });
        let raised = null;
        try {
          await client.request('search', { query: 'x' }, project);
        } catch (error) { raised = error; }
        assert.ok(raised, 'the client must reject a failed read');
        assert.equal(raised.code, scenario.expectedCode, `unexpected code for ${scenario.id}`);
        assert.equal(raised.status, scenario.expectedStatus, `unexpected status for ${scenario.id}`);
        record(`CLIENT-${scenario.id}`, 'PASS', { code: raised.code, status: raised.status, engineUrl });
      } finally {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
      }
    }

    // A successful read must still succeed.
    {
      const server = createEngineStub({ ...project, envelope: { kind: 'success' } });
      const engineUrl = await listen(server);
      try {
        const client = new EngineKnowledgeClient({ layout, engineUrl });
        const payload = await client.request('search', { query: 'x' }, project);
        assert.equal(payload.ok, true);
        assert.ok(Array.isArray(payload.results));
        record('CLIENT-success-envelope-untouched', 'PASS', { ok: payload.ok, resultCount: payload.results.length });
      } finally {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
      }
    }

    const summary = {
      lane: 'test-knowledge',
      file: 'parallel-knowledge-client-error-code-test.js',
      cases: results,
      productionTouched: false,
      gitHistoryUsed: false,
      note: 'the canonical regression validates the current product only; the pre-fix red reproduction was moved to the ignored legacy evidence and runs against a fixed source snapshot',
      legacyRedEvidence: 'qa-autopilot/artifacts/parallel-20261023/test-knowledge/legacy/',
    };
    const target = process.env.PARALLEL_KNOWLEDGE_EVIDENCE;
    if (target) fs.mkdirSync(path.dirname(target), { recursive: true });
    if (target) fs.writeFileSync(target, JSON.stringify(summary, null, 2), 'utf8');
    console.log('parallel-knowledge-client-error-code-test PASS');
  } finally {
    fixture.removeTree(root);
    fixture.cleanupIsolatedProcess();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
