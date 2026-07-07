"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Armchair, CalendarDays, Plus, RefreshCw, XCircle } from "lucide-react";
import { fetchAdminAPI } from "@/lib/api";

type Chair = {
  id: number;
  unit_name: string;
  chair_code: string;
  display_name: string;
  status: "active" | "maintenance" | "inactive";
  location_note?: string | null;
};

type Booking = {
  id: number;
  chair_id: number;
  unit_name: string;
  chair_code: string;
  display_name: string;
  cycle_id: number;
  patient_uid: string;
  patient_name?: string | null;
  cycle_number: number;
  protocol_code: string;
  protocol_name: string;
  start_at: string;
  end_at: string;
  status: string;
  warning_codes: string[];
  notes?: string | null;
};

type Board = {
  date: string;
  unit_name?: string | null;
  chairs: Chair[];
  bookings: Booking[];
  warnings: Booking[];
};

type BoardResponse = { board: Board };
type ChairsResponse = { chairs: Chair[] };
type ChairResponse = { chair: Chair };
type BookingResponse = {
  booking: Booking;
  warnings?: string[];
};

type Tab = "board" | "chairs";

const today = () => new Date().toISOString().slice(0, 10);

function timeLabel(value?: string | null) {
  if (!value) return "-";
  return new Date(value).toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function statusClass(status: string) {
  switch (status) {
    case "booked":
      return "bg-blue-500/15 text-blue-300";
    case "checked_in":
      return "bg-amber-500/15 text-amber-300";
    case "completed":
      return "bg-emerald-500/15 text-emerald-300";
    case "cancelled":
      return "bg-slate-500/15 text-slate-300";
    case "maintenance":
      return "bg-amber-500/15 text-amber-300";
    case "inactive":
      return "bg-slate-500/15 text-slate-300";
    default:
      return "bg-emerald-500/15 text-emerald-300";
  }
}

export default function OncologyPage() {
  const [tab, setTab] = useState<Tab>("board");
  const [date, setDate] = useState(today());
  const qc = useQueryClient();

  const board = useQuery({
    queryKey: ["oncology", "infusion-board", date],
    queryFn: async () => {
      const data = await fetchAdminAPI<BoardResponse>(`/oncology/infusion-board?date=${encodeURIComponent(date)}`);
      return data.board;
    },
    refetchInterval: 30_000,
  });

  const chairs = useQuery({
    queryKey: ["oncology", "infusion-chairs"],
    queryFn: async () => {
      const data = await fetchAdminAPI<ChairsResponse>("/oncology/infusion-chairs?include_inactive=true");
      return data.chairs;
    },
  });

  const activeChairs = useMemo(
    () => (chairs.data ?? []).filter((chair) => chair.status === "active"),
    [chairs.data],
  );

  const refreshAll = () => {
    qc.invalidateQueries({ queryKey: ["oncology"] });
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-3">
          <Armchair className="h-7 w-7 text-primary" />
          <h1 className="text-3xl font-bold text-foreground">Oncology</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="rounded border border-border bg-background px-3 py-2 text-sm"
            aria-label="Board date"
          />
          <button
            type="button"
            onClick={refreshAll}
            className="inline-flex items-center gap-2 rounded border border-border px-3 py-2 text-sm hover:bg-muted"
            title="Refresh"
          >
            <RefreshCw className="h-4 w-4" />
            Refresh
          </button>
        </div>
      </div>

      <div className="flex gap-2 border-b border-border">
        {([
          ["board", "Infusion Board", CalendarDays],
          ["chairs", "Chairs", Armchair],
        ] as const).map(([key, label, Icon]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`inline-flex items-center gap-2 border-b-2 px-4 py-2 text-sm font-medium ${
              tab === key
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            <Icon className="h-4 w-4" />
            {label}
          </button>
        ))}
      </div>

      {tab === "board" && (
        <BoardTab
          board={board.data}
          chairs={activeChairs}
          isLoading={board.isLoading || chairs.isLoading}
          error={board.error}
          date={date}
        />
      )}
      {tab === "chairs" && (
        <ChairsTab
          chairs={chairs.data ?? []}
          isLoading={chairs.isLoading}
          error={chairs.error}
        />
      )}
    </div>
  );
}

function BoardTab({
  board,
  chairs,
  isLoading,
  error,
  date,
}: {
  board?: Board;
  chairs: Chair[];
  isLoading: boolean;
  error: Error | null;
  date: string;
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    cycle_id: "",
    chair_id: "",
    start_at: `${date}T09:00`,
    end_at: `${date}T11:00`,
    notes: "",
  });

  const create = useMutation({
    mutationFn: async () => fetchAdminAPI<BookingResponse>("/oncology/chair-bookings", {
      method: "POST",
      body: {
        cycle_id: Number(form.cycle_id),
        chair_id: Number(form.chair_id),
        start_at: form.start_at,
        end_at: form.end_at,
        notes: form.notes || undefined,
      },
    }),
    onSuccess: () => {
      setForm({ cycle_id: "", chair_id: form.chair_id, start_at: form.start_at, end_at: form.end_at, notes: "" });
      qc.invalidateQueries({ queryKey: ["oncology"] });
    },
  });

  const cancel = useMutation({
    mutationFn: async (id: number) => fetchAdminAPI<unknown>(`/oncology/chair-bookings/${id}/cancel`, {
      method: "POST",
      body: { reason: "Cancelled from admin infusion board" },
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["oncology"] }),
  });

  const bookings = board?.bookings ?? [];
  const warningCount = board?.warnings?.length ?? 0;

  return (
    <div className="grid gap-5 xl:grid-cols-[360px_1fr]">
      <div className="rounded-lg border border-border bg-card p-4 space-y-3">
        <h2 className="text-lg font-semibold">Book Slot</h2>
        <Field
          label="Cycle ID"
          value={form.cycle_id}
          type="number"
          onChange={(value) => setForm({ ...form, cycle_id: value })}
        />
        <div>
          <label className="mb-1 block text-xs font-medium uppercase text-muted-foreground">Chair</label>
          <select
            value={form.chair_id}
            onChange={(e) => setForm({ ...form, chair_id: e.target.value })}
            className="w-full rounded border border-border bg-background px-3 py-2 text-sm"
          >
            <option value="">Select chair</option>
            {chairs.map((chair) => (
              <option key={chair.id} value={chair.id}>
                {chair.display_name}
              </option>
            ))}
          </select>
        </div>
        <Field
          label="Start"
          value={form.start_at}
          type="datetime-local"
          onChange={(value) => setForm({ ...form, start_at: value })}
        />
        <Field
          label="End"
          value={form.end_at}
          type="datetime-local"
          onChange={(value) => setForm({ ...form, end_at: value })}
        />
        <div>
          <label className="mb-1 block text-xs font-medium uppercase text-muted-foreground">Notes</label>
          <textarea
            value={form.notes}
            onChange={(e) => setForm({ ...form, notes: e.target.value })}
            className="min-h-20 w-full resize-none rounded border border-border bg-background px-3 py-2 text-sm"
          />
        </div>
        {create.error instanceof Error && (
          <div className="rounded border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-300">
            {create.error.message}
          </div>
        )}
        <button
          type="button"
          disabled={create.isPending || !form.cycle_id || !form.chair_id || !form.start_at || !form.end_at}
          onClick={() => create.mutate()}
          className="inline-flex w-full items-center justify-center gap-2 rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          <Plus className="h-4 w-4" />
          {create.isPending ? "Booking..." : "Book Slot"}
        </button>
      </div>

      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Kpi label="Active chairs" value={chairs.length} />
          <Kpi label="Bookings" value={bookings.length} />
          <Kpi label="Warnings" value={warningCount} tone={warningCount > 0 ? "warning" : undefined} />
          <Kpi label="Board date" value={board?.date ?? date} compact />
        </div>

        {isLoading && <div className="py-8 text-center text-sm text-muted-foreground">Loading...</div>}
        {error && (
          <div className="rounded border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-300">
            {error.message}
          </div>
        )}
        {!isLoading && !error && bookings.length === 0 && (
          <div className="rounded-lg border border-border p-8 text-center text-sm text-muted-foreground">
            No chair bookings.
          </div>
        )}

        {bookings.length > 0 && (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-muted-foreground">
                <tr>
                  <th className="p-3 text-left">Slot</th>
                  <th className="p-3 text-left">Chair</th>
                  <th className="p-3 text-left">Patient</th>
                  <th className="p-3 text-left">Cycle</th>
                  <th className="p-3 text-left">Status</th>
                  <th className="p-3 text-left">Warnings</th>
                  <th className="p-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {bookings.map((booking) => (
                  <tr key={booking.id} className="border-t border-border">
                    <td className="p-3">
                      <div className="font-medium">{timeLabel(booking.start_at)} - {timeLabel(booking.end_at)}</div>
                      <div className="text-xs text-muted-foreground">#{booking.id}</div>
                    </td>
                    <td className="p-3">
                      <div className="font-medium">{booking.display_name}</div>
                      <div className="text-xs text-muted-foreground">{booking.unit_name}</div>
                    </td>
                    <td className="p-3">
                      <div className="font-medium">{booking.patient_name ?? "Patient"}</div>
                      <div className="font-mono text-xs text-muted-foreground">{booking.patient_uid.slice(0, 8)}</div>
                    </td>
                    <td className="p-3">
                      <div className="font-medium">{booking.protocol_code} C{booking.cycle_number}</div>
                      <div className="text-xs text-muted-foreground">cycle #{booking.cycle_id}</div>
                    </td>
                    <td className="p-3">
                      <span className={`rounded px-2 py-1 text-xs ${statusClass(booking.status)}`}>
                        {booking.status.replace("_", " ")}
                      </span>
                    </td>
                    <td className="p-3">
                      {booking.warning_codes?.length ? (
                        <span className="rounded bg-amber-500/15 px-2 py-1 text-xs text-amber-300">
                          {booking.warning_codes.join(", ")}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </td>
                    <td className="p-3 text-right">
                      <button
                        type="button"
                        disabled={cancel.isPending || booking.status === "cancelled"}
                        onClick={() => cancel.mutate(booking.id)}
                        className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"
                        title="Cancel booking"
                      >
                        <XCircle className="h-3.5 w-3.5" />
                        Cancel
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function ChairsTab({
  chairs,
  isLoading,
  error,
}: {
  chairs: Chair[];
  isLoading: boolean;
  error: Error | null;
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    unit_name: "Day Care",
    chair_code: "",
    display_name: "",
    location_note: "",
  });

  const create = useMutation({
    mutationFn: async () => fetchAdminAPI<ChairResponse>("/oncology/infusion-chairs", {
      method: "POST",
      body: {
        unit_name: form.unit_name,
        chair_code: form.chair_code,
        display_name: form.display_name || form.chair_code,
        location_note: form.location_note || undefined,
      },
    }),
    onSuccess: () => {
      setForm({ unit_name: "Day Care", chair_code: "", display_name: "", location_note: "" });
      qc.invalidateQueries({ queryKey: ["oncology"] });
    },
  });

  const setStatus = useMutation({
    mutationFn: async ({ id, status }: { id: number; status: Chair["status"] }) =>
      fetchAdminAPI<ChairResponse>(`/oncology/infusion-chairs/${id}/status`, {
        method: "PATCH",
        body: { status },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["oncology"] }),
  });

  return (
    <div className="grid gap-5 xl:grid-cols-[360px_1fr]">
      <div className="rounded-lg border border-border bg-card p-4 space-y-3">
        <h2 className="text-lg font-semibold">Add Chair</h2>
        <Field label="Unit" value={form.unit_name} onChange={(value) => setForm({ ...form, unit_name: value })} />
        <Field label="Code" value={form.chair_code} onChange={(value) => setForm({ ...form, chair_code: value })} />
        <Field label="Name" value={form.display_name} onChange={(value) => setForm({ ...form, display_name: value })} />
        <Field label="Location" value={form.location_note} onChange={(value) => setForm({ ...form, location_note: value })} />
        {create.error instanceof Error && (
          <div className="rounded border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-300">
            {create.error.message}
          </div>
        )}
        <button
          type="button"
          disabled={create.isPending || !form.chair_code.trim()}
          onClick={() => create.mutate()}
          className="inline-flex w-full items-center justify-center gap-2 rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          <Plus className="h-4 w-4" />
          {create.isPending ? "Saving..." : "Add Chair"}
        </button>
      </div>

      <div className="space-y-4">
        {isLoading && <div className="py-8 text-center text-sm text-muted-foreground">Loading...</div>}
        {error && (
          <div className="rounded border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-300">
            {error.message}
          </div>
        )}
        {!isLoading && !error && chairs.length === 0 && (
          <div className="rounded-lg border border-border p-8 text-center text-sm text-muted-foreground">
            No chairs configured.
          </div>
        )}
        {chairs.length > 0 && (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-muted-foreground">
                <tr>
                  <th className="p-3 text-left">Chair</th>
                  <th className="p-3 text-left">Unit</th>
                  <th className="p-3 text-left">Location</th>
                  <th className="p-3 text-left">Status</th>
                </tr>
              </thead>
              <tbody>
                {chairs.map((chair) => (
                  <tr key={chair.id} className="border-t border-border">
                    <td className="p-3">
                      <div className="font-medium">{chair.display_name}</div>
                      <div className="font-mono text-xs text-muted-foreground">{chair.chair_code}</div>
                    </td>
                    <td className="p-3">{chair.unit_name}</td>
                    <td className="p-3">{chair.location_note || "-"}</td>
                    <td className="p-3">
                      <select
                        value={chair.status}
                        onChange={(e) => setStatus.mutate({ id: chair.id, status: e.target.value as Chair["status"] })}
                        className={`rounded border border-border bg-background px-2 py-1 text-xs ${statusClass(chair.status)}`}
                      >
                        <option value="active">active</option>
                        <option value="maintenance">maintenance</option>
                        <option value="inactive">inactive</option>
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
}) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium uppercase text-muted-foreground">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded border border-border bg-background px-3 py-2 text-sm"
      />
    </div>
  );
}

function Kpi({
  label,
  value,
  tone,
  compact = false,
}: {
  label: string;
  value: number | string;
  tone?: "warning";
  compact?: boolean;
}) {
  const cls = tone === "warning" ? "border-amber-500/30 bg-amber-500/5" : "border-border bg-card";
  return (
    <div className={`rounded-lg border p-4 ${cls}`}>
      <div className="text-xs font-medium uppercase text-muted-foreground">{label}</div>
      <div className={`${compact ? "text-base" : "text-3xl"} mt-1 font-semibold`}>{value}</div>
    </div>
  );
}
