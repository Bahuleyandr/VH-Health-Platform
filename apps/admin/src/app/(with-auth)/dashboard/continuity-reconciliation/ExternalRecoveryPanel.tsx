"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";

import {
  authorizeExternalRecoveryResume,
  loadExternalRecoveryWorkbench,
  registerExternalRecoveryOffset,
  type ExternalRecoveryReason,
  type ExternalRecoveryResumeReason,
  type ExternalRecoveryWorkbench,
  type ExternalRecoveryWorkbenchOffset,
} from "@/lib/api/externalRecoveryOperability";

const IMPLEMENTED_FAMILIES = [
  "I01",
  "I02",
  "I03",
  "I04",
  "I05",
  "I06",
  "I09",
  "I10",
  "I13",
  "I15",
  "I16",
  "I17",
  "I18",
  "I19",
  "I23",
  "I25",
] as const;

const EMPTY: ExternalRecoveryWorkbench = {
  offsets: [],
  count: 0,
  capabilities: {
    can_register_exact_partition: false,
    supports_predicate_bulk_mutation: false,
  },
};

function commandKey(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`;
}

function message(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "External-recovery command failed";
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="text-sm font-medium text-foreground">
      {label}
      {children}
    </label>
  );
}

const inputClass =
  "mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm";

export default function ExternalRecoveryPanel() {
  const [workbench, setWorkbench] = useState(EMPTY);
  const [familyFilter, setFamilyFilter] = useState("");
  const [stateFilter, setStateFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const refresh = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      setWorkbench(
        await loadExternalRecoveryWorkbench({
          interfaceFamily: familyFilter,
          recoveryState: stateFilter,
        }),
      );
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }, [familyFilter, stateFilter]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function mutate(label: string, command: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await command();
      await refresh();
      setNotice(label);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <div
        role="status"
        className="rounded-lg border border-amber-400 bg-amber-50 p-4 text-sm text-amber-950"
      >
        <strong>Exact-item authority only.</strong> Registration creates a
        paused or marker-missing offset; resume authorizes one exact partition.
        Neither command activates a family, starts a worker, dispatches work, or
        advances a cursor.
      </div>

      <section className="rounded-xl border border-border bg-card p-4 shadow-sm">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Family filter">
            <select
              value={familyFilter}
              onChange={(event) => setFamilyFilter(event.target.value)}
              className={inputClass}
            >
              <option value="">All implemented families</option>
              {IMPLEMENTED_FAMILIES.map((family) => (
                <option key={family} value={family}>
                  {family}
                </option>
              ))}
            </select>
          </Field>
          <Field label="State filter">
            <input
              value={stateFilter}
              onChange={(event) => setStateFilter(event.target.value)}
              className={inputClass}
              placeholder="paused"
            />
          </Field>
          <button
            type="button"
            disabled={busy}
            onClick={() => void refresh()}
            className="rounded-md border border-border px-4 py-2 text-sm font-semibold disabled:opacity-50"
          >
            Refresh output
          </button>
        </div>
      </section>

      <div aria-live="polite">
        {error ? (
          <p
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
          >
            {error}
          </p>
        ) : null}
        {notice ? (
          <p className="rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900">
            {notice}
          </p>
        ) : null}
      </div>

      <RegisterOffsetForm
        busy={busy}
        onSubmit={(command) =>
          mutate("Exact partition registration recorded.", command)
        }
      />

      <section className="rounded-xl border border-border bg-card p-4 shadow-sm">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">Observed partitions</h2>
          <span className="text-sm text-muted-foreground">
            {workbench.count} exact offset(s)
          </span>
        </div>
        {workbench.offsets.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No live external-recovery offset matches the current tenant filters.
          </p>
        ) : (
          <div className="space-y-4">
            {workbench.offsets.map((offset) => (
              <OffsetRow
                key={offset.offset_id}
                offset={offset}
                busy={busy}
                onSubmit={(command) =>
                  mutate("Exact resume authorization recorded.", command)
                }
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function RegisterOffsetForm({
  busy,
  onSubmit,
}: {
  busy: boolean;
  onSubmit: (command: () => Promise<unknown>) => Promise<void>;
}) {
  const [family, setFamily] = useState("I01");
  const [subpath, setSubpath] = useState("");
  const [protocol, setProtocol] = useState("");
  const [direction, setDirection] = useState("");
  const [partition, setPartition] = useState("");
  const [generation, setGeneration] = useState("1");
  const [facilityId, setFacilityId] = useState("");
  const [initialPosition, setInitialPosition] = useState("");
  const [initialToken, setInitialToken] = useState("");
  const [retainedPosition, setRetainedPosition] = useState("");
  const [retainedToken, setRetainedToken] = useState("");
  const [policyVersion, setPolicyVersion] = useState("");
  const [policySignature, setPolicySignature] = useState("");
  const [retentionPolicy, setRetentionPolicy] = useState("");
  const [retentionUntil, setRetentionUntil] = useState("");
  const [ownerReference, setOwnerReference] = useState("");
  const [ownerSignature, setOwnerSignature] = useState("");
  const [reason, setReason] = useState<ExternalRecoveryReason>(
    "initial_marker_reconciled",
  );
  const [detail, setDetail] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState(() =>
    commandKey("external-register"),
  );

  function submit(event: FormEvent) {
    event.preventDefault();
    const parsedGeneration = Number(generation);
    const parsedFacility = facilityId ? Number(facilityId) : null;
    const request = {
      interface_family: family,
      subpath: subpath.trim() || null,
      protocol: protocol.trim() || null,
      stream_direction: (direction || null) as "inbound" | "outbound" | null,
      source_partition: partition.trim(),
      generation: parsedGeneration,
      facility_id: parsedFacility,
      initial_position: initialPosition.trim() || null,
      initial_token: initialToken.trim() || null,
      retained_from_position: retainedPosition.trim() || null,
      retained_from_token: retainedToken.trim() || null,
      policy_version: policyVersion.trim(),
      policy_signature: policySignature.trim(),
      retention_policy: retentionPolicy.trim(),
      retention_until: new Date(retentionUntil).toISOString(),
      owner_evidence_reference: ownerReference.trim(),
      owner_evidence_signature: ownerSignature.trim(),
      reason_code: reason,
      reason_detail: detail.trim(),
    };
    void onSubmit(() =>
      registerExternalRecoveryOffset(idempotencyKey, request),
    );
  }

  return (
    <section className="rounded-xl border border-border bg-card p-4 shadow-sm">
      <h2 className="text-lg font-semibold">Register one exact partition</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Family class, scope, direction, cursor kind, consumer key, and next
        state are derived and rechecked by the server.
      </p>
      <form
        onSubmit={submit}
        className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3"
      >
        <Field label="Interface family">
          <select
            value={family}
            onChange={(event) => setFamily(event.target.value)}
            className={inputClass}
          >
            {IMPLEMENTED_FAMILIES.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </Field>
        <Field label="Mixed-family subpath (if required)">
          <input
            value={subpath}
            onChange={(event) => setSubpath(event.target.value)}
            className={inputClass}
            placeholder="study_link"
          />
        </Field>
        <Field label="I05 protocol">
          <input
            value={protocol}
            onChange={(event) => setProtocol(event.target.value)}
            className={inputClass}
            placeholder="hl7v2"
          />
        </Field>
        <Field label="I05 stream direction">
          <select
            value={direction}
            onChange={(event) => setDirection(event.target.value)}
            className={inputClass}
          >
            <option value="">Server-derived</option>
            <option value="inbound">Inbound</option>
            <option value="outbound">Outbound</option>
          </select>
        </Field>
        <Field label="Exact source partition">
          <input
            required
            value={partition}
            onChange={(event) => setPartition(event.target.value)}
            className={inputClass}
          />
        </Field>
        <Field label="Generation">
          <input
            required
            inputMode="numeric"
            value={generation}
            onChange={(event) => setGeneration(event.target.value)}
            className={inputClass}
          />
        </Field>
        <Field label="Facility ID (facility-scoped family only)">
          <input
            inputMode="numeric"
            value={facilityId}
            onChange={(event) => setFacilityId(event.target.value)}
            className={inputClass}
          />
        </Field>
        <Field label="Initial marker position">
          <input
            inputMode="numeric"
            value={initialPosition}
            onChange={(event) => setInitialPosition(event.target.value)}
            className={inputClass}
          />
        </Field>
        <Field label="Initial marker token">
          <input
            value={initialToken}
            onChange={(event) => setInitialToken(event.target.value)}
            className={inputClass}
          />
        </Field>
        <Field label="Retained-from position">
          <input
            inputMode="numeric"
            value={retainedPosition}
            onChange={(event) => setRetainedPosition(event.target.value)}
            className={inputClass}
          />
        </Field>
        <Field label="Retained-from token">
          <input
            value={retainedToken}
            onChange={(event) => setRetainedToken(event.target.value)}
            className={inputClass}
          />
        </Field>
        <Field label="Policy version">
          <input
            required
            value={policyVersion}
            onChange={(event) => setPolicyVersion(event.target.value)}
            className={inputClass}
          />
        </Field>
        <Field label="Signed policy evidence">
          <input
            required
            type="password"
            autoComplete="off"
            value={policySignature}
            onChange={(event) => setPolicySignature(event.target.value)}
            className={inputClass}
          />
        </Field>
        <Field label="Retention policy">
          <input
            required
            value={retentionPolicy}
            onChange={(event) => setRetentionPolicy(event.target.value)}
            className={inputClass}
          />
        </Field>
        <Field label="Retention cutoff">
          <input
            required
            type="datetime-local"
            value={retentionUntil}
            onChange={(event) => setRetentionUntil(event.target.value)}
            className={inputClass}
          />
        </Field>
        <Field label="Owner evidence reference">
          <input
            required
            value={ownerReference}
            onChange={(event) => setOwnerReference(event.target.value)}
            className={inputClass}
          />
        </Field>
        <Field label="Owner evidence signature">
          <input
            required
            type="password"
            autoComplete="off"
            value={ownerSignature}
            onChange={(event) => setOwnerSignature(event.target.value)}
            className={inputClass}
          />
        </Field>
        <Field label="Typed reason">
          <select
            value={reason}
            onChange={(event) =>
              setReason(event.target.value as ExternalRecoveryReason)
            }
            className={inputClass}
          >
            <option value="initial_marker_reconciled">
              Initial marker reconciled
            </option>
            <option value="retained_range_verified">
              Retained range verified
            </option>
            <option value="marker_absence_recorded">
              Marker absence recorded
            </option>
          </select>
        </Field>
        <Field label="Reason detail (10–500 characters)">
          <textarea
            required
            minLength={10}
            maxLength={500}
            value={detail}
            onChange={(event) => setDetail(event.target.value)}
            className={inputClass}
          />
        </Field>
        <Field label="Idempotency key">
          <input
            required
            value={idempotencyKey}
            onChange={(event) => setIdempotencyKey(event.target.value)}
            className={`${inputClass} font-mono`}
          />
        </Field>
        <div className="flex items-end">
          <button
            type="submit"
            disabled={busy}
            className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50"
          >
            Register exact partition
          </button>
        </div>
      </form>
    </section>
  );
}

function OffsetRow({
  offset,
  busy,
  onSubmit,
}: {
  offset: ExternalRecoveryWorkbenchOffset;
  busy: boolean;
  onSubmit: (command: () => Promise<unknown>) => Promise<void>;
}) {
  const [cutoffPosition, setCutoffPosition] = useState(
    offset.high_water_position ?? "",
  );
  const [cutoffToken, setCutoffToken] = useState("");
  const [ownerReference, setOwnerReference] = useState("");
  const [ownerSignature, setOwnerSignature] = useState("");
  const [reason, setReason] = useState<ExternalRecoveryResumeReason>(
    "resume_cutoff_reconciled",
  );
  const [detail, setDetail] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState(() =>
    commandKey(`external-resume:${offset.offset_id}`),
  );

  function submit(event: FormEvent) {
    event.preventDefault();
    void onSubmit(() =>
      authorizeExternalRecoveryResume(offset.offset_id, idempotencyKey, {
        expected_state_fingerprint: offset.state_fingerprint,
        resume_cutoff_position: cutoffPosition.trim(),
        resume_cutoff_token: cutoffToken.trim(),
        owner_evidence_reference: ownerReference.trim(),
        owner_evidence_signature: ownerSignature.trim(),
        reason_code: reason,
        reason_detail: detail.trim(),
      }),
    );
  }

  return (
    <article className="rounded-lg border border-border p-4 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold">
            {offset.interface_family} · {offset.direction} ·{" "}
            {offset.source_partition}
          </h3>
          <p className="text-muted-foreground">
            {offset.facility_scope === "tenant"
              ? "tenant-wide"
              : `facility ${offset.facility_id}`}{" "}
            · generation {offset.generation}
          </p>
        </div>
        <span className="rounded-full bg-amber-100 px-2 py-1 font-semibold text-amber-900">
          {offset.recovery_state.replaceAll("_", " ")}
        </span>
      </div>
      <dl className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-4">
        <div>
          <dt className="text-muted-foreground">High-water marker</dt>
          <dd className="break-all font-mono">
            {offset.high_water_position ?? "absent"} /{" "}
            {offset.high_water_token ?? "absent"}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Pending / oldest age</dt>
          <dd>
            {offset.observations.pending_rows} /{" "}
            {offset.observations.oldest_pending_age_seconds}s
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Dead</dt>
          <dd>{offset.observations.dead_rows}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">
            Unacknowledged late-critical
          </dt>
          <dd>{offset.observations.unacknowledged_critical_reviews}</dd>
        </div>
      </dl>
      <details className="mt-3">
        <summary className="cursor-pointer font-medium">
          Immutable state and command evidence
        </summary>
        <p className="mt-2 break-all font-mono text-xs">
          State SHA-256: {offset.state_fingerprint}
        </p>
        <pre className="mt-2 max-h-48 overflow-auto rounded bg-muted p-3 text-xs">
          {JSON.stringify(offset.latest_command_receipt, null, 2)}
        </pre>
      </details>
      {offset.capabilities.can_authorize_resume ? (
        <form
          onSubmit={submit}
          className="mt-4 grid gap-3 border-t border-border pt-4 md:grid-cols-2 xl:grid-cols-3"
        >
          <Field label="Exact resume cutoff position">
            <input
              required
              inputMode="numeric"
              value={cutoffPosition}
              onChange={(event) => setCutoffPosition(event.target.value)}
              className={inputClass}
            />
          </Field>
          <Field label="Exact resume cutoff token">
            <input
              required
              value={cutoffToken}
              onChange={(event) => setCutoffToken(event.target.value)}
              className={inputClass}
            />
          </Field>
          <Field label="Owner evidence reference">
            <input
              required
              value={ownerReference}
              onChange={(event) => setOwnerReference(event.target.value)}
              className={inputClass}
            />
          </Field>
          <Field label="Owner evidence signature">
            <input
              required
              type="password"
              autoComplete="off"
              value={ownerSignature}
              onChange={(event) => setOwnerSignature(event.target.value)}
              className={inputClass}
            />
          </Field>
          <Field label="Typed reason">
            <select
              value={reason}
              onChange={(event) =>
                setReason(event.target.value as ExternalRecoveryResumeReason)
              }
              className={inputClass}
            >
              <option value="resume_cutoff_reconciled">
                Resume cutoff reconciled
              </option>
              <option value="source_count_reconciled">
                Source count reconciled
              </option>
              <option value="owner_recovery_evidence_reconciled">
                Owner recovery evidence reconciled
              </option>
            </select>
          </Field>
          <Field label="Reason detail (10–500 characters)">
            <textarea
              required
              minLength={10}
              maxLength={500}
              value={detail}
              onChange={(event) => setDetail(event.target.value)}
              className={inputClass}
            />
          </Field>
          <Field label="Idempotency key">
            <input
              required
              value={idempotencyKey}
              onChange={(event) => setIdempotencyKey(event.target.value)}
              className={`${inputClass} font-mono`}
            />
          </Field>
          <div className="flex items-end">
            <button
              type="submit"
              disabled={busy}
              className="rounded-md bg-primary px-4 py-2 font-semibold text-primary-foreground disabled:opacity-50"
            >
              Authorize exact resume
            </button>
          </div>
        </form>
      ) : (
        <p className="mt-3 text-sm font-medium text-muted-foreground">
          Resume unavailable:{" "}
          {offset.refusal_reasons.join(", ") ||
            "server-derived capability is false"}
          .
        </p>
      )}
    </article>
  );
}
