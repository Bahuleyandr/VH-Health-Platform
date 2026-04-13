// src/app/(with-auth)/layout.tsx
// QueryClientProvider is already mounted in the root layout via <Providers>.
// AuthProvider is also mounted there via AuthContext. This layout wraps the
// authenticated surface in a PageErrorBoundary so any render error inside a
// dashboard page is caught, reported to Sentry, and shown as a recoverable
// fallback instead of a blank screen.
'use client';

import { PageErrorBoundary } from '@/components/PageErrorBoundary';

export default function WithAuthLayout({ children }: { children: React.ReactNode }) {
  return <PageErrorBoundary>{children}</PageErrorBoundary>;
}
