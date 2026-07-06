"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchAdminAPI } from "@/lib/api";
import { EmptyState } from "@/components/EmptyState";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { fmtDate, fmtINR, type PaymentNoticeReview } from "./types";

function unwrap<T>(r: unknown): T {
  return ((r as { data?: T }).data ?? r) as T;
}

type QueueResponse = {
  items: PaymentNoticeReview[];
  summary?: {
    count: number;
    manual_review: number;
    processed: number;
    rejected: number;
  };
};

const STATUS_LABELS: Record<string, string> = {
  manual_review: "Manual review",
  processed: "Approved",
  rejected: "Rejected",
};

const DISCREPANCY_CLASSES: Record<string, string> = {
  critical: "border-rose-300 bg-rose-50 text-rose-800",
  warning: "border-amber-300 bg-amber-50 text-amber-800",
  info: "border-sky-200 bg-sky-50 text-sky-800",
};

function statusLabel(value: string | null | undefined) {
  return STATUS_LABELS[String(value ?? "")] ?? String(value ?? "unknown");
}

function discrepancyClass(severity: string) {
  return DISCREPANCY_CLASSES[severity] ?? DISCREPANCY_CLASSES.info;
}

export function PaymentNoticeReviewTab() {
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState("manual_review");
  const [active, setActive] = useState<PaymentNoticeReview | null>(null);
  const [paidAmount, setPaidAmount] = useState("");
  const [paymentReference, setPaymentReference] = useState("");
  const [paidAt, setPaidAt] = useState("");
  const [rejectReason, setRejectReason] = useState("");

  const { data, error, isLoading } = useQuery<QueueResponse>({
    queryKey: ["insurance", "nhcx-payment-notices", statusFilter],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set("status", statusFilter);
      params.set("limit", "150");
      const result = await fetchAdminAPI<unknown>(
        `/admin/nhcx/payment-notices?${params.toString()}`,
      );
      const unwrapped = unwrap<QueueResponse>(result);
      return {
        items: Array.isArray(unwrapped.items) ? unwrapped.items : [],
        summary: unwrapped.summary,
      };
    },
  });

  useEffect(() => {
    if (!active) return;
    setPaidAmount(String(active.settlement_draft?.paid_amount ?? active.notice.amount ?? ""));
    setPaymentReference(
      String(active.settlement_draft?.payment_reference ?? active.notice.payment_reference ?? ""),
    );
    setPaidAt(String(active.settlement_draft?.paid_at ?? active.notice.paid_at ?? ""));
    setRejectReason("");
  }, [active]);

  const approveMut = useMutation({
    mutationFn: async (notice: PaymentNoticeReview) =>
      fetchAdminAPI(`/admin/nhcx/payment-notices/${notice.id}/approve`, {
        method: "POST",
        body: {
          paid_amount: Number(paidAmount),
          payment_reference: paymentReference,
          paid_at: paidAt || undefined,
        },
      }),
    onSuccess: async () => {
      setActive(null);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["insurance", "nhcx-payment-notices"] }),
        qc.invalidateQueries({ queryKey: ["insurance", "claims"] }),
      ]);
    },
  });

  const rejectMut = useMutation({
    mutationFn: async (notice: PaymentNoticeReview) =>
      fetchAdminAPI(`/admin/nhcx/payment-notices/${notice.id}/reject`, {
        method: "POST",
        body: { reason: rejectReason },
      }),
    onSuccess: async () => {
      setActive(null);
      await qc.invalidateQueries({ queryKey: ["insurance", "nhcx-payment-notices"] });
    },
  });

  const rows = data?.items ?? [];
  const busy = approveMut.isPending || rejectMut.isPending;
  const err =
    (error ?? approveMut.error ?? rejectMut.error)
      ? (error ?? approveMut.error ?? rejectMut.error)!.toString()
      : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">
            Queue
          </label>
          <select
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value)}
            className="rounded-md border border-border bg-background px-3 py-2 text-sm"
          >
            <option value="manual_review">Manual review</option>
            <option value="processed">Approved</option>
            <option value="rejected">Rejected</option>
            <option value="all">All</option>
          </select>
        </div>
        <div className="text-xs text-muted-foreground">
          {data?.summary
            ? `${data.summary.manual_review} review / ${data.summary.processed} approved / ${data.summary.rejected} rejected`
            : ""}
        </div>
        <div className="flex-1" />
        <button
          onClick={() =>
            qc.invalidateQueries({ queryKey: ["insurance", "nhcx-payment-notices"] })
          }
          className="rounded-md border px-3 py-2 text-sm hover:bg-muted"
        >
          Refresh
        </button>
      </div>

      {err && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {err}
        </div>
      )}

      {isLoading ? (
        <LoadingSpinner />
      ) : rows.length === 0 ? (
        <EmptyState title="No payment notices" description="No NHCX payment notices match this queue." />
      ) : (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
          <div className="overflow-x-auto rounded-md border bg-card">
            <table className="min-w-full text-sm">
              <thead className="border-b text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">Notice</th>
                  <th className="px-3 py-2">Claim</th>
                  <th className="px-3 py-2">Notice amount</th>
                  <th className="px-3 py-2">Claim amounts</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className="border-b last:border-0 hover:bg-muted/40">
                    <td className="px-3 py-2">
                      <div className="font-mono text-xs">{row.notice.payment_reference ?? row.hcx_api_call_id}</div>
                      <div className="text-xs text-muted-foreground">{fmtDate(row.received_at)}</div>
                    </td>
                    <td className="px-3 py-2">
                      {row.claim ? (
                        <>
                          <div className="font-medium">{row.claim.claim_number ?? `#${row.claim.id}`}</div>
                          <div className="text-xs text-muted-foreground">{row.claim.status}</div>
                        </>
                      ) : (
                        <span className="text-xs text-amber-700">Unlinked</span>
                      )}
                    </td>
                    <td className="px-3 py-2 font-mono">{fmtINR(row.notice.amount)}</td>
                    <td className="px-3 py-2 text-xs">
                      <div>Claimed {fmtINR(row.claim?.claimed_amount)}</div>
                      <div>Approved {fmtINR(row.claim?.approved_amount)}</div>
                      <div>Paid {fmtINR(row.claim?.paid_amount)}</div>
                    </td>
                    <td className="px-3 py-2">
                      <span className="rounded bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">
                        {statusLabel(row.status)}
                      </span>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {row.discrepancies.slice(0, 2).map((item) => (
                          <span
                            key={`${row.id}-${item.code}`}
                            className={`rounded border px-1.5 py-0.5 text-[11px] ${discrepancyClass(item.severity)}`}
                          >
                            {item.code}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button
                        onClick={() => setActive(row)}
                        className="rounded-md bg-foreground px-3 py-1.5 text-xs text-background disabled:opacity-40"
                      >
                        Review
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="rounded-md border bg-card p-4">
            {active ? (
              <div className="space-y-4">
                <div>
                  <div className="text-xs uppercase text-muted-foreground">Selected notice</div>
                  <div className="font-mono text-sm">{active.notice.payment_reference ?? active.hcx_api_call_id}</div>
                </div>

                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div>
                    <div className="text-xs text-muted-foreground">Notice</div>
                    <div className="font-mono">{fmtINR(active.notice.amount)}</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">Expected</div>
                    <div className="font-mono">{fmtINR(active.settlement_draft?.expected_amount)}</div>
                  </div>
                </div>

                {active.discrepancies.length > 0 && (
                  <div className="space-y-2">
                    {active.discrepancies.map((item) => (
                      <div
                        key={`${active.id}-${item.code}-${item.message}`}
                        className={`rounded-md border p-2 text-xs ${discrepancyClass(item.severity)}`}
                      >
                        <div className="font-medium">{item.code}</div>
                        <div>{item.message}</div>
                      </div>
                    ))}
                  </div>
                )}

                <div className="space-y-3">
                  <label className="block text-xs text-muted-foreground">
                    Paid amount
                    <input
                      value={paidAmount}
                      onChange={(event) => setPaidAmount(event.target.value)}
                      inputMode="decimal"
                      className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
                    />
                  </label>
                  <label className="block text-xs text-muted-foreground">
                    Payment reference
                    <input
                      value={paymentReference}
                      onChange={(event) => setPaymentReference(event.target.value)}
                      className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
                    />
                  </label>
                  <label className="block text-xs text-muted-foreground">
                    Paid at
                    <input
                      value={paidAt}
                      onChange={(event) => setPaidAt(event.target.value)}
                      className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
                    />
                  </label>
                </div>

                <div className="flex gap-2">
                  <button
                    disabled={busy || !active.claim || !active.settlement_draft}
                    onClick={() => approveMut.mutate(active)}
                    className="rounded-md bg-emerald-700 px-3 py-2 text-sm text-white disabled:opacity-40"
                  >
                    Approve
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => setActive(null)}
                    className="rounded-md border px-3 py-2 text-sm hover:bg-muted disabled:opacity-40"
                  >
                    Close
                  </button>
                </div>

                <div className="border-t pt-3">
                  <label className="block text-xs text-muted-foreground">
                    Reject reason
                    <textarea
                      value={rejectReason}
                      onChange={(event) => setRejectReason(event.target.value)}
                      rows={3}
                      className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
                    />
                  </label>
                  <button
                    disabled={busy || rejectReason.trim().length === 0}
                    onClick={() => rejectMut.mutate(active)}
                    className="mt-2 rounded-md border border-rose-300 px-3 py-2 text-sm text-rose-700 hover:bg-rose-50 disabled:opacity-40"
                  >
                    Reject
                  </button>
                </div>
              </div>
            ) : (
              <EmptyState title="No notice selected" description="Select a notice to review its settlement draft." />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
