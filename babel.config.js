// babel.config.js
module.exports = {
  presets: [
    ['@babel/preset-env', {
      targets: {
        // Align this with your package.json "engines" field
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