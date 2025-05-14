const Sentry = require('@sentry/node');
const Tracing = require('@sentry/tracing');

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  integrations: [
    // Removed Sentry.Handlers.Http as it is not a constructor and may not be supported
    new Tracing.Integrations.Express(), // Tracing for Express.js
  ],
  tracesSampleRate: 1.0, // Adjust as needed for performance and cost
});

module.exports = Sentry;