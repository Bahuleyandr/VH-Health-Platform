// src/app/(with-auth)/layout.tsx
// QueryClientProvider is already mounted in the root layout via <Providers>.
// AuthProvider is also mounted there via AuthContext. This layout is kept as a
// simple pass-through so the route-group folder structure is preserved.
'use client';

export default function WithAuthLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
