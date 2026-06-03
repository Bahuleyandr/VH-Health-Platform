// instrumentation-client.ts
import * as Sentry from "@sentry/nextjs";
import { scrubSentryEvent } from "./src/lib/sentryScrubber";

const replaySessionSampleRate = Number.parseFloat(
  process.env.NEXT_PUBLIC_SENTRY_REPLAY_SESSION_SAMPLE_RATE ?? "0",
);
const replayErrorSampleRate = Number.parseFloat(
  process.env.NEXT_PUBLIC_SENTRY_REPLAY_ERROR_SAMPLE_RATE ?? "0",
);
const tracesSampleRate = Number.parseFloat(
  process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE ?? "",
);
const resolvedTracesSampleRate = Number.isFinite(tracesSampleRate)
  ? tracesSampleRate
  : process.env.NODE_ENV === "production"
    ? 0.1
    : 1.0;

export function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    return;
  }

  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    integrations: [
      Sentry.replayIntegration({
        maskAllText: true,
        blockAllMedia: true,
      }),
    ],
    tracesSampleRate: resolvedTracesSampleRate,
    replaysSessionSampleRate: replaySessionSampleRate,
    replaysOnErrorSampleRate: replayErrorSampleRate,
    environment:
      process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT || process.env.NODE_ENV,
    release: process.env.NEXT_PUBLIC_SENTRY_RELEASE,
    sendDefaultPii: false,
    beforeSend: (event) => scrubSentryEvent(event),
    beforeSendTransaction: (event) => scrubSentryEvent(event),
    enabled:
      Boolean(process.env.NEXT_PUBLIC_SENTRY_DSN) &&
      process.env.NODE_ENV !== "test",
  });
}

// Call register immediately
register();

// Export navigation instrumentation hook (required for Sentry with Next.js)
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
