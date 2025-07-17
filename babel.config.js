module.exports = {
  presets: [
    ['@babel/preset-env', {
      targets: {
        node: '18'
      }
    }]
  ],
  plugins: ['@babel/plugin-transform-optional-chaining'],
  sourceMaps: true,
  retainLines: true,
  env: {
    development: {
      sourceMaps: 'inline'
    },
    production: {
      sourceMaps: true
    }
  }
};
