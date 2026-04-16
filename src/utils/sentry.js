// src/utils/sentry.js
//
// Sentry bootstrap. Call this module's side-effectful init ONCE at the top
// of app.js (before other imports that may throw). Per-request scope
// enrichment lives in `src/middleware/sentryScopeMiddleware.js`; the error
// handler (errorHandlerMiddleware) continues to call `Sentry.captureException`
// for 5xx paths.
import * as Sentry from '@sentry/node';

const env = process.env.NODE_ENV || 'development';
const dsn = process.env.SENTRY_DSN;
const release = process.env.GIT_COMMIT || process.env.RENDER_GIT_COMMIT || 'unknown';

// Production without a DSN means we're losing server errors — warn loudly.
if (!dsn && env === 'production') {
  // eslint-disable-next-line no-console
  console.warn('[sentry] SENTRY_DSN not set in production — error reporting disabled');
}

Sentry.init({
  dsn,
  tracesSampleRate: env === 'production' ? 0.1 : 1.0,
  environment: env,
  release,
  serverName: process.env.HOSTNAME || process.env.COMPUTERNAME || undefined,
  initialScope: {
    tags: {
      service: 'vh-health-backend',
    },
  },
});

export default Sentry;
