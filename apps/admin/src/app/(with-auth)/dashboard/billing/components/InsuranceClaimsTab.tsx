"use client";

import { useEffect, useState, useCallback } from "react";
import { fetchAdminAPI, putJSON } from "@/lib/api";
import type { InsuranceClaim, UpdateClaimPayload } from "@/lib/api";
import { StatusBadge, CLAIM_STATUS_COLORS, fmt, fmtDate } from "./shared";

// ═══════════════════════════════════════════════════════════════════════════════
// INSURANCE CLAIMS TAB
// ═══════════════════════════════════════════════════════════════════════════════

export function InsuranceClaimsTab() {
  const [claims, setClaims] = useState<InsuranceClaim[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState("");
  const [selectedClaim, setSelectedClaim] = useState<InsuranceClaim | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchClaims = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = statusFilter ? `?status=${statusFilter}` : "";
      const r = await fetchAdminAPI<{ data: InsuranceClaim[] }>(
        `/billing/insurance/claims${params}`,
      );
      const data = (r as Record<string, unknown>).data ?? r;
      setClaims(Array.isArray(data) ? data : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load claims");
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    fetchClaims();
  }, [fetchClaims]);

  const updateClaimStatus = async (claimId: number, payload: UpdateClaimPayload) => {
    try {
      await putJSON(`/api/v1/billing/insurance/claim/${claimId}`, payload);
      setSelectedClaim(null);
      fetchClaims();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Update failed");
    }
  };

  const STATUS_OPTIONS = [
    "",
    "submitted",
    "under_review",
    "approved",
    "partially_approved",
    "rejected",
    "paid",
  ];

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex gap-2 flex-wrap items-center">
        {STATUS_OPTIONS.map((s) => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            className={`px-3 py-1 rounded-full text-xs font-medium ${
              statusFilter === s
                ? "bg-primary text-white"
                : "bg-muted text-muted-foreground hover:bg-muted/80"
            }`}
          >
            {s ? s.replace("_", " ") : "All"}
          </button>
        ))}
        <button
          onClick={fetchClaims}
          className="ml-auto text-sm text-primary hover:underline"
        >
          ↻ Refresh
        </button>
      </div>

      {loading && (
        <div className="text-center py-8 text-muted-foreground">Loading claims...</div>
      )}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700 text-sm">
          {error}
        </div>
      )}

      {!loading && claims.length === 0 && !error && (
        <div className="text-center py-12 text-muted-foreground">
          No insurance claims found
        </div>
      )}

      {claims.length > 0 && (
        <div className="overflow-x-auto border border-border rounded-lg">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left bg-muted/50">
                <th className="py-2 px-3">Claim #</th>
                <th className="py-2 px-3">Provider</th>
                <th className="py-2 px-3">Policy</th>
                <th className="py-2 px-3">Claim Amount</th>
                <th className="py-2 px-3">Approved</th>
                <th className="py-2 px-3">Status</th>
                <th className="py-2 px-3">Submitted</th>
                <th className="py-2 px-3"></th>
              </tr>
            </thead>
            <tbody>
              {claims.map((claim) => (
                <tr key={claim.id} className="border-b border-border hover:bg-muted/40">
                  <td className="py-2 px-3 font-medium">{claim.claim_number}</td>
                  <td className="py-2 px-3">{claim.insurance_provider}</td>
                  <td className="py-2 px-3 font-mono text-xs">{claim.policy_number}</td>
                  <td className="py-2 px-3">{fmt(claim.claim_amount)}</td>
                  <td className="py-2 px-3">{fmt(claim.approved_amount)}</td>
                  <td className="py-2 px-3">
                    <StatusBadge status={claim.status} colorMap={CLAIM_STATUS_COLORS} />
                  </td>
                  <td className="py-2 px-3">{fmtDate(claim.submitted_at)}</td>
                  <td className="py-2 px-3">
                    <button
                      onClick={() => setSelectedClaim(claim)}
                      className="text-xs text-primary hover:underline"
                    >
                      Update
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Update Claim Modal */}
      {selectedClaim && (
        <UpdateClaimModal
          claim={selectedClaim}
          onClose={() => setSelectedClaim(null)}
          onUpdate={updateClaimStatus}
        />
      )}
    </div>
  );
}

// ── Update Claim Modal ───────────────────────────────────────────────────────

function UpdateClaimModal({
  claim,
  onClose,
  onUpdate,
}: {
  claim: InsuranceClaim;
  onClose: () => void;
  onUpdate: (claimId: number, payload: UpdateClaimPayload) => void;
}) {
  const [form, setForm] = useState<UpdateClaimPayload>({
    status: claim.status as UpdateClaimPayload["status"],
    approved_amount: claim.approved_amount
      ? parseFloat(claim.approved_amount)
      : undefined,
    reason: claim.rejection_reason ?? "",
  });
  const [saving, setSaving] = useState(false);

  const handleSubmit = async () => {
    setSaving(true);
    await onUpdate(claim.id, form);
    setSaving(false);
  };

  const STATUS_OPTIONS: UpdateClaimPayload["status"][] = [
    "submitted",
    "under_review",
    "approved",
    "partially_approved",
    "rejected",
    "paid",
  ];

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl max-w-md w-full p-6">
        <div className="flex justify-between items-start mb-4">
          <div>
            <h3 className="text-lg font-bold">Update Claim</h3>
            <p className="text-sm text-gray-500">{claim.claim_number}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">
            ✕
          </button>
        </div>

        <div className="space-y-3">
          <div>
            <p className="text-xs text-gray-500 mb-1">Insurance Provider</p>
            <p className="text-sm font-medium">{claim.insurance_provider}</p>
          </div>
          <div>
            <p className="text-xs text-gray-500 mb-1">Claim Amount</p>
            <p className="text-sm font-medium">{fmt(claim.claim_amount)}</p>
          </div>

          <div>
            <label className="text-xs text-gray-500 block mb-1">Status</label>
            <select
              value={form.status}
              onChange={(e) =>
                setForm({ ...form, status: e.target.value as UpdateClaimPayload["status"] })
              }
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
            >
              {STATUS_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {s.replace("_", " ")}
                </option>
              ))}
            </select>
          </div>

          {(form.status === "approved" || form.status === "partially_approved") && (
            <div>
              <label className="text-xs text-gray-500 block mb-1">Approved Amount (₹)</label>
              <input
                type="number"
                min={0}
                value={form.approved_amount ?? ""}
                onChange={(e) =>
                  setForm({ ...form, approved_amount: parseFloat(e.target.value) || 0 })
                }
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
              />
            </div>
          )}

          {form.status === "rejected" && (
            <div>
              <label className="text-xs text-gray-500 block mb-1">Rejection Reason</label>
              <textarea
                rows={3}
                value={form.reason ?? ""}
                onChange={(e) => setForm({ ...form, reason: e.target.value })}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm resize-none"
                placeholder="State the reason for rejection..."
              />
            </div>
          )}
        </div>

        <div className="flex gap-2 mt-6">
          <button
            onClick={onClose}
            className="flex-1 py-2 border border-gray-200 rounded-lg text-sm hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={saving}
            className="flex-1 py-2 bg-primary text-white rounded-lg text-sm hover:bg-primary/90 disabled:opacity-50"
          >
            {saving ? "Saving..." : "Update Claim"}
          </button>
        </div>
      </div>
    </div>
  );
}
