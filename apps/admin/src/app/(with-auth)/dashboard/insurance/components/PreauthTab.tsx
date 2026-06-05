"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchAdminAPI } from "@/lib/api";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { EmptyState } from "@/components/EmptyState";
import { fmtINR, fmtDate, STATUS_COLOURS, type Preauth } from "./types";

function unwrap<T>(r: unknown): T {
  return ((r as { data?: T }).data ?? r) as T;
}

export function PreauthTab() {
  const qc = useQueryClient();
  const {
    data: rows = [],
    error,
    isLoading,
  } = useQuery<Preauth[]>({
    queryKey: ["insurance", "preauth", "pending"],
    queryFn: async () => {
      const r = await fetchAdminAPI<unknown>(
        "/insurance/preauth/pending?limit=200",
      );
      const data = unwrap<Preauth[]>(r);
      return Array.isArray(data) ? data : [];
    },
  });

  const submitMut = useMutation({
    mutationFn: async (vars: { p: Preauth; ref: string }) =>
      fetchAdminAPI(`/insurance/preauth/${vars.p.id}/submit`, {
        method: "POST",
        body: {
          submission_channel: "portal",
          tpa_reference_id: vars.ref || undefined,
        },
      }),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["insurance", "preauth"] }),
  });

  const responseMut = useMutation({
    mutationFn: async (vars: {
      p: Preauth;
      // `partially_approved` accepts a sanctioned_amount < the requested
      // expected_cost — captures the "Star Health approved INR 30,000
      // of an INR 40,000 enhancement" case the backend already supports
      // but the UI previously couldn't represent. See finding
      // 2026-05-10-tpa-insurance-claim-billing-partial-enhancement-ui-missing.
      response_type: "approved" | "partially_approved" | "denied" | "queried";
      sanctioned_amount?: number;
      query_text?: string;
      denial_reason?: string;
      conditions?: string;
    }) => {
      const body: Record<string, unknown> = {
        response_type: vars.response_type,
      };
      if (vars.sanctioned_amount != null)
        body.sanctioned_amount = vars.sanctioned_amount;
      if (vars.query_text != null) body.query_text = vars.query_text;
      if (vars.denial_reason != null) body.denial_reason = vars.denial_reason;
      if (vars.conditions != null) body.conditions = vars.conditions;
      return fetchAdminAPI(`/insurance/preauth/${vars.p.id}/response`, {
        method: "POST",
        body: body,
      });
    },
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["insurance", "preauth"] }),
  });

  function submit(p: Preauth) {
    const ref = window.prompt(
      `TPA reference id (optional) for ${p.preauth_number}:`,
      "",
    );
    if (ref === null) return;
    submitMut.mutate({ p, ref });
  }

  function recordResponse(
    p: Preauth,
    response_type: "approved" | "partially_approved" | "denied" | "queried",
  ) {
    if (response_type === "approved") {
      const amt = window.prompt(
        `Sanctioned amount for ${p.preauth_number} (₹):`,
        String(p.expected_cost),
      );
      if (amt === null) return;
      responseMut.mutate({ p, response_type, sanctioned_amount: Number(amt) });
    } else if (response_type === "partially_approved") {
      // Partial approval: capture (a) the amount the TPA actually
      // sanctioned (which is < requested) and (b) a short reason /
      // conditions string so the audit trail can later distinguish
      // "TPA fully approved INR 30000" from "TPA partially approved
      // INR 30000 of a larger enhancement request". Both prompts must
      // be filled — empty values cancel.
      const amt = window.prompt(
        `Partially approved amount for ${p.preauth_number} (₹) ` +
          `— requested ₹${p.expected_cost}:`,
        "",
      );
      if (amt === null) return;
      const sanctioned = Number(amt);
      if (!Number.isFinite(sanctioned) || sanctioned <= 0) {
        window.alert(
          `Sanctioned amount must be a positive number; got "${amt}"`,
        );
        return;
      }
      if (sanctioned >= Number(p.expected_cost)) {
        window.alert(
          `Partial approval requires sanctioned < requested ` +
            `(requested ₹${p.expected_cost}, entered ₹${sanctioned}). ` +
            `Use the Approved button for full approvals.`,
        );
        return;
      }
      const conditions = window.prompt(
        `Conditions / reason TPA approved less than requested for ${p.preauth_number}:`,
        "",
      );
      if (conditions === null) return;
      responseMut.mutate({
        p,
        response_type,
        sanctioned_amount: sanctioned,
        conditions: conditions || undefined,
      });
    } else if (response_type === "denied") {
      const reason = window.prompt(
        `Denial reason for ${p.preauth_number}:`,
        "",
      );
      if (reason === null) return;
      responseMut.mutate({ p, response_type, denial_reason: reason });
    } else {
      const q = window.prompt(`Query text for ${p.preauth_number}:`, "");
      if (q === null) return;
      responseMut.mutate({ p, response_type, query_text: q });
    }
  }

  const errMsg =
    (error ?? submitMut.error ?? responseMut.error) instanceof Error
      ? (error ?? submitMut.error ?? responseMut.error)!.toString()
      : null;
  const busy = submitMut.isPending || responseMut.isPending;

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between flex-wrap gap-2">
        <p className="text-sm text-muted-foreground">
          Pre-auth requests in <strong>draft</strong>,{" "}
          <strong>submitted</strong>, or <strong>queried</strong>. Submit drafts
          to send to the TPA; record responses when the TPA replies.
        </p>
        <button
          onClick={() =>
            qc.invalidateQueries({ queryKey: ["insurance", "preauth"] })
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
        <EmptyState title="Inbox zero" description="No pending pre-auths." />
      ) : (
        <div className="bg-card rounded-lg border shadow-sm overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="text-xs text-muted-foreground border-b">
              <tr className="text-left">
                <th className="px-3 py-2">Pre-auth #</th>
                <th className="px-3 py-2">Patient</th>
                <th className="px-3 py-2">Policy / Payer</th>
                <th className="px-3 py-2">Diagnosis</th>
                <th className="px-3 py-2">Expected ₹</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Submitted</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr
                  key={p.id}
                  className="border-b last:border-0 hover:bg-muted/40"
                >
                  <td className="px-3 py-2 font-mono text-xs">
                    {p.preauth_number}
                  </td>
                  <td className="px-3 py-2 text-xs font-mono">
                    {p.patient_uid.slice(0, 8)}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    <div>{p.policy_number}</div>
                    <div className="text-muted-foreground">
                      {p.tpa_name ?? p.payer_name ?? "—"}
                    </div>
                  </td>
                  <td className="px-3 py-2">{p.primary_diagnosis}</td>
                  <td className="px-3 py-2 font-mono">
                    {fmtINR(p.expected_cost)}
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                        STATUS_COLOURS[p.status] ?? "bg-slate-100"
                      }`}
                    >
                      {p.status}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {fmtDate(p.submitted_at)}
                  </td>
                  <td className="px-3 py-2 space-x-1 text-xs">
                    {p.status === "draft" && (
                      <button
                        disabled={busy}
                        onClick={() => submit(p)}
                        className="px-2 py-1 rounded bg-blue-600 text-white disabled:opacity-40"
                      >
                        Submit
                      </button>
                    )}
                    {(p.status === "submitted" || p.status === "queried") && (
                      <>
                        <button
                          disabled={busy}
                          onClick={() => recordResponse(p, "approved")}
                          className="px-2 py-1 rounded bg-emerald-600 text-white disabled:opacity-40"
                        >
                          Approved
                        </button>
                        <button
                          disabled={busy}
                          onClick={() =>
                            recordResponse(p, "partially_approved")
                          }
                          className="px-2 py-1 rounded bg-emerald-500/80 text-white disabled:opacity-40"
                          title="TPA approved a smaller amount than requested"
                        >
                          Partial
                        </button>
                        <button
                          disabled={busy}
                          onClick={() => recordResponse(p, "queried")}
                          className="px-2 py-1 rounded bg-amber-600 text-white disabled:opacity-40"
                        >
                          Query
                        </button>
                        <button
                          disabled={busy}
                          onClick={() => recordResponse(p, "denied")}
                          className="px-2 py-1 rounded bg-rose-600 text-white disabled:opacity-40"
                        >
                          Denied
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
