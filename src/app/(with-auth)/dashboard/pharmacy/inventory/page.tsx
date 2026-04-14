// src/app/(with-auth)/dashboard/pharmacy/inventory/page.tsx
//
// Admin portal pharmacy inventory — stock on hand, reorder-point flags, and
// expiry window tiles (30/60/90 day). Reads the existing backend inventory
// endpoints (/pharmacy/inventory/summary, /low-stock, /expiring-soon).
"use client";

import { useEffect, useState } from "react";
import { fetchAdminAPI } from "@/lib/api";

type Summary = Record<string, number>;
type Row = {
  id?: number;
  medication_name?: string;
  name?: string;
  stock_on_hand?: number;
  stock?: number;
  reorder_point?: number;
  expiry_date?: string;
  batch_number?: string;
};

type SectionKey = "low-stock" | "expiring-soon" | "expired";

const SECTIONS: { key: SectionKey; title: string; path: string }[] = [
  { key: "low-stock", title: "Low stock", path: "/pharmacy/inventory/low-stock" },
  { key: "expiring-soon", title: "Expiring in 30 days", path: "/pharmacy/inventory/expiring-soon?days=30" },
  { key: "expired", title: "Already expired", path: "/pharmacy/inventory/expired" },
];

function unwrap(data: unknown): Row[] {
  // Controllers return either { items: [...] } or { data: [...] } depending on
  // which endpoint — accept both.
  if (Array.isArray(data)) return data as Row[];
  if (data && typeof data === "object") {
    const d = data as Record<string, unknown>;
    for (const k of ["items", "data", "medications", "rows"]) {
      if (Array.isArray(d[k])) return d[k] as Row[];
    }
  }
  return [];
}

export default function PharmacyInventoryPage() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [sections, setSections] = useState<Record<SectionKey, Row[]>>({
    "low-stock": [],
    "expiring-soon": [],
    "expired": [],
  });
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [sumRaw, ...lists] = await Promise.all([
          fetchAdminAPI("/pharmacy/inventory/summary"),
          ...SECTIONS.map((s) => fetchAdminAPI(s.path).catch(() => ({ data: [] }))),
        ]);
        const sumData = ((sumRaw as { data?: { summary?: Summary } })?.data?.summary)
          ?? ((sumRaw as { summary?: Summary })?.summary)
          ?? null;
        setSummary(sumData);
        const next: Record<SectionKey, Row[]> = {
          "low-stock": [],
          "expiring-soon": [],
          "expired": [],
        };
        SECTIONS.forEach((s, i) => {
          const payload = (lists[i] as { data?: unknown })?.data ?? lists[i];
          next[s.key] = unwrap(payload);
        });
        setSections(next);
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Failed to load inventory");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) return <div className="p-8 text-muted-foreground">Loading…</div>;
  if (err) return <div className="p-8 text-red-500">{err}</div>;

  return (
    <div className="space-y-6 p-6">
      <h1 className="text-2xl font-bold text-white">Pharmacy inventory</h1>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <SummaryCard label="In stock items" value={summary?.total_items ?? summary?.total} />
        <SummaryCard label="Below reorder" value={summary?.low_stock ?? summary?.below_reorder} tone="amber" />
        <SummaryCard label="Expiring soon" value={summary?.expiring_30 ?? summary?.expiring_soon} tone="amber" />
        <SummaryCard label="Expired" value={summary?.expired} tone="red" />
      </div>

      {SECTIONS.map((s) => (
        <Section key={s.key} title={s.title} rows={sections[s.key]} />
      ))}
    </div>
  );
}

function SummaryCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number | undefined;
  tone?: "amber" | "red";
}) {
  const colour =
    tone === "red" ? "text-red-400" : tone === "amber" ? "text-amber-400" : "text-white";
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`mt-1 text-2xl font-bold ${colour}`}>{value ?? "—"}</p>
    </div>
  );
}

function Section({ title, rows }: { title: string; rows: Row[] }) {
  return (
    <div className="rounded-xl border border-border bg-card">
      <div className="border-b border-border px-4 py-3">
        <h2 className="font-semibold text-white">{title}</h2>
      </div>
      {rows.length === 0 ? (
        <p className="p-4 text-sm text-muted-foreground">Nothing here — all good.</p>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-muted-foreground">
            <tr>
              <Th>Medication</Th>
              <Th>Stock</Th>
              <Th>Reorder pt</Th>
              <Th>Batch</Th>
              <Th>Expiry</Th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 50).map((r, i) => (
              <tr key={i} className="border-t border-border">
                <Td>{r.medication_name ?? r.name ?? "—"}</Td>
                <Td>{r.stock_on_hand ?? r.stock ?? "—"}</Td>
                <Td>{r.reorder_point ?? "—"}</Td>
                <Td>{r.batch_number ?? "—"}</Td>
                <Td>{r.expiry_date ? r.expiry_date.slice(0, 10) : "—"}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-4 py-2 text-left font-medium">{children}</th>;
}
function Td({ children }: { children: React.ReactNode }) {
  return <td className="px-4 py-2 text-white/90">{children}</td>;
}
