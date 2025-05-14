const Sentry = require('@sentry/node');
const { Integrations } = require('@sentry/tracing');

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  tracesSampleRate: 1.0,
  integrations: [
    new Integrations.Http({ tracing: true }),
  ],
});

module.exports = Sentry;
