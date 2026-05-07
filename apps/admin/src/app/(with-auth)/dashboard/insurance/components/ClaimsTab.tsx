"use client";

import { useState } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { fetchAdminAPI } from "@/lib/api";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { EmptyState } from "@/components/EmptyState";
import { fmtINR, STATUS_COLOURS, type Claim } from "./types";

const AGING_COLOURS: Record<string, string> = {
  fresh: "bg-emerald-100 text-emerald-800",
  "15-30_days_aging": "bg-amber-100 text-amber-800",
  "30+_days_aging": "bg-rose-100 text-rose-800",
  paid: "bg-slate-100 text-slate-700",
  denied: "bg-rose-200 text-rose-900",
};

function unwrap<T>(r: unknown): T {
  return ((r as { data?: T }).data ?? r) as T;
}

export function ClaimsTab() {
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState("");
  const [agingFilter, setAgingFilter] = useState("");

  const { data: rows = [], error, isLoading } = useQuery<Claim[]>({
    queryKey: ["insurance", "claims", { statusFilter, agingFilter }],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (statusFilter) params.set("status", statusFilter);
      if (agingFilter) params.set("aging_bucket", agingFilter);
      params.set("limit", "200");
      const r = await fetchAdminAPI<unknown>(
        `/insurance/claims?${params.toString()}`,
      );
      const data = unwrap<Claim[]>(r);
      return Array.isArray(data) ? data : [];
    },
  });

  const submitMut = useMutation({
    mutationFn: async (vars: { c: Claim; ref: string }) =>
      fetchAdminAPI(`/insurance/claims/${vars.c.id}/submit`, {
        method: "POST",
        body: JSON.stringify({
          submission_channel: "portal",
          tpa_reference_id: vars.ref || undefined,
        }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["insurance", "claims"] }),
  });

  const decisionMut = useMutation({
    mutationFn: async (vars: {
      c: Claim;
      decision: "approved" | "denied" | "queried";
      approved_amount?: number;
      denial_reason?: string;
    }) => {
      const body: Record<string, unknown> = { decision: vars.decision };
      if (vars.approved_amount != null) body.approved_amount = vars.approved_amount;
      if (vars.denial_reason != null) body.denial_reason = vars.denial_reason;
      return fetchAdminAPI(`/insurance/claims/${vars.c.id}/decision`, {
        method: "POST",
        body: JSON.stringify(body),
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["insurance", "claims"] }),
  });

  const paymentMut = useMutation({
    mutationFn: async (vars: {
      c: Claim;
      paid_amount: number;
      payment_reference: string;
    }) =>
      fetchAdminAPI(`/insurance/claims/${vars.c.id}/payment`, {
        method: "POST",
        body: JSON.stringify({
          paid_amount: vars.paid_amount,
          payment_reference: vars.payment_reference || undefined,
        }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["insurance", "claims"] }),
  });

  function submit(c: Claim) {
    const ref = window.prompt(
      `TPA reference id for ${c.claim_number} (optional):`,
      "",
    );
    if (ref === null) return;
    submitMut.mutate({ c, ref });
  }

  function decision(c: Claim, decision: "approved" | "denied" | "queried") {
    if (decision === "approved") {
      const amt = window.prompt(
        `Approved amount for ${c.claim_number}:`,
        String(c.claimed_amount),
      );
      if (amt === null) return;
      decisionMut.mutate({ c, decision, approved_amount: Number(amt) });
    } else if (decision === "denied") {
      const reason = window.prompt(`Denial reason:`, "");
      if (reason === null) return;
      decisionMut.mutate({ c, decision, denial_reason: reason });
    } else {
      decisionMut.mutate({ c, decision });
    }
  }

  function recordPayment(c: Claim) {
    const amt = window.prompt(
      `Paid amount (₹) for ${c.claim_number}:`,
      String(c.approved_amount ?? c.claimed_amount),
    );
    if (amt === null) return;
    const ref = window.prompt(`Payment reference (UTR / cheque):`, "");
    if (ref === null) return;
    paymentMut.mutate({
      c,
      paid_amount: Number(amt),
      payment_reference: ref,
    });
  }

  const errMsg = (error ?? submitMut.error ?? decisionMut.error ?? paymentMut.error)
    ? (error ?? submitMut.error ?? decisionMut.error ?? paymentMut.error)!.toString()
    : null;
  const busy =
    submitMut.isPending || decisionMut.isPending || paymentMut.isPending;

  return (
    <div className="space-y-4">
      <div className="flex gap-3 items-end flex-wrap">
        <div>
          <label className="text-xs text-muted-foreground block mb-1">Status</label>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="border border-border rounded-lg px-3 py-2 text-sm"
          >
            <option value="">Any</option>
            {[
              "prepared",
              "submitted",
              "queried",
              "approved",
              "partially_approved",
              "denied",
              "paid",
              "closed",
              "cancelled",
            ].map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-xs text-muted-foreground block mb-1">Aging</label>
          <select
            value={agingFilter}
            onChange={(e) => setAgingFilter(e.target.value)}
            className="border border-border rounded-lg px-3 py-2 text-sm"
          >
            <option value="">Any</option>
            <option value="fresh">Fresh (≤ 15d)</option>
            <option value="15-30_days_aging">15–30 days</option>
            <option value="30+_days_aging">30+ days</option>
            <option value="paid">Paid</option>
            <option value="denied">Denied</option>
          </select>
        </div>
        <div className="flex-1" />
        <button
          onClick={() => qc.invalidateQueries({ queryKey: ["insurance", "claims"] })}
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
        <EmptyState title="No claims" description="No claims match these filters." />
      ) : (
        <div className="bg-white rounded-lg border shadow-sm overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="text-xs text-muted-foreground border-b">
              <tr className="text-left">
                <th className="px-3 py-2">Claim #</th>
                <th className="px-3 py-2">Patient</th>
                <th className="px-3 py-2">Policy</th>
                <th className="px-3 py-2">Type</th>
                <th className="px-3 py-2">Claimed ₹</th>
                <th className="px-3 py-2">Approved ₹</th>
                <th className="px-3 py-2">Paid ₹</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Aging</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id} className="border-b last:border-0 hover:bg-muted/40">
                  <td className="px-3 py-2 font-mono text-xs">{c.claim_number}</td>
                  <td className="px-3 py-2 text-xs font-mono">
                    {c.patient_uid.slice(0, 8)}
                  </td>
                  <td className="px-3 py-2 text-xs">{c.policy_number ?? "—"}</td>
                  <td className="px-3 py-2 text-xs">{c.claim_type}</td>
                  <td className="px-3 py-2 font-mono">{fmtINR(c.claimed_amount)}</td>
                  <td className="px-3 py-2 font-mono">
                    {c.approved_amount != null ? fmtINR(c.approved_amount) : "—"}
                  </td>
                  <td className="px-3 py-2 font-mono">
                    {c.paid_amount != null ? fmtINR(c.paid_amount) : "—"}
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                        STATUS_COLOURS[c.status] ?? "bg-slate-100"
                      }`}
                    >
                      {c.status}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={`inline-block px-2 py-0.5 rounded text-xs ${
                        AGING_COLOURS[c.aging_bucket] ?? ""
                      }`}
                    >
                      {c.aging_bucket}
                      {c.days_since_submit != null
                        ? ` · ${Math.round(c.days_since_submit)}d`
                        : ""}
                    </span>
                  </td>
                  <td className="px-3 py-2 space-x-1 text-xs">
                    {c.status === "prepared" && (
                      <button
                        disabled={busy}
                        onClick={() => submit(c)}
                        className="px-2 py-1 rounded bg-blue-600 text-white disabled:opacity-40"
                      >
                        Submit
                      </button>
                    )}
                    {(c.status === "submitted" || c.status === "queried") && (
                      <>
                        <button
                          disabled={busy}
                          onClick={() => decision(c, "approved")}
                          className="px-2 py-1 rounded bg-emerald-600 text-white disabled:opacity-40"
                        >
                          Approve
                        </button>
                        <button
                          disabled={busy}
                          onClick={() => decision(c, "denied")}
                          className="px-2 py-1 rounded bg-rose-600 text-white disabled:opacity-40"
                        >
                          Deny
                        </button>
                      </>
                    )}
                    {(c.status === "approved" || c.status === "partially_approved") && (
                      <button
                        disabled={busy}
                        onClick={() => recordPayment(c)}
                        className="px-2 py-1 rounded bg-emerald-700 text-white disabled:opacity-40"
                      >
                        Record payment
                      </button>
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
