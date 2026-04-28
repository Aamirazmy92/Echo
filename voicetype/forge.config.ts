import fs from 'fs';
import path from 'path';
import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { PublisherGithub } from '@electron-forge/publisher-github';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';

// Native node modules cannot be bundled by Vite into main.js (they load
// `.node` binaries via `process.dlopen`). They must remain runtime
// requires AND must physically exist in the staged build's `node_modules`
// for `require()` to resolve them. The Forge Vite plugin wipes
// `node_modules` during packaging, so we copy these dirs back in the
// `packageAfterCopy` hook below. Once they are back in place,
// `@electron-forge/plugin-auto-unpack-natives` moves the `.node` files to
// `app.asar.unpacked` so `process.dlopen` can read them off disk.
const NATIVE_MAIN_DEPS = ['better-sqlite3', 'bindings', 'file-uri-to-path'];

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
  hooks: {
    // The Forge Vite plugin wipes `node_modules` from the staged build,
    // assuming Vite has bundled every dependency. That works for pure-JS
    // packages but is impossible for native addons (they load `.node`
    // binaries via `process.dlopen`). Copy the native modules — and their
    // own dependency trees — back into the staged `node_modules` so
    // `require('better-sqlite3')` resolves at runtime, and so
    // `auto-unpack-natives` finds the `.node` files to unpack.
    packageAfterCopy: async (_forgeConfig, buildPath) => {
      const projectRoot = __dirname;
      const sourceModulesDir = path.join(projectRoot, 'node_modules');
      const targetModulesDir = path.join(buildPath, 'node_modules');
      await fs.promises.mkdir(targetModulesDir, { recursive: true });
      for (const dep of NATIVE_MAIN_DEPS) {
        const src = path.join(sourceModulesDir, dep);
        const dst = path.join(targetModulesDir, dep);
        if (!fs.existsSync(src)) {
          // eslint-disable-next-line no-console
          console.warn(`[forge] native dep missing in node_modules: ${dep}`);
          continue;
        }
        await fs.promises.cp(src, dst, { recursive: true });
      }
    },
  },
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
    // Moves any `.node` binaries it finds in node_modules out of app.asar
    // and into app.asar.unpacked, where Node's process.dlopen can load
    // them at runtime. Must be paired with the packageAfterCopy hook
    // above which puts the native modules back into node_modules.
    new AutoUnpackNativesPlugin({}),
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
