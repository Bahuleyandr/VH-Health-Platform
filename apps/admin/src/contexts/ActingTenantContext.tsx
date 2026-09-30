// This is a cookie-state mirror, not authorization to override a tenant.
// The proxy independently verifies role and override evidence on every request.
"use client";

import { useAuth } from "@/contexts/AuthContext";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

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

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function readResponse(res: Response): Promise<ActingTenant | null> {
  if (!res.ok) throw new Error(`Acting tenant request failed (${res.status})`);
  const data: unknown = await res.json();
  if (!data || typeof data !== "object" || !("actingTenant" in data)) {
    throw new Error("Invalid acting tenant response");
  }
  const tenant = data.actingTenant;
  if (tenant === null) return null;
  if (
    !tenant ||
    typeof tenant !== "object" ||
    !("id" in tenant) ||
    typeof tenant.id !== "string" ||
    !UUID_RE.test(tenant.id) ||
    !("slug" in tenant) ||
    (tenant.slug !== null && typeof tenant.slug !== "string") ||
    !("reason" in tenant) ||
    typeof tenant.reason !== "string"
  ) {
    throw new Error("Invalid acting tenant response");
  }
  return { id: tenant.id, slug: tenant.slug, reason: tenant.reason };
}

async function fetchActing(signal: AbortSignal): Promise<ActingTenant | null> {
  return readResponse(
    await fetch("/api/act-as", { method: "GET", signal, cache: "no-store" }),
  );
}

interface ScopeMutation {
  input?: ActAsInput;
  signal: AbortSignal;
}

async function mutateActing({
  input,
  signal,
}: ScopeMutation): Promise<ActingTenant | null> {
  const tenant = await readResponse(
    await fetch(
      "/api/act-as",
      input
        ? {
            method: "POST",
            signal,
            headers: { "content-type": "application/json" },
            body: JSON.stringify(input),
          }
        : { method: "DELETE", signal },
    ),
  );
  if (
    input ? tenant?.id !== input.tenantId.trim().toLowerCase() : tenant !== null
  ) {
    throw new Error("Unexpected acting tenant mutation response");
  }
  return tenant;
}

export interface ActingTenantValue {
  actingTenant: ActingTenant | null;
  setActAs: (input: ActAsInput) => Promise<void>;
  clear: () => Promise<void>;
  isPending: boolean;
  isReady: boolean;
  status: "loading" | "ready" | "reconciling" | "error";
  error: Error | null;
  retry: () => Promise<void>;
  scopeKey: string | null;
  isScopeCurrent: (scopeKey: string) => boolean;
}

const ActingTenantCtx = createContext<ActingTenantValue | undefined>(undefined);

export function ActingTenantProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, loading, sessionRevision, isSessionCurrent } = useAuth();
  const sessionKey = JSON.stringify([
    sessionRevision,
    user?.uid,
    user?.id,
    user?.role,
    loading,
  ]);
  return (
    <SessionProvider
      key={sessionKey}
      sessionKey={sessionKey}
      authenticated={!loading && !!user}
      authLoading={loading}
      isAuthSessionCurrent={() => isSessionCurrent(sessionRevision)}
    >
      {children}
    </SessionProvider>
  );
}

function SessionProvider({
  children,
  sessionKey,
  authenticated,
  authLoading,
  isAuthSessionCurrent,
}: {
  children: React.ReactNode;
  sessionKey: string;
  authenticated: boolean;
  authLoading: boolean;
  isAuthSessionCurrent: () => boolean;
}) {
  const qc = useQueryClient();
  const queryKey = ["acting-tenant", sessionKey];
  const mounted = useRef(false);
  const operation = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [publication, setPublication] = useState(0);
  const invalidatedPublication = useRef(0);
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => fetchActing(signal),
    enabled: authenticated,
    staleTime: 60 * 1000,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
    retry: false,
  });
  const mutation = useMutation({
    mutationFn: (args: ScopeMutation) => {
      assertCurrent();
      return mutateActing(args);
    },
    retry: false,
  });

  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      operation.current?.abort();
      void qc.cancelQueries({
        queryKey: ["acting-tenant", sessionKey],
        exact: true,
      });
    };
  }, [qc, sessionKey]);

  const isReady =
    authenticated &&
    !busy &&
    query.isSuccess &&
    query.fetchStatus === "idle" &&
    query.isFetchedAfterMount;
  const scopeKey = isReady
    ? JSON.stringify([sessionKey, query.data?.id ?? null])
    : null;
  useEffect(() => {
    if (!isReady || publication === invalidatedPublication.current) return;
    invalidatedPublication.current = publication;
    // Dependent observers must render the settled scope before they refetch.
    void qc.invalidateQueries({
      predicate: (item) => item.queryKey[0] !== "acting-tenant",
    });
  }, [isReady, publication, qc]);

  const assertCurrent = () => {
    if (!mounted.current || !authenticated || !isAuthSessionCurrent())
      throw new Error("Authentication changed; reload tenant scope");
  };
  const reconcile = async () => {
    await qc.cancelQueries({ queryKey, exact: true });
    assertCurrent();
    await qc.fetchQuery({
      queryKey,
      queryFn: ({ signal }) => fetchActing(signal),
      staleTime: 0,
      retry: false,
    });
    assertCurrent();
    setPublication((value) => value + 1);
  };

  const run = async (input?: ActAsInput) => {
    assertCurrent();
    if (!scopeKey || !isScopeCurrent(scopeKey)) {
      throw new Error("Tenant scope is not ready");
    }
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    try {
      await qc.cancelQueries({ queryKey, exact: true });
      assertCurrent();
      const tenant = await mutation.mutateAsync({
        input,
        signal: controller.signal,
      });
      assertCurrent();
      await qc.cancelQueries({ queryKey, exact: true });
      assertCurrent();
      // Publish the server-confirmed cookie state before invalidating tenant data.
      qc.setQueryData(queryKey, tenant);
      setPublication((value) => value + 1);
    } catch (error) {
      if (mounted.current) {
        try {
          await reconcile();
        } catch {
          /* The query retains the failed reconciliation. */
        }
      }
      throw error;
    } finally {
      if (mounted.current) {
        operation.current = null;
        setBusy(false);
      }
    }
  };

  const retry = async () => {
    assertCurrent();
    if (operation.current)
      throw new Error("Tenant scope is already being reconciled");
    operation.current = new AbortController();
    setBusy(true);
    try {
      await reconcile();
    } finally {
      if (mounted.current) {
        operation.current = null;
        setBusy(false);
      }
    }
  };

  const error =
    !authenticated && !authLoading
      ? new Error("Authentication required")
      : query.error;
  const isScopeCurrent = (scopeKey: string) => {
    const latest = qc.getQueryState<ActingTenant | null>(queryKey);
    return (
      mounted.current &&
      authenticated &&
      isAuthSessionCurrent() &&
      isReady &&
      !operation.current &&
      latest?.status === "success" &&
      latest.fetchStatus === "idle" &&
      scopeKey === JSON.stringify([sessionKey, latest.data?.id ?? null])
    );
  };
  const value: ActingTenantValue = {
    actingTenant: isReady ? (query.data ?? null) : null,
    setActAs: run,
    clear: () => run(),
    isPending: !isReady,
    isReady,
    status:
      busy || (query.fetchStatus !== "idle" && query.isFetchedAfterMount)
        ? "reconciling"
        : error
          ? "error"
          : isReady
            ? "ready"
            : "loading",
    error,
    retry,
    isScopeCurrent,
    scopeKey,
  };

  return (
    <ActingTenantCtx.Provider value={value}>
      {children}
    </ActingTenantCtx.Provider>
  );
}

export function useActingTenant(): ActingTenantValue {
  const value = useContext(ActingTenantCtx);
  if (!value)
    throw new Error("useActingTenant must be used within ActingTenantProvider");
  return value;
}
