// src/app/(with-auth)/layout.tsx
'use client';

import { AuthProvider } from '@/contexts/AuthContext';
import { QueryProvider } from '@/providers/query-provider';

export default function WithAuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <QueryProvider>
      <AuthProvider>{children}</AuthProvider>
    </QueryProvider>
  );
}
