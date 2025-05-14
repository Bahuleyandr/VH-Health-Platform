const Sentry = require('@sentry/node');
const { Http, Express } = require('@sentry/integrations');

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  integrations: [
    new Http({ tracing: true }),
    new Express({ app: require('express')() }),
  ],
  tracesSampleRate: 1.0,
});

module.exports = Sentry;
