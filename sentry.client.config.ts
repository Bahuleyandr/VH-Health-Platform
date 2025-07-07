import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: process.env.NODE_ENV,
  integrations: [
    new Sentry.BrowserTracing(),
    new Sentry.Replay({
      maskAllText: true, // Important for HIPAA
      blockAllMedia: true,
    }),
  ],
  tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1.0,
  replaysSessionSampleRate: 0.1,
  replaysOnErrorSampleRate: 1.0,
  
  // Remove sensitive data
  beforeSend(event, hint) {
    // Remove auth tokens
    if (event.request?.cookies) {
      event.request.cookies = event.request.cookies.replace(/auth_token=[^;]+/, 'auth_token=[FILTERED]');
    }
    
    // Remove email/personal info from URLs
    if (event.request?.url) {
      event.request.url = event.request.url.replace(/email=[^&]+/, 'email=[FILTERED]');
    }
    
    return event;
  },
});