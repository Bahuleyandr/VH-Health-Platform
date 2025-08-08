// .eslintrc.cjs
module.exports = {
  root: true,
  env: { browser: true, node: true, es2022: true },
  parser: '@typescript-eslint/parser',
  parserOptions: {
    project: true,
    tsconfigRootDir: __dirname,
    ecmaVersion: 'latest',
    sourceType: 'module',
  },
  plugins: [
    '@typescript-eslint',
    'react-hooks',
    'unused-imports',
    'import',
    'tailwindcss',
    'jsx-a11y',
  ],
  extends: [
    'next/core-web-vitals',
    'plugin:@typescript-eslint/recommended',
    'plugin:import/recommended',
    'plugin:import/typescript',
    'plugin:tailwindcss/recommended', // Tailwind v4 plugin (beta)
    'plugin:react-hooks/recommended',
    'plugin:jsx-a11y/recommended',
    'prettier',
  ],
  settings: {
    'import/resolver': { typescript: true },
    tailwindcss: { callees: ['classnames', 'clsx', 'ctl'] },
  },
  rules: {
    // kill dead imports fast
    'unused-imports/no-unused-imports': 'error',
    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],

    // gentle nudges
    '@typescript-eslint/no-explicit-any': 'warn',
    'react-hooks/exhaustive-deps': 'warn',

    // keep imports tidy
    'import/order': [
      'warn',
      {
        groups: [['builtin', 'external', 'internal'], ['parent', 'sibling', 'index']],
        alphabetize: { order: 'asc', caseInsensitive: true },
        'newlines-between': 'always',
      },
    ],

    // Tailwind v4 beta: keep the plugin but mute noisy rules for now
    'tailwindcss/no-custom-classname': 'off',
    'tailwindcss/classnames-order': 'off',
    'tailwindcss/no-contradicting-classname': 'off',
    'tailwindcss/no-unnecessary-arbitrary-value': 'off',
    'tailwindcss/enforces-shorthand': 'off',
  },

  // Optional niceties
  overrides: [
    // Allow CommonJS in Node scripts
    {
      files: ['scripts/**/*.js'],
      rules: {
        '@typescript-eslint/no-require-imports': 'off',
      },
    },
  ],

  ignorePatterns: [
    '.next/**',
    'node_modules/**',
    'dist/**',
    'coverage/**',
    'public/**',
    'next-env.d.ts',
  ],
};
