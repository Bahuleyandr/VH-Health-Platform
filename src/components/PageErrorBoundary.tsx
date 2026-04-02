// src/components/PageErrorBoundary.tsx
"use client";

import { ErrorBoundary } from "react-error-boundary";
import { ReactNode } from "react";

import type { FallbackProps } from "react-error-boundary";

function ErrorFallback({ error, resetErrorBoundary }: FallbackProps) {
  const errorMessage = error instanceof Error ? error.message : String(error);
  return (
    <div className="min-h-[400px] flex items-center justify-center">
      <div className="text-center">
        <h2 className="text-2xl font-bold text-destructive mb-4">
          Oops! Something went wrong
        </h2>
        <p className="text-muted-foreground mb-4">{errorMessage}</p>
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
      onError={(error) => {
        // Hook up your error tracker here (Sentry, etc.)
        console.error("Page error:", error);
      }}
    >
      {children}
    </ErrorBoundary>
  );
}
