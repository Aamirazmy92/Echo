import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
  root: 'src/renderer',
  build: {
    rollupOptions: {
      input: {
        main_window: path.resolve(__dirname, 'src/renderer/index.html'),
        overlay_window: path.resolve(__dirname, 'src/renderer/overlay/overlay.html')
      }
    }
  }
});
