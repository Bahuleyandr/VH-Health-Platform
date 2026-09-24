// instrumentation-server.ts
import * as Sentry from "@sentry/nextjs";
import { scrubSentryEvent } from "./src/lib/sentryScrubber";

export function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    Sentry.init({
      dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
      integrations: (defaults) =>
        defaults.filter(({ name }) => name !== "SpanStreaming"),
      tracesSampleRate: 0,
      tracesSampler: () => 0,
      traceLifecycle: "static",
      environment:
        process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT || process.env.NODE_ENV,
      release: process.env.NEXT_PUBLIC_SENTRY_RELEASE,
      sendDefaultPii: false,
      beforeSend: (event) => scrubSentryEvent(event),
      beforeSendTransaction: () => null,
      enabled:
        Boolean(process.env.NEXT_PUBLIC_SENTRY_DSN) &&
        process.env.NODE_ENV !== "test",
    });
  }
}

// Call register immediately
register();
