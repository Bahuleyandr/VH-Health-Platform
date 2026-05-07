"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchAdminAPI } from "@/lib/api";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { EmptyState } from "@/components/EmptyState";
import { fmtINR, fmtDate, STATUS_COLOURS, type Preauth } from "./types";

export function PreauthTab() {
  const [rows, setRows] = useState<Preauth[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const fetchPending = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetchAdminAPI<{ data: Preauth[] } | Preauth[]>(
        "/insurance/preauth/pending?limit=200",
      );
      const data = (r as { data?: Preauth[] }).data ?? (r as Preauth[]);
      setRows(Array.isArray(data) ? data : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load pre-auths");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPending();
  }, [fetchPending]);

  async function submit(p: Preauth) {
    setBusyId(p.id);
    setError(null);
    try {
      const ref = window.prompt(
        `TPA reference id (optional) for ${p.preauth_number}:`,
        "",
      );
      if (ref === null) {
        setBusyId(null);
        return;
      }
      await fetchAdminAPI(`/insurance/preauth/${p.id}/submit`, {
        method: "POST",
        body: JSON.stringify({
          submission_channel: "portal",
          tpa_reference_id: ref || undefined,
        }),
      });
      await fetchPending();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Submit failed");
    } finally {
      setBusyId(null);
    }
  }

  async function recordResponse(p: Preauth, response_type: "approved" | "denied" | "queried") {
    setBusyId(p.id);
    setError(null);
    try {
      let body: Record<string, unknown> = { response_type };
      if (response_type === "approved") {
        const amt = window.prompt(
          `Sanctioned amount for ${p.preauth_number} (₹):`,
          String(p.expected_cost),
        );
        if (amt === null) {
          setBusyId(null);
          return;
        }
        body = { ...body, sanctioned_amount: Number(amt) };
      } else if (response_type === "denied") {
        const reason = window.prompt(`Denial reason for ${p.preauth_number}:`, "");
        if (reason === null) {
          setBusyId(null);
          return;
        }
        body = { ...body, denial_reason: reason };
      } else {
        const q = window.prompt(`Query text for ${p.preauth_number}:`, "");
        if (q === null) {
          setBusyId(null);
          return;
        }
        body = { ...body, query_text: q };
      }
      await fetchAdminAPI(`/insurance/preauth/${p.id}/response`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      await fetchPending();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Record response failed");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between flex-wrap gap-2">
        <p className="text-sm text-muted-foreground">
          Pre-auth requests in <strong>draft</strong>, <strong>submitted</strong>, or{" "}
          <strong>queried</strong>. Submit drafts to send to the TPA; record responses
          when the TPA replies.
        </p>
        <button
          onClick={fetchPending}
          className="px-3 py-2 rounded-md border text-sm hover:bg-muted"
        >
          Refresh
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {loading ? (
        <LoadingSpinner />
      ) : rows.length === 0 ? (
        <EmptyState title="Inbox zero" description="No pending pre-auths." />
      ) : (
        <div className="bg-white rounded-lg border shadow-sm overflow-x-auto">
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
                <tr key={p.id} className="border-b last:border-0 hover:bg-muted/40">
                  <td className="px-3 py-2 font-mono text-xs">{p.preauth_number}</td>
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
                  <td className="px-3 py-2 font-mono">{fmtINR(p.expected_cost)}</td>
                  <td className="px-3 py-2">
                    <span
                      className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                        STATUS_COLOURS[p.status] ?? "bg-slate-100"
                      }`}
                    >
                      {p.status}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-xs">{fmtDate(p.submitted_at)}</td>
                  <td className="px-3 py-2 space-x-1 text-xs">
                    {p.status === "draft" && (
                      <button
                        disabled={busyId === p.id}
                        onClick={() => submit(p)}
                        className="px-2 py-1 rounded bg-blue-600 text-white disabled:opacity-40"
                      >
                        Submit
                      </button>
                    )}
                    {(p.status === "submitted" || p.status === "queried") && (
                      <>
                        <button
                          disabled={busyId === p.id}
                          onClick={() => recordResponse(p, "approved")}
                          className="px-2 py-1 rounded bg-emerald-600 text-white disabled:opacity-40"
                        >
                          Approved
                        </button>
                        <button
                          disabled={busyId === p.id}
                          onClick={() => recordResponse(p, "queried")}
                          className="px-2 py-1 rounded bg-amber-600 text-white disabled:opacity-40"
                        >
                          Query
                        </button>
                        <button
                          disabled={busyId === p.id}
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
