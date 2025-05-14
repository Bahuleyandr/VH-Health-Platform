const Sentry = require('@sentry/node');
const Tracing = require('@sentry/tracing');

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  integrations: [
    new Sentry.Integrations.Http({ tracing: true }), // Note: Sentry.Integrations.Http, not Http directly
    new Tracing.Integrations.Express({ app: require('express')() })
  ],
  tracesSampleRate: 1.0,
});

module.exports = Sentry;
