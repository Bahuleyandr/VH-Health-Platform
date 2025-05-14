const Sentry = require('@sentry/node');
const { Http } = require('@sentry/integrations');
const Tracing = require('@sentry/tracing');

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  integrations: [
    new Http({ tracing: true }), // Correctly importing Http from '@sentry/integrations'
    new Tracing.Integrations.Express(),
  ],
  tracesSampleRate: 1.0, // Adjust as per your application's requirements
});

module.exports = Sentry;