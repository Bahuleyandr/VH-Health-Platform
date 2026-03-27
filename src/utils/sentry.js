// src/utils/sentry.js
import * as Sentry from '@sentry/node';

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
  environment: process.env.NODE_ENV || 'development',
  release: process.env.GIT_COMMIT || process.env.RENDER_GIT_COMMIT || 'unknown',
});

export default Sentry;
