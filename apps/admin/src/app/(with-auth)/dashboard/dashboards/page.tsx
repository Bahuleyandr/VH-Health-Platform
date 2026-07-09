// src/app/(with-auth)/dashboard/dashboards/page.tsx
"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  BarChart3,
  ExternalLink,
  LockKeyhole,
  ShieldCheck,
  TableProperties,
  X,
} from "lucide-react";
import { fetchAdminAPI } from "@/lib/api";
import { LoadingSpinner } from "@/components/LoadingSpinner";

interface DashboardEntry {
  key: string;
  title: string;
  description: string;
  available: boolean;
  status: "active" | "held" | "deprecated";
  certificationStatus: string;
  datasetKeys: string[];
  requiredParams: string[];
  embedRoles: string[];
  ownerRole: string;
  displayOrder: number;
}

interface DatasetField {
  fieldName: string;
  displayLabel: string;
  semanticType: string;
  phiClass: string;
  hiddenByDefault: boolean;
  allowedFilter: boolean;
  backendDrilldownOnly: boolean;
  description: string;
}

interface DatasetEntry {
  key: string;
  displayName: string;
  dbtRelation: string;
  grain: string;
  refreshCadence: string;
  sourceDomain: string;
  ownerRole: string;
  certificationStatus: string;
  tenantBoundaryMode: string;
  phiClass: string;
  minCellThreshold: number;
  allowedRoles: string[];
  exportPolicy: string;
  description: string;
  hiddenFieldCount: number;
  backendDrilldownFieldCount: number;
  fields: DatasetField[];
}

interface CatalogResponse {
  datasets: DatasetEntry[];
  dashboards: DashboardEntry[];
}

type TabKey = "embeds" | "catalog";

function label(value: string) {
  return value
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function compactRoles(roles: string[]) {
  if (roles.length <= 3) return roles.join(", ");
  return `${roles.slice(0, 3).join(", ")} +${roles.length - 3}`;
}

function statusClass(status: string) {
  if (status === "active") return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (status === "held") return "border-amber-200 bg-amber-50 text-amber-800";
  return "border-slate-200 bg-slate-50 text-slate-700";
}

function governanceClass(phiClass: string) {
  if (phiClass.includes("phi")) return "border-rose-200 bg-rose-50 text-rose-800";
  if (phiClass === "financial") return "border-blue-200 bg-blue-50 text-blue-800";
  return "border-slate-200 bg-slate-50 text-slate-700";
}

export default function DashboardsPage() {
  const [activeTab, setActiveTab] = useState<TabKey>("embeds");
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [embedUrl, setEmbedUrl] = useState<string | null>(null);

  const {
    data: catalog,
    error: catalogError,
    isLoading,
  } = useQuery<CatalogResponse>({
    queryKey: ["dashboards", "catalog"],
    queryFn: () => fetchAdminAPI<CatalogResponse>("/dashboards/catalog"),
    staleTime: 5 * 60 * 1000,
  });

  const dashboards = useMemo(
    () => [...(catalog?.dashboards ?? [])].sort((a, b) => a.displayOrder - b.displayOrder),
    [catalog?.dashboards],
  );
  const datasets = catalog?.datasets ?? [];

  const embedMutation = useMutation({
    mutationFn: async (key: string) =>
      fetchAdminAPI<{ url: string }>("/dashboards/embed/url", {
        method: "POST",
        body: { key, ttlSeconds: 1800 },
      }),
    onSuccess: (res) => {
      setEmbedUrl(res?.url ?? null);
    },
    onError: () => setEmbedUrl(null),
  });

  function open(dashboard: DashboardEntry) {
    setOpenKey(dashboard.key);
    setEmbedUrl(null);
    embedMutation.mutate(dashboard.key);
  }

  const error = catalogError ?? embedMutation.error;

  return (
    <div className="p-6 space-y-6">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-3xl font-bold text-foreground">Governed Analytics</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Certified warehouse marts and curated executive embeds.
          </p>
        </div>
        <div className="inline-flex w-fit rounded-md border border-border bg-card p-1">
          <button
            type="button"
            onClick={() => setActiveTab("embeds")}
            className={`inline-flex items-center gap-2 rounded px-3 py-2 text-sm font-medium ${
              activeTab === "embeds"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <BarChart3 className="h-4 w-4" aria-hidden="true" />
            Embeds
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("catalog")}
            className={`inline-flex items-center gap-2 rounded px-3 py-2 text-sm font-medium ${
              activeTab === "catalog"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <TableProperties className="h-4 w-4" aria-hidden="true" />
            Catalog
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {error instanceof Error ? error.message : "Failed to load analytics catalog"}
        </div>
      )}

      {isLoading ? (
        <LoadingSpinner />
      ) : activeTab === "embeds" ? (
        <EmbeddedDashboards
          dashboards={dashboards}
          openKey={openKey}
          embedUrl={embedUrl}
          loadingEmbed={embedMutation.isPending}
          onOpen={open}
          onClose={() => {
            setOpenKey(null);
            setEmbedUrl(null);
          }}
        />
      ) : (
        <DatasetCatalog datasets={datasets} />
      )}
    </div>
  );
}

function EmbeddedDashboards({
  dashboards,
  openKey,
  embedUrl,
  loadingEmbed,
  onOpen,
  onClose,
}: {
  dashboards: DashboardEntry[];
  openKey: string | null;
  embedUrl: string | null;
  loadingEmbed: boolean;
  onOpen: (dashboard: DashboardEntry) => void;
  onClose: () => void;
}) {
  const activeDashboard = dashboards.find((dashboard) => dashboard.key === openKey);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {dashboards.map((dashboard) => {
          const canOpen = dashboard.status === "active" && dashboard.available;
          return (
            <button
              key={dashboard.key}
              type="button"
              onClick={() => canOpen && onOpen(dashboard)}
              disabled={!canOpen}
              className={`min-h-44 rounded-md border bg-card p-4 text-left shadow-sm transition hover:border-primary/50 hover:bg-muted/30 disabled:cursor-not-allowed disabled:opacity-70 ${
                openKey === dashboard.key ? "ring-2 ring-primary" : ""
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="text-base font-semibold text-foreground">{dashboard.title}</h2>
                  <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                    {dashboard.description}
                  </p>
                </div>
                <span
                  className={`shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium ${statusClass(
                    dashboard.status,
                  )}`}
                >
                  {dashboard.status === "active" && dashboard.available
                    ? "Ready"
                    : dashboard.status === "held"
                      ? "Held"
                      : "Config"}
                </span>
              </div>
              <div className="mt-4 space-y-2 text-xs text-muted-foreground">
                <p>
                  <span className="font-medium text-foreground">Owner:</span>{" "}
                  {dashboard.ownerRole}
                </p>
                <p>
                  <span className="font-medium text-foreground">Datasets:</span>{" "}
                  {dashboard.datasetKeys.length ? dashboard.datasetKeys.join(", ") : "Pending"}
                </p>
                <p>
                  <span className="font-medium text-foreground">Roles:</span>{" "}
                  {compactRoles(dashboard.embedRoles)}
                </p>
              </div>
              {canOpen && (
                <span className="mt-4 inline-flex items-center gap-2 text-sm font-medium text-primary">
                  <ExternalLink className="h-4 w-4" aria-hidden="true" />
                  Open embed
                </span>
              )}
            </button>
          );
        })}
      </div>

      {openKey !== null && (
        <div className="rounded-md border bg-card shadow-sm">
          <div className="flex items-center justify-between gap-3 border-b p-3">
            <div>
              <h2 className="text-base font-semibold">{activeDashboard?.title}</h2>
              <p className="text-xs text-muted-foreground">
                {activeDashboard?.datasetKeys.join(", ")}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-9 w-9 items-center justify-center rounded border border-border text-muted-foreground hover:text-foreground"
              aria-label="Close embed"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
          {loadingEmbed ? (
            <LoadingSpinner />
          ) : embedUrl ? (
            <iframe
              src={embedUrl}
              className="w-full"
              style={{ height: "70vh", border: 0 }}
              title={openKey}
            />
          ) : (
            <div className="p-8 text-sm text-muted-foreground">
              Embed URL unavailable for this dashboard.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DatasetCatalog({ datasets }: { datasets: DatasetEntry[] }) {
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
            const patientUid = dataset.fields.find((field) => field.fieldName === "patient_uid");
            return (
              <tr key={dataset.key} className="align-top">
                <td className="px-4 py-4">
                  <div className="font-medium text-foreground">{dataset.displayName}</div>
                  <div className="mt-1 text-xs text-muted-foreground">{dataset.dbtRelation}</div>
                  <div className="mt-2 text-xs text-muted-foreground">{dataset.grain}</div>
                </td>
                <td className="px-4 py-4">
                  <div className="font-medium text-foreground">{dataset.ownerRole}</div>
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
                    {label(dataset.certificationStatus)} · {label(dataset.exportPolicy)}
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
                        <LockKeyhole className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                        <span>
                          patient_uid hidden · filter blocked · backend drilldown only
                        </span>
                      </div>
                    )}
                    <div className="text-xs text-muted-foreground">
                      {dataset.hiddenFieldCount} hidden · {dataset.backendDrilldownFieldCount} drilldown-only
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
