"use client";

import { Skeleton } from "@/components/ui/skeleton";
import {
  createMisReportSchedule,
  deleteMisReportSchedule,
  listMisReportSchedules,
  runMisReportScheduleNow,
  updateMisReportSchedule,
  type MisReportCadence,
  type MisReportCatalogEntry,
  type MisReportSchedule,
  type MisReportScheduleWrite,
} from "@/lib/api/misReportSchedules";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Mail, Pencil, Play, Plus, Trash2, X } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "react-hot-toast";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const QUERY_KEY = ["mis-report-schedules"];

interface FormState {
  name: string;
  reportKeys: string[];
  cadence: MisReportCadence;
  sendHour: number;
  sendWeekday: number;
  sendDayOfMonth: number;
  recipientsText: string;
  enabled: boolean;
}

const EMPTY_FORM: FormState = {
  name: "",
  reportKeys: [],
  cadence: "daily",
  sendHour: 7,
  sendWeekday: 1,
  sendDayOfMonth: 1,
  recipientsText: "",
  enabled: true,
};

function toForm(schedule: MisReportSchedule): FormState {
  return {
    name: schedule.name,
    reportKeys: schedule.reportKeys,
    cadence: schedule.cadence,
    sendHour: schedule.sendHour,
    sendWeekday: schedule.sendWeekday ?? 1,
    sendDayOfMonth: schedule.sendDayOfMonth ?? 1,
    recipientsText: schedule.recipients.join(", "),
    enabled: schedule.enabled,
  };
}

function toPayload(form: FormState): MisReportScheduleWrite {
  return {
    name: form.name.trim(),
    reportKeys: form.reportKeys,
    cadence: form.cadence,
    sendHour: form.sendHour,
    sendWeekday: form.cadence === "weekly" ? form.sendWeekday : null,
    sendDayOfMonth: form.cadence === "monthly" ? form.sendDayOfMonth : null,
    recipients: form.recipientsText
      .split(/[\s,;]+/)
      .map((email) => email.trim())
      .filter(Boolean),
    enabled: form.enabled,
  };
}

function cadenceLabel(schedule: MisReportSchedule) {
  const hour = `${String(schedule.sendHour).padStart(2, "0")}:00`;
  if (schedule.cadence === "weekly") {
    return `Weekly, ${WEEKDAYS[schedule.sendWeekday ?? 1]} at ${hour}`;
  }
  if (schedule.cadence === "monthly") {
    return `Monthly, day ${schedule.sendDayOfMonth ?? 1} at ${hour}`;
  }
  return `Daily at ${hour}`;
}

function StatusBadge({ status }: { status: MisReportSchedule["lastStatus"] }) {
  if (!status) {
    return <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-semibold text-slate-600">Never run</span>;
  }
  const styles: Record<string, string> = {
    sent: "bg-emerald-100 text-emerald-800",
    partial: "bg-amber-100 text-amber-800",
    failed: "bg-red-100 text-red-800",
    running: "bg-sky-100 text-sky-800",
  };
  return (
    <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${styles[status] ?? "bg-slate-100 text-slate-600"}`}>
      {status}
    </span>
  );
}

function ScheduleForm({
  form,
  setForm,
  reports,
  saving,
  onSubmit,
  onCancel,
  title,
}: {
  form: FormState;
  setForm: (updater: (prev: FormState) => FormState) => void;
  reports: MisReportCatalogEntry[];
  saving: boolean;
  onSubmit: () => void;
  onCancel: () => void;
  title: string;
}) {
  const toggleReport = (key: string) => {
    setForm((prev) => ({
      ...prev,
      reportKeys: prev.reportKeys.includes(key)
        ? prev.reportKeys.filter((existing) => existing !== key)
        : [...prev.reportKeys, key],
    }));
  };

  return (
    <div className="rounded border bg-white p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-base font-bold">{title}</h3>
        <button type="button" onClick={onCancel} className="rounded p-1 text-slate-500 hover:bg-slate-100" aria-label="Close form">
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">Schedule name</span>
            <input
              value={form.name}
              onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
              aria-label="Schedule name"
              placeholder="e.g. Morning management brief"
              className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
              Recipients (comma-separated emails)
            </span>
            <textarea
              value={form.recipientsText}
              onChange={(event) => setForm((prev) => ({ ...prev, recipientsText: event.target.value }))}
              aria-label="Recipients (comma-separated emails)"
              placeholder="cmo@hospital.example, finance@hospital.example"
              rows={3}
              className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">Cadence</span>
              <select
                value={form.cadence}
                onChange={(event) => setForm((prev) => ({ ...prev, cadence: event.target.value as MisReportCadence }))}
                className="w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm"
              >
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">Send hour (local)</span>
              <select
                value={form.sendHour}
                onChange={(event) => setForm((prev) => ({ ...prev, sendHour: Number(event.target.value) }))}
                className="w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm"
              >
                {Array.from({ length: 24 }, (_, hour) => (
                  <option key={hour} value={hour}>{String(hour).padStart(2, "0")}:00</option>
                ))}
              </select>
            </label>
            {form.cadence === "weekly" ? (
              <label className="block">
                <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">Day of week</span>
                <select
                  value={form.sendWeekday}
                  onChange={(event) => setForm((prev) => ({ ...prev, sendWeekday: Number(event.target.value) }))}
                  className="w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm"
                >
                  {WEEKDAYS.map((day, index) => (
                    <option key={day} value={index}>{day}</option>
                  ))}
                </select>
              </label>
            ) : null}
            {form.cadence === "monthly" ? (
              <label className="block">
                <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">Day of month</span>
                <select
                  value={form.sendDayOfMonth}
                  onChange={(event) => setForm((prev) => ({ ...prev, sendDayOfMonth: Number(event.target.value) }))}
                  className="w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm"
                >
                  {Array.from({ length: 28 }, (_, index) => index + 1).map((day) => (
                    <option key={day} value={day}>{day}</option>
                  ))}
                </select>
              </label>
            ) : null}
          </div>
          <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(event) => setForm((prev) => ({ ...prev, enabled: event.target.checked }))}
              aria-label="Enabled"
              className="h-4 w-4 rounded border-slate-300"
            />
            Enabled
          </label>
        </div>
        <div>
          <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">Reports to include</span>
          <div className="space-y-2 rounded border border-slate-200 p-3">
            {reports.map((report) => (
              <label key={report.key} className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={form.reportKeys.includes(report.key)}
                  onChange={() => toggleReport(report.key)}
                  aria-label={report.title}
                  className="h-4 w-4 rounded border-slate-300"
                />
                {report.title}
              </label>
            ))}
          </div>
        </div>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onSubmit}
          disabled={saving}
          className="rounded bg-slate-950 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:text-slate-600"
        >
          {saving ? "Saving…" : "Save schedule"}
        </button>
      </div>
    </div>
  );
}

export default function MisReportSchedulesPage() {
  const queryClient = useQueryClient();
  const [editingId, setEditingId] = useState<number | "new" | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);

  const listQuery = useQuery({ queryKey: QUERY_KEY, queryFn: listMisReportSchedules });
  const schedules = useMemo(() => listQuery.data?.schedules ?? [], [listQuery.data]);
  const reports = useMemo(() => listQuery.data?.reports ?? [], [listQuery.data]);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: QUERY_KEY });

  const saveMutation = useMutation({
    mutationFn: async (payload: MisReportScheduleWrite) =>
      editingId === "new" || editingId == null
        ? createMisReportSchedule(payload)
        : updateMisReportSchedule(editingId, payload),
    onSuccess: () => {
      toast.success("Schedule saved");
      setEditingId(null);
      void invalidate();
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Failed to save schedule"),
  });

  const toggleMutation = useMutation({
    mutationFn: async (schedule: MisReportSchedule) =>
      updateMisReportSchedule(schedule.id, { enabled: !schedule.enabled }),
    onSuccess: () => void invalidate(),
    onError: (error) => toast.error(error instanceof Error ? error.message : "Failed to update schedule"),
  });

  const deleteMutation = useMutation({
    mutationFn: deleteMisReportSchedule,
    onSuccess: () => {
      toast.success("Schedule deleted");
      void invalidate();
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Failed to delete schedule"),
  });

  const runNowMutation = useMutation({
    mutationFn: runMisReportScheduleNow,
    onSuccess: (result) => {
      if (result.status === "sent") toast.success(`Reports emailed (${result.deliveries.length} recipient${result.deliveries.length === 1 ? "" : "s"})`);
      else if (result.status === "partial") toast.error("Some recipients did not receive the email — check last-run detail");
      else toast.error("Delivery failed — no recipient was acknowledged");
      void invalidate();
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Run failed"),
  });

  const startCreate = () => {
    setForm(EMPTY_FORM);
    setEditingId("new");
  };

  const startEdit = (schedule: MisReportSchedule) => {
    setForm(toForm(schedule));
    setEditingId(schedule.id);
  };

  const submit = () => {
    const payload = toPayload(form);
    if (!payload.name) return void toast.error("Schedule name is required");
    if (!payload.reportKeys || payload.reportKeys.length === 0) return void toast.error("Select at least one report");
    if (!payload.recipients || payload.recipients.length === 0) return void toast.error("Add at least one recipient email");
    saveMutation.mutate(payload);
  };

  return (
    <div className="min-h-full bg-slate-50 p-4 text-slate-950 sm:p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded bg-slate-950 text-white">
            <Mail className="h-5 w-5" aria-hidden="true" />
          </div>
          <div>
            <h2 className="text-xl font-bold tracking-normal">MIS Report Emails</h2>
            <p className="text-sm text-slate-600">
              Scheduled census, revenue, and department snapshot reports delivered to management by email.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={startCreate}
          className="inline-flex items-center gap-2 rounded bg-slate-950 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-800"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          New schedule
        </button>
      </div>

      {editingId != null ? (
        <div className="mb-4">
          <ScheduleForm
            form={form}
            setForm={setForm}
            reports={reports}
            saving={saveMutation.isPending}
            onSubmit={submit}
            onCancel={() => setEditingId(null)}
            title={editingId === "new" ? "New schedule" : "Edit schedule"}
          />
        </div>
      ) : null}

      {listQuery.isLoading ? (
        <Skeleton className="h-72 w-full" />
      ) : listQuery.isError ? (
        <div className="rounded border border-amber-300 bg-amber-50 p-8 text-amber-900">
          {listQuery.error instanceof Error ? listQuery.error.message : "Failed to load schedules"}
        </div>
      ) : schedules.length === 0 ? (
        <div className="rounded border bg-white p-12 text-center text-slate-600">
          No report schedules yet. Create one to email MIS snapshots to management automatically.
        </div>
      ) : (
        <div className="overflow-x-auto rounded border bg-white">
          <table className="w-full min-w-[900px] text-left text-sm">
            <thead>
              <tr className="border-b bg-slate-50 text-xs font-semibold uppercase tracking-wide text-slate-500">
                <th className="px-4 py-3">Schedule</th>
                <th className="px-4 py-3">Reports</th>
                <th className="px-4 py-3">Cadence</th>
                <th className="px-4 py-3">Recipients</th>
                <th className="px-4 py-3">Last run</th>
                <th className="px-4 py-3">Enabled</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {schedules.map((schedule) => (
                <tr key={schedule.id} className="border-b last:border-b-0">
                  <td className="px-4 py-3 font-semibold">{schedule.name}</td>
                  <td className="px-4 py-3 text-slate-600">
                    {schedule.reportKeys
                      .map((key) => reports.find((report) => report.key === key)?.title ?? key)
                      .join(", ")}
                  </td>
                  <td className="px-4 py-3 text-slate-600">{cadenceLabel(schedule)}</td>
                  <td className="px-4 py-3 text-slate-600">{schedule.recipients.join(", ")}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <StatusBadge status={schedule.lastStatus} />
                      {schedule.lastRunAt ? (
                        <span className="text-xs text-slate-500">{new Date(schedule.lastRunAt).toLocaleString()}</span>
                      ) : null}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <button
                      type="button"
                      onClick={() => toggleMutation.mutate(schedule)}
                      disabled={toggleMutation.isPending}
                      className={`rounded-full px-3 py-1 text-xs font-semibold ${
                        schedule.enabled ? "bg-emerald-100 text-emerald-800" : "bg-slate-200 text-slate-600"
                      }`}
                    >
                      {schedule.enabled ? "Enabled" : "Disabled"}
                    </button>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-1">
                      <button
                        type="button"
                        onClick={() => runNowMutation.mutate(schedule.id)}
                        disabled={runNowMutation.isPending}
                        title="Send now"
                        aria-label={`Send "${schedule.name}" now`}
                        className="rounded p-2 text-slate-600 hover:bg-slate-100 disabled:opacity-50"
                      >
                        <Play className="h-4 w-4" aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        onClick={() => startEdit(schedule)}
                        title="Edit"
                        aria-label={`Edit "${schedule.name}"`}
                        className="rounded p-2 text-slate-600 hover:bg-slate-100"
                      >
                        <Pencil className="h-4 w-4" aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          if (window.confirm(`Delete schedule "${schedule.name}"?`)) {
                            deleteMutation.mutate(schedule.id);
                          }
                        }}
                        disabled={deleteMutation.isPending}
                        title="Delete"
                        aria-label={`Delete "${schedule.name}"`}
                        className="rounded p-2 text-red-600 hover:bg-red-50 disabled:opacity-50"
                      >
                        <Trash2 className="h-4 w-4" aria-hidden="true" />
                      </button>
                    </div>
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
