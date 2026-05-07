// src/app/(with-auth)/dashboard/dashboards/page.tsx
//
// Metabase dashboard picker — Sprint 9.

"use client";

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { fetchAdminAPI } from "@/lib/api";
import { LoadingSpinner } from "@/components/LoadingSpinner";

interface DashboardEntry {
  key: string;
  title: string;
  description: string;
  available: boolean;
}

function unwrap<T>(r: unknown): T {
  return ((r as { data?: T }).data ?? r) as T;
}

export default function DashboardsPage() {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [embedUrl, setEmbedUrl] = useState<string | null>(null);

  const {
    data: list = [],
    error: listError,
    isLoading,
  } = useQuery<DashboardEntry[]>({
    queryKey: ["dashboards", "embed-list"],
    queryFn: async () => {
      const r = await fetchAdminAPI<unknown>("/dashboards/embed/list");
      const data = unwrap<DashboardEntry[]>(r);
      return Array.isArray(data) ? data : [];
    },
    staleTime: 5 * 60 * 1000,
  });

  const embedMutation = useMutation({
    mutationFn: async (key: string) => {
      const r = await fetchAdminAPI<unknown>("/dashboards/embed/url", {
        method: "POST",
        body: JSON.stringify({ key, ttlSeconds: 1800 }),
      });
      return unwrap<{ url: string }>(r);
    },
    onSuccess: (res) => {
      setEmbedUrl(res?.url ?? null);
    },
    onError: () => setEmbedUrl(null),
  });

  function open(d: DashboardEntry) {
    setOpenKey(d.key);
    setEmbedUrl(null);
    embedMutation.mutate(d.key);
  }

  const error = listError ?? embedMutation.error;

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-foreground">Dashboards</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Metabase-hosted analytics. Pick a dashboard to embed it inline.
          Snapshots and ad-hoc views live under{" "}
          <a href="/dashboard/operations" className="text-blue-600 hover:underline">
            /dashboard/operations
          </a>
          .
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {error instanceof Error ? error.message : "Failed to load"}
        </div>
      )}

      {isLoading ? (
        <LoadingSpinner />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {list.map((d) => (
            <button
              key={d.key}
              onClick={() => d.available && open(d)}
              disabled={!d.available}
              className={`text-left bg-white rounded-lg border shadow-sm p-4 hover:bg-muted/30 disabled:opacity-50 disabled:cursor-not-allowed ${
                openKey === d.key ? "ring-2 ring-blue-400" : ""
              }`}
            >
              <h3 className="font-semibold">{d.title}</h3>
              <p className="text-xs text-muted-foreground mt-1.5">
                {d.description}
              </p>
              {!d.available && (
                <p className="text-xs text-amber-700 mt-2">
                  Not yet configured (METABASE_DASH_* env)
                </p>
              )}
            </button>
          ))}
        </div>
      )}

      {openKey !== null && (
        <div className="bg-white rounded-lg border shadow-sm">
          <div className="p-3 border-b flex items-center justify-between">
            <h2 className="text-base font-semibold">
              {list.find((d) => d.key === openKey)?.title}
            </h2>
            <button
              onClick={() => {
                setOpenKey(null);
                setEmbedUrl(null);
              }}
              className="text-muted-foreground hover:text-foreground text-sm"
            >
              ✕ close
            </button>
          </div>
          {embedMutation.isPending ? (
            <div className="p-8">
              <LoadingSpinner />
            </div>
          ) : embedUrl ? (
            <iframe
              src={embedUrl}
              className="w-full"
              style={{ height: "70vh", border: 0 }}
              title={openKey}
            />
          ) : (
            <div className="p-8 text-sm text-muted-foreground">
              Couldn&apos;t generate an embed URL. Check that{" "}
              <code>METABASE_URL</code> and <code>METABASE_EMBED_SECRET</code>{" "}
              are set on the backend.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
