const tsParser = require('@typescript-eslint/parser');

module.exports = [
  {
    ignores: [
      '.vite/**',
      'dist/**',
      'out/**',
      'node_modules/**',
      'vendor/**',
    ],
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    rules: {},
  },
];
