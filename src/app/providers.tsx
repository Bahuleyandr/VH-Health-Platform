// src/app/providers.tsx
'use client';

import { useEffect, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { Toaster } from 'react-hot-toast';
import { AuthProvider } from '@/contexts/AuthContext';
import { installApiFetchGuard } from '@/lib/install-api-fetch-guard';

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 60 * 1000, // 1 minute
            refetchOnWindowFocus: false,
          },
        },
      }),
  );

  useEffect(() => {
    // Install once on the client; the guard itself is idempotent.
    installApiFetchGuard(() => {
      try {
        return localStorage.getItem('adminToken') ?? undefined;
      } catch {
        return undefined;
      }
    });
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>{children}</AuthProvider>

      <Toaster
        position="top-right"
        toastOptions={{
          duration: 3500,
          success: { iconTheme: { primary: '#16a34a', secondary: '#fff' } },
          error: { iconTheme: { primary: '#dc2626', secondary: '#fff' } },
        }}
      />

      {process.env.NODE_ENV === 'development' && (
        <ReactQueryDevtools initialIsOpen={false} />
      )}
    </QueryClientProvider>
  );
}
