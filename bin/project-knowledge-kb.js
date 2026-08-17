#!/usr/bin/env node

const { KnowledgeToolRuntime } = require('../_site/lib/knowledge-tool-runtime');
const { serializeErrorEnvelope, createId } = require('../_site/lib/contracts');

function parseOptions(args) {
  const first = args[0] || 'help';
  const output = { command: first === '--help' || first === '-h' ? 'help' : first };
  for (let index = 1; index < args.length; index += 1) {
    const key = args[index];
    if (!key.startsWith('--')) continue;
    const name = key.slice(2).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
    if (args[index + 1] && !args[index + 1].startsWith('--')) output[name] = args[++index];
    else output[name] = true;
  }
  return output;
}

function help() {
  process.stdout.write(`project-knowledge-kb

Read-only local knowledge tools:
  project-knowledge-kb search  --project <projectId-or-legacy-slug> --query <text> [--limit 8]
  project-knowledge-kb ask     --project <projectId-or-legacy-slug> --query <text> [--limit 8]
  project-knowledge-kb get     --project <projectId-or-legacy-slug> --entry <path>
  project-knowledge-kb history --project <projectId-or-legacy-slug> [--limit 20]

Add --json for machine-readable output. These commands never modify knowledge or project configuration.\n`);
}

async function main(argv = process.argv.slice(2), options = {}) {
  const args = parseOptions(argv);
  if (args.command === 'help' || args.help) {
    help();
    return 0;
  }
  if (!['search', 'ask', 'get', 'history'].includes(args.command)) throw new Error(`unknown command: ${args.command}`);
  if (!args.project) throw new Error('--project is required');
  const runtime = options.runtime || new KnowledgeToolRuntime(options);
  try {
    const input = { project: args.project, query: args.query, limit: args.limit, entry: args.entry };
    let result;
    if (args.command === 'search') result = await runtime.search(input);
    else if (args.command === 'ask') result = await runtime.ask(input);
    else if (args.command === 'get') result = await runtime.get(input);
    else result = await runtime.history(input);
    if (args.json || args.command !== 'ask') process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else process.stdout.write(`${result.answer}\n`);
    return 0;
  } finally {
    await runtime.close();
  }
}

if (require.main === module) {
  const jsonMode = process.argv.includes('--json');
  const operationId = createId('op');
  main().catch(error => {
    if (jsonMode) process.stderr.write(`${JSON.stringify(serializeErrorEnvelope(error, operationId))}\n`);
    else process.stderr.write(`project-knowledge-kb: ${String(error && error.message || 'The operation failed.')} [${operationId}]\n`);
    process.exitCode = 1;
  });
}

module.exports = { main, parseOptions };
