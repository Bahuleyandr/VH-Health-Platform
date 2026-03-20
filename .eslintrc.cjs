// .eslintrc.cjs
module.exports = {
  root: true,
  env: { browser: true, node: true, es2022: true },
  parser: '@typescript-eslint/parser',
  parserOptions: {
    project: ['./tsconfig.json'],
    tsconfigRootDir: __dirname,
    ecmaVersion: 'latest',
    sourceType: 'module',
  },
  plugins: [
    '@typescript-eslint',
    'react',
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
    'plugin:tailwindcss/recommended',
    'plugin:react-hooks/recommended',
    'plugin:jsx-a11y/recommended',
    'prettier',
  ],
  settings: {
    react: { version: 'detect' },
    tailwindcss: { callees: ['classnames', 'clsx', 'ctl'] },
    'import/resolver': {
      typescript: {
        // picks up "@/..." from tsconfig paths
        alwaysTryTypes: true,
        project: ['./tsconfig.json'],
      },
      node: { extensions: ['.js', '.jsx', '.ts', '.tsx'] },
    },
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
        groups: [
          ['builtin', 'external', 'internal'],
          ['parent', 'sibling', 'index'],
        ],
        alphabetize: { order: 'asc', caseInsensitive: true },
        'newlines-between': 'always',
      },
    ],
    'import/no-unresolved': 'error',

    // next/react specifics
    'react/react-in-jsx-scope': 'off',
    'react/jsx-uses-react': 'off',
    'react/no-unescaped-entities': 'error', // keep this — it caught your 404 text
    '@next/next/no-html-link-for-pages': ['error', 'src/app'],

    // Tailwind v4 beta: keep plugin, mute noisy rules for now
    'tailwindcss/no-custom-classname': 'off',
    'tailwindcss/classnames-order': 'off',
    'tailwindcss/no-contradicting-classname': 'off',
    'tailwindcss/no-unnecessary-arbitrary-value': 'off',
    'tailwindcss/enforces-shorthand': 'off',
  },

  overrides: [
    // Node scripts & config files can use CommonJS etc.
    {
      files: ['scripts/**/*.{js,ts}', '**/*.config.{js,cjs,ts}'],
      rules: {
        '@typescript-eslint/no-require-imports': 'off',
        'import/no-extraneous-dependencies': 'off',
      },
    },
    // Tests may import devDeps
    {
      files: [
        '**/*.{test,spec}.{js,jsx,ts,tsx}',
        'tests/**/*',
        'vitest.config.*',
        'jest.config.*',
        'playwright.config.*',
      ],
      rules: {
        'import/no-extraneous-dependencies': 'off',
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
    'src/scripts/*.js',
    'transforms/**',
    '.eslintrc.cjs',
    'eslint.config.mjs',
    'postcss.config.mjs',
    'reset-password.js',
  ],
};
