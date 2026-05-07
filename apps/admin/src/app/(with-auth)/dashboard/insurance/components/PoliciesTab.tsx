"use client";

import { useCallback, useState } from "react";
import { fetchAdminAPI } from "@/lib/api";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { EmptyState } from "@/components/EmptyState";
import { fmtINR, fmtDate, type InsurancePolicy } from "./types";

export function PoliciesTab() {
  const [patientUid, setPatientUid] = useState("");
  const [rows, setRows] = useState<InsurancePolicy[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetch = useCallback(async () => {
    if (!patientUid) {
      setRows([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const r = await fetchAdminAPI<{ data: InsurancePolicy[] } | InsurancePolicy[]>(
        `/insurance/policies/patient/${encodeURIComponent(patientUid)}`,
      );
      const data = (r as { data?: InsurancePolicy[] }).data ?? (r as InsurancePolicy[]);
      setRows(Array.isArray(data) ? data : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load policies");
    } finally {
      setLoading(false);
    }
  }, [patientUid]);

  return (
    <div className="space-y-4">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          fetch();
        }}
        className="flex gap-3 items-end flex-wrap"
      >
        <div className="flex-1 min-w-[280px]">
          <label className="text-xs text-muted-foreground block mb-1">
            Patient UID
          </label>
          <input
            value={patientUid}
            onChange={(e) => setPatientUid(e.target.value)}
            placeholder="UUID"
            className="w-full border border-border rounded-lg px-3 py-2 text-sm font-mono"
          />
        </div>
        <button
          type="submit"
          className="px-3 py-2 rounded-md bg-foreground text-background text-sm"
        >
          Fetch
        </button>
      </form>

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {loading ? (
        <LoadingSpinner />
      ) : rows.length === 0 ? (
        <EmptyState
          title={patientUid ? "No policies on file" : "Enter a patient UID"}
          description={
            patientUid
              ? "This patient has no insurance policies recorded."
              : "Look up policies for a patient by UID."
          }
        />
      ) : (
        <div className="bg-white rounded-lg border shadow-sm overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="text-xs text-muted-foreground border-b">
              <tr className="text-left">
                <th className="px-3 py-2">Policy #</th>
                <th className="px-3 py-2">Member ID</th>
                <th className="px-3 py-2">Holder</th>
                <th className="px-3 py-2">Payer / TPA</th>
                <th className="px-3 py-2">Type</th>
                <th className="px-3 py-2">Sum insured</th>
                <th className="px-3 py-2">Used</th>
                <th className="px-3 py-2">Validity</th>
                <th className="px-3 py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id} className="border-b last:border-0 hover:bg-muted/40">
                  <td className="px-3 py-2 font-mono text-xs">{p.policy_number}</td>
                  <td className="px-3 py-2 text-xs">{p.member_id ?? "—"}</td>
                  <td className="px-3 py-2 text-xs">{p.policyholder_name ?? "—"}</td>
                  <td className="px-3 py-2 text-xs">
                    <div>{p.tpa_name ?? p.payer_name ?? "—"}</div>
                    {p.tpa_name && p.payer_name && (
                      <div className="text-muted-foreground">{p.payer_name}</div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs">{p.policy_type ?? "—"}</td>
                  <td className="px-3 py-2 font-mono">
                    {p.sum_insured != null ? fmtINR(p.sum_insured) : "—"}
                  </td>
                  <td className="px-3 py-2 font-mono text-muted-foreground">
                    {p.cumulative_used != null ? fmtINR(p.cumulative_used) : "—"}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {fmtDate(p.valid_from)} → {fmtDate(p.valid_to)}
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                        p.status === "active"
                          ? "bg-emerald-100 text-emerald-800"
                          : "bg-slate-200 text-slate-600"
                      }`}
                    >
                      {p.status}
                    </span>
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
