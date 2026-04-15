"use client";

import { useEffect, useState, useCallback } from "react";
import { fetchAdminAPI } from "@/lib/api";
import type { RevenueStats } from "@/lib/api";
import { StatCard, fmt } from "./shared";

// ═══════════════════════════════════════════════════════════════════════════════
// REVENUE SUMMARY TAB
// ═══════════════════════════════════════════════════════════════════════════════

export function RevenueSummaryTab() {
  const today = new Date();
  const firstOfMonth = new Date(today.getFullYear(), today.getMonth(), 1)
    .toISOString()
    .split("T")[0];
  const todayStr = today.toISOString().split("T")[0];

  const [dateFrom, setDateFrom] = useState(firstOfMonth);
  const [dateTo, setDateTo] = useState(todayStr);
  const [stats, setStats] = useState<RevenueStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchRevenue = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetchAdminAPI<{ data: RevenueStats }>(
        `/billing/revenue?date_from=${dateFrom}&date_to=${dateTo}`,
      );
      const data = (r as Record<string, unknown>).data ?? r;
      setStats(data as RevenueStats);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load revenue data");
    } finally {
      setLoading(false);
    }
  }, [dateFrom, dateTo]);

  useEffect(() => {
    fetchRevenue();
  }, [fetchRevenue]);

  return (
    <div className="space-y-6">
      {/* Date Range Filter */}
      <div className="flex gap-3 items-end flex-wrap">
        <div>
          <label className="text-xs text-muted-foreground block mb-1">From</label>
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="border border-border rounded-lg px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="text-xs text-muted-foreground block mb-1">To</label>
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="border border-border rounded-lg px-3 py-2 text-sm"
          />
        </div>
        <button
          onClick={fetchRevenue}
          className="px-4 py-2 bg-primary text-white rounded-lg text-sm hover:bg-primary/90"
        >
          Apply
        </button>
      </div>

      {loading && <div className="text-center py-8 text-muted-foreground">Loading revenue data...</div>}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700 text-sm">
          {error}
        </div>
      )}

      {stats && !loading && (
        <>
          {/* Summary Cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatCard
              label="Total Billed"
              value={fmt(stats.summary.total_billed)}
              color="text-foreground"
            />
            <StatCard
              label="Total Collected"
              value={fmt(stats.summary.total_collected)}
              color="text-green-700"
              bg="bg-green-50"
            />
            <StatCard
              label="Outstanding"
              value={fmt(stats.summary.total_outstanding)}
              color="text-orange-600"
              bg="bg-orange-50"
            />
            <StatCard
              label="Total Invoices"
              value={stats.summary.total_invoices}
            />
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatCard
              label="Paid"
              value={stats.summary.paid_count}
              color="text-green-600"
            />
            <StatCard
              label="Pending"
              value={stats.summary.pending_count}
              color="text-orange-600"
            />
            <StatCard
              label="Partial"
              value={stats.summary.partial_count}
              color="text-blue-600"
            />
            <StatCard
              label="Discounts Given"
              value={fmt(stats.summary.total_discounts)}
              color="text-muted-foreground"
            />
          </div>

          {/* By Type */}
          {stats.by_type.length > 0 && (
            <div className="border border-border rounded-lg overflow-hidden">
              <div className="bg-muted px-4 py-2 font-medium text-sm">Revenue by Type</div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left bg-muted/50">
                      <th className="py-2 px-3">Type</th>
                      <th className="py-2 px-3">Invoices</th>
                      <th className="py-2 px-3">Billed</th>
                      <th className="py-2 px-3">Collected</th>
                      <th className="py-2 px-3">Outstanding</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.by_type.map((row) => (
                      <tr key={row.type} className="border-b border-border hover:bg-muted/30">
                        <td className="py-2 px-3 capitalize font-medium">{row.type.replace("_", " ")}</td>
                        <td className="py-2 px-3">{row.invoice_count}</td>
                        <td className="py-2 px-3">{fmt(row.total_billed)}</td>
                        <td className="py-2 px-3">{fmt(row.total_collected)}</td>
                        <td className="py-2 px-3">{fmt(row.outstanding)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* By Payment Method */}
          {stats.by_payment_method.length > 0 && (
            <div className="border border-border rounded-lg overflow-hidden">
              <div className="bg-muted px-4 py-2 font-medium text-sm">By Payment Method</div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left bg-muted/50">
                      <th className="py-2 px-3">Method</th>
                      <th className="py-2 px-3">Transactions</th>
                      <th className="py-2 px-3">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.by_payment_method.map((row) => (
                      <tr key={row.payment_method} className="border-b border-border hover:bg-muted/30">
                        <td className="py-2 px-3 uppercase font-medium">{row.payment_method}</td>
                        <td className="py-2 px-3">{row.transaction_count}</td>
                        <td className="py-2 px-3">{fmt(row.total_amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
