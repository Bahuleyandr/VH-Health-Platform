// src/app/(with-auth)/dashboard/compliance/indicators/page.tsx
//
// NABH/JCI indicator board. Reads /compliance/indicators which computes rates
// from the tables we already populate (MAR rights audit, prescription_safety_
// overrides, clinical_alerts). Indicators with no data source yet render as
// "tracking integration needed" rather than misleading zeros.
"use client";

import { useEffect, useState } from "react";
import { fetchAdminAPI } from "@/lib/api";
import { exportToPdf } from "@/lib/exportToPdf";

type Indicator = {
  available: boolean;
  numerator?: number;
  denominator?: number;
  ratePct?: number;
  reason?: string;
};

type Payload = {
  windowDays: number;
  medicationErrorRate: Indicator;
  patientIdentificationErrorRate: Indicator;
  marOverrideRate: Indicator;
  cdsOverrideRate: Indicator;
  unacknowledgedCriticalAlerts: Indicator;
  handHygieneCompliance: Indicator;
  hospitalAcquiredInfectionRate: Indicator;
  surgicalSiteInfectionRate: Indicator;
};

const TILES: { key: keyof Payload; title: string; lowerIsBetter: boolean }[] = [
  {
    key: "medicationErrorRate",
    title: "Medication error rate",
    lowerIsBetter: true,
  },
  {
    key: "patientIdentificationErrorRate",
    title: "Patient-ID error rate",
    lowerIsBetter: true,
  },
  { key: "marOverrideRate", title: "MAR override rate", lowerIsBetter: true },
  { key: "cdsOverrideRate", title: "CDS override rate", lowerIsBetter: true },
  {
    key: "unacknowledgedCriticalAlerts",
    title: "Unack. critical alerts",
    lowerIsBetter: true,
  },
  {
    key: "handHygieneCompliance",
    title: "Hand-hygiene compliance",
    lowerIsBetter: false,
  },
  {
    key: "hospitalAcquiredInfectionRate",
    title: "HAI rate",
    lowerIsBetter: true,
  },
  {
    key: "surgicalSiteInfectionRate",
    title: "Surgical-site infection rate",
    lowerIsBetter: true,
  },
];

function toneFor(rate: number | undefined, lowerIsBetter: boolean) {
  if (rate == null) return "text-muted-foreground";
  const value = lowerIsBetter ? rate : 100 - rate;
  if (value >= 15) return "text-red-400";
  if (value >= 5) return "text-amber-400";
  return "text-emerald-400";
}

export default function ComplianceIndicatorsPage() {
  const [data, setData] = useState<Payload | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        // fetchAdminAPI already unwraps the {success, data} envelope — `resp`
        // IS the Payload directly. Previous `resp.data` double-unwrap left the
        // page stuck on "Loading…" forever.
        const resp = await fetchAdminAPI<Payload>("/compliance/indicators");
        setData(resp ?? null);
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Failed to load indicators");
      }
    })();
  }, []);

  if (err) return <div className="p-8 text-red-500">{err}</div>;
  if (!data) return <div className="p-8 text-muted-foreground">Loading…</div>;

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-end justify-between">
        <h1 className="text-2xl font-bold text-white">Compliance indicators</h1>
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground">
            Trailing {data.windowDays} days
          </span>
          <button
            onClick={() => {
              void exportToPdf({
                filename: `compliance-indicators-${new Date().toISOString().slice(0, 10)}.pdf`,
                title: "Compliance indicators",
                subtitle: `Trailing ${data.windowDays} days`,
                tables: [
                  {
                    title: "NABH / JCI indicators",
                    head: [
                      "Indicator",
                      "Rate",
                      "Numerator / Denominator",
                      "Status",
                    ],
                    rows: TILES.map((t) => {
                      const ind = data[t.key] as Indicator;
                      return [
                        t.title,
                        ind.available ? `${ind.ratePct?.toFixed(2)}%` : "—",
                        ind.available
                          ? `${ind.numerator ?? 0} / ${ind.denominator ?? 0}`
                          : "—",
                        ind.available
                          ? "Tracked"
                          : (ind.reason ?? "Not available"),
                      ];
                    }),
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

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {TILES.map((t) => {
          const ind = data[t.key] as Indicator;
          return (
            <div
              key={String(t.key)}
              className="rounded-xl border border-border bg-card p-4"
            >
              <p className="text-xs uppercase tracking-wide text-muted-foreground">
                {t.title}
              </p>
              {ind.available ? (
                <>
                  <p
                    className={`mt-1 text-2xl font-bold ${toneFor(ind.ratePct, t.lowerIsBetter)}`}
                  >
                    {ind.ratePct?.toFixed(2) ?? "—"}%
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {ind.numerator ?? 0} / {ind.denominator ?? 0}
                  </p>
                </>
              ) : (
                <>
                  <p className="mt-1 text-lg font-semibold text-muted-foreground">
                    —
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {ind.reason ?? "Not available"}
                  </p>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
