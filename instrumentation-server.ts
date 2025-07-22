// instrumentation-server.ts
import * as Sentry from "@sentry/nextjs";

export function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    Sentry.init({
      dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
      
      // Performance Monitoring
      tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1.0,
      
      // Environment
      environment: process.env.NODE_ENV,
      
      // Disable in development
      enabled: process.env.NODE_ENV === "production",
      
      // Disable telemetry
      telemetry: false,
    });
  }
}