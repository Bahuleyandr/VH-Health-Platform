// src/app/(protected)/layout.tsx
'use client';

import type { ReactNode } from 'react';
import { PageErrorBoundary } from '@/components/PageErrorBoundary';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';

export default function ProtectedLayout({ children }: { children: ReactNode }) {
  return (
    <PageErrorBoundary>
      <ProtectedRoute requiredRole="ADMIN">{children}</ProtectedRoute>
    </PageErrorBoundary>
  );
}
