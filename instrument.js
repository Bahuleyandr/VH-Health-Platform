const Sentry = require('@sentry/node');
const Tracing = require('@sentry/tracing');

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  integrations: [
    new Tracing.Integrations.Express({ app: require('express')() }) // Only Express tracing
  ],
  tracesSampleRate: 1.0,
});

module.exports = Sentry;
