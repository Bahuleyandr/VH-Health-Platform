// src/providers/AuthProvider.tsx
'use client';

import { UserProvider } from '@/contexts/UserContext';

export function AuthProvider({ children }: { children: React.ReactNode }) {
  return <UserProvider>{children}</UserProvider>;
}