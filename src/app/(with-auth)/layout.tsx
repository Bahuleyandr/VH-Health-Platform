// app/(with-auth)/layout.tsx  (Client Component)
'use client';

import React from 'react';
// IMPORTANT: import the provider that supplies useUser()
// e.g., if your useAuth uses "@/contexts/UserContext", import its Provider here:
import { UserProvider } from '@/contexts/UserContext'; // or AuthProvider from your setup

export default function WithAuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <UserProvider> 
      {children}
    </UserProvider>
  );
}
