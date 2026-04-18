// instrument.js
import * as Sentry from '@sentry/node';

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  integrations: [
    // Enable HTTP calls tracing
    Sentry.httpIntegration(),
    // Enable Express.js middleware tracing
    Sentry.expressIntegration(),
  ],
  // Set tracesSampleRate to 1.0 to capture 100%
  // of transactions for performance monitoring.
  tracesSampleRate: 1.0,
  profilesSampleRate: 1.0, // Profile 100% of transactions
});