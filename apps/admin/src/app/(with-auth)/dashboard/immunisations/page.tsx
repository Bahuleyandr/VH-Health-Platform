// src/app/(with-auth)/dashboard/immunisations/page.tsx
//
// Newborn immunisation admin — three tabs:
//   1. Catalogue (read-only browser of vaccine_catalogue)
//   2. Per-newborn schedule (lookup by newborn id, see / record doses)
//   3. Due / overdue across the tenant (cron-shaped reminder list)

"use client";

import { useState } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { fetchAdminAPI } from "@/lib/api";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { EmptyState } from "@/components/EmptyState";

type Tab = "catalogue" | "newborn" | "due";

interface CatalogueEntry {
  id: number;
  code: string;
  display_name: string;
  dose_number: number | null;
  recommended_age_days: number;
  window_days: number;
  description: string | null;
  active: boolean;
}

interface NewbornDose {
  id: number;
  due_date: string;
  status: "scheduled" | "given" | "missed" | "refused" | "contraindicated";
  given_at: string | null;
  given_by_name: string | null;
  batch_number: string | null;
  manufacturer: string | null;
  site_of_injection: string | null;
  adverse_event: string | null;
  notes: string | null;
  code: string;
  display_name: string;
  dose_number: number | null;
  recommended_age_days: number;
  window_days: number;
}

interface DueRow {
  id: number;
  newborn_id: number;
  due_date: string;
  status: string;
  code: string;
  display_name: string;
  dose_number: number | null;
  delivery_id: number | null;
  newborn_patient_uid: string | null;
  days_overdue: number;
}

const STATUS_COLOURS: Record<string, string> = {
  scheduled: "bg-slate-100 text-slate-700",
  given: "bg-emerald-100 text-emerald-800",
  missed: "bg-rose-100 text-rose-800",
  refused: "bg-amber-100 text-amber-800",
  contraindicated: "bg-purple-100 text-purple-800",
};

function unwrap<T>(r: unknown): T {
  return ((r as { data?: T }).data ?? r) as T;
}

function ageWeeks(days: number): string {
  if (days < 14) return `${days}d`;
  return `${(days / 7).toFixed(0)}w`;
}

function fmtDate(s: string | null): string {
  if (!s) return "—";
  return new Date(s).toLocaleDateString();
}

export default function ImmunisationsPage() {
  const [tab, setTab] = useState<Tab>("catalogue");
  return (
    <div className="p-6">
      <h1 className="text-3xl font-bold text-foreground mb-1">
        Newborn Immunisations
      </h1>
      <p className="text-sm text-muted-foreground mb-6">
        Indian NIS + IAP schedule. Catalogue, per-newborn schedule, and
        due/overdue reminder list.
      </p>
      <div className="flex gap-1 bg-muted rounded-lg p-1 mb-6 w-fit">
        {(
          [
            { key: "catalogue", label: "💉 Catalogue" },
            { key: "newborn", label: "👶 Per-newborn" },
            { key: "due", label: "⏰ Due / overdue" },
          ] as { key: Tab; label: string }[]
        ).map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
              tab === key
                ? "bg-white text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "catalogue" && <CatalogueTab />}
      {tab === "newborn" && <NewbornTab />}
      {tab === "due" && <DueTab />}
    </div>
  );
}

function CatalogueTab() {
  const { data: rows = [], isLoading, error } = useQuery<CatalogueEntry[]>({
    queryKey: ["immunisations", "catalogue"],
    queryFn: async () => {
      const r = await fetchAdminAPI<unknown>(
        "/maternity/immunisations/catalogue",
      );
      const data = unwrap<CatalogueEntry[]>(r);
      return Array.isArray(data) ? data : [];
    },
    staleTime: 5 * 60 * 1000,
  });

  if (isLoading) return <LoadingSpinner />;
  if (error)
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
        {(error as Error).message}
      </div>
    );

  return (
    <div className="bg-white rounded-lg border shadow-sm overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead className="text-xs text-muted-foreground border-b">
          <tr className="text-left">
            <th className="px-3 py-2">Code</th>
            <th className="px-3 py-2">Vaccine</th>
            <th className="px-3 py-2">Dose</th>
            <th className="px-3 py-2">Recommended age</th>
            <th className="px-3 py-2">Window</th>
            <th className="px-3 py-2">Notes</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-b last:border-0 hover:bg-muted/40">
              <td className="px-3 py-2 font-mono text-xs">{r.code}</td>
              <td className="px-3 py-2">{r.display_name}</td>
              <td className="px-3 py-2 text-xs">
                {r.dose_number != null ? `#${r.dose_number}` : "—"}
              </td>
              <td className="px-3 py-2 text-xs">
                {ageWeeks(r.recommended_age_days)}
                <span className="text-muted-foreground"> ({r.recommended_age_days}d)</span>
              </td>
              <td className="px-3 py-2 text-xs">{r.window_days}d</td>
              <td className="px-3 py-2 text-xs text-muted-foreground">
                {r.description ?? ""}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function NewbornTab() {
  const qc = useQueryClient();
  const [newbornIdInput, setNewbornIdInput] = useState("");
  const [submittedId, setSubmittedId] = useState<number | null>(null);
  const [recording, setRecording] = useState<NewbornDose | null>(null);

  const { data: doses = [], isLoading, error } = useQuery<NewbornDose[]>({
    queryKey: ["immunisations", "newborn", submittedId],
    queryFn: async () => {
      if (!submittedId) return [];
      const r = await fetchAdminAPI<unknown>(
        `/maternity/newborns/${submittedId}/immunisations`,
      );
      const data = unwrap<NewbornDose[]>(r);
      return Array.isArray(data) ? data : [];
    },
    enabled: !!submittedId,
  });

  const seedMut = useMutation({
    mutationFn: async (id: number) =>
      fetchAdminAPI(`/maternity/newborns/${id}/immunisations/seed`, {
        method: "POST",
      }),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["immunisations", "newborn", submittedId] }),
  });

  const errMsg = (error ?? seedMut.error)?.toString();

  return (
    <div className="space-y-4">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const n = Number(newbornIdInput);
          if (!Number.isFinite(n)) return;
          setSubmittedId(n);
        }}
        className="flex gap-3 items-end flex-wrap"
      >
        <div className="flex-1 min-w-[200px]">
          <label className="text-xs text-muted-foreground block mb-1">
            Newborn ID
          </label>
          <input
            value={newbornIdInput}
            onChange={(e) => setNewbornIdInput(e.target.value)}
            placeholder="e.g. 12"
            className="w-full border border-border rounded-lg px-3 py-2 text-sm font-mono"
          />
        </div>
        <button
          type="submit"
          className="px-3 py-2 rounded-md bg-foreground text-background text-sm"
        >
          Fetch schedule
        </button>
        {submittedId != null && (
          <button
            type="button"
            disabled={seedMut.isPending}
            onClick={() => seedMut.mutate(submittedId)}
            className="px-3 py-2 rounded-md border text-sm hover:bg-muted disabled:opacity-40"
          >
            {seedMut.isPending ? "Seeding…" : "Seed schedule"}
          </button>
        )}
      </form>

      {errMsg && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {errMsg}
        </div>
      )}

      {submittedId == null ? (
        <EmptyState
          title="Enter a newborn ID"
          description="Look up the immunisation schedule for a specific newborn."
        />
      ) : isLoading ? (
        <LoadingSpinner />
      ) : doses.length === 0 ? (
        <EmptyState
          title="No schedule yet"
          description="Click 'Seed schedule' to materialise the full Indian NIS + IAP schedule for this newborn."
        />
      ) : (
        <div className="bg-white rounded-lg border shadow-sm overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="text-xs text-muted-foreground border-b">
              <tr className="text-left">
                <th className="px-3 py-2">Vaccine</th>
                <th className="px-3 py-2">Dose</th>
                <th className="px-3 py-2">Due</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Given</th>
                <th className="px-3 py-2">Batch</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {doses.map((d) => (
                <tr key={d.id} className="border-b last:border-0 hover:bg-muted/40">
                  <td className="px-3 py-2">
                    <div>{d.display_name}</div>
                    <div className="text-xs text-muted-foreground font-mono">
                      {d.code}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {d.dose_number != null ? `#${d.dose_number}` : "—"}
                  </td>
                  <td className="px-3 py-2 text-xs">{fmtDate(d.due_date)}</td>
                  <td className="px-3 py-2">
                    <span
                      className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                        STATUS_COLOURS[d.status] ?? ""
                      }`}
                    >
                      {d.status}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {d.given_at ? (
                      <>
                        <div>{fmtDate(d.given_at)}</div>
                        <div className="text-muted-foreground">
                          {d.given_by_name ?? ""}
                        </div>
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs font-mono">
                    {d.batch_number ?? "—"}
                  </td>
                  <td className="px-3 py-2">
                    {d.status === "scheduled" && (
                      <button
                        onClick={() => setRecording(d)}
                        className="px-2 py-1 rounded border text-xs hover:bg-muted"
                      >
                        Record dose
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {recording && (
        <RecordDoseModal
          dose={recording}
          onClose={() => setRecording(null)}
          onSaved={() => {
            setRecording(null);
            qc.invalidateQueries({ queryKey: ["immunisations", "newborn", submittedId] });
            qc.invalidateQueries({ queryKey: ["immunisations", "due"] });
          }}
        />
      )}
    </div>
  );
}

function RecordDoseModal({
  dose, onClose, onSaved,
}: {
  dose: NewbornDose;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({
    status: "given" as NewbornDose["status"],
    given_by_name: "",
    batch_number: "",
    manufacturer: "",
    site_of_injection: "left_thigh",
    adverse_event: "",
    notes: "",
  });

  const recordMut = useMutation({
    mutationFn: async () =>
      fetchAdminAPI(`/maternity/immunisations/${dose.id}/record`, {
        method: "PATCH",
        body: {
          status: form.status,
          given_by_name: form.status === "given" ? form.given_by_name : undefined,
          batch_number: form.batch_number || undefined,
          manufacturer: form.manufacturer || undefined,
          site_of_injection: form.status === "given" ? form.site_of_injection : undefined,
          adverse_event: form.adverse_event || undefined,
          notes: form.notes || undefined,
        },
      }),
    onSuccess: onSaved,
  });

  const errMsg =
    recordMut.error instanceof Error ? recordMut.error.message : null;

  return (
    <div className="fixed inset-0 bg-black/40 flex items-start justify-center z-50 p-4 overflow-y-auto">
      <div className="bg-white rounded-lg shadow-lg w-full max-w-lg">
        <div className="p-4 border-b flex items-center justify-between">
          <h2 className="text-lg font-semibold">
            Record dose · {dose.display_name}
          </h2>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground"
          >
            ✕
          </button>
        </div>
        <div className="p-4 space-y-3">
          <div>
            <label className="text-xs text-muted-foreground block mb-1">
              Outcome
            </label>
            <select
              value={form.status}
              onChange={(e) =>
                setForm({ ...form, status: e.target.value as NewbornDose["status"] })
              }
              className="w-full border border-border rounded-lg px-3 py-2 text-sm"
            >
              <option value="given">Given</option>
              <option value="missed">Missed</option>
              <option value="refused">Refused (parent declined)</option>
              <option value="contraindicated">Contraindicated</option>
            </select>
          </div>
          {form.status === "given" && (
            <>
              <div>
                <label className="text-xs text-muted-foreground block mb-1">
                  Given by (name) *
                </label>
                <input
                  value={form.given_by_name}
                  onChange={(e) =>
                    setForm({ ...form, given_by_name: e.target.value })
                  }
                  placeholder="Nurse / Doctor name"
                  className="w-full border border-border rounded-lg px-3 py-2 text-sm"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-muted-foreground block mb-1">
                    Batch #
                  </label>
                  <input
                    value={form.batch_number}
                    onChange={(e) =>
                      setForm({ ...form, batch_number: e.target.value })
                    }
                    className="w-full border border-border rounded-lg px-3 py-2 text-sm font-mono"
                  />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground block mb-1">
                    Manufacturer
                  </label>
                  <input
                    value={form.manufacturer}
                    onChange={(e) =>
                      setForm({ ...form, manufacturer: e.target.value })
                    }
                    className="w-full border border-border rounded-lg px-3 py-2 text-sm"
                  />
                </div>
              </div>
              <div>
                <label className="text-xs text-muted-foreground block mb-1">
                  Site
                </label>
                <select
                  value={form.site_of_injection}
                  onChange={(e) =>
                    setForm({ ...form, site_of_injection: e.target.value })
                  }
                  className="w-full border border-border rounded-lg px-3 py-2 text-sm"
                >
                  <option value="left_thigh">Left thigh</option>
                  <option value="right_thigh">Right thigh</option>
                  <option value="left_deltoid">Left deltoid</option>
                  <option value="right_deltoid">Right deltoid</option>
                  <option value="oral">Oral</option>
                  <option value="intradermal">Intradermal</option>
                </select>
              </div>
            </>
          )}
          <div>
            <label className="text-xs text-muted-foreground block mb-1">
              Adverse event (optional)
            </label>
            <input
              value={form.adverse_event}
              onChange={(e) =>
                setForm({ ...form, adverse_event: e.target.value })
              }
              placeholder="Fever / fussiness / local reaction"
              className="w-full border border-border rounded-lg px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground block mb-1">
              Notes
            </label>
            <textarea
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              rows={2}
              className="w-full border border-border rounded-lg px-3 py-2 text-sm"
            />
          </div>
          {errMsg && (
            <div className="text-xs text-destructive">{errMsg}</div>
          )}
        </div>
        <div className="p-4 border-t flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-3 py-2 rounded-md border text-sm hover:bg-muted"
          >
            Cancel
          </button>
          <button
            onClick={() => recordMut.mutate()}
            disabled={
              recordMut.isPending ||
              (form.status === "given" && !form.given_by_name)
            }
            className="px-3 py-2 rounded-md bg-emerald-600 text-white text-sm disabled:opacity-40"
          >
            {recordMut.isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

function DueTab() {
  const todayIso = new Date().toISOString().split("T")[0]!;
  const sevenAgo = new Date(Date.now() - 7 * 86400 * 1000)
    .toISOString()
    .split("T")[0]!;
  const [from, setFrom] = useState(sevenAgo);
  const [to, setTo] = useState(
    new Date(Date.now() + 14 * 86400 * 1000).toISOString().split("T")[0]!,
  );

  const { data: rows = [], isLoading, error } = useQuery<DueRow[]>({
    queryKey: ["immunisations", "due", { from, to }],
    queryFn: async () => {
      const params = new URLSearchParams({ from, to, limit: "200" });
      const r = await fetchAdminAPI<unknown>(
        `/maternity/immunisations/due?${params.toString()}`,
      );
      const data = unwrap<DueRow[]>(r);
      return Array.isArray(data) ? data : [];
    },
  });

  const errMsg = error instanceof Error ? error.message : null;
  const overdue = rows.filter((r) => r.days_overdue > 0).length;
  const dueToday = rows.filter((r) => r.due_date === todayIso).length;
  const upcoming = rows.length - overdue - dueToday;

  return (
    <div className="space-y-4">
      <div className="flex gap-3 items-end flex-wrap">
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
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div className="bg-white rounded-lg border shadow-sm p-3">
          <p className="text-xs text-muted-foreground">Overdue</p>
          <p className="text-xl font-semibold mt-1 text-rose-700">{overdue}</p>
        </div>
        <div className="bg-white rounded-lg border shadow-sm p-3">
          <p className="text-xs text-muted-foreground">Due today</p>
          <p className="text-xl font-semibold mt-1 text-amber-700">{dueToday}</p>
        </div>
        <div className="bg-white rounded-lg border shadow-sm p-3">
          <p className="text-xs text-muted-foreground">Upcoming</p>
          <p className="text-xl font-semibold mt-1 text-slate-700">{upcoming}</p>
        </div>
      </div>

      {errMsg && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {errMsg}
        </div>
      )}

      {isLoading ? (
        <LoadingSpinner />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No doses due"
          description="No immunisations scheduled in this window."
        />
      ) : (
        <div className="bg-white rounded-lg border shadow-sm overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="text-xs text-muted-foreground border-b">
              <tr className="text-left">
                <th className="px-3 py-2">Newborn</th>
                <th className="px-3 py-2">Vaccine</th>
                <th className="px-3 py-2">Dose</th>
                <th className="px-3 py-2">Due</th>
                <th className="px-3 py-2">Days overdue</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  className={`border-b last:border-0 ${
                    r.days_overdue > 0 ? "bg-rose-50" : "hover:bg-muted/30"
                  }`}
                >
                  <td className="px-3 py-2 text-xs font-mono">
                    #{r.newborn_id}
                    {r.newborn_patient_uid && (
                      <div className="text-muted-foreground">
                        {r.newborn_patient_uid.slice(0, 8)}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2">{r.display_name}</td>
                  <td className="px-3 py-2 text-xs">
                    {r.dose_number != null ? `#${r.dose_number}` : "—"}
                  </td>
                  <td className="px-3 py-2 text-xs">{fmtDate(r.due_date)}</td>
                  <td
                    className={`px-3 py-2 font-mono text-xs ${
                      r.days_overdue > 0 ? "text-rose-700 font-semibold" : ""
                    }`}
                  >
                    {r.days_overdue > 0 ? `+${r.days_overdue}` : "—"}
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
