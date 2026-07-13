// Flat ESLint config for the whole monorepo (TS/TSX). Formatting is Prettier's job —
// `eslint-config-prettier` (last) disables every stylistic rule so the two never fight.
// Type-aware rules are intentionally off here (fast, no per-package project wiring); the
// per-package `tsc` build is the type-checker. Rust/Python have their own linters (CI).
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import prettier from 'eslint-config-prettier'

export default tseslint.config(
  {
    // Never lint build output, deps, vendored assets, or generated dirs.
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/target/**',
      '**/.next/**',
      '**/next-env.d.ts',
      '**/public/**',
      // Python virtualenvs (the bots are Python apps) ship vendored JS we must never lint.
      '**/.venv/**',
      '**/venv/**',
      'design/**',
      'docs/**',
      'deploy/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      // Allow intentionally-unused args/vars when prefixed with `_` (e.g. ignored callback params).
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // Node-context (non-TS) config files — declare the Node globals they use.
    files: ['**/*.config.{js,mjs,cjs}'],
    languageOptions: {
      globals: { process: 'readonly', module: 'writable', require: 'readonly', __dirname: 'readonly' },
    },
  },
  {
    // Node CLI helper scripts (task-runner tooling) — declare the Node globals they use.
    files: ['scripts/**/*.{js,mjs,cjs}'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        module: 'writable',
        require: 'readonly',
        __dirname: 'readonly',
      },
    },
  },
  prettier,
)
