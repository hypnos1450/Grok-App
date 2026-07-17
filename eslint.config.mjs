// Flat ESLint config. Deliberately lean: the codebase already has strong type
// discipline (tsc --strict passes, very few `any`), so this exists mainly to
// catch what tsc doesn't — chiefly React hook dependency mistakes (the
// stale-closure family that produced the false re-auth banner) and dead code.
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

const NODE_GLOBALS = {
  process: 'readonly',
  console: 'readonly',
  require: 'readonly',
  module: 'writable',
  exports: 'writable',
  __dirname: 'readonly',
  __filename: 'readonly',
  Buffer: 'readonly'
}

export default tseslint.config(
  {
    ignores: ['out/**', 'release/**', 'dist/**', 'node_modules/**']
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // exhaustive-deps is an error, not a warning: a suppressed dep list is
      // where stale-closure bugs hide, so each suppression must be justified in
      // review rather than silently accumulating.
      'react-hooks/exhaustive-deps': 'error',
      // Allow the conventional `_`-prefixed intentional-unused (event args,
      // catch vars, deliberately-ignored destructures).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }
      ]
    }
  },
  {
    // Build/config scripts are CommonJS Node, not browser or ESM.
    files: ['scripts/**/*.{js,cjs}', 'build/**/*.{js,cjs}', '*.cjs'],
    languageOptions: { sourceType: 'commonjs', globals: NODE_GLOBALS },
    rules: {
      '@typescript-eslint/no-require-imports': 'off'
    }
  }
)
