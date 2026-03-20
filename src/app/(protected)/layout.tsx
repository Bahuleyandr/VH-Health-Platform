// src/app/(protected)/layout.tsx
"use client";

import { ProtectedRoute } from "@/components/auth/ProtectedRoute";
import { PageErrorBoundary } from "@/components/PageErrorBoundary";
import type { ReactNode } from "react";

export default function ProtectedLayout({ children }: { children: ReactNode }) {
  return (
    <PageErrorBoundary>
      <ProtectedRoute requiredRole="ADMIN">{children}</ProtectedRoute>
    </PageErrorBoundary>
  );
}
