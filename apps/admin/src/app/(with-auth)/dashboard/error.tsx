"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

export default function DashboardError({
  error,
  reset,
}: {
  error: Error;
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(new Error("Dashboard render failed"));
  }, [error]);

  return (
    <div className="space-y-3">
      <h2 className="text-lg font-semibold">Couldn’t load the dashboard</h2>
      <p className="text-sm text-muted-foreground">This page failed to load.</p>
      <button
        onClick={reset}
        className="inline-flex items-center px-3 py-1.5 rounded bg-primary text-white"
      >
        Try again
      </button>
    </div>
  );
}
