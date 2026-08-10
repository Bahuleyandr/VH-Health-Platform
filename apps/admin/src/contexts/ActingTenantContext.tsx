// W5 S3 — client mirror of the SUPER_ADMIN acting-tenant state. The authoritative
// state is the httpOnly `acting_tenant` cookie set by /api/act-as (server-gated
// to SUPER_ADMIN); this context reads it (GET), and begins/ends acting via
// POST/DELETE. On any change it invalidates ALL queries so tenant-scoped data
// reloads under the new acting tenant (the proxy now sends that tenant's
// x-tenant-id). Non-super admins never get a non-null acting tenant (the route
// rejects them), so this is inert for them.
'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext } from 'react';

export interface ActingTenant {
  id: string;
  slug: string | null;
  reason: string;
}

export interface ActAsInput {
  tenantId: string;
  slug?: string | null;
  reason: string;
}

async function fetchActing(): Promise<ActingTenant | null> {
  const res = await fetch('/api/act-as', { method: 'GET' });
  if (!res.ok) return null;
  const data = (await res.json()) as { actingTenant?: ActingTenant | null };
  return data.actingTenant ?? null;
}

async function postActing(input: ActAsInput): Promise<ActingTenant | null> {
  const res = await fetch('/api/act-as', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const d = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(d.message || 'Failed to act as tenant');
  }
  const data = (await res.json()) as { actingTenant?: ActingTenant | null };
  return data.actingTenant ?? null;
}

async function clearActing(): Promise<void> {
  const res = await fetch('/api/act-as', { method: 'DELETE' });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(data.message || 'Failed to stop acting as tenant');
  }
}

interface ActingTenantValue {
  actingTenant: ActingTenant | null;
  setActAs: (input: ActAsInput) => Promise<void>;
  clear: () => Promise<void>;
  isPending: boolean;
}

const ActingTenantCtx = createContext<ActingTenantValue>({
  actingTenant: null,
  setActAs: async () => {},
  clear: async () => {},
  isPending: false,
});

export function ActingTenantProvider({ children }: { children: React.ReactNode }) {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['acting-tenant'],
    queryFn: fetchActing,
    staleTime: 60 * 1000,
    retry: false,
  });

  const applyActingTenant = (actingTenant: ActingTenant | null) => {
    // The mutation response and cookie transition are one operation. Publish
    // that scope before invalidating tenant data so no refetch can be stored
    // under the previous tenant's query key.
    qc.setQueryData(['acting-tenant'], actingTenant);
    qc.invalidateQueries({
      predicate: (query) => query.queryKey[0] !== 'acting-tenant',
    });
  };

  const setMut = useMutation({
    mutationFn: postActing,
    onSuccess: applyActingTenant,
  });
  const clearMut = useMutation({
    mutationFn: clearActing,
    onSuccess: () => applyActingTenant(null),
  });

  const value: ActingTenantValue = {
    actingTenant: data ?? null,
    setActAs: async (input) => {
      await setMut.mutateAsync(input);
    },
    clear: async () => {
      await clearMut.mutateAsync();
    },
    isPending: setMut.isPending || clearMut.isPending,
  };

  return <ActingTenantCtx.Provider value={value}>{children}</ActingTenantCtx.Provider>;
}

export function useActingTenant(): ActingTenantValue {
  return useContext(ActingTenantCtx);
}
