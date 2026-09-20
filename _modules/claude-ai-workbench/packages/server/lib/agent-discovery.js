'use strict';

const { spawnSync } = require('child_process');
const { AGENTS, AGENT_IDS } = require('../../contracts');
const { discoverZCodeCli, probeZCodeVersion } = require('./drivers/zcode-driver');

const PROBE_TIMEOUT_MS = 5000;
const CACHE_TTL_MS = 30000;

// Probes locally installed agent CLIs. Results are cached briefly so
// GET /agents stays cheap; a failed probe is a valid (negative) result.
function createAgentDiscovery(options = {}) {
  const claudeProbe = options.claudeProbe || null; // () => {available, version}
  let cache = null;
  let cacheAt = 0;

  function probeVersion(command) {
    try {
      const result = spawnSync(command, ['--version'], {
        timeout: PROBE_TIMEOUT_MS,
        windowsHide: true,
        encoding: 'utf8',
        shell: process.platform === 'win32',
      });
      if (result.error || result.status !== 0) return null;
      const text = String(result.stdout || result.stderr || '').trim();
      const match = text.match(/(\d+\.\d+[\w.-]*)/);
      return match ? match[1] : text.split(/\r?\n/)[0].slice(0, 64) || null;
    } catch {
      return null;
    }
  }

  // ZCode detection runs the driver's discovery chain (ZCODE_CLI_PATH ->
  // install roots -> registry App Paths): the bundled CLI is what the
  // app-server driver needs, so a found CLI means a working driver. The
  // ~/.zcode marker alone (previous heuristic) says nothing about the CLI.
  function probeZCodeInstall() {
    const cli = discoverZCodeCli();
    if (!cli) return { installed: false, version: null, cliPath: null };
    return { installed: true, version: probeZCodeVersion(cli.path), cliPath: cli.path };
  }

  function discover() {
    const now = Date.now();
    if (cache && now - cacheAt < CACHE_TTL_MS) return cache;
    const statuses = {};
    for (const id of AGENT_IDS) {
      const definition = AGENTS[id];
      let available = false;
      let version = null;
      let reason = '';
      if (id === 'claude-code') {
        const probed = claudeProbe ? claudeProbe() : { available: false, version: null };
        available = Boolean(probed.available);
        version = probed.version || null;
        if (!available) reason = 'Claude Code executable was not found';
      } else if (id === 'zcode') {
        const install = probeZCodeInstall();
        available = install.installed;
        version = install.version;
        reason = install.installed
          ? `ZCode desktop install found (bundled zcode CLI at ${install.cliPath} speaks app-server --stdio)`
          : 'ZCode was not found on this machine';
      } else {
        version = probeVersion(id);
        available = version != null;
        if (!available) reason = `\`${id}\` command was not found on PATH`;
      }
      statuses[id] = {
        id: definition.id,
        label: definition.label,
        transport: definition.transport,
        authModes: [...definition.authModes],
        capabilities: {
          ...definition.capabilities,
          generationParams: [...definition.capabilities.generationParams],
        },
        available,
        version,
        reason,
      };
    }
    cache = statuses;
    cacheAt = now;
    return statuses;
  }

  discover.invalidate = () => { cache = null; cacheAt = 0; };
  return discover;
}

module.exports = { createAgentDiscovery };
