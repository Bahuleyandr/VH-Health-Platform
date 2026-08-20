// src/app/(with-auth)/dashboard/dashboards/page.tsx
//
// Thin tab orchestrator (god-page split per admin CLAUDE.md): tab state +
// catalog query + embed mutation live here; rendering lives in components/.
"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { BarChart3, TableProperties } from "lucide-react";
import { fetchAdminAPI } from "@/lib/api";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import EmbedsTab from "./components/EmbedsTab";
import CatalogTab from "./components/CatalogTab";
import type { CatalogResponse, DashboardEntry } from "./components/types";

type TabKey = "embeds" | "catalog";

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
    () =>
      [...(catalog?.dashboards ?? [])].sort(
        (a, b) => a.displayOrder - b.displayOrder,
      ),
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

  // Embed failures render inside the viewer panel (per-dashboard), so the
  // page-level banner only carries catalog-load failures.
  const error = catalogError;
  const gate = catalog?.analyticsBi ?? null;

  return (
    <div className="p-6 space-y-6">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-3xl font-bold text-foreground">
            Governed Analytics
          </h1>
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
          {error instanceof Error
            ? error.message
            : "Failed to load analytics catalog"}
        </div>
      )}

      {isLoading ? (
        <LoadingSpinner />
      ) : activeTab === "embeds" ? (
        <EmbedsTab
          dashboards={dashboards}
          gate={gate}
          openKey={openKey}
          embedUrl={embedUrl}
          embedError={embedMutation.error}
          loadingEmbed={embedMutation.isPending}
          onOpen={open}
          onClose={() => {
            setOpenKey(null);
            setEmbedUrl(null);
          }}
        />
      ) : (
        <CatalogTab datasets={datasets} />
      )}
    </div>
  );
}
