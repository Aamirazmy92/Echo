import { defineConfig } from 'vite';

// Modules that physically cannot be inlined into the main-process bundle
// and must remain runtime `require()`s:
//   - `electron` itself (provided by the Electron runtime).
//   - Native addons that load `.node` binaries from disk. These are
//     unpacked from app.asar by `@electron-forge/plugin-auto-unpack-natives`
//     and copied into the staged build by the `packageAfterCopy` hook in
//     forge.config.ts (because the Forge Vite plugin wipes node_modules).
const NATIVE_OR_RUNTIME_EXTERNALS = [
  'electron',
  'better-sqlite3',
  '@huggingface/transformers',
  'onnxruntime-node',
  'sharp',
];

export default defineConfig({
  // The Forge Vite plugin used to inject these as build-time constants.
  // The standalone `vite build` we run for electron-builder does not, so
  // any reference to them in main.js / preload.js would throw a
  // ReferenceError in the packaged app. Replace them with sensible
  // production values: no dev server URL, and the `main_window` renderer
  // entry name that matches `vite.renderer.config.ts`.
  define: {
    MAIN_WINDOW_VITE_DEV_SERVER_URL: 'undefined',
    MAIN_WINDOW_VITE_NAME: JSON.stringify('main_window'),
  },
  build: {
    ssr: true,
    outDir: '.vite/build',
    rollupOptions: {
      input: 'src/main/index.ts',
      external: NATIVE_OR_RUNTIME_EXTERNALS,
      output: {
        format: 'cjs',
        entryFileNames: 'main.js',
      },
    },
  },
  // Force every other dependency to be bundled into main.js. The Forge
  // Vite plugin does NOT ship `node_modules` into `app.asar`, so anything
  // left external (other than the native modules above) will throw
  // "Cannot find module ..." at runtime. `noExternal: true` makes Vite
  // inline `electron-updater`, `electron-store`, and all of their
  // transitive deps.
  ssr: {
    noExternal: true,
    external: NATIVE_OR_RUNTIME_EXTERNALS,
  },
  resolve: {
    mainFields: ['module', 'jsnext:main', 'jsnext'],
  },
});
