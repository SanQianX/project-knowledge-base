#!/usr/bin/env node

const {
  IntegrationManager,
  SUPPORTED_CLIENTS,
  normalizeClient,
} = require('../_site/lib/integration-installer');

function printHelp() {
  console.log(`project-knowledge-integrations

Install Project Knowledge for coding agents: Knowledge Integration (MCP +
Skill / plugin) and Development Capture (Bridge hooks / notify / plugin).

Usage:
  project-knowledge-integrations install [--ide <client>] [--scope <scope>] [--knowledge-only|--capture-only]
  project-knowledge-integrations update [--ide <client>] [--scope <scope>]
  project-knowledge-integrations uninstall [--ide <client>] [--scope <scope>] [--knowledge-only|--capture-only]
  project-knowledge-integrations status [--ide <client>]
  project-knowledge-integrations disable-capture

Clients:
  claude       Claude Code plugin (MCP + Skill) + managed Bridge hooks
  opencode     OpenCode MCP + global Skill + managed Bridge plugin
  codex        Codex plugin (MCP + Skill) + managed Bridge notify
  all          All supported clients

Options:
      --ide <client>       Repeat or use a comma-separated list
      --scope <scope>      Claude scope: user, project, or local (default: user)
      --marketplace <src>  Marketplace GitHub repo, Git URL, or local path
      --knowledge-only     Only install/uninstall the Knowledge Integration
      --capture-only       Only install/uninstall the Development Capture
      --dry-run            Show intended operations without changing config
      --json               Print machine-readable results
  -h, --help               Show this help

Without --ide, installed clients are detected automatically. One install
action configures both capabilities; no client UI needs to be opened.`);
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
    knowledgeOnly: false,
    captureOnly: false,
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
    } else if (arg === '--knowledge-only') {
      options.knowledgeOnly = true;
    } else if (arg === '--capture-only') {
      options.captureOnly = true;
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
  if (options.knowledgeOnly && options.captureOnly) {
    throw new Error('--knowledge-only and --capture-only are mutually exclusive');
  }
  if (!['install', 'update', 'uninstall', 'status', 'disable-capture'].includes(options.operation)) {
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

function printCapabilityLine(prefix, capability) {
  if (!capability) return;
  const mark = capability.ok ? 'OK' : 'FAIL';
  console.log(`  [${mark}] ${prefix}: ${capability.state} - ${capability.detail}`);
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

  if (options.operation === 'disable-capture') {
    const summary = await manager.disableAllCapture({ clients });
    if (options.json) {
      console.log(JSON.stringify({ operation: 'disable-capture', ...summary, planned: manager.planned }, null, 2));
    } else {
      for (const result of summary.clients) {
        const mark = result.ok ? 'OK' : 'FAIL';
        console.log(`[${mark}] ${result.label}: ${result.state} - ${result.detail}`);
      }
      const consumerMark = summary.consumer.ok ? 'OK' : 'FAIL';
      console.log(`[${consumerMark}] Bridge consumer: ${summary.consumer.state || summary.consumer.detail}`);
    }
    return summary.clients.some(result => !result.ok) || !summary.consumer.ok ? 1 : 0;
  }

  if (options.operation === 'install') {
    // One action configures Knowledge Integration + Development Capture
    // together (per-client flags narrow the scope). No client UI is needed.
    const summary = await manager.installAll({ clients, knowledgeOnly: options.knowledgeOnly, captureOnly: options.captureOnly, scope: options.scope });
    if (options.json) {
      console.log(JSON.stringify({ operation: 'install', ...summary, planned: manager.planned }, null, 2));
    } else {
      const bridgeMark = summary.bridge.ok ? 'OK' : 'FAIL';
      console.log(`[${bridgeMark}] Bridge: ${summary.bridge.state} - consumer ${manager.bridgeConsumerName}`);
      for (const entry of summary.clients) {
        printCapabilityLine(`${entry.label} Knowledge Integration`, entry.knowledgeIntegration);
        printCapabilityLine(`${entry.label} Development Capture`, entry.developmentCapture);
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
    return summary.clients.some(entry =>
      (entry.knowledgeIntegration && !entry.knowledgeIntegration.ok)
      || (entry.developmentCapture && !entry.developmentCapture.ok)
    ) || !summary.bridge.ok ? 1 : 0;
  }

  if (options.operation === 'uninstall') {
    if (options.captureOnly) {
      const results = await manager.operateCapture('uninstall', clients, {});
      if (options.json) {
        console.log(JSON.stringify({ operation: 'uninstall', captureOnly: true, results, planned: manager.planned }, null, 2));
      } else {
        for (const result of results) {
          const mark = result.ok ? 'OK' : 'FAIL';
          console.log(`[${mark}] ${result.label}: ${result.state} - ${result.detail}`);
        }
      }
      return results.some(result => !result.ok) ? 1 : 0;
    }
    // Default uninstall removes both capabilities but KEEPS the host Bridge
    // consumer; use disable-capture for the global consumer unregister.
    const knowledgeResults = await manager.operate('uninstall', clients, { scope: options.scope });
    const captureResults = options.knowledgeOnly ? [] : await manager.operateCapture('uninstall', clients, {});
    if (options.json) {
      console.log(JSON.stringify({ operation: 'uninstall', knowledgeResults, captureResults, planned: manager.planned }, null, 2));
    } else {
      for (const result of [...knowledgeResults, ...captureResults]) {
        const mark = result.ok ? 'OK' : 'FAIL';
        console.log(`[${mark}] ${result.label}: ${result.state} - ${result.detail}`);
      }
    }
    return [...knowledgeResults, ...captureResults].some(result => !result.ok) ? 1 : 0;
  }

  if (options.operation === 'status') {
    const summary = await manager.statusAll({ clients });
    if (options.json) {
      console.log(JSON.stringify({ operation: 'status', ...summary, planned: manager.planned }, null, 2));
    } else {
      const bridgeMark = summary.bridge.ok ? 'OK' : 'FAIL';
      console.log(`[${bridgeMark}] Bridge: consumer ${summary.bridge.consumerRegistered ? 'registered' : 'not registered'}, journal ${summary.bridge.bridgeHealthy ? 'healthy' : 'unavailable'}`);
      for (const entry of summary.clients) {
        printCapabilityLine(`${entry.label} Knowledge Integration`, entry.knowledgeIntegration);
        printCapabilityLine(`${entry.label} Development Capture`, entry.developmentCapture);
      }
    }
    return 0;
  }

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
