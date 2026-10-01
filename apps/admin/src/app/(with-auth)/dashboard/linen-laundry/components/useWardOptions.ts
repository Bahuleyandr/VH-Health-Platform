"use client";

import { useActingTenant } from "@/contexts/ActingTenantContext";
import { useAuth } from "@/contexts/AuthContext";
import { useTenant } from "@/contexts/TenantContext";
import { listLinenWardOptions } from "@/lib/api/linenLaundry";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

export function useWardOptions(onScopeChange: () => void) {
  const { user, loading } = useAuth();
  const { tenant, isLoading: tenantLoading } = useTenant();
  const { actingTenant, isReady, scopeKey: tenantScopeKey, isScopeCurrent } = useActingTenant();
  const profileTenant = (user as { tenantId?: unknown } | null)?.tenantId;
  const admin = user?.role === "ADMIN" || user?.role === "SUPER_ADMIN";
  const tenantId = user?.role === "SUPER_ADMIN" && actingTenant
    ? actingTenant.id : admin ? tenant?.id
      : typeof profileTenant === "string" ? profileTenant : null;
  const ready = !loading && !!user && isReady && !!tenantScopeKey
    && (!admin || (!!tenantId && (!!actingTenant || !tenantLoading)));
  const scopeKey = JSON.stringify([
    tenantScopeKey, user?.uid ?? user?.id, user?.role, user?.permissions, tenantId,
  ]);
  const [openedScope, setOpenedScope] = useState<string | null>(null);
  const changed = openedScope !== null && (!ready || scopeKey !== openedScope);
  useEffect(() => {
    if (openedScope === null && ready) setOpenedScope(scopeKey);
    if (changed) onScopeChange();
  }, [openedScope, ready, scopeKey, changed, onScopeChange]);

  const active = useRef(false);
  useLayoutEffect(() => {
    active.current = ready && !changed;
    return () => { active.current = false; };
  }, [ready, changed, scopeKey]);

  const query = useInfiniteQuery({
    queryKey: ["linen-laundry", "wards", scopeKey],
    queryFn: async ({ pageParam, signal }) => {
      if (!tenantScopeKey || !isScopeCurrent(tenantScopeKey)) throw new Error("Tenant scope changed");
      const page = await listLinenWardOptions({ cursor: pageParam }, signal);
      if (!isScopeCurrent(tenantScopeKey)) throw new Error("Tenant scope changed");
      return page;
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: page => page.next_cursor ?? undefined,
    enabled: ready && !changed,
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: "always",
    retry: false,
  });
  const wards = ready && !changed && !query.isError
    ? query.data?.pages.flatMap(page => page.items) ?? [] : [];

  return {
    wards,
    scopeKey,
    ready: ready && !changed,
    changed,
    isLoading: !ready || query.isPending,
    isFetching: query.isFetching,
    hasNextPage: query.hasNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
    fetchNextPage: query.fetchNextPage,
    error: query.error instanceof Error ? query.error.message
      : query.error ? "Could not load the ward directory" : null,
    async validateSelection(id: number) {
      if (!tenantScopeKey || !isScopeCurrent(tenantScopeKey)) throw new Error("Tenant scope changed");
      const current = await query.refetch();
      if (!active.current || !isScopeCurrent(tenantScopeKey) || current.isError
        || !current.data?.pages.some(page => page.items.some(ward => ward.id === id))) {
        throw new Error("The ward selection is no longer available. Select a ward again.");
      }
    },
  };
}
