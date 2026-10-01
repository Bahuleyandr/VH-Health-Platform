"use client";

// Instrument-set issue surface: POST /cssd/issues plus the four transitions.
//
// Before lane L none of these had a caller, so set_issue_log was never written
// — which is also why the theatre page's `cssd_warnings` (derived from that
// table by getOtSterilityWarnings) could never show anything.
//
// Every transition offered here comes from CSSD_ISSUE_TRANSITIONS, which
// mirrors ISSUE_TRANSITIONS in the backend service and is pinned against it by
// test. Anything not in that map would only ever 409.

import { useActingTenant } from "@/contexts/ActingTenantContext";
import { useAuth } from "@/contexts/AuthContext";
import { useTenant } from "@/contexts/TenantContext";
import {
  CSSD_ISSUE_TRANSITION_ACTIONS,
  CSSD_RETURN_CONDITIONS,
  issueInstrumentSet,
  listInstrumentSets,
  listOtSchedulesForDate,
  type CssdIssue,
} from "@/lib/api/cssd";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { toast } from "react-hot-toast";

import {
  DialogError,
  Field,
  Modal,
  errorMessage,
  humanize,
  inputClass,
  todayIso,
} from "./helpers";

export function issueTransitionLabel(transition: string) {
  return (
    CSSD_ISSUE_TRANSITION_ACTIONS[transition]?.label ?? humanize(transition)
  );
}

/* ── Issue a set to an OT case ──────────────────────────────────────────── */

export function IssueSetDialog({
  presetSetId,
  onClose,
}: {
  presetSetId?: number;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { user, loading } = useAuth();
  const { tenant, isLoading: tenantLoading } = useTenant();
  const { actingTenant, isReady, scopeKey: tenantScopeKey, isScopeCurrent } = useActingTenant();
  const profileTenant = (user as { tenantId?: unknown } | null)?.tenantId;
  const admin = user?.role === "ADMIN" || user?.role === "SUPER_ADMIN";
  const tenantId = user?.role === "SUPER_ADMIN" && actingTenant
    ? actingTenant.id : admin ? tenant?.id
      : typeof profileTenant === "string" ? profileTenant : null;
  const ready = !loading && !!user && isReady && !!tenantScopeKey
    && (!admin || (!!tenantId && (!!actingTenant || !tenantLoading)));
  const scopeKey = JSON.stringify([
    tenantScopeKey, user?.uid ?? user?.id, user?.role, user?.permissions, tenantId,
  ]);
  const [openedScope, setOpenedScope] = useState<string | null>(null);
  const changed = openedScope !== null && (!ready || scopeKey !== openedScope);
  useEffect(() => {
    if (openedScope === null && ready) setOpenedScope(scopeKey);
    if (changed) onClose();
  }, [openedScope, ready, scopeKey, changed, onClose]);
  const active = useRef(false);
  useLayoutEffect(() => {
    active.current = ready && !changed;
    return () => { active.current = false; };
  }, [ready, changed, scopeKey]);
  const [date, setDate] = useState(todayIso());
  const [setId, setSetId] = useState(presetSetId ? String(presetSetId) : "");
  const [scheduleId, setScheduleId] = useState("");
  const [returnDue, setReturnDue] = useState("");
  const [notes, setNotes] = useState("");
  const [failure, setFailure] = useState<string | null>(null);

  // The service refuses a set that is retired, unusable, awaiting reprocessing
  // or already in circulation (CSSD_SET_UNUSABLE / CSSD_SET_NOT_AVAILABLE), so
  // the picker offers exactly the sets it will accept.
  const sets = useQuery({
    queryKey: ["cssd", "sets", "issuable", scopeKey],
    queryFn: () => listInstrumentSets({ usable: true, limit: 500 }),
    enabled: ready && !changed,
    gcTime: 0,
  });
  const issuable = (sets.data ?? []).filter(
    (set) =>
      ["available", "sterilized"].includes(set.status) &&
      !set.requires_reprocessing,
  );

  const schedules = useInfiniteQuery({
    queryKey: ["cssd", "theatre-options", scopeKey, date],
    queryFn: async ({ pageParam, signal }) => {
      if (!tenantScopeKey || !isScopeCurrent(tenantScopeKey)) throw new Error("Tenant scope changed");
      const page = await listOtSchedulesForDate(date, pageParam, signal);
      if (!isScopeCurrent(tenantScopeKey)) throw new Error("Tenant scope changed");
      return page;
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: page => page.next_cursor ?? undefined,
    enabled: ready && !changed && date !== "",
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: "always",
    retry: false,
  });
  const scheduleOptions = ready && !changed && !schedules.isError
    ? schedules.data?.pages.flatMap(page => page.items) ?? [] : [];
  useEffect(() => {
    if (!schedules.isFetching && scheduleId
      && !scheduleOptions.some(schedule => schedule.id === Number(scheduleId))) {
      setScheduleId("");
    }
  }, [schedules.isFetching, scheduleOptions, scheduleId]);

  const issue = useMutation({
    mutationFn: async () => {
      if (!tenantScopeKey || !isScopeCurrent(tenantScopeKey)) throw new Error("Tenant scope changed");
      const selected = scheduleOptions.find(schedule => schedule.id === Number(scheduleId));
      const current = await schedules.refetch();
      const refreshed = current.data?.pages.flatMap(page => page.items)
        .find(schedule => schedule.id === Number(scheduleId));
      if (!active.current || !isScopeCurrent(tenantScopeKey) || current.isError
        || !selected || !refreshed || selected.scheduled_date !== refreshed.scheduled_date
        || selected.scheduled_time !== refreshed.scheduled_time) {
        setScheduleId("");
        throw new Error("The case selection is no longer available. Select a case again.");
      }
      return issueInstrumentSet({
        instrument_set_id: Number(setId),
        ot_schedule_id: Number(scheduleId),
        return_due_at: returnDue
          ? new Date(returnDue).toISOString()
          : undefined,
        notes: notes.trim() || undefined,
      });
    },
    onSuccess: (created) => {
      const warnings = created.warnings ?? [];
      toast.success(
        warnings.length > 0
          ? `Issued ${created.issue_code} with ${warnings.length} sterility warning${warnings.length === 1 ? "" : "s"}`
          : `Issued ${created.issue_code}`,
      );
      qc.invalidateQueries({ queryKey: ["cssd"] });
      onClose();
    },
    onError: (err: unknown) =>
      setFailure(errorMessage(err, "Could not issue the instrument set")),
  });

  const canIssue = ready && !schedules.isFetching && !schedules.isError && !sets.isError
    && issuable.some(set => set.id === Number(setId))
    && scheduleOptions.some(schedule => schedule.id === Number(scheduleId));

  if (changed) return null;

  return (
    <Modal
      title="Issue instrument set"
      onClose={onClose}
      wide
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-border px-4 py-2 text-sm"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canIssue || issue.isPending}
            onClick={() => {
              setFailure(null);
              issue.mutate();
            }}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            {issue.isPending ? "Issuing…" : "Issue set"}
          </button>
        </>
      }
    >
      <DialogError message={failure} />
      {sets.error instanceof Error && (
        <DialogError message={sets.error.message} />
      )}
      {!sets.isLoading && !sets.error && issuable.length === 0 && (
        <DialogError message="No set is currently available or sterilized — create one on the Sets tab, or release a passed sterilization load first." />
      )}
      {schedules.error instanceof Error && (
        <DialogError
          message={`Case directory unavailable — ${schedules.error.message}`}
        />
      )}

      <Field label="Instrument set *">
        <select
          aria-label="Instrument set"
          className={inputClass}
          value={setId}
          disabled={!ready || issue.isPending}
          onChange={(e) => setSetId(e.target.value)}
        >
          <option value="">Select a set</option>
          {issuable.map((set) => (
            <option key={set.id} value={String(set.id)}>
              {set.set_code} — {set.display_name} ({humanize(set.status)})
            </option>
          ))}
        </select>
      </Field>

      <Field label="Theatre date">
        <input
          aria-label="Theatre date"
          type="date"
          className={inputClass}
          value={date}
          disabled={issue.isPending}
          onChange={(e) => {
            setDate(e.target.value);
            setScheduleId("");
          }}
        />
      </Field>

      <Field label="OT case *">
        <select
          aria-label="OT case"
          className={inputClass}
          value={scheduleId}
          disabled={!ready || schedules.isPending || schedules.isError || issue.isPending}
          onChange={(e) => setScheduleId(e.target.value)}
        >
          <option value="">
            {!ready || schedules.isPending
              ? "Loading OT cases…"
              : scheduleOptions.length === 0
                ? schedules.isError ? "Case directory unavailable" : "No eligible OT case on this date"
                : "Select an OT case"}
          </option>
          {scheduleOptions.map((schedule) => (
            <option key={schedule.id} value={String(schedule.id)}>
              Case #{schedule.id} · {schedule.scheduled_time ?? "Time not scheduled"}
            </option>
          ))}
        </select>
      </Field>

      {schedules.hasNextPage && (
        <button type="button" disabled={schedules.isFetchingNextPage || issue.isPending}
          onClick={() => void schedules.fetchNextPage()} className="text-sm text-primary">
          {schedules.isFetchingNextPage ? "Loading cases…" : "Load more cases"}
        </button>
      )}

      <Field label="Return due">
        <input
          aria-label="Return due"
          type="datetime-local"
          className={inputClass}
          value={returnDue}
          onChange={(e) => setReturnDue(e.target.value)}
        />
      </Field>

      <Field label="Notes">
        <textarea
          aria-label="Notes"
          className={inputClass}
          rows={2}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </Field>
    </Modal>
  );
}

/* ── Issue transitions ──────────────────────────────────────────────────── */

export function IssueActionDialog({
  issue,
  transition,
  onClose,
}: {
  issue: CssdIssue;
  transition: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const action = CSSD_ISSUE_TRANSITION_ACTIONS[transition];
  const [returnCondition, setReturnCondition] = useState("intact");
  const [contaminationNotes, setContaminationNotes] = useState("");
  const [notes, setNotes] = useState("");
  const [failure, setFailure] = useState<string | null>(null);

  const run = useMutation({
    mutationFn: async () => {
      if (!action) throw new Error(`Unsupported transition: ${transition}`);
      return action.run(issue.id, {
        ...(transition === "returned"
          ? { return_condition: returnCondition }
          : {}),
        ...(contaminationNotes.trim()
          ? { contamination_notes: contaminationNotes.trim() }
          : {}),
        ...(transition === "cancelled" && notes.trim()
          ? { notes: notes.trim() }
          : {}),
      });
    },
    onSuccess: (updated) => {
      toast.success(
        `${issue.issue_code} — ${humanize(updated?.status ?? transition)}`,
      );
      qc.invalidateQueries({ queryKey: ["cssd"] });
      onClose();
    },
    onError: (err: unknown) =>
      setFailure(
        errorMessage(
          err,
          `Could not ${issueTransitionLabel(transition).toLowerCase()}`,
        ),
      ),
  });

  return (
    <Modal
      title={`${issueTransitionLabel(transition)} — ${issue.issue_code}`}
      onClose={onClose}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-border px-4 py-2 text-sm"
          >
            Close
          </button>
          <button
            type="button"
            disabled={!action || run.isPending}
            onClick={() => {
              setFailure(null);
              run.mutate();
            }}
            className={`rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50 ${
              transition === "cancelled"
                ? "bg-rose-600 text-white"
                : "bg-primary text-primary-foreground"
            }`}
          >
            {run.isPending ? "Working…" : issueTransitionLabel(transition)}
          </button>
        </>
      }
    >
      <DialogError message={failure} />
      <p className="text-sm text-muted-foreground">
        {issue.set_code} · {issue.set_name ?? "Instrument set"} — currently{" "}
        {humanize(issue.status)}.
      </p>

      {transition === "returned" && (
        <Field label="Return condition">
          <select
            aria-label="Return condition"
            className={inputClass}
            value={returnCondition}
            onChange={(e) => setReturnCondition(e.target.value)}
          >
            {CSSD_RETURN_CONDITIONS.map((condition) => (
              <option key={condition} value={condition}>
                {humanize(condition)}
              </option>
            ))}
          </select>
        </Field>
      )}

      {transition === "awaiting_sterilization" && (
        <p className="text-sm text-muted-foreground">
          Marks the set decontaminated and awaiting sterilization. It stays
          unusable until a sterilization load carrying it passes.
        </p>
      )}

      {transition === "cancelled" && (
        <Field label="Cancellation note">
          <textarea
            aria-label="Cancellation note"
            className={inputClass}
            rows={3}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </Field>
      )}

      {/* set_issue_log.contamination_notes is COALESCE-updated on every
          transition, but it only means anything on the two legs where the set
          is physically handled back — offering it on "mark in theatre" or a
          cancellation would be a field with no moment to fill it in. */}
      {(transition === "returned" ||
        transition === "awaiting_sterilization") && (
        <Field label="Contamination notes">
          <textarea
            aria-label="Contamination notes"
            className={inputClass}
            rows={2}
            value={contaminationNotes}
            onChange={(e) => setContaminationNotes(e.target.value)}
          />
        </Field>
      )}
    </Modal>
  );
}
