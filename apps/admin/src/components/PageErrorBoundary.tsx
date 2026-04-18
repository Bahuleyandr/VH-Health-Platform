// src/components/PageErrorBoundary.tsx
"use client";

import * as Sentry from "@sentry/nextjs";
import { ErrorBoundary } from "react-error-boundary";
import { ReactNode } from "react";

import type { FallbackProps } from "react-error-boundary";

function ErrorFallback({ error, resetErrorBoundary }: FallbackProps) {
  // Avoid leaking the raw error message to the user — the message may
  // contain internal detail. Log the real error to Sentry instead (see
  // `onError` below) and show a generic, reassuring fallback.
  return (
    <div className="min-h-[400px] flex items-center justify-center">
      <div className="text-center max-w-md px-4">
        <h2 className="text-2xl font-bold text-destructive mb-2">
          Something went wrong
        </h2>
        <p className="text-muted-foreground mb-4">
          This page failed to load. Our team has been notified.
        </p>
        <button
          onClick={resetErrorBoundary}
          className="px-4 py-2 bg-primary text-white rounded hover:bg-primary/90"
        >
          Try again
        </button>
        {process.env.NODE_ENV === "development" && error instanceof Error && (
          <pre className="mt-4 text-left text-xs text-muted-foreground whitespace-pre-wrap">
            {error.message}
          </pre>
        )}
      </div>
    </div>
  );
}

interface PageErrorBoundaryProps {
  children: ReactNode;
}

export function PageErrorBoundary({ children }: PageErrorBoundaryProps) {
  return (
    <ErrorBoundary
      FallbackComponent={ErrorFallback}
      onError={(error, info) => {
        Sentry.captureException(error, {
          contexts: {
            react: { componentStack: info.componentStack },
          },
        });
        if (process.env.NODE_ENV === "development") {
          // eslint-disable-next-line no-console
          console.error("Page error:", error);
        }
      }}
    >
      {children}
    </ErrorBoundary>
  );
}
