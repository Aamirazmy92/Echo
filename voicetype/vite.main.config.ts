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
  // inline `electron-updater`, `electron-store`, `openai`,
  // `electron-squirrel-startup`, and all of their transitive deps.
  ssr: {
    noExternal: true,
    external: NATIVE_OR_RUNTIME_EXTERNALS,
  },
  resolve: {
    mainFields: ['module', 'jsnext:main', 'jsnext'],
  },
});
