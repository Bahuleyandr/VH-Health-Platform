"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Armchair, CalendarDays, ClipboardList, Plus, RefreshCw, ShieldCheck, ToggleLeft, ToggleRight, XCircle } from "lucide-react";
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

type OncologySettings = {
  enabled: boolean;
  owner_source_policy_ref?: string | null;
  tumor_board_quorum_policy_ref?: string | null;
};

type TumorBoardCase = {
  id: number;
  patient_uid: string;
  patient_name?: string | null;
  cancer_site: string;
  diagnosis_id: number;
  staging_record_id?: number | null;
  t_category?: string | null;
  n_category?: string | null;
  m_category?: string | null;
  clinical_stage?: string | null;
  pathologic_stage?: string | null;
  question: string;
  priority: string;
  discussion_state: string;
  recommendation_count: number;
  created_at: string;
};

type ToxicityEvent = {
  id: number;
  patient_uid: string;
  patient_name?: string | null;
  diagnosis_id?: number | null;
  chemo_plan_id?: number | null;
  chemo_cycle_id?: number | null;
  chemo_administration_id?: number | null;
  toxicity_term: string;
  ctcae_grade: number;
  ctcae_source?: string | null;
  ctcae_source_version?: string | null;
  attribution?: string | null;
  action_taken?: string | null;
  signoff_status: string;
  created_at: string;
};

type SettingsResponse = { settings: OncologySettings };
type TumorBoardQueueResponse = { cases: TumorBoardCase[] };
type ToxicityEventsResponse = { toxicity_events: ToxicityEvent[] };
type TumorBoardCaseResponse = { board_case: TumorBoardCase };
type ToxicityEventResponse = { toxicity_event: ToxicityEvent };

type Tab = "board" | "chairs" | "tumor-board" | "toxicity";

const today = () => new Date().toISOString().slice(0, 10);

function timeLabel(value?: string | null) {
  if (!value) return "-";
  return new Date(value).toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function dateTimeLabel(value?: string | null) {
  if (!value) return "-";
  return new Date(value).toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
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
    case "signed":
    case "accepted":
    case "recommended":
      return "bg-emerald-500/15 text-emerald-300";
    case "draft":
    case "queued":
    case "proposed":
      return "bg-blue-500/15 text-blue-300";
    case "in_review":
    case "deferred":
    case "expedite":
    case "urgent":
      return "bg-amber-500/15 text-amber-300";
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

  const settings = useQuery({
    queryKey: ["oncology", "completion-settings"],
    queryFn: async () => {
      const data = await fetchAdminAPI<SettingsResponse>("/oncology/completion-settings");
      return data.settings;
    },
  });

  const tumorBoardQueue = useQuery({
    queryKey: ["oncology", "tumor-board-queue"],
    queryFn: async () => {
      const data = await fetchAdminAPI<TumorBoardQueueResponse>("/oncology/tumor-board/queue");
      return data.cases;
    },
    enabled: settings.data?.enabled === true,
  });

  const toxicityEvents = useQuery({
    queryKey: ["oncology", "toxicity-events"],
    queryFn: async () => {
      const data = await fetchAdminAPI<ToxicityEventsResponse>("/oncology/toxicity-events?limit=50");
      return data.toxicity_events;
    },
    enabled: settings.data?.enabled === true,
  });

  const toggleCompletion = useMutation({
    mutationFn: async (enabled: boolean) => fetchAdminAPI<SettingsResponse>("/oncology/completion-settings", {
      method: "PATCH",
      body: {
        enabled,
        owner_source_policy_ref: "tenant oncology owner-source policy",
        tumor_board_quorum_policy_ref: "tenant tumor-board quorum policy",
        acceptance_snapshot: {
          surface: "admin oncology completion",
          acknowledged_owner_sourced_staging_and_ctcae: true,
        },
      },
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["oncology"] }),
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
          ["tumor-board", "Tumor Board", ClipboardList],
          ["toxicity", "Toxicity", ShieldCheck],
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

      <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold">
            {settings.data?.enabled ? <ToggleRight className="h-4 w-4 text-emerald-400" /> : <ToggleLeft className="h-4 w-4 text-muted-foreground" />}
            Oncology completion suite {settings.data?.enabled ? "enabled" : "disabled"}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            TNM/AJCC and CTCAE clinical sign-off requires tenant-supplied source/version metadata.
          </p>
        </div>
        <button
          type="button"
          disabled={toggleCompletion.isPending || settings.isLoading}
          onClick={() => toggleCompletion.mutate(settings.data?.enabled !== true)}
          className="inline-flex items-center justify-center gap-2 rounded border border-border px-3 py-2 text-sm hover:bg-muted disabled:opacity-50"
          title={settings.data?.enabled ? "Disable completion suite" : "Enable completion suite"}
        >
          {settings.data?.enabled ? <ToggleLeft className="h-4 w-4" /> : <ToggleRight className="h-4 w-4" />}
          {settings.data?.enabled ? "Disable" : "Enable"}
        </button>
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
      {tab === "tumor-board" && (
        <TumorBoardTab
          cases={tumorBoardQueue.data ?? []}
          isLoading={tumorBoardQueue.isLoading}
          error={tumorBoardQueue.error}
          enabled={settings.data?.enabled === true}
        />
      )}
      {tab === "toxicity" && (
        <ToxicityTab
          toxicityEvents={toxicityEvents.data ?? []}
          isLoading={toxicityEvents.isLoading}
          error={toxicityEvents.error}
          enabled={settings.data?.enabled === true}
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

function TumorBoardTab({
  cases,
  isLoading,
  error,
  enabled,
}: {
  cases: TumorBoardCase[];
  isLoading: boolean;
  error: Error | null;
  enabled: boolean;
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    diagnosis_id: "",
    staging_record_id: "",
    question: "",
    priority: "routine",
  });
  const [recommendation, setRecommendation] = useState({
    case_id: "",
    recommendation_type: "systemic_therapy",
    recommendation_text: "",
    due_date: today(),
    chemo_plan_id: "",
  });

  const createCase = useMutation({
    mutationFn: async () => fetchAdminAPI<TumorBoardCaseResponse>("/oncology/tumor-board/cases", {
      method: "POST",
      body: {
        diagnosis_id: Number(form.diagnosis_id),
        staging_record_id: form.staging_record_id ? Number(form.staging_record_id) : undefined,
        question: form.question,
        priority: form.priority,
      },
    }),
    onSuccess: () => {
      setForm({ diagnosis_id: "", staging_record_id: "", question: "", priority: "routine" });
      qc.invalidateQueries({ queryKey: ["oncology", "tumor-board-queue"] });
    },
  });

  const createRecommendation = useMutation({
    mutationFn: async () => fetchAdminAPI<unknown>(`/oncology/tumor-board/cases/${recommendation.case_id}/recommendations`, {
      method: "POST",
      body: {
        recommendation_type: recommendation.recommendation_type,
        recommendation_text: recommendation.recommendation_text,
        due_date: recommendation.due_date,
        chemo_plan_id: recommendation.chemo_plan_id ? Number(recommendation.chemo_plan_id) : undefined,
      },
    }),
    onSuccess: () => {
      setRecommendation({ case_id: "", recommendation_type: "systemic_therapy", recommendation_text: "", due_date: today(), chemo_plan_id: "" });
      qc.invalidateQueries({ queryKey: ["oncology", "tumor-board-queue"] });
    },
  });

  if (!enabled) {
    return (
      <div className="rounded-lg border border-border p-8 text-center text-sm text-muted-foreground">
        Enable oncology completion to use the tumor-board queue.
      </div>
    );
  }

  return (
    <div className="grid gap-5 xl:grid-cols-[360px_1fr]">
      <div className="space-y-4">
        <div className="rounded-lg border border-border bg-card p-4 space-y-3">
          <h2 className="text-lg font-semibold">Queue Case</h2>
          <Field label="Diagnosis ID" value={form.diagnosis_id} type="number" onChange={(value) => setForm({ ...form, diagnosis_id: value })} />
          <Field label="Staging Record ID" value={form.staging_record_id} type="number" onChange={(value) => setForm({ ...form, staging_record_id: value })} />
          <div>
            <label className="mb-1 block text-xs font-medium uppercase text-muted-foreground">Priority</label>
            <select
              value={form.priority}
              onChange={(e) => setForm({ ...form, priority: e.target.value })}
              className="w-full rounded border border-border bg-background px-3 py-2 text-sm"
            >
              <option value="routine">routine</option>
              <option value="urgent">urgent</option>
              <option value="expedite">expedite</option>
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium uppercase text-muted-foreground">Question</label>
            <textarea
              value={form.question}
              onChange={(e) => setForm({ ...form, question: e.target.value })}
              className="min-h-24 w-full resize-none rounded border border-border bg-background px-3 py-2 text-sm"
            />
          </div>
          {createCase.error instanceof Error && (
            <div className="rounded border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-300">
              {createCase.error.message}
            </div>
          )}
          <button
            type="button"
            disabled={createCase.isPending || !form.diagnosis_id || !form.question.trim()}
            onClick={() => createCase.mutate()}
            className="inline-flex w-full items-center justify-center gap-2 rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            <Plus className="h-4 w-4" />
            {createCase.isPending ? "Queuing..." : "Queue Case"}
          </button>
        </div>

        <div className="rounded-lg border border-border bg-card p-4 space-y-3">
          <h2 className="text-lg font-semibold">Add Recommendation</h2>
          <Field label="Case ID" value={recommendation.case_id} type="number" onChange={(value) => setRecommendation({ ...recommendation, case_id: value })} />
          <div>
            <label className="mb-1 block text-xs font-medium uppercase text-muted-foreground">Type</label>
            <select
              value={recommendation.recommendation_type}
              onChange={(e) => setRecommendation({ ...recommendation, recommendation_type: e.target.value })}
              className="w-full rounded border border-border bg-background px-3 py-2 text-sm"
            >
              <option value="systemic_therapy">systemic therapy</option>
              <option value="radiation">radiation</option>
              <option value="surgery">surgery</option>
              <option value="diagnostics">diagnostics</option>
              <option value="palliative">palliative</option>
              <option value="surveillance">surveillance</option>
              <option value="trial">trial</option>
              <option value="supportive_care">supportive care</option>
              <option value="other">other</option>
            </select>
          </div>
          <Field label="Due Date" value={recommendation.due_date} type="date" onChange={(value) => setRecommendation({ ...recommendation, due_date: value })} />
          <Field label="Chemo Plan ID" value={recommendation.chemo_plan_id} type="number" onChange={(value) => setRecommendation({ ...recommendation, chemo_plan_id: value })} />
          <div>
            <label className="mb-1 block text-xs font-medium uppercase text-muted-foreground">Recommendation</label>
            <textarea
              value={recommendation.recommendation_text}
              onChange={(e) => setRecommendation({ ...recommendation, recommendation_text: e.target.value })}
              className="min-h-24 w-full resize-none rounded border border-border bg-background px-3 py-2 text-sm"
            />
          </div>
          {createRecommendation.error instanceof Error && (
            <div className="rounded border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-300">
              {createRecommendation.error.message}
            </div>
          )}
          <button
            type="button"
            disabled={createRecommendation.isPending || !recommendation.case_id || !recommendation.recommendation_text.trim() || !recommendation.due_date}
            onClick={() => createRecommendation.mutate()}
            className="inline-flex w-full items-center justify-center gap-2 rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            <Plus className="h-4 w-4" />
            {createRecommendation.isPending ? "Saving..." : "Add Recommendation"}
          </button>
        </div>
      </div>

      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Kpi label="Open cases" value={cases.length} />
          <Kpi label="Urgent" value={cases.filter((row) => row.priority !== "routine").length} tone="warning" />
          <Kpi label="With staging" value={cases.filter((row) => row.staging_record_id).length} />
          <Kpi label="Recommendations" value={cases.reduce((sum, row) => sum + (row.recommendation_count || 0), 0)} />
        </div>
        {isLoading && <div className="py-8 text-center text-sm text-muted-foreground">Loading...</div>}
        {error && (
          <div className="rounded border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-300">
            {error.message}
          </div>
        )}
        {!isLoading && !error && cases.length === 0 && (
          <div className="rounded-lg border border-border p-8 text-center text-sm text-muted-foreground">
            No tumor-board cases waiting.
          </div>
        )}
        {cases.length > 0 && (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-muted-foreground">
                <tr>
                  <th className="p-3 text-left">Case</th>
                  <th className="p-3 text-left">Patient</th>
                  <th className="p-3 text-left">Staging</th>
                  <th className="p-3 text-left">Priority</th>
                  <th className="p-3 text-left">State</th>
                  <th className="p-3 text-left">Question</th>
                </tr>
              </thead>
              <tbody>
                {cases.map((row) => (
                  <tr key={row.id} className="border-t border-border">
                    <td className="p-3">
                      <div className="font-medium">#{row.id} {row.cancer_site}</div>
                      <div className="text-xs text-muted-foreground">{dateTimeLabel(row.created_at)}</div>
                    </td>
                    <td className="p-3">
                      <div className="font-medium">{row.patient_name ?? "Patient"}</div>
                      <div className="font-mono text-xs text-muted-foreground">{row.patient_uid.slice(0, 8)}</div>
                    </td>
                    <td className="p-3">
                      <div>{[row.t_category, row.n_category, row.m_category].filter(Boolean).join(" ") || "-"}</div>
                      <div className="text-xs text-muted-foreground">{row.clinical_stage || row.pathologic_stage || "No stage label"}</div>
                    </td>
                    <td className="p-3"><span className={`rounded px-2 py-1 text-xs ${statusClass(row.priority)}`}>{row.priority}</span></td>
                    <td className="p-3"><span className={`rounded px-2 py-1 text-xs ${statusClass(row.discussion_state)}`}>{row.discussion_state.replace("_", " ")}</span></td>
                    <td className="p-3 max-w-md">{row.question}</td>
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

function ToxicityTab({
  toxicityEvents,
  isLoading,
  error,
  enabled,
}: {
  toxicityEvents: ToxicityEvent[];
  isLoading: boolean;
  error: Error | null;
  enabled: boolean;
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    patient_uid: "",
    diagnosis_id: "",
    toxicity_term: "",
    ctcae_grade: "2",
    ctcae_source: "",
    ctcae_source_version: "",
    attribution: "",
    action_taken: "monitor",
    chemo_cycle_id: "",
    chemo_administration_id: "",
    signoff: true,
  });

  const create = useMutation({
    mutationFn: async () => fetchAdminAPI<ToxicityEventResponse>("/oncology/toxicity-events", {
      method: "POST",
      body: {
        patient_uid: form.patient_uid,
        diagnosis_id: form.diagnosis_id ? Number(form.diagnosis_id) : undefined,
        toxicity_term: form.toxicity_term,
        ctcae_grade: Number(form.ctcae_grade),
        ctcae_source: form.ctcae_source,
        ctcae_source_version: form.ctcae_source_version,
        attribution: form.attribution || undefined,
        action_taken: form.action_taken,
        chemo_cycle_id: form.chemo_cycle_id ? Number(form.chemo_cycle_id) : undefined,
        chemo_administration_id: form.chemo_administration_id ? Number(form.chemo_administration_id) : undefined,
        signoff: form.signoff,
      },
    }),
    onSuccess: () => {
      setForm({
        patient_uid: "",
        diagnosis_id: "",
        toxicity_term: "",
        ctcae_grade: "2",
        ctcae_source: form.ctcae_source,
        ctcae_source_version: form.ctcae_source_version,
        attribution: "",
        action_taken: "monitor",
        chemo_cycle_id: "",
        chemo_administration_id: "",
        signoff: true,
      });
      qc.invalidateQueries({ queryKey: ["oncology", "toxicity-events"] });
    },
  });

  if (!enabled) {
    return (
      <div className="rounded-lg border border-border p-8 text-center text-sm text-muted-foreground">
        Enable oncology completion to capture CTCAE toxicity events.
      </div>
    );
  }

  return (
    <div className="grid gap-5 xl:grid-cols-[360px_1fr]">
      <div className="rounded-lg border border-border bg-card p-4 space-y-3">
        <h2 className="text-lg font-semibold">Capture Toxicity</h2>
        <Field label="Patient UID" value={form.patient_uid} onChange={(value) => setForm({ ...form, patient_uid: value })} />
        <Field label="Diagnosis ID" value={form.diagnosis_id} type="number" onChange={(value) => setForm({ ...form, diagnosis_id: value })} />
        <Field label="Term" value={form.toxicity_term} onChange={(value) => setForm({ ...form, toxicity_term: value })} />
        <div>
          <label className="mb-1 block text-xs font-medium uppercase text-muted-foreground">Grade</label>
          <select
            value={form.ctcae_grade}
            onChange={(e) => setForm({ ...form, ctcae_grade: e.target.value })}
            className="w-full rounded border border-border bg-background px-3 py-2 text-sm"
          >
            {[1, 2, 3, 4, 5].map((grade) => <option key={grade} value={grade}>grade {grade}</option>)}
          </select>
        </div>
        <Field label="CTCAE Source" value={form.ctcae_source} onChange={(value) => setForm({ ...form, ctcae_source: value })} />
        <Field label="CTCAE Version" value={form.ctcae_source_version} onChange={(value) => setForm({ ...form, ctcae_source_version: value })} />
        <Field label="Attribution" value={form.attribution} onChange={(value) => setForm({ ...form, attribution: value })} />
        <div>
          <label className="mb-1 block text-xs font-medium uppercase text-muted-foreground">Action</label>
          <select
            value={form.action_taken}
            onChange={(e) => setForm({ ...form, action_taken: e.target.value })}
            className="w-full rounded border border-border bg-background px-3 py-2 text-sm"
          >
            <option value="monitor">monitor</option>
            <option value="supportive_care">supportive care</option>
            <option value="dose_delay">dose delay</option>
            <option value="dose_reduce">dose reduce</option>
            <option value="withhold">withhold</option>
            <option value="stop">stop</option>
            <option value="admit">admit</option>
            <option value="other">other</option>
          </select>
        </div>
        <Field label="Chemo Cycle ID" value={form.chemo_cycle_id} type="number" onChange={(value) => setForm({ ...form, chemo_cycle_id: value })} />
        <Field label="Chemo Administration ID" value={form.chemo_administration_id} type="number" onChange={(value) => setForm({ ...form, chemo_administration_id: value })} />
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.signoff}
            onChange={(e) => setForm({ ...form, signoff: e.target.checked })}
          />
          Clinical sign-off
        </label>
        {create.error instanceof Error && (
          <div className="rounded border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-300">
            {create.error.message}
          </div>
        )}
        <button
          type="button"
          disabled={
            create.isPending ||
            !form.patient_uid.trim() ||
            !form.toxicity_term.trim() ||
            (form.signoff && (!form.ctcae_source.trim() || !form.ctcae_source_version.trim()))
          }
          onClick={() => create.mutate()}
          className="inline-flex w-full items-center justify-center gap-2 rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          <Plus className="h-4 w-4" />
          {create.isPending ? "Saving..." : "Capture Toxicity"}
        </button>
      </div>

      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Kpi label="Events" value={toxicityEvents.length} />
          <Kpi label="Signed" value={toxicityEvents.filter((row) => row.signoff_status === "signed").length} />
          <Kpi label="Grade 3+" value={toxicityEvents.filter((row) => Number(row.ctcae_grade) >= 3).length} tone="warning" />
          <Kpi label="Chemo linked" value={toxicityEvents.filter((row) => row.chemo_plan_id || row.chemo_cycle_id || row.chemo_administration_id).length} />
        </div>
        {isLoading && <div className="py-8 text-center text-sm text-muted-foreground">Loading...</div>}
        {error && (
          <div className="rounded border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-300">
            {error.message}
          </div>
        )}
        {!isLoading && !error && toxicityEvents.length === 0 && (
          <div className="rounded-lg border border-border p-8 text-center text-sm text-muted-foreground">
            No toxicity events captured.
          </div>
        )}
        {toxicityEvents.length > 0 && (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-muted-foreground">
                <tr>
                  <th className="p-3 text-left">Event</th>
                  <th className="p-3 text-left">Patient</th>
                  <th className="p-3 text-left">Grade</th>
                  <th className="p-3 text-left">Source</th>
                  <th className="p-3 text-left">Action</th>
                  <th className="p-3 text-left">Status</th>
                </tr>
              </thead>
              <tbody>
                {toxicityEvents.map((row) => (
                  <tr key={row.id} className="border-t border-border">
                    <td className="p-3">
                      <div className="font-medium">{row.toxicity_term}</div>
                      <div className="text-xs text-muted-foreground">{dateTimeLabel(row.created_at)}</div>
                    </td>
                    <td className="p-3">
                      <div className="font-medium">{row.patient_name ?? "Patient"}</div>
                      <div className="font-mono text-xs text-muted-foreground">{row.patient_uid.slice(0, 8)}</div>
                    </td>
                    <td className="p-3">grade {row.ctcae_grade}</td>
                    <td className="p-3">
                      <div>{row.ctcae_source || "-"}</div>
                      <div className="text-xs text-muted-foreground">{row.ctcae_source_version || "-"}</div>
                    </td>
                    <td className="p-3">{row.action_taken?.replace("_", " ") || "-"}</td>
                    <td className="p-3"><span className={`rounded px-2 py-1 text-xs ${statusClass(row.signoff_status)}`}>{row.signoff_status}</span></td>
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
