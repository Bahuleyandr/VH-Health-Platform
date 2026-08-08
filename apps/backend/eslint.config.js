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
      'node_modules/',
      'dist/',
      'load-tests/',
      // k6 scripts run in the k6 runtime (k6/* modules, __ENV global) —
      // not lintable as Node code (roadmap A5).
      'loadtest/',
      'ecosystem.config.cjs',
      'local_plugins/',
    ],
  },

  // 2. Base modern configuration
  eslintRecommended.configs.recommended,

  // 3. LEGACY plugin configs wrapped in the compatibility tool
  ...compat.extends('plugin:import/recommended'),

  // 4. Global rules for all JavaScript files (including CJS and MJS)
  {
    files: ['**/*.js', '**/*.cjs', '**/*.mjs'],
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
    settings: {
      // `eslint-import-resolver-node` (the only resolver eslint-plugin-import
      // ships with) predates the package.json `exports` field, so it cannot
      // follow subpath exports that have no matching directory on disk.
      // firebase-admin 14 publishes its modular entry points that way —
      // `./app`, `./auth`, `./messaging` resolve through `exports` only, and
      // `node_modules/firebase-admin/` contains just `lib/`. Node resolves
      // them fine; the linter does not. Declaring them here is the documented
      // escape hatch and keeps a new resolver dependency out of the tree.
      // Add a line here if a further firebase-admin subpath is ever imported.
      'import/core-modules': [
        'firebase-admin/app',
        'firebase-admin/app-check',
        'firebase-admin/auth',
        'firebase-admin/messaging',
      ],
    },
    rules: {
      // --- Your Custom Rules ---
      // Ban raw console.* everywhere — Winston `logger.*` is the structured
      // path. Allow `warn`/`error` as a temporary escape hatch; dedicated
      // overrides below let `bin/www.js` and `src/scripts/**` print freely
      // because they run before the logger is initialised / out of band.
      // Block new console.* in production code. `logger.*` is the structured path.
      // Scripts + bin/www.js are exempted via the overrides below.
      'no-console': ['error', { allow: ['warn', 'error'] }],
      // Flag `prisma.$queryRawUnsafe(sql, [array])` — the drift bug that was
      // silently broken across ~70 sites. Raw Prisma methods need spread args.
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.property.name=/^\\$queryRawUnsafe$|^\\$executeRawUnsafe$/] > ArrayExpression:nth-child(2)",
          message: 'prisma.$queryRawUnsafe/$executeRawUnsafe takes spread params (...args), not an array. Use sql, ...params instead of sql, [params].',
        },
      ],
      'no-unused-vars': [
        'warn',
        {
          varsIgnorePattern: '^_',
          argsIgnorePattern: '^_',
          caughtErrors: 'all',
          caughtErrorsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      'no-unreachable': 'error',
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-var': 'warn',
      'prefer-const': 'warn',
      'eqeqeq': ['warn', 'always', { null: 'ignore' }],
      'curly': ['warn', 'all'],
      'no-duplicate-imports': 'error',
      'no-implicit-globals': 'error', // 'no-empty-catch' was removed from here.
      'import/order': 'off',
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
    // Scripts (both src/scripts/ per-app scripts and repo-root scripts/
    // one-shot migration/codemod tooling) are exempt from no-console —
    // they're interactive CLIs that print progress to stdout.
    // The admin/ directory holds DB operator tooling (backup/cleanup/
    // purge) which is also console-first by design.
    files: [
      'src/scripts/**/*.js',
      'src/scripts/**/*.cjs',
      'src/scripts/**/*.mjs',
      'scripts/**/*.js',
      'scripts/**/*.cjs',
      'scripts/**/*.mjs',
      'admin/**/*.js',
    ],
    rules: {
      'no-console': 'off',
    },
  },
  {
    // Startup printers run before the Winston logger is ready.
    files: ['src/bin/www.js', 'src/cluster.js'],
    rules: {
      'no-console': 'off',
    },
  },
  
  // 6. Prettier config must be last to override other styling rules
  prettierConfig,
];
