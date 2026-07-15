const path = require('path');

const iconBase = path.join(__dirname, 'assets', 'icon');

module.exports = {
  packagerConfig: {
    asar: {
      unpack: '**/*.{node,dll}',
    },
    executableName: 'Project Knowledge',
    icon: iconBase,
    ignore: [
      /^\/\.core-package(?:\/|$)/,
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
