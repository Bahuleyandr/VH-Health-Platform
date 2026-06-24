"use client";

import { fmt } from "../../components/shared";
import { useReport } from "./useReport";
import type { AgingReport } from "@/lib/api";

export function AgingSection({
  load,
  emptyLabel,
}: {
  load: () => Promise<AgingReport>;
  emptyLabel: string;
}) {
  const { data, loading, error } = useReport(load);

  if (loading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (error) return <p className="text-sm text-red-700">{error}</p>;
  if (!data || data.grandTotalPaise === 0)
    return <p className="text-sm text-muted-foreground">{emptyLabel}</p>;

  const totalInvoices = data.buckets.reduce((s, b) => s + b.invoiceCount, 0);

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left bg-muted/50">
            <th className="py-2 px-3">Bucket (days)</th>
            <th className="py-2 px-3 text-right">Invoices</th>
            <th className="py-2 px-3 text-right">Outstanding</th>
          </tr>
        </thead>
        <tbody>
          {data.buckets.map((b) => (
            <tr key={b.bucket} className="border-b border-border hover:bg-muted/30">
              <td className="py-2 px-3 font-medium">{b.bucket}</td>
              <td className="py-2 px-3 text-right">{b.invoiceCount}</td>
              <td className="py-2 px-3 text-right">{fmt(b.total)}</td>
            </tr>
          ))}
          <tr className="bg-muted/50 font-medium">
            <td className="py-2 px-3">Total</td>
            <td className="py-2 px-3 text-right">{totalInvoices}</td>
            <td className="py-2 px-3 text-right">{fmt(data.grandTotal)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
