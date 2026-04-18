// src/app/(protected)/layout.tsx
"use client";

import type { ReactNode } from "react";
import { PageErrorBoundary } from "@/components/PageErrorBoundary";
import { ProtectedRoute } from "@/components/auth/ProtectedRoute";
import { useIdleTimeout } from "@/hooks/useIdleTimeout";

export default function ProtectedLayout({ children }: { children: ReactNode }) {
  // Auto-logout after 15 minutes of inactivity
  useIdleTimeout();

  return (
    <PageErrorBoundary>
      <ProtectedRoute requiredRole="ADMIN">{children}</ProtectedRoute>
    </PageErrorBoundary>
  );
}

