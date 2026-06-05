// src/app/(with-auth)/dashboard/executive/page.tsx
//
// Executive (C-suite) KPI digest. Reads /admin/executive-kpi/summary which
// aggregates revenue, occupancy, satisfaction, and doctor utilisation for a
// rolling window. Role-gated client-side via usePermissions — the backend
// also enforces ADMIN via the standard admin middleware, so this page is
// defence-in-depth.
"use client";

import { useEffect, useState } from "react";
import { fetchAdminAPI } from "@/lib/api";
import { exportToPdf } from "@/lib/exportToPdf";
import { usePermissions } from "@/hooks/usePermissions";

type Kpi = {
  windowDays: number;
  revenue: {
    total: number;
    collected: number;
    invoiceCount: number;
    paid: number;
    pending: number;
  };
  occupancy: { total: number; occupied: number; pct: number };
  satisfaction: { avgRating: number; responses: number };
  doctorUtilisation: {
    activeDoctors: number;
    appointments: number;
    completed: number;
    completionPct: number;
  };
};

function fmtCurrency(n: number) {
  return `₹${Math.round(n).toLocaleString("en-IN")}`;
}

export default function ExecutiveKpiPage() {
  const { isAdmin, loading: permLoading } = usePermissions();
  const [data, setData] = useState<Kpi | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!isAdmin) return;
    (async () => {
      try {
        const resp = (await fetchAdminAPI("/admin/executive-kpi/summary")) as {
          data?: Kpi;
        };
        setData(resp.data ?? null);
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Failed to load executive KPI");
      }
    })();
  }, [isAdmin]);

  if (permLoading)
    return <div className="p-8 text-muted-foreground">Loading…</div>;
  if (!isAdmin)
    return (
      <div className="p-8 text-red-400">
        Executive KPI is restricted to admins.
      </div>
    );
  if (err) return <div className="p-8 text-red-500">{err}</div>;
  if (!data) return <div className="p-8 text-muted-foreground">Loading…</div>;

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-end justify-between">
        <h1 className="text-2xl font-bold text-white">Executive KPI</h1>
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground">
            Trailing {data.windowDays} days
          </span>
          <button
            onClick={() => {
              void exportToPdf({
                filename: `executive-kpi-${new Date().toISOString().slice(0, 10)}.pdf`,
                title: "Executive KPI",
                subtitle: `Trailing ${data.windowDays} days`,
                kpis: [
                  {
                    label: "Revenue billed",
                    value: fmtCurrency(data.revenue.total),
                  },
                  {
                    label: "Revenue collected",
                    value: fmtCurrency(data.revenue.collected),
                  },
                  { label: "Bed occupancy", value: `${data.occupancy.pct}%` },
                  {
                    label: "Satisfaction",
                    value: `${data.satisfaction.avgRating.toFixed(2)}/5`,
                  },
                ],
                tables: [
                  {
                    title: "Revenue",
                    head: ["Metric", "Value"],
                    rows: [
                      ["Invoices issued", data.revenue.invoiceCount],
                      ["Paid invoices", data.revenue.paid],
                      ["Pending invoices", data.revenue.pending],
                      ["Billed total", fmtCurrency(data.revenue.total)],
                      ["Collected", fmtCurrency(data.revenue.collected)],
                    ],
                  },
                  {
                    title: "Operations",
                    head: ["Metric", "Value"],
                    rows: [
                      [
                        "Beds occupied",
                        `${data.occupancy.occupied} / ${data.occupancy.total}`,
                      ],
                      ["Occupancy", `${data.occupancy.pct}%`],
                      ["Active doctors", data.doctorUtilisation.activeDoctors],
                      [
                        "Appointments completed",
                        `${data.doctorUtilisation.completed} / ${data.doctorUtilisation.appointments} (${data.doctorUtilisation.completionPct}%)`,
                      ],
                      ["Feedback responses", data.satisfaction.responses],
                      [
                        "Avg rating",
                        `${data.satisfaction.avgRating.toFixed(2)}/5`,
                      ],
                    ],
                  },
                ],
              });
            }}
            className="rounded-md border border-border bg-card px-3 py-1.5 text-xs text-foreground hover:border-indigo-500"
          >
            Export PDF
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Tile
          title="Revenue billed"
          primary={fmtCurrency(data.revenue.total)}
          sub={`Collected ${fmtCurrency(data.revenue.collected)}`}
          tone="emerald"
        />
        <Tile
          title="Bed occupancy"
          primary={`${data.occupancy.pct}%`}
          sub={`${data.occupancy.occupied} of ${data.occupancy.total}`}
          tone={
            data.occupancy.pct >= 90
              ? "red"
              : data.occupancy.pct >= 75
                ? "amber"
                : "emerald"
          }
        />
        <Tile
          title="Patient satisfaction"
          primary={`${data.satisfaction.avgRating.toFixed(2)} / 5`}
          sub={`${data.satisfaction.responses} responses`}
          tone={
            data.satisfaction.avgRating >= 4
              ? "emerald"
              : data.satisfaction.avgRating >= 3
                ? "amber"
                : "red"
          }
        />
        <Tile
          title="Doctor utilisation"
          primary={`${data.doctorUtilisation.completionPct}%`}
          sub={`${data.doctorUtilisation.completed} of ${data.doctorUtilisation.appointments} appts`}
          tone="white"
        />
      </div>

      <div className="rounded-xl border border-border bg-card p-4">
        <h2 className="mb-3 font-semibold text-white">Revenue breakdown</h2>
        <div className="grid grid-cols-3 gap-3 text-center text-sm">
          <MiniStat label="Invoices" value={data.revenue.invoiceCount} />
          <MiniStat label="Paid" value={data.revenue.paid} tone="emerald" />
          <MiniStat label="Pending" value={data.revenue.pending} tone="amber" />
        </div>
      </div>
    </div>
  );
}

function Tile({
  title,
  primary,
  sub,
  tone,
}: {
  title: string;
  primary: string;
  sub: string;
  tone: "emerald" | "amber" | "red" | "white";
}) {
  const colour =
    tone === "emerald"
      ? "text-emerald-400"
      : tone === "amber"
        ? "text-amber-400"
        : tone === "red"
          ? "text-red-400"
          : "text-white";
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">
        {title}
      </p>
      <p className={`mt-1 text-2xl font-bold ${colour}`}>{primary}</p>
      <p className="mt-1 text-xs text-muted-foreground">{sub}</p>
    </div>
  );
}

function MiniStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "emerald" | "amber";
}) {
  const colour =
    tone === "emerald"
      ? "text-emerald-400"
      : tone === "amber"
        ? "text-amber-400"
        : "text-white";
  return (
    <div>
      <p className={`text-xl font-bold ${colour}`}>{value}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}
