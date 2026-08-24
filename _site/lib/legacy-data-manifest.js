// The complete v4.1.x runtime asset inventory. Both relocation from an
// installed package and layout-v2 migration consume this manifest.
const path = require('path');

const LEGACY_ASSETS = Object.freeze([
  { source: 'projects.json', target: 'projects.json', kind: 'file', authority: 'user' },
  { source: 'ai-profiles.json', target: 'ai-profiles.json', kind: 'file', authority: 'user' },
  { source: 'knowledge-store.json', target: 'knowledge-store.json', kind: 'file', authority: 'user' },
  { source: 'embedding-config.json', target: 'embedding-config.json', kind: 'file', authority: 'user' },
  { source: 'logging.json', target: 'logging.json', kind: 'file', authority: 'user' },
  { source: 'claude-prompts.json', target: 'claude-prompts.json', kind: 'file', authority: 'user' },
  { source: 'github-team.json', target: 'github-team.json', kind: 'file', authority: 'user' },
  { source: 'team-git-providers.json', target: 'team-git-providers.json', kind: 'file', authority: 'user' },
  { source: 'knowledge-scopes.json', target: 'knowledge-scopes.json', kind: 'file', authority: 'user' },
  { source: '.jobs-log.json', target: '.jobs-log.json', kind: 'file', authority: 'history' },
  { source: '.hook-trigger-errors.log', target: '.hook-trigger-errors.log', kind: 'file', authority: 'history' },
  { source: 'projects', target: 'projects', kind: 'dir', authority: 'user' },
  { source: 'logs', target: 'logs', kind: 'dir', authority: 'history' },
  { source: 'models', target: 'models', kind: 'dir', authority: 'cache-but-expensive' },
  { source: path.join('_site', '_ai'), target: '_ai', kind: 'dir', authority: 'history' },
]);

function getLegacyAsset(source) { return LEGACY_ASSETS.find(asset => asset.source === source) || null; }
function assetPath(root, asset, side = 'source') { return path.join(root, asset[side] || asset.source); }

module.exports = { LEGACY_ASSETS, getLegacyAsset, assetPath };
