"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchAdminAPI } from "@/lib/api";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { EmptyState } from "@/components/EmptyState";

interface Phrase {
  id: number;
  code: string;
  title: string;
  body: string;
  specialty: string | null;
  scope: "private" | "tenant_shared";
  owner_uid: string | null;
  placeholders: string[] | null;
  use_count: number;
  active: boolean;
  created_at: string;
}

function unwrap<T>(r: unknown): T {
  return ((r as { data?: T }).data ?? r) as T;
}

export function SmartPhrasesTab() {
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [specialty, setSpecialty] = useState("");

  const { data: rows = [], error, isLoading } = useQuery<Phrase[]>({
    queryKey: ["productivity", "phrases", { q, specialty }],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (q) params.set("q", q);
      if (specialty) params.set("specialty", specialty);
      params.set("limit", "200");
      const r = await fetchAdminAPI<unknown>(
        `/productivity/phrases?${params.toString()}`,
      );
      const data = unwrap<Phrase[]>(r);
      return Array.isArray(data) ? data : [];
    },
  });

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Smart phrases (dot phrases). Doctors type{" "}
        <code className="bg-muted px-1 rounded">.dmreview</code> in any text
        field and the client expands the body with{" "}
        <code className="bg-muted px-1 rounded">{"{{TOKEN}}"}</code>{" "}
        placeholders filled from the encounter.
      </p>

      <div className="flex gap-3 items-end flex-wrap">
        <div>
          <label className="text-xs text-muted-foreground block mb-1">Search</label>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder=".dm or 'fever'"
            className="border border-border rounded-lg px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="text-xs text-muted-foreground block mb-1">
            Specialty
          </label>
          <input
            value={specialty}
            onChange={(e) => setSpecialty(e.target.value)}
            placeholder="general_medicine / obg / ..."
            className="border border-border rounded-lg px-3 py-2 text-sm"
          />
        </div>
        <button
          onClick={() => qc.invalidateQueries({ queryKey: ["productivity", "phrases"] })}
          className="px-3 py-2 rounded-md border text-sm hover:bg-muted"
        >
          Refresh
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {error instanceof Error ? error.message : "Failed to load phrases"}
        </div>
      )}

      {isLoading ? (
        <LoadingSpinner />
      ) : rows.length === 0 ? (
        <EmptyState title="No smart phrases" description="Try clearing the filter." />
      ) : (
        <div className="space-y-3">
          {rows.map((p) => (
            <details
              key={p.id}
              className="bg-white rounded-lg border shadow-sm"
            >
              <summary className="cursor-pointer px-4 py-2 flex items-center justify-between hover:bg-muted/30">
                <div className="flex items-center gap-3">
                  <code className="bg-muted px-2 py-0.5 rounded text-xs font-mono">
                    {p.code}
                  </code>
                  <span className="font-medium">{p.title}</span>
                  {p.specialty && (
                    <span className="text-xs text-muted-foreground">
                      {p.specialty}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  <span
                    className={`inline-block px-2 py-0.5 rounded ${
                      p.scope === "tenant_shared"
                        ? "bg-blue-100 text-blue-800"
                        : "bg-slate-100 text-slate-700"
                    }`}
                  >
                    {p.scope === "tenant_shared" ? "shared" : "private"}
                  </span>
                  <span>used {p.use_count}×</span>
                  {!p.active && (
                    <span className="px-2 py-0.5 rounded bg-rose-100 text-rose-800">
                      inactive
                    </span>
                  )}
                </div>
              </summary>
              <div className="px-4 pb-4 pt-2 border-t">
                <pre className="text-xs whitespace-pre-wrap font-mono bg-muted/30 p-3 rounded">
                  {p.body}
                </pre>
                {p.placeholders && p.placeholders.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {p.placeholders.map((ph) => (
                      <code
                        key={ph}
                        className="text-xs bg-amber-50 text-amber-800 px-1.5 py-0.5 rounded"
                      >
                        {`{{${ph}}}`}
                      </code>
                    ))}
                  </div>
                )}
              </div>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}
