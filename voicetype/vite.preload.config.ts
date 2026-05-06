import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    ssr: true,
    outDir: '.vite/build',
    emptyOutDir: false,
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
