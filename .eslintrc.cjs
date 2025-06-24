// .eslintrc.cjs
// Enhanced version with additional hospital-grade rules (optional)

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

    // ===== OPTIONAL ENHANCEMENTS =====
    
    // Security and Best Practices
    'no-eval': 'error',                    // Prevent eval() usage
    'no-implied-eval': 'error',           // Prevent implied eval
    'no-new-func': 'error',               // Prevent Function constructor
    'prefer-const': 'warn',               // Prefer const when possible
    'no-var': 'warn',                     // Prefer let/const over var
    
    // Code Quality
    'eqeqeq': ['warn', 'always'],         // Require === and !==
    'curly': ['warn', 'all'],             // Require curly braces
    'no-duplicate-imports': 'warn',       // Prevent duplicate imports
    
    // Hospital-specific: Error handling
    'no-empty-catch': 'warn',             // Warn about empty catch blocks
    'no-unused-catch-bindings': 'warn',   // Warn about unused catch parameters
    
    // Medical data safety
    'no-implicit-globals': 'error',       // Prevent global variable leaks
    'no-undef': 'error',                  // Prevent undefined variables
  },
  
  // Override rules for specific file patterns
  overrides: [
    {
      // Test files can be more relaxed
      files: ['**/*.test.js', '**/*.spec.js', '**/tests/**/*.js'],
      rules: {
        'no-console': 'off',               // Allow console in tests
        'no-unused-vars': 'off',          // Allow unused vars in tests
      }
    },
    {
      // Scripts can use console freely
      files: ['src/scripts/**/*.js'],
      rules: {
        'no-console': 'off',               // Allow console in scripts
      }
    },
    {
      // Configuration files
      files: ['*.config.js', '*.config.cjs'],
      env: {
        node: true,
      },
      rules: {
        'no-console': 'off',               // Allow console in config files
      }
    }
  ]
};