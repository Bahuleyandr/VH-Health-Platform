"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  Download,
  FileClock,
  ListFilter,
  ShieldCheck,
  Stethoscope,
  UserRoundSearch,
  Users,
} from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { exportCsvText } from "@/lib/exportToCsv";
import type {
  AuditEvent,
  AuditWorkspaceFilters,
  AuditWorkspaceView,
} from "../auditTypes";
import {
  exportAuditEvents,
  listAuditEvents,
} from "../auditWorkspaceApi";
import { AuditEventDetailPanel } from "./AuditEventDetailPanel";
import { AuditEventTable } from "./AuditEventTable";
import { AuditHealthPanel } from "./AuditHealthPanel";
import { AuditWorkspaceFiltersPanel } from "./AuditWorkspaceFilters";

const EMPTY_FILTERS: AuditWorkspaceFilters = {
  actor_uid: "",
  actor_role: "",
  patient_uid: "",
  department_id: "",
  action: "",
  resource_type: "",
  outcome: "",
  encounter_id: "",
  admission_id: "",
  from: "",
  to: "",
  source: "",
};

const VIEWS: Array<{
  id: AuditWorkspaceView;
  label: string;
  icon: typeof ListFilter;
}> = [
  { id: "all", label: "All events", icon: ListFilter },
  { id: "staff", label: "Staff activity", icon: Users },
  { id: "doctor", label: "Doctor activity", icon: Stethoscope },
  { id: "patient", label: "Patient audit", icon: UserRoundSearch },
  { id: "time", label: "Date / time", icon: CalendarClock },
  { id: "health", label: "Audit health", icon: ShieldCheck },
];

function filtersForView(
  view: AuditWorkspaceView,
  current: AuditWorkspaceFilters,
): AuditWorkspaceFilters {
  if (view === "doctor") return { ...current, actor_role: "DOCTOR_GROUP" };
  if (view === "staff") return { ...current, actor_role: "STAFF_GROUP" };
  if (["DOCTOR_GROUP", "STAFF_GROUP"].includes(current.actor_role)) {
    return { ...current, actor_role: "" };
  }
  return current;
}

function toApiInstant(value: string): string {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

function apiFilters(filters: AuditWorkspaceFilters): AuditWorkspaceFilters {
  return {
    ...filters,
    actor_uid: filters.actor_uid.trim(),
    patient_uid: filters.patient_uid.trim(),
    department_id: filters.department_id.trim(),
    action: filters.action.trim(),
    resource_type: filters.resource_type.trim(),
    encounter_id: filters.encounter_id.trim(),
    admission_id: filters.admission_id.trim(),
    from: toApiInstant(filters.from),
    to: toApiInstant(filters.to),
  };
}

function outcomeIsFlagged(outcome: string | null): boolean {
  const normalized = (outcome ?? "").toLowerCase();
  return ["failure", "failed", "denied", "error", "blocked"].includes(normalized);
}

function MetricCard({ label, value, detail }: { label: string; value: number; detail: string }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-card px-4 py-3 shadow-sm dark:border-gray-700 dark:bg-gray-800">
      <p className="text-2xl font-semibold tabular-nums text-gray-900 dark:text-white">
        {value.toLocaleString()}
      </p>
      <p className="mt-0.5 text-xs font-medium text-gray-600 dark:text-gray-300">{label}</p>
      <p className="mt-0.5 text-[11px] text-gray-400">{detail}</p>
    </div>
  );
}

export function ClinicalAuditTab() {
  const [view, setView] = useState<AuditWorkspaceView>("all");
  const [draft, setDraft] = useState<AuditWorkspaceFilters>(EMPTY_FILTERS);
  const [submitted, setSubmitted] = useState<AuditWorkspaceFilters>(EMPTY_FILTERS);
  const [displayTimezone, setDisplayTimezone] = useState("Asia/Kolkata");
  const [cursor, setCursor] = useState<string | undefined>();
  const [cursorHistory, setCursorHistory] = useState<Array<string | undefined>>([]);
  const [selectedEvent, setSelectedEvent] = useState<AuditEvent | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const submittedApiFilters = useMemo(() => apiFilters(submitted), [submitted]);
  const eventsQuery = useQuery({
    queryKey: ["admin-audit-events", submittedApiFilters, cursor],
    queryFn: () => listAuditEvents(submittedApiFilters, cursor),
    enabled: view !== "health",
    placeholderData: (previous) => previous,
  });

  const changeView = (nextView: AuditWorkspaceView) => {
    const nextFilters = filtersForView(nextView, draft);
    setView(nextView);
    setDraft(nextFilters);
    setSubmitted(nextFilters);
    setCursor(undefined);
    setCursorHistory([]);
    setSelectedEvent(null);
    setExportError(null);
  };

  const changeFilter = (field: keyof AuditWorkspaceFilters, value: string) => {
    setDraft((current) => ({ ...current, [field]: value }));
  };

  const submitFilters = () => {
    setSubmitted({ ...draft });
    setCursor(undefined);
    setCursorHistory([]);
    setSelectedEvent(null);
  };

  const resetFilters = () => {
    const next = filtersForView(view, EMPTY_FILTERS);
    setDraft(next);
    setSubmitted(next);
    setCursor(undefined);
    setCursorHistory([]);
    setSelectedEvent(null);
  };

  const nextPage = () => {
    const nextCursor = eventsQuery.data?.pagination.next_cursor;
    if (!nextCursor) return;
    setCursorHistory((history) => [...history, cursor]);
    setCursor(nextCursor);
    setSelectedEvent(null);
  };

  const previousPage = () => {
    if (cursorHistory.length === 0) return;
    const previousCursor = cursorHistory[cursorHistory.length - 1];
    setCursorHistory((history) => history.slice(0, -1));
    setCursor(previousCursor);
    setSelectedEvent(null);
  };

  const exportCurrentFilters = async () => {
    setIsExporting(true);
    setExportError(null);
    try {
      const csv = await exportAuditEvents(submittedApiFilters);
      exportCsvText(
        `vh-health-audit-${new Date().toISOString().slice(0, 10)}.csv`,
        csv,
      );
    } catch (error) {
      setExportError(error instanceof Error ? error.message : "Audit export failed");
    } finally {
      setIsExporting(false);
    }
  };

  const events = eventsQuery.data?.events ?? [];
  const uniqueActors = new Set(events.map((event) => event.actor_uid).filter(Boolean)).size;
  const uniquePatients = new Set(events.map((event) => event.patient_uid).filter(Boolean)).size;
  const flaggedEvents = events.filter((event) => outcomeIsFlagged(event.outcome)).length;

  return (
    <div className="space-y-4">
      <div className="overflow-x-auto border-b border-gray-200 dark:border-gray-700">
        <div className="flex min-w-max gap-1" role="tablist" aria-label="Audit workspace views">
          {VIEWS.map((item) => {
            const Icon = item.icon;
            const active = item.id === view;
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => changeView(item.id)}
                className={`inline-flex items-center gap-2 border-b-2 px-3 py-2.5 text-sm font-medium transition ${active ? "border-blue-600 text-blue-700 dark:text-blue-300" : "border-transparent text-gray-500 hover:text-gray-800 dark:hover:text-gray-200"}`}
              >
                <Icon className="h-4 w-4" />
                {item.label}
              </button>
            );
          })}
        </div>
      </div>

      {view === "health" ? (
        <AuditHealthPanel />
      ) : (
        <>
          <AuditWorkspaceFiltersPanel
            view={view}
            filters={draft}
            displayTimezone={displayTimezone}
            onTimezoneChange={setDisplayTimezone}
            onChange={changeFilter}
            onSubmit={submitFilters}
            onReset={resetFilters}
          />

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <MetricCard label="Events on this page" value={events.length} detail={`Cursor page ${cursorHistory.length + 1}`} />
            <MetricCard label="Staff represented" value={uniqueActors} detail="Unique attributed actor UIDs" />
            <MetricCard label="Patients represented" value={uniquePatients} detail="Unique patient UIDs" />
            <MetricCard label="Failed or denied" value={flaggedEvents} detail="Visible outcomes needing review" />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
              <FileClock className="h-4 w-4" />
              Page {cursorHistory.length + 1} · newest matching events first
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void exportCurrentFilters()}
                disabled={isExporting}
                className="inline-flex items-center gap-2 rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
              >
                <Download className="h-4 w-4" />
                {isExporting ? "Preparing export…" : "Export filtered CSV"}
              </button>
              <button
                type="button"
                aria-label="Previous audit page"
                disabled={cursorHistory.length === 0 || eventsQuery.isFetching}
                onClick={previousPage}
                className="inline-flex items-center gap-1 rounded-md border border-gray-300 px-3 py-1.5 text-sm disabled:opacity-40 dark:border-gray-600"
              >
                <ChevronLeft className="h-4 w-4" /> Previous
              </button>
              <button
                type="button"
                aria-label="Next audit page"
                disabled={!eventsQuery.data?.pagination.has_more || !eventsQuery.data.pagination.next_cursor || eventsQuery.isFetching}
                onClick={nextPage}
                className="inline-flex items-center gap-1 rounded-md border border-gray-300 px-3 py-1.5 text-sm disabled:opacity-40 dark:border-gray-600"
              >
                Next <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>

          {exportError ? (
            <div role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              {exportError}
            </div>
          ) : null}

          {eventsQuery.isLoading ? (
            <LoadingSpinner label="Loading audit events…" />
          ) : eventsQuery.error ? (
            <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
              {eventsQuery.error.message}
            </div>
          ) : events.length === 0 ? (
            <div className="rounded-lg border border-gray-200 bg-card shadow-sm dark:border-gray-700 dark:bg-gray-800">
              <EmptyState
                icon={<UserRoundSearch className="h-10 w-10 text-muted-foreground" />}
                title="No audit events found"
                description="No events match these staff, patient, action, outcome, or date/time filters. Clear a filter and try again."
              />
            </div>
          ) : (
            <AuditEventTable
              events={events}
              displayTimezone={displayTimezone}
              onSelect={setSelectedEvent}
            />
          )}
        </>
      )}

      {selectedEvent ? (
        <AuditEventDetailPanel
          event={selectedEvent}
          displayTimezone={displayTimezone}
          onClose={() => setSelectedEvent(null)}
        />
      ) : null}
    </div>
  );
}
