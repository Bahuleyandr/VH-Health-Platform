"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchAdminAPI } from "@/lib/api";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { EmptyState } from "@/components/EmptyState";

interface OrderSetSummary {
  id: number;
  code: string;
  title: string;
  specialty: string | null;
  condition_codes: string[] | null;
  description: string | null;
  active: boolean;
  item_count: number;
}

interface OrderSetItem {
  id: number;
  display_order: number;
  kind: string;
  payload: Record<string, unknown>;
  default_selected: boolean;
}

interface OrderSetDetail extends OrderSetSummary {
  items: OrderSetItem[];
}

const KIND_COLOURS: Record<string, string> = {
  med: "bg-emerald-100 text-emerald-800",
  lab: "bg-blue-100 text-blue-800",
  radiology: "bg-purple-100 text-purple-800",
  diet: "bg-amber-100 text-amber-800",
  nursing: "bg-cyan-100 text-cyan-800",
  vitals: "bg-slate-100 text-slate-700",
  consult: "bg-rose-100 text-rose-800",
  monitor: "bg-fuchsia-100 text-fuchsia-800",
};

export function OrderSetsTab() {
  const [rows, setRows] = useState<OrderSetSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [specialty, setSpecialty] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const [detail, setDetail] = useState<OrderSetDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const fetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: "200" });
      if (q) params.set("q", q);
      if (specialty) params.set("specialty", specialty);
      const r = await fetchAdminAPI<{ data: OrderSetSummary[] } | OrderSetSummary[]>(
        `/productivity/order-sets?${params.toString()}`,
      );
      const data = (r as { data?: OrderSetSummary[] }).data ?? (r as OrderSetSummary[]);
      setRows(Array.isArray(data) ? data : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load order sets");
    } finally {
      setLoading(false);
    }
  }, [q, specialty]);

  useEffect(() => {
    fetch();
  }, [fetch]);

  async function openDetail(id: number) {
    setOpen(id);
    setDetail(null);
    setDetailLoading(true);
    try {
      const r = await fetchAdminAPI<{ data: OrderSetDetail } | OrderSetDetail>(
        `/productivity/order-sets/${id}`,
      );
      const data = (r as { data?: OrderSetDetail }).data ?? (r as OrderSetDetail);
      setDetail(data);
    } finally {
      setDetailLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Bundle templates. Doctor picks a set, edits/applies the items, the
        chosen ones become orders. Each item carries its own JSONB payload
        based on kind (med / lab / radiology / etc.).
      </p>

      <div className="flex gap-3 items-end flex-wrap">
        <div>
          <label className="text-xs text-muted-foreground block mb-1">Search</label>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="pneumonia / sepsis / ..."
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
            placeholder="general_medicine / cardiology / ..."
            className="border border-border rounded-lg px-3 py-2 text-sm"
          />
        </div>
        <button
          onClick={fetch}
          className="px-3 py-2 rounded-md border text-sm hover:bg-muted"
        >
          Refresh
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {loading ? (
        <LoadingSpinner />
      ) : rows.length === 0 ? (
        <EmptyState title="No order sets" description="Try clearing the filter." />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {rows.map((s) => (
            <button
              key={s.id}
              onClick={() => openDetail(s.id)}
              className="text-left bg-white rounded-lg border shadow-sm p-4 hover:bg-muted/30"
            >
              <div className="flex items-start justify-between">
                <div>
                  <code className="text-xs bg-muted px-2 py-0.5 rounded font-mono">
                    {s.code}
                  </code>
                  <h3 className="font-semibold mt-1">{s.title}</h3>
                </div>
                <span className="text-xs text-muted-foreground">
                  {s.item_count} items
                </span>
              </div>
              {s.specialty && (
                <p className="text-xs text-muted-foreground mt-2">{s.specialty}</p>
              )}
              {s.description && (
                <p className="text-sm mt-2">{s.description}</p>
              )}
              {s.condition_codes && s.condition_codes.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {s.condition_codes.map((c) => (
                    <code
                      key={c}
                      className="text-xs bg-blue-50 text-blue-800 px-1.5 py-0.5 rounded font-mono"
                    >
                      {c}
                    </code>
                  ))}
                </div>
              )}
            </button>
          ))}
        </div>
      )}

      {open !== null && (
        <div className="fixed inset-0 bg-black/40 flex items-start justify-center z-50 p-4 overflow-y-auto">
          <div className="bg-white rounded-lg shadow-lg w-full max-w-3xl">
            <div className="p-4 border-b flex items-center justify-between">
              <h2 className="text-lg font-semibold">
                {detail?.title ?? "Loading…"}
              </h2>
              <button
                onClick={() => setOpen(null)}
                className="text-muted-foreground hover:text-foreground"
              >
                ✕
              </button>
            </div>
            <div className="p-4">
              {detailLoading || !detail ? (
                <LoadingSpinner />
              ) : (
                <ul className="space-y-2">
                  {detail.items.map((item) => (
                    <li
                      key={item.id}
                      className="flex items-start gap-3 p-3 bg-muted/30 rounded"
                    >
                      <span
                        className={`inline-block px-2 py-0.5 rounded text-xs font-medium shrink-0 ${
                          KIND_COLOURS[item.kind] ?? "bg-slate-100"
                        }`}
                      >
                        {item.kind}
                      </span>
                      <pre className="text-xs whitespace-pre-wrap font-mono flex-1">
                        {JSON.stringify(item.payload, null, 2)}
                      </pre>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
