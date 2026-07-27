#!/usr/bin/env node

const {
  IntegrationManager,
  SUPPORTED_CLIENTS,
  normalizeClient,
} = require('../_site/lib/integration-installer');

function printHelp() {
  console.log(`project-knowledge-integrations

Install Project Knowledge for coding agents.

Usage:
  project-knowledge-integrations install [--ide <client>] [--scope <scope>]
  project-knowledge-integrations update [--ide <client>] [--scope <scope>]
  project-knowledge-integrations uninstall [--ide <client>] [--scope <scope>]
  project-knowledge-integrations status [--ide <client>]

Clients:
  claude       Claude Code plugin (MCP + Skill)
  opencode     OpenCode MCP + global Skill
  codex        Codex plugin (MCP + Skill)
  all          All supported clients

Options:
      --ide <client>       Repeat or use a comma-separated list
      --scope <scope>      Claude scope: user, project, or local (default: user)
      --marketplace <src>  Marketplace GitHub repo, Git URL, or local path
      --dry-run            Show intended operations without changing config
      --json               Print machine-readable results
  -h, --help               Show this help

Without --ide, installed clients are detected automatically.`);
}

function parseArgs(argv) {
  const operation = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'status';
  const start = operation === 'status' && (!argv[0] || argv[0].startsWith('-')) ? 0 : 1;
  const options = {
    operation,
    clients: [],
    scope: 'user',
    dryRun: false,
    json: false,
    help: false,
    marketplaceSource: '',
  };
  for (let i = start; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--ide' && argv[i + 1]) {
      options.clients.push(...argv[++i].split(',').filter(Boolean));
    } else if (arg === '--all') {
      options.clients.push('all');
    } else if (arg === '--scope' && argv[i + 1]) {
      options.scope = argv[++i];
    } else if (arg === '--marketplace' && argv[i + 1]) {
      options.marketplaceSource = argv[++i];
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }
  if (!['install', 'update', 'uninstall', 'status'].includes(options.operation)) {
    throw new Error(`unknown operation: ${options.operation}`);
  }
  if (!['user', 'project', 'local'].includes(options.scope)) {
    throw new Error(`unsupported scope: ${options.scope}`);
  }
  return options;
}

function selectClients(requested, manager) {
  if (requested.some(item => String(item).toLowerCase() === 'all')) return [...SUPPORTED_CLIENTS];
  if (requested.length) return [...new Set(requested.map(normalizeClient))];
  const detected = manager.detectClients();
  if (detected.length) return detected;
  return [...SUPPORTED_CLIENTS];
}

async function runCli(argv = process.argv.slice(2), dependencies = {}) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return 0;
  }
  const manager = dependencies.manager || new IntegrationManager({
    dryRun: options.dryRun,
    marketplaceSource: options.marketplaceSource || undefined,
  });
  const clients = selectClients(options.clients, manager);
  const results = await manager.operate(options.operation, clients, { scope: options.scope });
  if (options.json) {
    console.log(JSON.stringify({
      operation: options.operation,
      results,
      planned: manager.planned,
    }, null, 2));
  } else {
    for (const result of results) {
      const mark = result.ok ? 'OK' : 'FAIL';
      console.log(`[${mark}] ${result.label}: ${result.state} - ${result.detail}`);
    }
    if (options.dryRun && manager.planned.length) {
      console.log('\nPlanned operations:');
      for (const item of manager.planned) {
        if (item.command) console.log(`  ${item.command} ${item.args.join(' ')}`);
        else if (item.copy) console.log(`  copy ${item.copy} -> ${item.destination}`);
        else console.log(`  remove ${item.removeConfig} and ${item.removeDirectory}`);
      }
    }
  }
  return results.some(result => !result.ok) ? 1 : 0;
}

if (require.main === module) {
  runCli().then(code => {
    process.exitCode = code;
  }).catch(error => {
    console.error(`project-knowledge-integrations: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs,
  runCli,
  selectClients,
};
