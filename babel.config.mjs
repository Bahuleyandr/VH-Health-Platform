export default {
  presets: [
    ['@babel/preset-env', {
      targets: {
        node: '18',
      },
      useBuiltIns: 'entry',
      corejs: 3,
    }],
  ],
  plugins: [
    '@babel/plugin-transform-optional-chaining',
    '@babel/plugin-transform-nullish-coalescing-operator',
  ],
  sourceMaps: true,
  retainLines: true,
  env: {
    development: {
      sourceMaps: 'inline',
    },
    production: {
      sourceMaps: true,
    },
  },
};
