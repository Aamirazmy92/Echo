import fs from 'fs';
import path from 'path';
import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { PublisherGithub } from '@electron-forge/publisher-github';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';

const bundledModelPath = path.join(__dirname, 'vendor', 'whispercpp', 'ggml-base.bin');
const extraResource: NonNullable<ForgeConfig['packagerConfig']>['extraResource'] = [
  'vendor/whispercpp/blas-bin',
  'assets',
];

if (fs.existsSync(bundledModelPath)) {
  extraResource.push({
    from: 'vendor/whispercpp/ggml-base.bin',
    to: 'models/ggml-base.bin',
  });
}

// Only point to an icon if one actually exists on disk. Electron Packager
// errors out hard if the `icon` path is set but missing, so this guard keeps
// dev builds working even before a designer supplies the final icon.
const iconCandidate = path.join(__dirname, 'assets', 'icon.ico');
const packagedIconPath = fs.existsSync(iconCandidate) ? 'assets/icon' : undefined;

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    extraResource,
    ...(packagedIconPath ? { icon: packagedIconPath } : {}),
    appCopyright: `Copyright (c) ${new Date().getFullYear()} Aamir Azmi`,
  },
  rebuildConfig: {},
  makers: [
    new MakerSquirrel({
      // Code signing — reads SIGNING_CERT_PATH and SIGNING_CERT_PASSWORD from env
      // If not set, the build proceeds unsigned (for dev builds)
      certificateFile: process.env.SIGNING_CERT_PATH,
      certificatePassword: process.env.SIGNING_CERT_PASSWORD,
      name: 'Echo',
      ...(fs.existsSync(iconCandidate) ? { setupIcon: 'assets/icon.ico' } : {}),
    }),
    new MakerZIP({}, ['win32']),
  ],
  publishers: [
    new PublisherGithub({
      repository: {
        owner: 'Aamirazmy92',
        name: 'Echo',
      },
      prerelease: false,
    }),
  ],
  plugins: [
    new VitePlugin({
      build: [
        {
          entry: 'src/main/index.ts',
          config: 'vite.main.config.ts',
        },
        {
          entry: 'src/main/preload.ts',
          config: 'vite.preload.config.ts',
        }
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
        }
      ],
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
