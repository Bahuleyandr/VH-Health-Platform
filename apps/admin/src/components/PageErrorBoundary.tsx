// src/components/PageErrorBoundary.tsx
"use client";

import * as Sentry from "@sentry/nextjs";
import { ErrorBoundary } from "react-error-boundary";
import { ReactNode } from "react";

import type { FallbackProps } from "react-error-boundary";

function ErrorFallback({ resetErrorBoundary }: FallbackProps) {
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
      onError={() => {
        Sentry.captureException(new Error("Authenticated page render failed"));
      }}
    >
      {children}
    </ErrorBoundary>
  );
}
