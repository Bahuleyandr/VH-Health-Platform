// src/app/(with-auth)/dashboard/billing/denials/page.tsx
//
// Insurance-denial dashboard. Reads /billing/denials/summary (aggregate tiles
// + top reason codes) and /billing/denials (recent list). Full 837 EDI
// generation and payer-specific workflows are follow-up work; this page gives
// billing staff a first usable view of the denial stream.
"use client";

import { useEffect, useState } from "react";
import { fetchAdminAPI } from "@/lib/api";

type Summary = {
  windowDays: number;
  overall: { total: number; denied_total: number; appealed: number; won: number };
  byReason: { reason_code: string; count: number; amount: number }[];
};

type Denial = {
  id: number;
  invoice_id: number | null;
  payer: string | null;
  reason_code: string;
  reason_text: string | null;
  denied_amount: number;
  appealed: boolean;
  appeal_outcome: string | null;
  denied_at: string;
};

export default function DenialDashboard() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [denials, setDenials] = useState<Denial[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        // fetchAdminAPI already unwraps the {success, data} envelope — `s`
        // IS the Summary; previously the code re-accessed `.data` which was
        // undefined, leaving the page stuck on "Loading…" forever.
        const [s, list] = await Promise.all([
          fetchAdminAPI<Summary>("/billing/denials/summary"),
          fetchAdminAPI<{ items?: Denial[] }>("/billing/denials?limit=50"),
        ]);
        setSummary(s ?? null);
        setDenials(list?.items ?? []);
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Failed to load denials");
      }
    })();
  }, []);

  if (err) return <div className="p-8 text-red-500">{err}</div>;
  if (!summary) return <div className="p-8 text-muted-foreground">Loading…</div>;

  const winRate = summary.overall.appealed > 0
    ? Math.round((summary.overall.won / summary.overall.appealed) * 100)
    : 0;

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-end justify-between">
        <h1 className="text-2xl font-bold text-white">Insurance denials</h1>
        <span className="text-xs text-muted-foreground">
          Trailing {summary.windowDays} days
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Denials" value={summary.overall.total} />
        <StatTile label="Amount denied" value={`₹${Math.round(summary.overall.denied_total).toLocaleString("en-IN")}`} tone="red" />
        <StatTile label="Appealed" value={summary.overall.appealed} tone="amber" />
        <StatTile label="Appeal win rate" value={`${winRate}%`} tone={winRate >= 50 ? "emerald" : "amber"} />
      </div>

      <div className="rounded-xl border border-border bg-card p-4">
        <h2 className="mb-3 font-semibold text-white">Top denial reasons</h2>
        {summary.byReason.length === 0 ? (
          <p className="text-sm text-muted-foreground">No denials in this window.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-muted-foreground">
              <tr>
                <Th>Reason code</Th>
                <Th>Count</Th>
                <Th>Amount</Th>
              </tr>
            </thead>
            <tbody>
              {summary.byReason.map((r) => (
                <tr key={r.reason_code} className="border-t border-border">
                  <Td>{r.reason_code}</Td>
                  <Td>{r.count}</Td>
                  <Td>₹{Math.round(r.amount).toLocaleString("en-IN")}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="rounded-xl border border-border bg-card p-4">
        <h2 className="mb-3 font-semibold text-white">Recent denials</h2>
        {denials.length === 0 ? (
          <p className="text-sm text-muted-foreground">No recent denials.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-muted-foreground">
              <tr>
                <Th>When</Th>
                <Th>Payer</Th>
                <Th>Reason</Th>
                <Th>Amount</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {denials.map((d) => (
                <tr key={d.id} className="border-t border-border">
                  <Td>{new Date(d.denied_at).toLocaleDateString()}</Td>
                  <Td>{d.payer ?? "—"}</Td>
                  <Td>{d.reason_code} — {d.reason_text ?? ""}</Td>
                  <Td>₹{Math.round(d.denied_amount).toLocaleString("en-IN")}</Td>
                  <Td>{d.appealed ? (d.appeal_outcome ?? "appealed") : "denied"}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function StatTile({ label, value, tone }: { label: string; value: string | number; tone?: "amber" | "red" | "emerald" }) {
  const colour =
    tone === "red" ? "text-red-400"
    : tone === "amber" ? "text-amber-400"
    : tone === "emerald" ? "text-emerald-400"
    : "text-white";
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`mt-1 text-2xl font-bold ${colour}`}>{value}</p>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-4 py-2 text-left font-medium">{children}</th>;
}
function Td({ children }: { children: React.ReactNode }) {
  return <td className="px-4 py-2 text-white/90">{children}</td>;
}
