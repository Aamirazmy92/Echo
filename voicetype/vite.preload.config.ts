import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    ssr: true,
    rollupOptions: {
      input: 'src/main/preload.ts',
      external: ['electron'],
      output: {
        format: 'cjs',
        entryFileNames: 'preload.js',
      }
    }
  }
});
