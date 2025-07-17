// eslint.config.js
import { FlatCompat } from '@eslint/eslintrc';
import eslintRecommended from '@eslint/js';
import prettierConfig from 'eslint-config-prettier';
import importPlugin from 'eslint-plugin-import';
import sonarjs from 'eslint-plugin-sonarjs';
import globals from 'globals';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// --- Setup for the compatibility tool ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const compat = new FlatCompat({ baseDirectory: __dirname });
// ---

export default [
  // 1. Global ignores
  {
  ignores: [
    "node_modules/", 
    "dist/"
  ],
},

  // 2. Base modern configuration
  eslintRecommended.configs.recommended,

  // 3. LEGACY plugin configs wrapped in the compatibility tool
  ...compat.extends('plugin:import/recommended'),

  // 4. Global rules for all JavaScript files
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.es2022,
      },
    },
    plugins: {
      sonarjs,
      import: importPlugin,
    },
    rules: {
      // --- Your Custom Rules ---
      'no-console': process.env.NODE_ENV === 'production' ? 'warn' : 'off',
      'no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          caughtErrors: 'all',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      'no-unreachable': 'error',
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-var': 'warn',
      'prefer-const': 'warn',
      'eqeqeq': ['warn', 'always'],
      'curly': ['warn', 'all'],
      'no-duplicate-imports': 'error',
      'no-implicit-globals': 'error', // 'no-empty-catch' was removed from here.
      'import/order': [
        'warn',
        {
          groups: [['builtin', 'external'], 'internal', 'parent', 'sibling', 'index'],
          alphabetize: { order: 'asc', caseInsensitive: true },
        },
      ],
    },
  },

  // 5. Overrides for specific files
  {
    files: ['**/*.test.js', '**/*.spec.js', '**/tests/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.jest,
      },
    },
    rules: {
      'no-console': 'off',
      'no-unused-vars': 'off',
    },
  },
  {
    files: ['src/scripts/**/*.js'],
    rules: {
      'no-console': 'off',
    },
  },
  
  // 6. Prettier config must be last to override other styling rules
  prettierConfig,
];