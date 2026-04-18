// src/components/LoadingSpinner.tsx
"use client";

import { ReactNode } from "react";

interface LoadingSpinnerProps {
  /** Optional label shown below the spinner. */
  label?: ReactNode;
  /** Spinner size in pixels (default 32). */
  size?: number;
  /** Fill the parent height — useful for full-page loads. */
  fullHeight?: boolean;
  className?: string;
}

/**
 * Standard loading indicator used across the admin portal. Prefer this over
 * ad-hoc spinners so loading states stay visually consistent.
 */
export function LoadingSpinner({
  label,
  size = 32,
  fullHeight = false,
  className = "",
}: LoadingSpinnerProps) {
  const wrapperClass = fullHeight
    ? "flex min-h-[50vh] items-center justify-center"
    : "flex items-center justify-center py-8";

  return (
    <div
      className={`${wrapperClass} ${className}`.trim()}
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <div className="text-center">
        <div
          className="mx-auto animate-spin rounded-full border-2 border-b-transparent border-primary"
          style={{ width: size, height: size }}
        />
        {label && (
          <p className="mt-3 text-sm text-muted-foreground">{label}</p>
        )}
        <span className="sr-only">Loading…</span>
      </div>
    </div>
  );
}
