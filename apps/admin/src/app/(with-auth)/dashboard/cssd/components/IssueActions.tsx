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

import {
  CSSD_ISSUE_TRANSITION_ACTIONS,
  CSSD_RETURN_CONDITIONS,
  issueInstrumentSet,
  listInstrumentSets,
  listOtSchedulesForDate,
  type CssdIssue,
} from "@/lib/api/cssd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
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
    queryKey: ["cssd", "sets", "issuable"],
    queryFn: () => listInstrumentSets({ usable: true, limit: 500 }),
  });
  const issuable = (sets.data ?? []).filter(
    (set) =>
      ["available", "sterilized"].includes(set.status) &&
      !set.requires_reprocessing,
  );

  const schedules = useQuery({
    queryKey: ["cssd", "ot-schedules", date],
    queryFn: () => listOtSchedulesForDate(date),
    enabled: date !== "",
    retry: false,
  });
  const scheduleOptions = schedules.data ?? [];

  const issue = useMutation({
    mutationFn: () =>
      issueInstrumentSet({
        instrument_set_id: Number(setId),
        ot_schedule_id: Number(scheduleId),
        return_due_at: returnDue
          ? new Date(returnDue).toISOString()
          : undefined,
        notes: notes.trim() || undefined,
      }),
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

  const canIssue = setId !== "" && scheduleId !== "";

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
          message={`OT schedule list unavailable — ${schedules.error.message}. A set is issued against an OT case, so this needs an account that can read the theatre schedule.`}
        />
      )}

      <Field label="Instrument set *">
        <select
          aria-label="Instrument set"
          className={inputClass}
          value={setId}
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
          disabled={schedules.isLoading}
          onChange={(e) => setScheduleId(e.target.value)}
        >
          <option value="">
            {schedules.isLoading
              ? "Loading OT cases…"
              : scheduleOptions.length === 0
                ? "No OT case scheduled on this date"
                : "Select an OT case"}
          </option>
          {scheduleOptions.map((schedule) => (
            <option key={schedule.id} value={String(schedule.id)}>
              #{schedule.id} · {schedule.procedure_name ?? "Procedure"} ·{" "}
              {schedule.ot_room ?? "No room"}
              {schedule.scheduled_time ? ` · ${schedule.scheduled_time}` : ""}
            </option>
          ))}
        </select>
      </Field>

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
