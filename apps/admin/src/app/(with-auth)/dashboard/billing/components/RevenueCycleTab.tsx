"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  getARAging,
  getClaimQueue,
  type ARAgingSummary,
  type ClaimQueueResponse,
} from "@/lib/api";
import { CLAIM_STATUS_COLORS, fmt, fmtDate, StatCard, StatusBadge } from "./shared";

const CLAIM_STATUS_OPTIONS = [
  "",
  "submitted",
  "under_review",
  "partially_approved",
  "rejected",
];

export function RevenueCycleTab() {
  const [aging, setAging] = useState<ARAgingSummary | null>(null);
  const [claimQueue, setClaimQueue] = useState<ClaimQueueResponse | null>(null);
  const [statusFilter, setStatusFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchRevenueCycle = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [agingResult, queueResult] = await Promise.all([
        getARAging({ limit: 8 }),
        getClaimQueue({ status: statusFilter || undefined, limit: 10 }),
      ]);
      setAging(agingResult);
      setClaimQueue(queueResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load revenue-cycle data");
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    fetchRevenueCycle();
  }, [fetchRevenueCycle]);

  const maxBucketAmount = useMemo(
    () => Math.max(...(aging?.buckets.map((bucket) => bucket.outstanding_amount) ?? [0]), 1),
    [aging],
  );

  return (
    <div className="space-y-6">
      <div className="flex gap-2 flex-wrap items-center">
        {CLAIM_STATUS_OPTIONS.map((status) => (
          <button
            key={status}
            onClick={() => setStatusFilter(status)}
            className={`px-3 py-1 rounded-full text-xs font-medium ${
              statusFilter === status
                ? "bg-primary text-white"
                : "bg-muted text-muted-foreground hover:bg-muted/80"
            }`}
          >
            {status ? status.replace("_", " ") : "Open queue"}
          </button>
        ))}
        <button
          onClick={fetchRevenueCycle}
          className="ml-auto text-sm text-primary hover:underline"
        >
          ↻ Refresh
        </button>
      </div>

      {loading && (
        <div className="text-center py-8 text-muted-foreground">Loading revenue cycle...</div>
      )}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700 text-sm">
          {error}
        </div>
      )}

      {aging && claimQueue && !loading && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatCard
              label="Total A/R"
              value={fmt(aging.overall.total_outstanding)}
              color="text-orange-700"
              bg="bg-orange-50"
            />
            <StatCard
              label="Open Invoices"
              value={aging.overall.invoice_count}
            />
            <StatCard
              label="Oldest Balance"
              value={`${aging.overall.oldest_age_days} days`}
              color="text-red-700"
              bg="bg-red-50"
            />
            <StatCard
              label="Claims in Queue"
              value={claimQueue.claims.length}
              color="text-blue-700"
              bg="bg-blue-50"
            />
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <section className="border border-border rounded-lg overflow-hidden">
              <div className="bg-muted px-4 py-2 font-medium text-sm">A/R Aging</div>
              <div className="p-4 space-y-3">
                {aging.buckets.length === 0 && (
                  <p className="text-sm text-muted-foreground">No open receivables.</p>
                )}
                {aging.buckets.map((bucket) => (
                  <div key={bucket.bucket}>
                    <div className="flex items-center justify-between text-sm mb-1">
                      <span className="font-medium">{bucket.bucket} days</span>
                      <span className="text-muted-foreground">
                        {bucket.invoice_count} · {fmt(bucket.outstanding_amount)}
                      </span>
                    </div>
                    <div className="h-2 rounded-full bg-muted overflow-hidden">
                      <div
                        className="h-full rounded-full bg-orange-500"
                        style={{ width: `${(bucket.outstanding_amount / maxBucketAmount) * 100}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <section className="border border-border rounded-lg overflow-hidden">
              <div className="bg-muted px-4 py-2 font-medium text-sm">Claim Queue Mix</div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left bg-muted/50">
                      <th className="py-2 px-3">Status</th>
                      <th className="py-2 px-3">Claims</th>
                      <th className="py-2 px-3">Claimed</th>
                      <th className="py-2 px-3">Payer Balance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {claimQueue.summary.map((row) => (
                      <tr key={row.status} className="border-b border-border hover:bg-muted/30">
                        <td className="py-2 px-3">
                          <StatusBadge status={row.status} colorMap={CLAIM_STATUS_COLORS} />
                        </td>
                        <td className="py-2 px-3">{row.count}</td>
                        <td className="py-2 px-3">{fmt(row.claim_amount)}</td>
                        <td className="py-2 px-3">{fmt(row.payer_balance)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </div>

          <section className="border border-border rounded-lg overflow-hidden">
            <div className="bg-muted px-4 py-2 font-medium text-sm">Oldest Open Balances</div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left bg-muted/50">
                    <th className="py-2 px-3">Invoice</th>
                    <th className="py-2 px-3">Patient</th>
                    <th className="py-2 px-3">Type</th>
                    <th className="py-2 px-3">Issued</th>
                    <th className="py-2 px-3">Age</th>
                    <th className="py-2 px-3">Outstanding</th>
                  </tr>
                </thead>
                <tbody>
                  {aging.invoices.map((invoice) => (
                    <tr key={invoice.id} className="border-b border-border hover:bg-muted/30">
                      <td className="py-2 px-3 font-mono text-xs">{invoice.invoice_number}</td>
                      <td className="py-2 px-3">{invoice.patient_name || invoice.patient_uid.slice(0, 8)}</td>
                      <td className="py-2 px-3 capitalize">{invoice.type.replace("_", " ")}</td>
                      <td className="py-2 px-3">{fmtDate(invoice.issued_at)}</td>
                      <td className="py-2 px-3">{invoice.age_days}d</td>
                      <td className="py-2 px-3 font-medium">{fmt(invoice.outstanding_amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="border border-border rounded-lg overflow-hidden">
            <div className="bg-muted px-4 py-2 font-medium text-sm">Claim Follow-up Queue</div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left bg-muted/50">
                    <th className="py-2 px-3">Claim</th>
                    <th className="py-2 px-3">Payer</th>
                    <th className="py-2 px-3">Invoice</th>
                    <th className="py-2 px-3">Status</th>
                    <th className="py-2 px-3">Age</th>
                    <th className="py-2 px-3">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {claimQueue.claims.map((claim) => (
                    <tr key={claim.id} className="border-b border-border hover:bg-muted/30">
                      <td className="py-2 px-3">
                        <div className="font-mono text-xs">{claim.claim_number}</div>
                        <div className="text-xs text-muted-foreground">
                          {claim.patient_name || claim.patient_uid.slice(0, 8)}
                        </div>
                      </td>
                      <td className="py-2 px-3">{claim.insurance_provider}</td>
                      <td className="py-2 px-3 font-mono text-xs">{claim.invoice_number || "-"}</td>
                      <td className="py-2 px-3">
                        <StatusBadge status={claim.status} colorMap={CLAIM_STATUS_COLORS} />
                      </td>
                      <td className="py-2 px-3">{claim.days_in_queue}d</td>
                      <td className="py-2 px-3 font-medium">{fmt(claim.payer_balance)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
