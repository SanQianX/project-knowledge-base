// project-knowledge-base ESLint flat config — the AI-team review pipeline runs
// this via real subprocess receipts (ai-coding-workflow checks runner).
// Six dimensions; thresholds are calibrated warning lines, correctness rules
// are blocking errors. Generated test artifacts (qa-autopilot shadow copies)
// stay out of the metric per the quality policy (.ai-quality/policy.json).
const TEST_DIRS = ['_site/_test/**', 'qa-autopilot/**'];
export default [
  {
    ignores: [
      'node_modules/**', '.local-test-data/**', 'artifacts/**', 'Microsoft/**',
      'desktop/**', '_modules/**', '**/node_modules/**',
      'qa-autopilot/artifacts/**', 'qa-autopilot/.runtime/**',
    ],
  },
  {
    files: ['**/*.{js,cjs,mjs}'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'commonjs' },
    rules: {
      // --- 1. Correctness / syntax (blocking) ---
      'eqeqeq': ['warn', 'smart'],
      'no-fallthrough': 'error',
      'no-self-assign': 'error',
      'no-self-compare': 'error',
      'no-throw-literal': 'warn',
      'no-async-promise-executor': 'error',
      'no-unsafe-finally': 'error',
      'no-shadow-restricted-names': 'error',
      'use-isnan': 'error',
      'valid-typeof': 'error',
      'no-constant-binary-expression': 'error',
      // --- 2. Logical simplicity ---
      'complexity': ['warn', { max: 30 }],
      'max-depth': ['warn', { max: 5 }],
      'no-nested-ternary': 'warn',
      // --- 3. Naming ---
      'camelcase': ['warn', { properties: 'never', ignoreDestructuring: true, ignoreGlobals: true }],
      'new-cap': ['warn', { capIsNew: false }],
      // --- 4. Performance anti-patterns ---
      'no-await-in-loop': 'warn',
      'prefer-regex-literals': 'warn',
      // --- 5. Maintainability ---
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
      'no-unreachable': 'warn',
      'no-empty': ['warn', { allowEmptyCatch: true }],
      // --- 6. Structural size ---
      'max-lines-per-function': ['warn', { max: 260, skipBlankLines: true, skipComments: true }],
      'max-lines': ['warn', { max: 1500, skipBlankLines: true, skipComments: true }],
    },
  },
  // Sequential awaits in tests are usually deliberate isolation ordering;
  // the review pipeline evaluates them in production code only.
  {
    files: TEST_DIRS.map(p => p),
    rules: { 'no-await-in-loop': 'off', 'max-lines-per-function': ['warn', { max: 400, skipBlankLines: true, skipComments: true }] },
  },
  { files: ['ui/**/*.js'], languageOptions: { sourceType: 'script', ecmaVersion: 2024, globals: { window: 'readonly', document: 'readonly', localStorage: 'readonly', navigator: 'readonly', fetch: 'readonly', EventSource: 'readonly', location: 'readonly', history: 'readonly', HTMLElement: 'readonly', dialog: 'readonly' } } },
];
