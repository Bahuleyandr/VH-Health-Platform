// babel.config.mjs
export default {
  presets: [
    ['@babel/preset-env', {
      targets: {
        node: '18'
      }
    }]
  ],
  sourceMaps: true,
  retainLines: true,
  plugins: [
    '@babel/plugin-transform-optional-chaining',
    '@babel/plugin-transform-nullish-coalescing-operator',
    '@babel/plugin-proposal-class-properties',
    '@babel/plugin-proposal-private-methods'
  ],
  env: {
    development: {
      sourceMaps: 'inline'
    },
    production: {
      sourceMaps: true
    }
  }
};
