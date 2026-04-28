import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    ssr: true,
    outDir: '.vite/build',
    rollupOptions: {
      input: 'src/main/index.ts',
      // Modules left out of the main-process bundle. These either:
      //   1. Are native addons that must load .node binaries from disk
      //      (better-sqlite3, onnxruntime-node, sharp).
      //   2. Are core Node modules that Electron provides at runtime
      //      (electron, child_process, fs, path, os).
      //   3. Use dynamic, platform-conditional `require()` calls that
      //      Rollup can't statically trace, so bundling them produces a
      //      broken artifact that throws "Cannot find module ..." at
      //      runtime (electron-updater is the canonical example).
      // Anything externalized here must be installed as a regular
      // `dependency` so it ships inside `app.asar` after packaging.
      external: [
        'electron',
        'electron-updater',
        'child_process',
        'fs',
        'path',
        'os',
        'better-sqlite3',
        '@huggingface/transformers',
        'onnxruntime-node',
        'sharp',
      ],
      output: {
        format: 'cjs',
        entryFileNames: 'main.js',
      }
    }
  },
  resolve: {
    mainFields: ['module', 'jsnext:main', 'jsnext'],
  },
});
