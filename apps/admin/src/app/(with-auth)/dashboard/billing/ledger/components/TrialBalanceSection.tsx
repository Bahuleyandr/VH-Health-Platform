"use client";

import { getTrialBalance } from "@/lib/api";
import { fmt } from "../../components/shared";
import { useReport } from "./useReport";

export function TrialBalanceSection() {
  const { data, loading, error } = useReport(getTrialBalance);

  if (loading) return <p className="text-sm text-muted-foreground">Loading trial balance…</p>;
  if (error) return <p className="text-sm text-red-700">{error}</p>;
  if (!data || data.accounts.length === 0)
    return <p className="text-sm text-muted-foreground">No ledger accounts yet.</p>;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">Status:</span>
        {data.balanced ? (
          <span className="px-2 py-1 rounded-full text-xs font-medium bg-green-100 text-green-700">
            Balanced
          </span>
        ) : (
          <span className="px-2 py-1 rounded-full text-xs font-medium bg-red-100 text-red-700">
            Out of balance by {fmt(data.signedTotalPaise / 100)}
          </span>
        )}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left bg-muted/50">
              <th className="py-2 px-3">Account</th>
              <th className="py-2 px-3">Type</th>
              <th className="py-2 px-3 text-right">Balance</th>
            </tr>
          </thead>
          <tbody>
            {data.accounts.map((a) => (
              <tr key={a.code} className="border-b border-border hover:bg-muted/30">
                <td className="py-2 px-3 font-mono text-xs">{a.code}</td>
                <td className="py-2 px-3">{a.type}</td>
                <td className="py-2 px-3 text-right font-medium">{fmt(a.balance)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
