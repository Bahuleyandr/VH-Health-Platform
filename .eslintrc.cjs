// .eslintrc.cjs

module.exports = {
  env: {
    node: true,
    es2021: true,
    jest: true, // ✅ Add Jest globals for test files (describe, it, expect)
  },
  extends: ['eslint:recommended', 'prettier'],
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
  },
  rules: {
    // Only warn for console logs in production
    'no-console': process.env.NODE_ENV === 'production' ? 'warn' : 'off',

    // Allow unused variables prefixed with _
    'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
  },
};
