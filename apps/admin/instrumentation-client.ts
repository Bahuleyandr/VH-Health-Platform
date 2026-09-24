// instrumentation-client.ts
import * as Sentry from "@sentry/nextjs";
import { scrubSentryEvent } from "./src/lib/sentryScrubber";

export function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    return;
  }

  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    integrations: (defaults) =>
      defaults.filter(
        ({ name }) => name !== "Replay" && name !== "SpanStreaming",
      ),
    tracesSampleRate: 0,
    tracesSampler: () => 0,
    traceLifecycle: "static",
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
    environment:
      process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT || process.env.NODE_ENV,
    release: process.env.NEXT_PUBLIC_SENTRY_RELEASE,
    sendDefaultPii: false,
    beforeBreadcrumb: () => null,
    beforeSend: (event) => scrubSentryEvent(event),
    beforeSendTransaction: () => null,
    enabled:
      Boolean(process.env.NEXT_PUBLIC_SENTRY_DSN) &&
      process.env.NODE_ENV !== "test",
  });
}

// Call register immediately
register();

// Export navigation instrumentation hook (required for Sentry with Next.js)
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
