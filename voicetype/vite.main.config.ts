import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    ssr: true,
    outDir: '.vite/build',
    rollupOptions: {
      input: 'src/main/index.ts',
      external: [
        'electron',
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
