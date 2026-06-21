// src/app/(with-auth)/layout.tsx
// QueryClientProvider is already mounted in the root layout via <Providers>.
// AuthProvider is also mounted there via AuthContext. This layout wraps the
// authenticated surface in a PageErrorBoundary so any render error inside a
// dashboard page is caught, reported to Sentry, and shown as a recoverable
// fallback instead of a blank screen.
'use client';

import { PageErrorBoundary } from '@/components/PageErrorBoundary';
import { TenantProvider } from '@/contexts/TenantContext';

export default function WithAuthLayout({ children }: { children: React.ReactNode }) {
  // TenantProvider fetches the caller's tenant branding once, post-auth, so the
  // dashboard chrome can brand itself (W5 S2). Scoped here (not in the root
  // <Providers>) so the login page never fires the authenticated request.
  return (
    <PageErrorBoundary>
      <TenantProvider>{children}</TenantProvider>
    </PageErrorBoundary>
  );
}
