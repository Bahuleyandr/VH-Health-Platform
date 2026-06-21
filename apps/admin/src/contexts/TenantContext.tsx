// W5 S2 — TenantProvider: fetches the caller's tenant context once (post-auth)
// and exposes { tenant, isLoading } for the dashboard chrome to brand itself.
// Degrades silently to null on error (retry:false) so an unbranded / single
// default tenant keeps today's look — branding is a pure enhancement.
'use client';

import { createContext, useContext, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getTenantContext, type TenantContext as TenantContextData } from '@/lib/api/tenantContext';

interface TenantContextValue {
  tenant: TenantContextData | null;
  isLoading: boolean;
}

const TenantCtx = createContext<TenantContextValue>({ tenant: null, isLoading: false });

export function TenantProvider({ children }: { children: React.ReactNode }) {
  const { data, isLoading } = useQuery({
    queryKey: ['tenant-context'],
    queryFn: getTenantContext,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  const tenant = data ?? null;
  const primaryColor = tenant?.branding?.primaryColor ?? null;

  // Apply the tenant's primary colour as a CSS variable so themed components can
  // opt in via var(--tenant-primary). Only set when present — absent ⇒ today's
  // palette is untouched (NO-OP for the default tenant).
  useEffect(() => {
    if (typeof document === 'undefined' || !primaryColor) return;
    const root = document.documentElement;
    root.style.setProperty('--tenant-primary', primaryColor);
    return () => {
      root.style.removeProperty('--tenant-primary');
    };
  }, [primaryColor]);

  return <TenantCtx.Provider value={{ tenant, isLoading }}>{children}</TenantCtx.Provider>;
}

export function useTenant(): TenantContextValue {
  return useContext(TenantCtx);
}
