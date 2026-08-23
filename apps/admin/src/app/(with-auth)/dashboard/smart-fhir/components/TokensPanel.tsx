"use client";

import { EmptyState } from "@/components/EmptyState";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import {
  describeSmartApiError,
  listSmartTokens,
  revokeSmartToken,
  SMART_TOKEN_STATUSES,
  type SmartAccessToken,
  type SmartApiErrorInfo,
  type SmartApp,
} from "@/lib/api/smartFhir";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, RefreshCw, ShieldOff } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "react-hot-toast";

import { ErrorBanner, formatDateTime, ScopeChips, StatusPill } from "./shared";

const selectClass =
  "rounded-md border border-border bg-background px-2 py-1.5 text-sm";

function RevokeDialog({
  token,
  appLabel,
  onClose,
}: {
  token: SmartAccessToken;
  appLabel: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<SmartApiErrorInfo | null>(null);

  const mutation = useMutation({
    mutationFn: () => revokeSmartToken(token.id, reason.trim()),
    onSuccess: () => {
      toast.success(`Token #${token.id} revoked`);
      void queryClient.invalidateQueries({
        queryKey: ["smart-fhir", "tokens"],
      });
      onClose();
    },
    onError: (err: unknown) => setError(describeSmartApiError(err)),
  });

  const canRevoke = reason.trim().length > 0 && !mutation.isPending;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Revoke access token ${token.id}`}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    >
      <div className="w-full max-w-md space-y-3 rounded-md border border-border bg-card p-5 shadow-lg">
        <div className="flex items-center gap-2 text-base font-semibold text-foreground">
          <ShieldOff className="h-5 w-5 text-red-600" />
          Revoke access token #{token.id}
        </div>
        <p className="text-sm text-muted-foreground">
          Immediately cuts off <span className="font-medium">{appLabel}</span> (
          {token.environment}) from the FHIR surface for this token. This cannot
          be undone; the app must complete a new OAuth flow to regain access.
        </p>
        <div className="rounded-md bg-muted/40 p-2 text-xs text-muted-foreground">
          Scopes: {token.granted_scopes.join(" ") || "-"}
        </div>
        <div>
          <label
            className="mb-1 block text-xs font-medium text-muted-foreground"
            htmlFor="revoke-reason"
          >
            Revocation reason (required — recorded on the token)
          </label>
          <textarea
            id="revoke-reason"
            aria-label="Revocation reason (required — recorded on the token)"
            className="min-h-20 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Integration decommissioned / credential suspected compromised"
          />
        </div>
        {error && (
          <ErrorBanner
            message={error.message}
            code={error.code}
            requestId={error.requestId}
          />
        )}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border bg-background px-3 py-2 text-sm font-medium hover:bg-muted"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canRevoke}
            onClick={() => mutation.mutate()}
            className="rounded-md bg-red-600 px-3 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-60"
          >
            {mutation.isPending ? "Revoking..." : "Revoke token"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function TokensPanel({ apps }: { apps: SmartApp[] }) {
  const [appFilter, setAppFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [revokeTarget, setRevokeTarget] = useState<SmartAccessToken | null>(
    null,
  );

  const appById = useMemo(() => {
    const map = new Map<number, SmartApp>();
    for (const app of apps) map.set(app.id, app);
    return map;
  }, [apps]);

  const tokensQuery = useQuery({
    queryKey: ["smart-fhir", "tokens", appFilter, statusFilter],
    queryFn: () =>
      listSmartTokens({
        smartAppId: appFilter ? Number(appFilter) : undefined,
        status: statusFilter || undefined,
        limit: 200,
      }),
  });

  const tokens = tokensQuery.data?.tokens ?? [];
  const appLabel = (id: number) => appById.get(id)?.client_id ?? `app #${id}`;

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold text-foreground">
          Access tokens ({tokens.length})
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label="Filter tokens by app"
            className={selectClass}
            value={appFilter}
            onChange={(e) => setAppFilter(e.target.value)}
          >
            <option value="">All apps</option>
            {apps.map((app) => (
              <option key={app.id} value={String(app.id)}>
                {app.client_id}
              </option>
            ))}
          </select>
          <select
            aria-label="Filter tokens by status"
            className={selectClass}
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            <option value="">All statuses</option>
            {SMART_TOKEN_STATUSES.map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void tokensQuery.refetch()}
            className="inline-flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm font-medium hover:bg-muted"
          >
            <RefreshCw className="h-4 w-4" />
            Refresh
          </button>
        </div>
      </div>

      {tokensQuery.isLoading ? (
        <LoadingSpinner label="Loading tokens..." />
      ) : tokensQuery.error ? (
        <ErrorBanner
          message={describeSmartApiError(tokensQuery.error).message}
          code={describeSmartApiError(tokensQuery.error).code}
        />
      ) : tokens.length === 0 ? (
        <div className="rounded-md border border-border bg-card">
          <EmptyState
            compact
            icon={<KeyRound className="h-10 w-10 text-muted-foreground" />}
            title="No access tokens"
            description="Tokens issued to registered apps will appear here."
          />
        </div>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border bg-card">
          <table className="min-w-full divide-y divide-border text-sm">
            <thead className="bg-muted/40 text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-3 py-2">ID</th>
                <th className="px-3 py-2">App</th>
                <th className="px-3 py-2">Env</th>
                <th className="px-3 py-2">Granted scopes</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Issued</th>
                <th className="px-3 py-2">Access expires</th>
                <th className="px-3 py-2">Last used</th>
                <th className="px-3 py-2">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {tokens.map((token) => (
                <tr key={token.id}>
                  <td className="px-3 py-3 font-mono text-xs">{token.id}</td>
                  <td className="px-3 py-3 font-mono text-xs">
                    {appLabel(token.smart_app_id)}
                  </td>
                  <td className="px-3 py-3 text-xs">{token.environment}</td>
                  <td className="px-3 py-3">
                    <ScopeChips scopes={token.granted_scopes} />
                  </td>
                  <td className="px-3 py-3">
                    <StatusPill value={token.status} />
                  </td>
                  <td className="whitespace-nowrap px-3 py-3 text-xs text-muted-foreground">
                    {formatDateTime(token.issued_at)}
                  </td>
                  <td className="whitespace-nowrap px-3 py-3 text-xs text-muted-foreground">
                    {formatDateTime(token.access_expires_at)}
                  </td>
                  <td className="whitespace-nowrap px-3 py-3 text-xs text-muted-foreground">
                    {formatDateTime(token.last_used_at)}
                    {token.last_used_ip && (
                      <span className="ml-1 font-mono">
                        ({token.last_used_ip})
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-3">
                    {token.status === "active" ? (
                      <button
                        type="button"
                        onClick={() => setRevokeTarget(token)}
                        className="rounded-md border border-red-200 bg-red-50 px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-100"
                      >
                        Revoke
                      </button>
                    ) : (
                      <span className="text-xs text-muted-foreground">-</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {revokeTarget && (
        <RevokeDialog
          token={revokeTarget}
          appLabel={appLabel(revokeTarget.smart_app_id)}
          onClose={() => setRevokeTarget(null)}
        />
      )}
    </section>
  );
}
