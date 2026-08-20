"use client";

// Catalog tab of the BI Dashboards page: the governed dataset table.

import { LockKeyhole, ShieldCheck } from "lucide-react";
import type { DatasetEntry } from "./types";
import { compactRoles, governanceClass, label } from "./helpers";

export default function CatalogTab({ datasets }: { datasets: DatasetEntry[] }) {
  return (
    <div className="overflow-x-auto rounded-md border bg-card shadow-sm">
      <table className="min-w-[1100px] w-full text-left text-sm">
        <thead className="border-b bg-muted/40 text-xs uppercase text-muted-foreground">
          <tr>
            <th className="px-4 py-3 font-semibold">Dataset</th>
            <th className="px-4 py-3 font-semibold">Owner</th>
            <th className="px-4 py-3 font-semibold">Governance</th>
            <th className="px-4 py-3 font-semibold">Boundary</th>
            <th className="px-4 py-3 font-semibold">Fields</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {datasets.map((dataset) => {
            const patientUid = dataset.fields.find(
              (field) => field.fieldName === "patient_uid",
            );
            return (
              <tr key={dataset.key} className="align-top">
                <td className="px-4 py-4">
                  <div className="font-medium text-foreground">
                    {dataset.displayName}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {dataset.dbtRelation}
                  </div>
                  <div className="mt-2 text-xs text-muted-foreground">
                    {dataset.grain}
                  </div>
                </td>
                <td className="px-4 py-4">
                  <div className="font-medium text-foreground">
                    {dataset.ownerRole}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {label(dataset.sourceDomain)}
                  </div>
                  <div className="mt-2 text-xs text-muted-foreground">
                    {dataset.refreshCadence}
                  </div>
                </td>
                <td className="px-4 py-4">
                  <div className="flex flex-wrap gap-2">
                    <span
                      className={`rounded-full border px-2 py-0.5 text-xs font-medium ${governanceClass(
                        dataset.phiClass,
                      )}`}
                    >
                      {label(dataset.phiClass)}
                    </span>
                    <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs font-medium text-slate-700">
                      Min cell {dataset.minCellThreshold}
                    </span>
                  </div>
                  <div className="mt-2 text-xs text-muted-foreground">
                    {label(dataset.certificationStatus)} ·{" "}
                    {label(dataset.exportPolicy)}
                  </div>
                </td>
                <td className="px-4 py-4">
                  <div className="font-medium text-foreground">
                    {label(dataset.tenantBoundaryMode)}
                  </div>
                  <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                    <ShieldCheck className="h-4 w-4" aria-hidden="true" />
                    {compactRoles(dataset.allowedRoles)}
                  </div>
                </td>
                <td className="px-4 py-4">
                  <div className="space-y-2">
                    {patientUid && (
                      <div className="flex items-start gap-2 rounded-md border border-rose-200 bg-rose-50 p-2 text-xs text-rose-800">
                        <LockKeyhole
                          className="mt-0.5 h-4 w-4 shrink-0"
                          aria-hidden="true"
                        />
                        <span>
                          patient_uid hidden · filter blocked · backend
                          drilldown only
                        </span>
                      </div>
                    )}
                    <div className="text-xs text-muted-foreground">
                      {dataset.hiddenFieldCount} hidden ·{" "}
                      {dataset.backendDrilldownFieldCount} drilldown-only
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {dataset.fields
                        .filter((field) => !field.hiddenByDefault)
                        .slice(0, 4)
                        .map((field) => field.fieldName)
                        .join(", ") || "Catalog fields pending"}
                    </div>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
