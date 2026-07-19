const path = require('path');
const { pruneWindowsRuntime } = require('./scripts/prune-runtime.cjs');

const iconBase = path.join(__dirname, 'assets', 'icon');

module.exports = {
  packagerConfig: {
    asar: {
      unpack: '**/*.{node,dll,ps1}',
    },
    executableName: 'Project Knowledge',
    icon: iconBase,
    ignore: [
      /^\/\.core-package(?:\/|$)/,
      /^\/out(?:\/|$)/,
      /^\/test(?:\/|$)/,
    ],
    afterPrune: [
      (buildPath, _electronVersion, platform, arch, done) => {
        try {
          pruneWindowsRuntime(buildPath, { platform, arch });
          done();
        } catch (error) {
          done(error);
        }
      },
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
