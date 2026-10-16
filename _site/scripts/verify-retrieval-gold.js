'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

async function verify({ url, projects, fixtureRoot, queries, reportPath }) {
  const root = path.resolve(fixtureRoot);
  const inside = file => { const relative = path.relative(root, path.resolve(file)); return relative && !relative.startsWith('..') && !path.isAbsolute(relative); };
  const report = { passed: false, source: 'real engine and configured remote embeddings', startedAt: new Date().toISOString(), cases: [], metrics: {} };
  const save = () => fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  let semanticHits = 0, vectorCases = 0, checkedCitations = 0, badCitations = 0, scopeLeaks = 0, deepReads = 0, snippetFactHits = 0;
  for (const q of queries) {
    const project = projects[q.project];
    if (!project || !inside(project.knowledgePath)) throw new Error('gold corpus must be bound to an explicit isolated fixture root');
    const item = { id: q.id, kind: q.kind, query: q.query, passed: false };
    let hidden, target;
    try {
      if (q.kind === 'stale') {
        target = path.resolve(project.knowledgePath, q.entry);
        if (!inside(target) || fs.lstatSync(target).isSymbolicLink()) throw new Error('unsafe stale-test path');
        hidden = path.join(root, `gold-hidden-${q.id}.md`);
        if (fs.existsSync(hidden)) throw new Error('prior interrupted stale test needs recovery');
        fs.renameSync(target, hidden);
      }
      const response = await fetch(new URL('/api/engine/search', url), { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: project.projectId, scope: 'project', query: q.query, limit: 5 }), signal: AbortSignal.timeout(20000) });
      const result = await response.json();
      if (!response.ok) throw new Error(`search failed with HTTP ${response.status}`);
      const rows = result.results || [];
      item.health = result.health;
      item.matchStatus = result.matchStatus;
      item.results = rows;
      let citationErrors = 0, leaks = 0;
      for (const row of rows) {
        checkedCitations++;
        if (row.scope_project_id !== project.projectId) { leaks++; continue; }
        const file = path.resolve(project.knowledgePath, row.entry_id);
        if (!inside(file) || !fs.existsSync(file)) { citationErrors++; continue; }
        const body = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
        const snippet = String(row.chunk_text || '').replace(/\r\n/g, '\n');
        const hash = crypto.createHash('sha256').update(snippet).digest('hex');
        if (!snippet.trim() || !body.includes(snippet) || hash !== row.content_hash) citationErrors++;
      }
      badCitations += citationErrors; scopeLeaks += leaks;
      const documentHit = rows.some(row => row.entry_id === q.entry);
      const snippetFactHit = rows.some(row => row.entry_id === q.entry && (!q.fact || String(row.chunk_text).toLowerCase().includes(q.fact.toLowerCase())));
      let factRetrieved = snippetFactHit;
      if (q.fact && documentHit && !snippetFactHit) {
        // Search locates documents; an agent may then get the selected entry.
        // Record this separately rather than claiming a snippet contained it.
        const detail = await fetch(new URL('/api/engine/get', url), { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectId: project.projectId, entryId: q.entry, scope: 'project' }), signal: AbortSignal.timeout(10000) });
        const full = await detail.json();
        const text = full.chunks?.map(chunk => chunk.chunk_text).join('\n') || '';
        const source = fs.readFileSync(path.resolve(project.knowledgePath, q.entry), 'utf8');
        factRetrieved = detail.ok && text === source && text.toLowerCase().includes(q.fact.toLowerCase());
        item.followupRead = { entry: q.entry, passed: factRetrieved, sha256: crypto.createHash('sha256').update(text).digest('hex') };
        deepReads++;
      }
      item.documentHit = documentHit; item.snippetFactHit = snippetFactHit;
      const vector = rows.some(row => row.match_channels?.includes('index:vector-hub')) && result.health?.vectorMode === 'verified-chunks';
      if (q.kind === 'semantic') { if (documentHit) semanticHits++; if (vector) vectorCases++; if (snippetFactHit) snippetFactHits++; }
      item.passed = !citationErrors && !leaks && (q.empty ? rows.length === 0
        : q.kind === 'stale' ? rows.every(row => row.entry_id !== q.entry)
        : q.kind === 'isolation' ? true : documentHit && factRetrieved && (q.kind !== 'semantic' || vector));
      item.citationErrors = citationErrors; item.scopeLeaks = leaks;
    } catch (error) { item.error = error.message; }
    finally { if (hidden && fs.existsSync(hidden)) { if (fs.existsSync(target)) throw new Error('stale-test source changed concurrently; backup retained'); fs.renameSync(hidden, target); } }
    report.cases.push(item); save();
    console.log(`${item.passed ? 'PASS' : 'FAIL'} ${q.id} ${q.kind}`);
  }
  report.metrics = { semanticRecallAt5: semanticHits / queries.filter(q => q.kind === 'semantic').length, semanticSnippetFactCoverage: snippetFactHits / 10, followupEntryReads: deepReads, semanticVectorCases: vectorCases, checkedCitations, badCitations, scopeLeaks };
  report.passed = report.cases.every(c => c.passed) && report.metrics.semanticRecallAt5 >= 0.9 && vectorCases === 10 && !badCitations && !scopeLeaks;
  report.finishedAt = new Date().toISOString(); save();
  return report;
}

if (require.main === module) {
  const env = JSON.parse(fs.readFileSync(path.resolve(process.argv[2]), 'utf8'));
  const queries = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../_test/fixtures/retrieval-gold-queries.json'), 'utf8'));
  verify({ ...env, queries, reportPath: path.resolve(process.argv[3]) }).then(report => { console.log(JSON.stringify(report.metrics)); process.exitCode = report.passed ? 0 : 1; }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { verify };
