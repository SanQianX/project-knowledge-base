'use strict';

const { createEngineServer } = require('@sanqianx/ai-coding-knowledge-engine');
const { corpus, evaluate, setup } = require('./helpers/agentic-context-fixture');

async function main() {
  const fixture = await setup({ createEngineServer });
  try {
    const rows = [];
    for (const item of corpus.cases) {
      for (const [index, query] of item.queries.entries()) {
        const sessionId = `${item.id}-${index}`;
        const result = await fixture.request('/api/context', { projectId: fixture.projectId, query, scope: 'project', client: 'codex', sessionId });
        rows.push({ case: sessionId, split: index === 0 ? 'debug' : 'blind', ...evaluate(result, item) });
      }
    }
    console.log(JSON.stringify({ corpusVersion: corpus.version, group: 'B', engine: '0.4.2', condition: 'controlled lexical fallback', rows }, null, 2));
  } finally {
    await fixture.close();
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
