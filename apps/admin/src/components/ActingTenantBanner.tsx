"use client";

import { LoadingSpinner } from "@/components/LoadingSpinner";
import { useActingTenant } from "@/contexts/ActingTenantContext";
import { useLayoutEffect, useRef, useState } from "react";

export function useActiveTenantScope(scopeKey?: string) {
  const { isScopeCurrent } = useActingTenant();
  const active = useRef(true);
  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  return {
    get current() {
      return (
        active.current && (scopeKey === undefined || isScopeCurrent(scopeKey))
      );
    },
    assertCurrent() {
      if (
        !active.current ||
        scopeKey === undefined ||
        !isScopeCurrent(scopeKey)
      ) {
        throw new Error("Tenant scope is not ready");
      }
    },
  };
}

export function ActingTenantReadinessNotice({
  error,
  retry,
}: {
  error: Error | null;
  retry: () => Promise<void>;
}) {
  return (
    <div
      role={error ? "alert" : "status"}
      className="flex items-center gap-3 p-4 text-sm"
    >
      {error ? (
        <>
          <span>
            Tenant scope could not be confirmed. Tenant actions are unavailable.
          </span>
          <button
            type="button"
            onClick={() => void retry().catch(() => undefined)}
          >
            Retry tenant scope
          </button>
        </>
      ) : (
        <>
          <LoadingSpinner />
          <span>Confirming tenant scope…</span>
        </>
      )}
    </div>
  );
}

export function ActingTenantBanner() {
  const [clearFailed, setClearFailed] = useState(false);
  const activeScope = useActiveTenantScope();
  const { actingTenant, clear, isPending, isReady, error, retry } =
    useActingTenant();
  const failure = clearFailed ? (
    <p role="alert" className="p-4 text-sm">
      The exit request was not confirmed. Check the current tenant scope before
      continuing.
    </p>
  ) : null;
  if (!isReady)
    return (
      <>
        {failure}
        <ActingTenantReadinessNotice error={error} retry={retry} />
      </>
    );
  if (!actingTenant) return failure;

  return (
    <>
      {failure}
      <div
        role="alert"
        style={{
          background: "#7c2d12",
          color: "#fff",
          padding: "8px 16px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          fontSize: 14,
        }}
      >
        <span>
          ⚠ Acting as tenant{" "}
          <strong>{actingTenant.slug || actingTenant.id}</strong> — every view
          and action remains subject to server authorization and audit.
        </span>
        <button
          type="button"
          onClick={() => {
            setClearFailed(false);
            void clear().catch(() => {
              if (activeScope.current) setClearFailed(true);
            });
          }}
          disabled={isPending}
          style={{
            background: "#fff",
            color: "#7c2d12",
            border: "none",
            borderRadius: 4,
            padding: "4px 12px",
            cursor: isPending ? "wait" : "pointer",
            fontWeight: 600,
            whiteSpace: "nowrap",
          }}
        >
          Exit tenant
        </button>
      </div>
    </>
  );
}
