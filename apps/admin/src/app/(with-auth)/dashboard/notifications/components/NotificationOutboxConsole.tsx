"use client";

import { fetchAdminAPI } from "@/lib/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { useState } from "react";
import { toast } from "react-hot-toast";

type OutboxStatus = "FAILED" | "RECONCILIATION_REQUIRED";

type NotificationOutboxRow = {
  id: number;
  type: string;
  channel: string;
  status: OutboxStatus;
  recipient_id?: string | number | null;
  title?: string | null;
  retry_count: number;
  failure_reason?: string | null;
  created_at: string;
  last_attempt_at?: string | null;
  dead_letter: boolean;
};

type DeliveryCursor = {
  channel: string;
  last_contiguous_outbox_id?: number | null;
  state: string;
  blocked_outbox_id?: number | null;
  inflight_outbox_id?: number | null;
  updated_at?: string | null;
};

type OutboxResult = { rows?: NotificationOutboxRow[]; count?: number };
type CursorResult = { cursors?: DeliveryCursor[]; count?: number };

function formatDate(value?: string | null) {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString("en-GB");
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "The delivery ledger could not be loaded";
}

export function NotificationOutboxConsole() {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<OutboxStatus>("FAILED");
  const [reason, setReason] = useState("");
  const hasReason = reason.trim().length > 0;

  const rowsQuery = useQuery({
    queryKey: ["notification-outbox", status],
    queryFn: () => fetchAdminAPI<OutboxResult>(
      `/admin/notification-outbox?status=${status}&limit=100`,
    ),
    refetchInterval: 30_000,
  });

  const cursorsQuery = useQuery({
    queryKey: ["notification-outbox", "cursors"],
    queryFn: () => fetchAdminAPI<CursorResult>("/admin/notification-outbox/cursors"),
    refetchInterval: 30_000,
  });

  const refreshLedger = async () => {
    await queryClient.invalidateQueries({ queryKey: ["notification-outbox"] });
  };

  const replay = useMutation({
    mutationFn: (id: number) => fetchAdminAPI(
      `/admin/notification-outbox/${id}/replay`,
      { method: "POST", body: { reason: reason.trim() } },
    ),
    onSuccess: async () => {
      await refreshLedger();
      toast.success("Notification recovery was recorded");
    },
    onError: (error: Error) => toast.error(error.message || "Notification recovery failed"),
  });

  const reset = useMutation({
    mutationFn: (channel: string) => fetchAdminAPI(
      `/admin/notification-outbox/cursors/${encodeURIComponent(channel)}/reset`,
      { method: "POST", body: { reason: reason.trim() } },
    ),
    onSuccess: async () => {
      await refreshLedger();
      toast.success("Resolved delivery cursor was reset");
    },
    onError: (error: Error) => toast.error(error.message || "Delivery cursor reset failed"),
  });

  const rows = rowsQuery.data?.rows ?? [];
  const cursors = cursorsQuery.data?.cursors ?? [];

  const requestReplay = (row: NotificationOutboxRow) => {
    if (!hasReason || !row.dead_letter) return;
    const warning = row.status === "RECONCILIATION_REQUIRED"
      ? "The provider outcome is unknown. Replaying may deliver a duplicate notification. Continue?"
      : "Replay this terminal notification failure?";
    if (window.confirm(warning)) replay.mutate(row.id);
  };

  const requestReset = (cursor: DeliveryCursor) => {
    if (!hasReason) return;
    if (window.confirm("Reset this cursor only after its blocked delivery is factually resolved?")) {
      reset.mutate(cursor.channel);
    }
  };

  return (
    <section className="space-y-6" aria-labelledby="notification-delivery-health-title">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <h3 id="notification-delivery-health-title" className="text-lg font-semibold">
            Notification Delivery Health
          </h3>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            Inspect terminal or uncertain provider outcomes. Recovery actions are audited and
            require a specific operator reason.
          </p>
        </div>
        <button
          type="button"
          onClick={() => refreshLedger()}
          className="inline-flex items-center justify-center gap-2 rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-accent"
        >
          <RefreshCw className="h-4 w-4" />
          Refresh
        </button>
      </div>

      <div className="rounded-lg border border-border bg-card p-4">
        <label className="block text-sm font-semibold">
          Operator reason
          <textarea
            aria-label="Operator reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={1000}
            rows={2}
            placeholder="Incident or provider evidence supporting this exact action"
            className="mt-2 w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-normal"
          />
        </label>
        <p className="mt-1 text-xs text-muted-foreground">
          An uncertain replay can duplicate delivery. A cursor reset cannot bypass an unresolved head.
        </p>
      </div>

      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h4 className="font-semibold">Outbox recovery queue</h4>
          <div className="flex rounded-md border border-border p-1">
            {(["FAILED", "RECONCILIATION_REQUIRED"] as OutboxStatus[]).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setStatus(value)}
                className={`rounded px-3 py-1.5 text-xs font-medium ${status === value ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
              >
                {value === "FAILED" ? "Failed" : "Reconciliation required"}
              </button>
            ))}
          </div>
        </div>

        {rowsQuery.error ? (
          <div role="alert" className="rounded-md border border-destructive bg-destructive/10 px-4 py-3 text-sm text-destructive">
            Outbox state is unavailable: {errorMessage(rowsQuery.error)}
          </div>
        ) : rowsQuery.isLoading ? (
          <div className="py-8 text-center text-sm text-muted-foreground">Loading delivery ledger…</div>
        ) : rows.length === 0 ? (
          <div className="rounded-lg border border-border bg-card p-8 text-center text-sm text-muted-foreground">
            No rows in this state.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border bg-card">
            <table className="w-full min-w-[960px] divide-y divide-border text-sm">
              <thead className="bg-muted">
                <tr>
                  {['ID', 'Created', 'Type / channel', 'Status', 'Retries', 'Failure', 'Action'].map((heading) => (
                    <th key={heading} className="px-4 py-3 text-left text-xs font-semibold uppercase text-muted-foreground">
                      {heading}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((row) => (
                  <tr key={row.id} className="align-top hover:bg-muted/40">
                    <td className="px-4 py-3 font-mono">{row.id}</td>
                    <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">{formatDate(row.created_at)}</td>
                    <td className="px-4 py-3">
                      <div className="font-medium">{row.type}</div>
                      <div className="text-xs text-muted-foreground">{row.channel}</div>
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-1 text-xs font-semibold text-amber-800">
                        <AlertTriangle className="h-3 w-3" /> {row.status}
                      </span>
                    </td>
                    <td className="px-4 py-3">{row.retry_count}</td>
                    <td className="max-w-xs px-4 py-3 text-muted-foreground">{row.failure_reason || "—"}</td>
                    <td className="px-4 py-3">
                      <button
                        type="button"
                        disabled={!hasReason || !row.dead_letter || replay.isPending}
                        onClick={() => requestReplay(row)}
                        title={!row.dead_letter ? "Only terminal or uncertain rows can be replayed" : undefined}
                        className="rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        Replay
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="space-y-3">
        <h4 className="font-semibold">Channel cursors</h4>
        {cursorsQuery.error ? (
          <div role="alert" className="rounded-md border border-destructive bg-destructive/10 px-4 py-3 text-sm text-destructive">
            Cursor state is unavailable: {errorMessage(cursorsQuery.error)}
          </div>
        ) : cursorsQuery.isLoading ? (
          <div className="py-6 text-center text-sm text-muted-foreground">Loading channel cursors…</div>
        ) : cursors.length === 0 ? (
          <div className="rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground">
            No channel cursors have been created.
          </div>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {cursors.map((cursor) => {
              const paused = cursor.state === "paused_rejected" || cursor.state === "paused_uncertain";
              return (
                <div key={cursor.channel} className="rounded-lg border border-border bg-card p-4">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold">{cursor.channel}</span>
                    <span className={`rounded-full px-2 py-1 text-xs font-medium ${paused ? "bg-amber-100 text-amber-800" : "bg-emerald-100 text-emerald-800"}`}>
                      {cursor.state}
                    </span>
                  </div>
                  <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
                    <dt className="text-muted-foreground">Blocked row</dt>
                    <dd className="text-right font-mono">{cursor.blocked_outbox_id ?? "—"}</dd>
                    <dt className="text-muted-foreground">Last contiguous</dt>
                    <dd className="text-right font-mono">{cursor.last_contiguous_outbox_id ?? "—"}</dd>
                    <dt className="text-muted-foreground">Updated</dt>
                    <dd className="col-span-2 text-muted-foreground">{formatDate(cursor.updated_at)}</dd>
                  </dl>
                  {paused && (
                    <button
                      type="button"
                      disabled={!hasReason || reset.isPending}
                      onClick={() => requestReset(cursor)}
                      className="mt-4 w-full rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Reset resolved cursor
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
