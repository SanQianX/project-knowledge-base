const path = require('node:path');

// Thin-shell packaging. The core package and its module tree arrive via the
// exact npm dependency in package.json — no vendoring, no prune scripts.
const iconBase = path.join(__dirname, 'assets', 'icon');

module.exports = {
  packagerConfig: {
    asar: {
      unpack: '**/*.{node,dll,ps1}',
    },
    executableName: 'Project Knowledge',
    icon: iconBase,
    ignore: [
      /^\/out(?:\/|$)/,
      /^\/test(?:\/|$)/,
    ],
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        name: 'project_knowledge',
        authors: 'SanQianX',
        description: 'Local AI project knowledge-base manager',
        setupExe: `Project-Knowledge-${require('./package.json').version}-Setup.exe`,
        setupIcon: path.join(__dirname, 'assets', 'icon.ico'),
        iconUrl: 'https://raw.githubusercontent.com/SanQianX/project-knowledge-base/main/desktop/assets/icon.ico',
        noMsi: true,
      },
    },
  ],
};
