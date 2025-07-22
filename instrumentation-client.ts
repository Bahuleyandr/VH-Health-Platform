# Complete file replacement to ensure it's correct
$content = @"
// instrumentation-client.ts
import * as Sentry from "@sentry/nextjs";

export function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    return;
  }

  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    integrations: [
      Sentry.replayIntegration({
        maskAllText: false,
        blockAllMedia: false,
      }),
    ],
    tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1.0,
    replaysSessionSampleRate: 0.1,
    replaysOnErrorSampleRate: 1.0,
    environment: process.env.NODE_ENV,
    enabled: process.env.NODE_ENV === "production",
    telemetry: false,
  });
}

// Call register immediately
register();

// Export navigation instrumentation hook (required for Sentry with Next.js)
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
"@

Set-Content -Path instrumentation-client.ts -Value $content -Encoding UTF8