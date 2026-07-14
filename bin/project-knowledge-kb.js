#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { getDataDir } = require('../_site/lib/data-dir');
const { KnowledgeDatabase } = require('../_site/lib/knowledge-db');
const { LocalEmbeddingService } = require('../_site/lib/embedding-service');
const { KnowledgeScopeRegistry } = require('../_site/lib/knowledge-scope-registry');
const { KnowledgeQueryService } = require('../_site/lib/knowledge-query-service');

function options(args) {
  const first = args[0] || 'help';
  const out = { command: first === '--help' || first === '-h' ? 'help' : first };
  for (let i = 1; i < args.length; i++) {
    const key = args[i];
    if (!key.startsWith('--')) continue;
    const name = key.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (args[i + 1] && !args[i + 1].startsWith('--')) out[name] = args[++i];
    else out[name] = true;
  }
  return out;
}

function help() {
  console.log(`project-knowledge-kb

Read-only local knowledge tools:
  project-knowledge-kb search  --project <slug> --query <text> [--limit 8]
  project-knowledge-kb ask     --project <slug> --query <text> [--limit 8]
  project-knowledge-kb get     --project <slug> --entry <path> [--space <space-id>]
  project-knowledge-kb history --project <slug> [--limit 20]

Add --json for machine-readable output. These commands never modify knowledge.`);
}

async function main() {
  const args = options(process.argv.slice(2));
  if (args.command === 'help' || args.help) return help();
  if (!['search', 'ask', 'get', 'history'].includes(args.command)) throw new Error(`unknown command: ${args.command}`);
  if (!args.project) throw new Error('--project is required');
  const dataDir = getDataDir();
  const projectsPath = path.join(dataDir, 'projects.json');
  const projects = JSON.parse(fs.readFileSync(projectsPath, 'utf8'));
  const database = new KnowledgeDatabase({ dbPath: path.join(dataDir, 'knowledge.lancedb') });
  const embedder = new LocalEmbeddingService({ cacheDir: path.join(dataDir, 'models') });
  const scopeRegistry = new KnowledgeScopeRegistry({ filePath: path.join(dataDir, 'knowledge-scopes.json') });
  const service = new KnowledgeQueryService({ database, embedder, scopeRegistry, readProjects: () => projects });
  try {
    let result;
    if (args.command === 'search') result = await service.search({ projectSlug: args.project, query: args.query, limit: args.limit });
    else if (args.command === 'ask') result = await service.ask({ projectSlug: args.project, query: args.query, limit: args.limit });
    else if (args.command === 'get') result = await service.get({ projectSlug: args.project, entryId: args.entry, spaceId: args.space });
    else result = await service.history({ projectSlug: args.project, limit: args.limit });
    if (args.json) console.log(JSON.stringify(result, null, 2));
    else if (args.command === 'ask') console.log(result.answer);
    else console.log(JSON.stringify(result, null, 2));
  } finally {
    await database.close();
  }
}

main().catch(error => {
  console.error(`project-knowledge-kb: ${error.message}`);
  process.exit(1);
});
