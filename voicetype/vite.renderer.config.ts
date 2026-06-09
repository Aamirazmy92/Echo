import { defineConfig } from 'vite';
import path from 'path';

// `root: 'src/renderer'` makes Vite resolve `build.outDir` relative to
// that folder by default, so without an explicit absolute outDir the
// renderer ends up at `src/renderer/.vite/renderer/main_window/` —
// which Forge's Vite plugin doesn't know about and silently doesn't
// copy into the packaged app, producing a blank white window.
// Pin the outDir to the project root's `.vite/renderer/main_window/`
// so the Forge plugin picks it up and packages it into `app.asar`.
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
      input: {
        main_window: path.resolve(__dirname, 'src/renderer/index.html'),
        sticky_window: path.resolve(__dirname, 'src/renderer/sticky.html'),
        overlay_window: path.resolve(__dirname, 'src/renderer/overlay/overlay.html'),
      },
    },
  },
});
