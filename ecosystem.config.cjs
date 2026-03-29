module.exports = {
  apps: [{
    name: 'vh-health-api',
    script: 'src/bin/www.js',
    instances: 'max',
    exec_mode: 'cluster',
    node_args: '--enable-source-maps',
    env: { NODE_ENV: 'production' },
    max_memory_restart: '512M',
    watch: false,
  }],
};
