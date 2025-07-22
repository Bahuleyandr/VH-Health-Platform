// instrumentation.ts
import * as Sentry from "@sentry/nextjs";

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./instrumentation-server');
  }
}

// Export the onRequestError hook for Sentry
export const onRequestError = Sentry.captureRequestError;