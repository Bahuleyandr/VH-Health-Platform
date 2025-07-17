// babel.config.js
module.exports = {
  presets: [
    ['@babel/preset-env', {
      targets: {
        // This is the critical change.
        // It tells Babel to support features available in Node.js 18 and newer.
        node: '18'
      }
    }]
  ],
  sourceMaps: true,
  retainLines: true,
  plugins: [
    // Add any babel plugins you need
  ],
  // Different source map types for different environments
  env: {
    development: {
      sourceMaps: 'inline'
    },
    production: {
      sourceMaps: true // Creates separate .map files
    }
  }
};