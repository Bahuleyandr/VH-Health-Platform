// src/utils/sentry.js
import * as Sentry from '@sentry/node';
import dotenv from 'dotenv';
import { scrubSentryEvent } from './sentryScrubber.js';

dotenv.config();

const env = process.env.NODE_ENV || 'development';
const dsn = process.env.SENTRY_DSN;
const release = process.env.GIT_COMMIT || process.env.RENDER_GIT_COMMIT || 'unknown';
const sampleRate = Number.parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE || '');
const tracesSampleRate = Number.isFinite(sampleRate) ? sampleRate : (env === 'production' ? 0.1 : 1.0);

// Production without a DSN means we're losing server errors — warn loudly.
if (!dsn && env === 'production') {
  // no-console rule allows `warn` + `error` globally — no disable needed.
  console.warn('[sentry] SENTRY_DSN not set in production — error reporting disabled');
}

// Roadmap A6: clinical WRITE paths trace at 100% — when a med
// administration or order write goes slow/wrong, a 10% sample is not
// enough to reconstruct the incident. Everything else keeps the
// env-configured rate. Pure + exported for unit tests.
const CLINICAL_WRITE_RX = /^(POST|PUT|PATCH|DELETE)\s+\/api\/v1\/(emr|clinical|prescriptions|pharmacy-orders|downtime|bloodbank|theatre)\b/i;
export function clinicalAwareTracesSampler({ name, parentSampled, baseRate = tracesSampleRate }) {
  if (typeof parentSampled === 'boolean') return parentSampled;
  if (name && CLINICAL_WRITE_RX.test(name)) return 1.0;
  return baseRate;
}

Sentry.init({
  dsn,
  enabled: Boolean(dsn) && env !== 'test',
  tracesSampler: (ctx) => clinicalAwareTracesSampler({
    name: ctx?.name || ctx?.transactionContext?.name || '',
    parentSampled: ctx?.parentSampled,
  }),
  environment: process.env.SENTRY_ENVIRONMENT || env,
  release,
  serverName: process.env.HOSTNAME || process.env.COMPUTERNAME || undefined,
  sendDefaultPii: false,
  beforeSend: scrubSentryEvent,
  beforeSendTransaction: scrubSentryEvent,
  initialScope: {
    tags: {
      service: 'vh-health-backend',
    },
  },
});

export default Sentry;
