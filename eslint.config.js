import js from '@eslint/js';
import tseslint from 'typescript-eslint';
export default [
  { ignores: ['dist', 'infra'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Plain Node scripts (not TypeScript) use Node's built-in globals.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly', fetch: 'readonly' },
    },
  },
];
