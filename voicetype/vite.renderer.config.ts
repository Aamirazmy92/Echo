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
  build: {
    outDir: path.resolve(__dirname, '.vite/renderer/main_window'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main_window: path.resolve(__dirname, 'src/renderer/index.html'),
        overlay_window: path.resolve(__dirname, 'src/renderer/overlay/overlay.html'),
      },
    },
  },
});
