// W5 S2 — TenantProvider: fetches the caller's tenant context once (post-auth)
// and exposes { tenant, isLoading } for the dashboard chrome to brand itself.
// Degrades silently to null on error (retry:false) so an unbranded / single
// default tenant keeps today's look — branding is a pure enhancement.
"use client";

import { createContext, useContext, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  getTenantContext,
  type TenantContext as TenantContextData,
} from "@/lib/api/tenantContext";
import { tenantPrimaryCssVariables } from "@/lib/designTokens";

interface TenantContextValue {
  tenant: TenantContextData | null;
  isLoading: boolean;
}

const TenantCtx = createContext<TenantContextValue>({
  tenant: null,
  isLoading: false,
});

export function TenantProvider({ children }: { children: React.ReactNode }) {
  const { data, isLoading } = useQuery({
    queryKey: ["tenant-context"],
    queryFn: getTenantContext,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  const tenant = data ?? null;
  const primaryColor = tenant?.branding?.primaryColor ?? null;

  // Apply the tenant primary through the shared admin token bridge. The CSS
  // layer keeps the default token contract as fallback when branding is absent.
  useEffect(() => {
    if (typeof document === "undefined" || !primaryColor) return;
    const root = document.documentElement;
    tenantPrimaryCssVariables.forEach((name) => {
      root.style.setProperty(name, primaryColor);
    });
    return () => {
      tenantPrimaryCssVariables.forEach((name) => {
        root.style.removeProperty(name);
      });
    };
  }, [primaryColor]);

  return (
    <TenantCtx.Provider value={{ tenant, isLoading }}>
      {children}
    </TenantCtx.Provider>
  );
}

export function useTenant(): TenantContextValue {
  return useContext(TenantCtx);
}
