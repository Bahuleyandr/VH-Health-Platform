// src/utils/sentry.js
import * as Sentry from '@sentry/node';
import dotenv from 'dotenv';
import {
  normalizeSentryPath,
  scrubSentryEvent,
  scrubSentryText,
  scrubSentryValue,
} from './sentryScrubber.js';

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

// Roadmap / audit 2026-06-18 §4 Observability: beforeSend / beforeSendTransaction
// scrub the final event, but the default integrations (console capture,
// outbound HTTP) attach BREADCRUMBS that bypass those hooks — so a
// console.log / fetch carrying a phone, email, JWT, or sensitive key rode
// into Sentry unscrubbed. beforeBreadcrumb runs the same scrubbers over each
// breadcrumb's message + data before it is attached. Pure + exported for unit
// tests.
export function scrubBreadcrumb(breadcrumb) {
  if (!breadcrumb || typeof breadcrumb !== 'object') return breadcrumb;
  try {
    if (typeof breadcrumb.message === 'string') {
      breadcrumb.message = scrubSentryText(breadcrumb.message);
    }
    if (breadcrumb.data && typeof breadcrumb.data === 'object') {
      // Key-aware value scrub (redacts sensitive KEYS regardless of value).
      breadcrumb.data = scrubSentryValue(breadcrumb.data);
      // http breadcrumbs put the request target on data.url — path-normalize
      // it so ids/PHI in the URL don't survive and cardinality stays bounded.
      if (typeof breadcrumb.data.url === 'string') {
        breadcrumb.data.url = normalizeSentryPath(breadcrumb.data.url);
      }
    }
  } catch (_) {
    // Never let scrubbing drop a breadcrumb — return it as-is on error.
  }
  return breadcrumb;
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
  beforeBreadcrumb: scrubBreadcrumb,
  initialScope: {
    tags: {
      service: 'vh-health-backend',
    },
  },
});

export default Sentry;
