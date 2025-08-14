// src/app/(with-auth)/layout.tsx
'use client';

import { QueryProvider } from '@/providers/query-provider';
import { AuthProvider } from '@/providers/AuthProvider';

export default function WithAuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <QueryProvider>
      <AuthProvider>
        {children}
      </AuthProvider>
    </QueryProvider>
  );
}
