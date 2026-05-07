"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchAdminAPI } from "@/lib/api";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { EmptyState } from "@/components/EmptyState";

interface ScheduleEntry {
  id: number;
  drug_name: string;
  schedule_class: "H" | "H1" | "X";
  batch_number: string;
  quantity_dispensed: number;
  patient_uid: string | null;
  patient_name: string | null;
  prescriber_name: string | null;
  prescriber_reg: string | null;
  witness_name: string | null;
  witness_reg: string | null;
  dispensed_at: string;
  notes: string | null;
}

const SCHEDULE_COLOURS: Record<string, string> = {
  H: "bg-amber-100 text-amber-800",
  H1: "bg-orange-100 text-orange-800",
  X: "bg-rose-200 text-rose-900",
};

function unwrap<T>(r: unknown): T {
  return ((r as { data?: T }).data ?? r) as T;
}

function fmtTs(s: string | null): string {
  if (!s) return "—";
  return new Date(s).toLocaleString();
}

export function ScheduleRegisterTab() {
  const qc = useQueryClient();
  const [scheduleClass, setScheduleClass] = useState<string>("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const { data: rows = [], error, isLoading } = useQuery<ScheduleEntry[]>({
    queryKey: ["pharmacy", "schedule-register", { scheduleClass, from, to }],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (scheduleClass) params.set("schedule_class", scheduleClass);
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      params.set("limit", "300");
      const r = await fetchAdminAPI<unknown>(
        `/pharmacy/inventory/v2/schedule-register?${params.toString()}`,
      );
      const data = unwrap<ScheduleEntry[]>(r);
      return Array.isArray(data) ? data : [];
    },
  });

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Schedule H / H1 / X dispensing register required by the Drugs and
        Cosmetics Rules. Schedule X dispenses require a witness signature.
      </p>

      <div className="flex gap-3 items-end flex-wrap">
        <div>
          <label className="text-xs text-muted-foreground block mb-1">Class</label>
          <select
            value={scheduleClass}
            onChange={(e) => setScheduleClass(e.target.value)}
            className="border border-border rounded-lg px-3 py-2 text-sm"
          >
            <option value="">All</option>
            <option value="H">H</option>
            <option value="H1">H1</option>
            <option value="X">X</option>
          </select>
        </div>
        <div>
          <label className="text-xs text-muted-foreground block mb-1">From</label>
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="border border-border rounded-lg px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="text-xs text-muted-foreground block mb-1">To</label>
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="border border-border rounded-lg px-3 py-2 text-sm"
          />
        </div>
        <button
          onClick={() => qc.invalidateQueries({ queryKey: ["pharmacy", "schedule-register"] })}
          className="px-3 py-2 rounded-md border text-sm hover:bg-muted"
        >
          Refresh
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {error instanceof Error ? error.message : "Failed to load register"}
        </div>
      )}

      {isLoading ? (
        <LoadingSpinner />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No entries"
          description="No dispenses recorded for these filters."
        />
      ) : (
        <div className="bg-white rounded-lg border shadow-sm overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="text-xs text-muted-foreground border-b">
              <tr className="text-left">
                <th className="px-3 py-2">When</th>
                <th className="px-3 py-2">Drug</th>
                <th className="px-3 py-2">Class</th>
                <th className="px-3 py-2">Batch</th>
                <th className="px-3 py-2">Qty</th>
                <th className="px-3 py-2">Patient</th>
                <th className="px-3 py-2">Prescriber</th>
                <th className="px-3 py-2">Witness</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  className={`border-b last:border-0 ${
                    r.schedule_class === "X" ? "bg-rose-50" : ""
                  }`}
                >
                  <td className="px-3 py-2 text-xs">{fmtTs(r.dispensed_at)}</td>
                  <td className="px-3 py-2 font-medium">{r.drug_name}</td>
                  <td className="px-3 py-2">
                    <span
                      className={`inline-block px-2 py-0.5 rounded text-xs font-bold ${
                        SCHEDULE_COLOURS[r.schedule_class] ?? ""
                      }`}
                    >
                      {r.schedule_class}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-xs font-mono">{r.batch_number}</td>
                  <td className="px-3 py-2 font-mono">{r.quantity_dispensed}</td>
                  <td className="px-3 py-2 text-xs">{r.patient_name ?? "—"}</td>
                  <td className="px-3 py-2 text-xs">
                    <div>{r.prescriber_name ?? "—"}</div>
                    <div className="text-muted-foreground">{r.prescriber_reg}</div>
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {r.schedule_class === "X" && !r.witness_name ? (
                      <span className="text-rose-700 font-medium">missing</span>
                    ) : (
                      <>
                        <div>{r.witness_name ?? "—"}</div>
                        <div className="text-muted-foreground">{r.witness_reg}</div>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
