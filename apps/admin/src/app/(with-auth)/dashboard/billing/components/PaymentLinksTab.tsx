"use client";

// Sprint 4 — UPI payment links list, send + mark-paid + cancel actions.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchAdminAPI } from "@/lib/api";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { EmptyState } from "@/components/EmptyState";

interface PaymentLink {
  id: number;
  link_token: string;
  invoice_id: number | null;
  patient_uid: string;
  amount: number | string;
  currency: string;
  status: "created" | "sent" | "paid" | "expired" | "cancelled";
  upi_deep_link: string | null;
  provider: string;
  expires_at: string | null;
  paid_at: string | null;
  paid_via: string | null;
  sent_via_whatsapp_at: string | null;
  sent_via_email_at: string | null;
  sent_via_sms_at: string | null;
  created_at: string;
}

const STATUS_COLOURS: Record<string, string> = {
  created: "bg-slate-100 text-slate-700",
  sent: "bg-blue-100 text-blue-800",
  paid: "bg-emerald-200 text-emerald-900",
  expired: "bg-amber-100 text-amber-800",
  cancelled: "bg-rose-100 text-rose-800",
};

function unwrap<T>(r: unknown): T {
  return ((r as { data?: T }).data ?? r) as T;
}

function fmtINR(n: number | string | null | undefined): string {
  const num = Number(n ?? 0);
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2,
  }).format(num);
}

function fmtDate(s: string | null): string {
  if (!s) return "—";
  return new Date(s).toLocaleString();
}

export function PaymentLinksTab() {
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState("");

  const {
    data: rows = [],
    error,
    isLoading,
  } = useQuery<PaymentLink[]>({
    queryKey: ["billing", "payment-links", { statusFilter }],
    queryFn: async () => {
      const params = new URLSearchParams({ limit: "200" });
      if (statusFilter) params.set("status", statusFilter);
      const r = await fetchAdminAPI<unknown>(
        `/billing/v2/payment-links?${params.toString()}`,
      );
      const data = unwrap<PaymentLink[]>(r);
      return Array.isArray(data) ? data : [];
    },
  });

  const sendMut = useMutation({
    mutationFn: async (vars: { link: PaymentLink; phone: string }) =>
      fetchAdminAPI(`/billing/v2/payment-links/${vars.link.link_token}/send`, {
        method: "POST",
        body: {
          channels: ["whatsapp"],
          patient_phone: vars.phone,
        },
      }),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["billing", "payment-links"] }),
  });

  const paidMut = useMutation({
    mutationFn: async (vars: { link: PaymentLink; ref: string }) =>
      fetchAdminAPI(
        `/billing/v2/payment-links/${vars.link.link_token}/mark-paid`,
        {
          method: "POST",
          body: { paid_via: "upi", paid_reference: vars.ref },
        },
      ),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["billing", "payment-links"] }),
  });

  const cancelMut = useMutation({
    mutationFn: async (vars: { link: PaymentLink; reason: string }) =>
      fetchAdminAPI(
        `/billing/v2/payment-links/${vars.link.link_token}/cancel`,
        {
          method: "POST",
          body: { reason: vars.reason },
        },
      ),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["billing", "payment-links"] }),
  });

  function send(link: PaymentLink) {
    const phone = window.prompt(
      "Patient WhatsApp phone (with country code):",
      "",
    );
    if (!phone) return;
    sendMut.mutate({ link, phone });
  }
  function markPaid(link: PaymentLink) {
    const ref = window.prompt("UPI reference (UTR):", "");
    if (ref === null) return;
    paidMut.mutate({ link, ref });
  }
  function cancel(link: PaymentLink) {
    const reason = window.prompt("Cancellation reason:", "");
    if (reason === null) return;
    cancelMut.mutate({ link, reason });
  }
  function copyLink(link: PaymentLink) {
    if (link.upi_deep_link) navigator.clipboard?.writeText(link.upi_deep_link);
  }

  const errMsg =
    (error ?? sendMut.error ?? paidMut.error ?? cancelMut.error)
      ? (error ?? sendMut.error ?? paidMut.error ?? cancelMut.error)!.toString()
      : null;
  const busy = sendMut.isPending || paidMut.isPending || cancelMut.isPending;

  return (
    <div className="space-y-4">
      <div className="flex items-end gap-3 flex-wrap">
        <div>
          <label className="text-xs text-muted-foreground block mb-1">
            Status
          </label>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="border border-border rounded-lg px-3 py-2 text-sm"
          >
            <option value="">All</option>
            {["created", "sent", "paid", "expired", "cancelled"].map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <div className="flex-1" />
        <button
          onClick={() =>
            qc.invalidateQueries({ queryKey: ["billing", "payment-links"] })
          }
          className="px-3 py-2 rounded-md border text-sm hover:bg-muted"
        >
          Refresh
        </button>
      </div>

      {errMsg && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {errMsg}
        </div>
      )}

      {isLoading ? (
        <LoadingSpinner />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No payment links"
          description="Create one from the invoice screen to bill a patient by UPI."
        />
      ) : (
        <div className="bg-card rounded-lg border shadow-sm overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="text-xs text-muted-foreground border-b">
              <tr className="text-left">
                <th className="px-3 py-2">Token</th>
                <th className="px-3 py-2">Patient</th>
                <th className="px-3 py-2">Invoice</th>
                <th className="px-3 py-2">Amount</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Sent via</th>
                <th className="px-3 py-2">Expires</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  className="border-b last:border-0 hover:bg-muted/40"
                >
                  <td className="px-3 py-2 font-mono text-xs">
                    {r.link_token.slice(0, 12)}…
                  </td>
                  <td className="px-3 py-2 text-xs font-mono">
                    {r.patient_uid.slice(0, 8)}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {r.invoice_id ? `#${r.invoice_id}` : "—"}
                  </td>
                  <td className="px-3 py-2 font-mono">{fmtINR(r.amount)}</td>
                  <td className="px-3 py-2">
                    <span
                      className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                        STATUS_COLOURS[r.status] ?? ""
                      }`}
                    >
                      {r.status}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {[
                      r.sent_via_whatsapp_at ? "WA" : null,
                      r.sent_via_email_at ? "✉" : null,
                      r.sent_via_sms_at ? "SMS" : null,
                    ]
                      .filter(Boolean)
                      .join(" · ") || "—"}
                  </td>
                  <td className="px-3 py-2 text-xs">{fmtDate(r.expires_at)}</td>
                  <td className="px-3 py-2 space-x-1 text-xs">
                    {r.upi_deep_link && (
                      <button
                        onClick={() => copyLink(r)}
                        className="px-2 py-1 rounded border hover:bg-muted"
                      >
                        Copy
                      </button>
                    )}
                    {(r.status === "created" || r.status === "sent") && (
                      <>
                        <button
                          disabled={busy}
                          onClick={() => send(r)}
                          className="px-2 py-1 rounded bg-blue-600 text-white disabled:opacity-40"
                        >
                          Send WA
                        </button>
                        <button
                          disabled={busy}
                          onClick={() => markPaid(r)}
                          className="px-2 py-1 rounded bg-emerald-600 text-white disabled:opacity-40"
                        >
                          Mark paid
                        </button>
                        <button
                          disabled={busy}
                          onClick={() => cancel(r)}
                          className="px-2 py-1 rounded bg-rose-600 text-white disabled:opacity-40"
                        >
                          Cancel
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
