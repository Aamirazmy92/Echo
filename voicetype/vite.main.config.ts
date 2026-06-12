import { defineConfig } from 'vite';

// Modules that physically cannot be inlined into the main-process bundle
// and must remain runtime `require()`s:
//   - `electron` itself (provided by the Electron runtime).
//   - Native addons that load `.node` binaries from disk. electron-builder
//     copies these runtime modules into the app and unpacks their native
//     binaries according to electron-builder.config.cjs.
const NATIVE_OR_RUNTIME_EXTERNALS = [
  'electron',
  'better-sqlite3',
  '@huggingface/transformers',
  'onnxruntime-node',
  'sharp',
];

export default defineConfig(() => ({
  // The direct Vite/electron-builder flow always loads the built renderer
  // files. Keep these constants explicit so the main process never depends
  // on dev-server globals injected by a packaging plugin.
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
        // The Electron main process keeps auth/entitlement state in module
        // singletons. Runtime chunks can duplicate that state across lazy
        // imports, so keep the main process in one bundle.
        inlineDynamicImports: true,
      },
    },
  },
  // Force every other dependency to be bundled into main.js. Anything left
  // external (other than the native/runtime modules above) would need to be
  // shipped separately. `noExternal: true` keeps pure-JS dependencies inline.
  ssr: {
    noExternal: true,
    external: NATIVE_OR_RUNTIME_EXTERNALS,
  },
  resolve: {
    mainFields: ['module', 'jsnext:main', 'jsnext'],
  },
}));
