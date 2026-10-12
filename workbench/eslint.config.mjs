// tsc doesn't check the hooks' JavaScript (checkJs is off), so this catches undefined names
// and bad imports. Run from workbench/: npx eslint@9.39.1 hooks
export default [
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { console: 'readonly', URL: 'readonly', encodeURIComponent: 'readonly', JSON: 'readonly', Date: 'readonly', Math: 'readonly', Promise: 'readonly', Map: 'readonly', Set: 'readonly', Object: 'readonly', String: 'readonly', Number: 'readonly', Array: 'readonly', Error: 'readonly', RegExp: 'readonly' },
    },
    rules: { 'no-undef': 'error', 'no-unused-vars': ['warn', { args: 'none' }], 'no-import-assign': 'error' },
  },
]
