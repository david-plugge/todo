import js from '@eslint/js';
import ts from 'typescript-eslint';
import svelte from 'eslint-plugin-svelte';
import tailwind from 'eslint-plugin-tailwindcss';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default [
  {
    ignores: [
      'node_modules/**',
      // Session worktrees carry their own checkouts; they lint themselves.
      '.claude/**',
      '.svelte-kit/**',
      '.test-build/**',
      '.tools/**',
      'pb_data/**',
      'pb_test_data/**',
      'pb_public/**',
      'test-results/**',
      'playwright-report/**',
    ],
  },
  js.configs.recommended,
  ...ts.configs.recommended,
  ...svelte.configs['flat/recommended'],
  tailwind.configs['flat/recommended'] ?? tailwind.configs.recommended,
  {
    settings: {
      tailwindcss: {
        cssConfigPath: './src/app.css',
      },
    },
    // The v4 plugin currently suggests decimal spacing classes that the compiler
    // cannot resolve; exact line-height values remain intentional arbitrary values.
    rules: {
      'tailwindcss/no-unnecessary-arbitrary-value': 'off',
    },
  },
  prettier,
  // Crash tests intentionally pause the JS runtime through CDP.
  {
    files: ['tests/browser/crash.spec.ts', 'tests/product-pwa/installability.spec.ts'],
    rules: { 'no-debugger': 'off', 'no-empty-pattern': 'off' },
  },
  {
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
  // The Svelte parser also claims rune modules; it needs the TS parser for them.
  {
    files: ['**/*.svelte.ts'],
    languageOptions: { parserOptions: { parser: ts.parser } },
  },
  // Svelte bindable props write through to the parent even without a local read.
  {
    files: ['**/*.svelte'],
    rules: { 'no-useless-assignment': 'off' },
    languageOptions: { parserOptions: { parser: ts.parser } },
  },
];
