"use client";

// Sterilization loads: POST /cssd/loads and PATCH /cssd/loads/{id}/status.
// Neither had a caller before lane L, so sterilization_loads was never written
// and the board's "Recent loads" table was permanently empty.

import {
  CSSD_CYCLE_TYPES,
  CSSD_INDICATOR_RESULTS,
  CSSD_LOAD_STATUSES,
  createSterilizationLoad,
  listInstrumentSets,
  transitionSterilizationLoad,
  type CssdIndicatorResult,
  type CssdLoad,
} from "@/lib/api/cssd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "react-hot-toast";

import {
  DialogError,
  Field,
  Modal,
  StatusPill,
  errorMessage,
  humanize,
  inputClass,
} from "./helpers";

type Indicators = {
  biological_indicator_result: CssdIndicatorResult;
  chemical_indicator_result: CssdIndicatorResult;
  mechanical_indicator_result: CssdIndicatorResult;
};

const INDICATOR_FIELDS: { key: keyof Indicators; label: string }[] = [
  { key: "biological_indicator_result", label: "Biological (BI)" },
  { key: "chemical_indicator_result", label: "Chemical (CI)" },
  { key: "mechanical_indicator_result", label: "Mechanical" },
];

function asIndicator(value: unknown): CssdIndicatorResult {
  const text = String(value ?? "pending");
  return (CSSD_INDICATOR_RESULTS as readonly string[]).includes(text)
    ? (text as CssdIndicatorResult)
    : "pending";
}

function IndicatorFields({
  values,
  onChange,
}: {
  values: Indicators;
  onChange: (key: keyof Indicators, value: CssdIndicatorResult) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      {INDICATOR_FIELDS.map((field) => (
        <Field key={field.key} label={field.label}>
          <select
            className={inputClass}
            value={values[field.key]}
            onChange={(e) => onChange(field.key, asIndicator(e.target.value))}
          >
            {CSSD_INDICATOR_RESULTS.map((result) => (
              <option key={result} value={result}>
                {humanize(result)}
              </option>
            ))}
          </select>
        </Field>
      ))}
    </div>
  );
}

/* ── New load ───────────────────────────────────────────────────────────── */

export function NewLoadDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<number[]>([]);
  const [cycleType, setCycleType] = useState<string>("steam");
  const [sterilizer, setSterilizer] = useState("");
  const [startedAt, setStartedAt] = useState("");
  const [completedAt, setCompletedAt] = useState("");
  const [notes, setNotes] = useState("");
  const [failureReason, setFailureReason] = useState("");
  const [indicators, setIndicators] = useState<Indicators>({
    biological_indicator_result: "pending",
    chemical_indicator_result: "pending",
    mechanical_indicator_result: "pending",
  });
  const [failure, setFailure] = useState<string | null>(null);

  const sets = useQuery({
    queryKey: ["cssd", "sets", "all"],
    queryFn: () => listInstrumentSets({ limit: 500 }),
  });
  const term = search.trim().toLowerCase();
  const options = (sets.data ?? []).filter(
    (set) =>
      term === "" ||
      set.set_code.toLowerCase().includes(term) ||
      set.display_name.toLowerCase().includes(term),
  );

  const anyFailed = Object.values(indicators).includes("failed");

  const create = useMutation({
    mutationFn: () =>
      createSterilizationLoad({
        set_ids: selected,
        cycle_type: cycleType,
        sterilizer_name: sterilizer.trim() || undefined,
        started_at: startedAt ? new Date(startedAt).toISOString() : undefined,
        completed_at: completedAt
          ? new Date(completedAt).toISOString()
          : undefined,
        ...indicators,
        failure_reason: failureReason.trim() || undefined,
        notes: notes.trim() || undefined,
      }),
    onSuccess: (load) => {
      toast.success(
        `Load ${load.load_code} recorded as ${humanize(load.status)}`,
      );
      qc.invalidateQueries({ queryKey: ["cssd"] });
      onClose();
    },
    onError: (err: unknown) =>
      setFailure(errorMessage(err, "Could not create the sterilization load")),
  });

  return (
    <Modal
      title="New sterilization load"
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
            disabled={selected.length === 0 || create.isPending}
            onClick={() => {
              setFailure(null);
              create.mutate();
            }}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            {create.isPending ? "Recording…" : "Record load"}
          </button>
        </>
      }
    >
      <DialogError message={failure} />
      {sets.error instanceof Error && (
        <DialogError message={sets.error.message} />
      )}
      <p className="text-sm text-muted-foreground">
        Every set in the load is taken out of circulation until the load is
        recorded as passed. A failed indicator marks the load failed and its
        sets unusable until they are reprocessed.
      </p>

      <Field label="Find sets">
        <input
          aria-label="Find sets"
          className={inputClass}
          value={search}
          placeholder="Set code or name"
          onChange={(e) => setSearch(e.target.value)}
        />
      </Field>

      <div className="max-h-56 overflow-y-auto rounded-lg border border-border">
        {options.length === 0 ? (
          <p className="p-3 text-sm text-muted-foreground">
            {sets.isLoading ? "Loading sets…" : "No instrument sets match."}
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {options.map((set) => (
              <li key={set.id}>
                <label className="flex cursor-pointer items-center gap-3 p-2 text-sm hover:bg-muted/40">
                  <input
                    type="checkbox"
                    aria-label={`Include ${set.set_code} in this load`}
                    checked={selected.includes(set.id)}
                    onChange={(e) =>
                      setSelected((prev) =>
                        e.target.checked
                          ? [...new Set([...prev, set.id])]
                          : prev.filter((id) => id !== set.id),
                      )
                    }
                  />
                  <span className="flex-1">
                    <span className="font-medium">{set.set_code}</span>{" "}
                    <span className="text-muted-foreground">
                      {set.display_name}
                    </span>
                  </span>
                  <StatusPill status={set.status} />
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        {selected.length} set{selected.length === 1 ? "" : "s"} selected.
      </p>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Cycle type">
          <select
            aria-label="Cycle type"
            className={inputClass}
            value={cycleType}
            onChange={(e) => setCycleType(e.target.value)}
          >
            {CSSD_CYCLE_TYPES.map((type) => (
              <option key={type} value={type}>
                {humanize(type)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Sterilizer">
          <input
            aria-label="Sterilizer"
            className={inputClass}
            value={sterilizer}
            placeholder="e.g. Autoclave 2"
            onChange={(e) => setSterilizer(e.target.value)}
          />
        </Field>
        <Field label="Started at">
          <input
            aria-label="Started at"
            type="datetime-local"
            className={inputClass}
            value={startedAt}
            onChange={(e) => setStartedAt(e.target.value)}
          />
        </Field>
        <Field
          label="Completed at"
          hint="With every indicator passed or not required, a completed load is released as passed."
        >
          <input
            aria-label="Completed at"
            type="datetime-local"
            className={inputClass}
            value={completedAt}
            onChange={(e) => setCompletedAt(e.target.value)}
          />
        </Field>
      </div>

      <IndicatorFields
        values={indicators}
        onChange={(key, value) =>
          setIndicators((prev) => ({ ...prev, [key]: value }))
        }
      />

      {anyFailed && (
        <Field label="Failure reason">
          <textarea
            aria-label="Failure reason"
            className={inputClass}
            rows={2}
            value={failureReason}
            onChange={(e) => setFailureReason(e.target.value)}
          />
        </Field>
      )}

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

/* ── Load status ────────────────────────────────────────────────────────── */

export function LoadStatusDialog({
  load,
  onClose,
}: {
  load: CssdLoad;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [status, setStatus] = useState(load.status);
  const [completedAt, setCompletedAt] = useState("");
  const [failureReason, setFailureReason] = useState("");
  const [notes, setNotes] = useState("");
  const [indicators, setIndicators] = useState<Indicators>({
    biological_indicator_result: asIndicator(load.biological_indicator_result),
    chemical_indicator_result: asIndicator(load.chemical_indicator_result),
    mechanical_indicator_result: asIndicator(load.mechanical_indicator_result),
  });
  const [failure, setFailure] = useState<string | null>(null);

  // Both rules below come from deriveLoadStatus() in cssdService.js: a failed
  // indicator forces 'failed' whatever status is asked for, and asking for
  // 'passed' with any indicator still pending is rejected outright
  // (CSSD_INDICATORS_PENDING).
  const anyFailed = Object.values(indicators).includes("failed");
  const anyPending = Object.values(indicators).includes("pending");

  const transition = useMutation({
    mutationFn: () =>
      transitionSterilizationLoad(load.id, {
        status: anyFailed ? undefined : status,
        ...indicators,
        completed_at: completedAt
          ? new Date(completedAt).toISOString()
          : undefined,
        failure_reason: failureReason.trim() || undefined,
        notes: notes.trim() || undefined,
      }),
    onSuccess: (updated) => {
      toast.success(
        `${load.load_code} recorded as ${humanize(updated?.status ?? status)}`,
      );
      qc.invalidateQueries({ queryKey: ["cssd"] });
      onClose();
    },
    onError: (err: unknown) =>
      setFailure(errorMessage(err, "Could not update the load")),
  });

  const blockedPassed = status === "passed" && anyPending;

  return (
    <Modal
      title={`Update load — ${load.load_code}`}
      onClose={onClose}
      wide
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
            disabled={blockedPassed || transition.isPending}
            onClick={() => {
              setFailure(null);
              transition.mutate();
            }}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            {transition.isPending ? "Saving…" : "Save load"}
          </button>
        </>
      }
    >
      <DialogError message={failure} />
      <p className="text-sm text-muted-foreground">
        Currently <StatusPill status={load.status} />. Releasing a load as
        passed marks every set in it sterilized and usable again.
      </p>

      <Field
        label="Status"
        hint="Cancelling a load leaves its sets awaiting sterilization — they stay out of circulation until another load carrying them passes."
      >
        <select
          aria-label="Load status"
          className={inputClass}
          value={anyFailed ? "failed" : status}
          disabled={anyFailed}
          onChange={(e) => setStatus(e.target.value)}
        >
          {CSSD_LOAD_STATUSES.map((option) => (
            <option
              key={option}
              value={option}
              disabled={option === "passed" && anyPending}
            >
              {humanize(option)}
              {option === "passed" && anyPending ? " (indicators pending)" : ""}
            </option>
          ))}
        </select>
      </Field>

      {anyFailed && (
        <DialogError message="A failed indicator forces this load to be recorded as failed, and its sets unusable until reprocessed." />
      )}

      <IndicatorFields
        values={indicators}
        onChange={(key, value) =>
          setIndicators((prev) => ({ ...prev, [key]: value }))
        }
      />

      <Field label="Completed at">
        <input
          aria-label="Completed at"
          type="datetime-local"
          className={inputClass}
          value={completedAt}
          onChange={(e) => setCompletedAt(e.target.value)}
        />
      </Field>

      {(anyFailed || status === "failed") && (
        <Field label="Failure reason">
          <textarea
            aria-label="Failure reason"
            className={inputClass}
            rows={2}
            value={failureReason}
            onChange={(e) => setFailureReason(e.target.value)}
          />
        </Field>
      )}

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
