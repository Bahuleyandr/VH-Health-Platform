// src/components/EmptyState.tsx
"use client";

import { ReactNode } from "react";

interface EmptyStateProps {
  /** Optional icon rendered above the title (e.g. lucide icon element). */
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /** Optional primary action (e.g. <Link> or <button>). */
  action?: ReactNode;
  /** Compact variant with less vertical padding — for in-card empty states. */
  compact?: boolean;
  className?: string;
}

/**
 * Standard empty state used across the admin portal. Prefer this over
 * ad-hoc "No data" markup so empty states stay visually consistent.
 *
 * Example:
 * ```tsx
 * <EmptyState
 *   icon={<Inbox className="h-10 w-10 text-muted-foreground" />}
 *   title="No pending appointments"
 *   description="New appointments will appear here."
 *   action={<Button onClick={refetch}>Refresh</Button>}
 * />
 * ```
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  compact = false,
  className = "",
}: EmptyStateProps) {
  const padding = compact ? "py-6" : "py-12";
  return (
    <div
      className={`flex flex-col items-center justify-center ${padding} text-center ${className}`.trim()}
    >
      {icon && <div className="mb-3 opacity-60">{icon}</div>}
      <h3 className="text-base font-semibold text-foreground">{title}</h3>
      {description && (
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">
          {description}
        </p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
