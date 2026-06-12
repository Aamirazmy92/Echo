import { defineConfig } from 'vite';
import path from 'path';

// `root: 'src/renderer'` makes Vite resolve `build.outDir` relative to
// that folder by default, so without an explicit absolute outDir the
// renderer ends up at `src/renderer/.vite/renderer/main_window/`.
// Pin the outDir to the project root's `.vite/renderer/main_window/`
// so both local Electron launches and electron-builder packaging load the
// same renderer files.
export default defineConfig({
  root: 'src/renderer',
  // Use relative asset URLs so the built index.html / overlay.html work
  // when loaded over `file://` from inside the packaged app.asar. With
  // the default `base: '/'`, Vite emits `<script src="/assets/...js">`
  // which resolves against the filesystem root at runtime, the bundle
  // 404s, and React never replaces the splash screen.
  base: './',
  build: {
    outDir: path.resolve(__dirname, '.vite/renderer/main_window'),
    emptyOutDir: true,
    rollupOptions: {
      // framer-motion ships "use client" directives that are meaningless
      // outside React Server Components; Rollup warns on every file.
      onwarn(warning, warn) {
        if (warning.code === 'MODULE_LEVEL_DIRECTIVE') return;
        warn(warning);
      },
      input: {
        main_window: path.resolve(__dirname, 'src/renderer/index.html'),
        sticky_window: path.resolve(__dirname, 'src/renderer/sticky.html'),
        overlay_window: path.resolve(__dirname, 'src/renderer/overlay/overlay.html'),
      },
    },
  },
});
