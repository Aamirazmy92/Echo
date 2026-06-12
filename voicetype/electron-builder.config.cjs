const fs = require('fs');
const path = require('path');

const projectRoot = __dirname;
const iconPath = path.join(projectRoot, 'assets', 'icon.ico');
const bundledModelPath = path.join(projectRoot, 'vendor', 'whispercpp', 'ggml-base.bin');
const signingCertPath = (process.env.SIGNING_CERT_PATH || '').trim();
const signingCertPassword = process.env.SIGNING_CERT_PASSWORD || '';

const extraResources = [
  {
    from: 'assets',
    to: 'assets',
  },
  {
    from: 'vendor/whispercpp/blas-bin',
    to: 'blas-bin',
  },
];

if (fs.existsSync(bundledModelPath)) {
  extraResources.push({
    from: 'vendor/whispercpp/ggml-base.bin',
    to: 'models/ggml-base.bin',
  });
}

module.exports = {
  appId: 'com.aamirazmi.echo',
  productName: 'Echo',
  copyright: 'Copyright © 2026 Aamir Azmi',
  directories: {
    output: 'dist',
  },
  npmRebuild: false,
  electronDownload: {
    cache: path.join(projectRoot, '.electron-cache'),
  },
  toolsets: {
    winCodeSign: '1.1.0',
  },
  files: [
    'package.json',
    {
      from: '.vite/build',
      to: '.vite/build',
    },
    {
      from: '.vite/renderer',
      to: '.vite/renderer',
    },
    {
      from: 'node_modules/better-sqlite3',
      to: 'node_modules/better-sqlite3',
    },
    {
      from: 'node_modules/bindings',
      to: 'node_modules/bindings',
    },
    {
      from: 'node_modules/file-uri-to-path',
      to: 'node_modules/file-uri-to-path',
    },
  ],
  extraResources,
  asar: true,
  asarUnpack: [
    'node_modules/better-sqlite3/**/*.node',
    'node_modules/bindings/**/*',
    'node_modules/file-uri-to-path/**/*',
  ],
  win: {
    target: [
      {
        target: 'nsis',
        arch: ['x64'],
      },
    ],
    ...(fs.existsSync(iconPath) ? { icon: 'assets/icon.ico' } : {}),
    ...(signingCertPath ? { certificateFile: signingCertPath } : {}),
    ...(signingCertPassword ? { certificatePassword: signingCertPassword } : {}),
    artifactName: 'Echo-Setup-${version}.${ext}',
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'Echo',
    ...(fs.existsSync(iconPath) ? {
      installerIcon: 'assets/icon.ico',
      uninstallerIcon: 'assets/icon.ico',
    } : {}),
  },
  publish: {
    provider: 'github',
    owner: 'Aamirazmy92',
    repo: 'Echo',
    releaseType: 'release',
  },
};
