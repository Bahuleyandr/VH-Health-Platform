"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import {
  CheckCircle2,
  CircleAlert,
  ExternalLink,
  Loader2,
  ShieldAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  extractContinuityDeviceLossOperation,
  orchestrateContinuityDeviceLoss,
  type ContinuityDeviceLossOperation,
  type ContinuityDeviceLossStepName,
} from "@/lib/api/continuityFacilityContext";

const DEVICE_LOSS_RUNBOOK_URL =
  "https://github.com/Bahuleyandr/VH-Health-Platform/blob/main/docs/continuity/c4-device-loss-operator-runbook.md";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const STEP_LABELS: Record<ContinuityDeviceLossStepName, string> = {
  capture_grants: "Capture-grant revocation",
  edge_read_grants: "C3 edge-read grant revocation",
  identity_access: "C-D15 identity access shutdown",
  tokens: "Token revocation",
  wipe_order: "Signed wipe-order issuance",
  needs_review_routing: "C-D6 needs_review routing",
  offline_pack_risk: "Residual offline-pack risk",
};

function parseStaffUids(value: string) {
  return [...new Set(value.split(/[\s,]+/).map((uid) => uid.trim()).filter(Boolean))].sort();
}

function newIdempotencyKey() {
  return `device-loss-${globalThis.crypto.randomUUID()}`;
}

function Evidence({ operation }: { operation: ContinuityDeviceLossOperation }) {
  return (
    <section aria-live="polite" className="space-y-4">
      <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="font-semibold text-foreground">Ordered server evidence</h3>
            <p className="mt-1 font-mono text-xs text-muted-foreground">
              Operation {operation.operation_id}
            </p>
          </div>
          <span className="rounded-lg border border-primary/30 bg-primary/10 px-2.5 py-1 text-xs font-semibold text-primary">
            {operation.state}
          </span>
        </div>

        <ol className="mt-5 space-y-3">
          {operation.steps.map((step, index) => {
            const proved = step.state !== "retryable_failed";
            return (
              <li key={step.name} className="rounded-lg border border-border p-3">
                <div className="flex items-start gap-3">
                  {proved ? (
                    <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-success" />
                  ) : (
                    <CircleAlert className="mt-0.5 h-5 w-5 shrink-0 text-error-on-surface" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="font-medium text-foreground">
                        {index + 1}. {STEP_LABELS[step.name]}
                      </p>
                      <span className="text-xs text-muted-foreground">
                        {step.state}; attempt {step.attempt}
                      </span>
                    </div>
                    {step.error_code && (
                      <p className="mt-1 font-mono text-xs text-error-on-surface">
                        {step.error_code}
                      </p>
                    )}
                    {step.expires_no_later_than && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        Access expires no later than {step.expires_no_later_than}
                      </p>
                    )}
                    <div className="mt-2 space-y-1 font-mono text-xs text-muted-foreground">
                      {step.evidence_ids.length === 0 ? (
                        <p>No audit evidence ID recorded yet.</p>
                      ) : (
                        step.evidence_ids.map((id) => <p key={id}>{id}</p>)
                      )}
                    </div>
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
          <h3 className="font-semibold text-foreground">Affected identities</h3>
          <div className="mt-3 space-y-3">
            {operation.subjects.map((subject) => (
              <div key={subject.staff_uid} className="rounded-lg border border-border p-3 text-sm">
                <p className="break-all font-mono font-medium">{subject.staff_uid}</p>
                <p className="mt-1 text-muted-foreground">
                  Identity: {subject.identity_revocation}; tokens: {subject.token_revocation}
                </p>
                {subject.break_glass && (
                  <p className="mt-1 font-medium text-warning">
                    Named break-glass account excluded by C-D15.
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
          <h3 className="font-semibold text-foreground">Governed wipe order</h3>
          {operation.wipe_order ? (
            <dl className="mt-3 space-y-2 text-sm">
              <div>
                <dt className="text-muted-foreground">Order</dt>
                <dd className="break-all font-mono">{operation.wipe_order.order_id}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Signing key / algorithm</dt>
                <dd className="break-all font-mono">
                  {operation.wipe_order.key_id} / {operation.wipe_order.algorithm}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Content hash</dt>
                <dd className="break-all font-mono text-xs">
                  {operation.wipe_order.content_hash}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Delivery</dt>
                <dd>{operation.wipe_order.delivery_state}</dd>
              </div>
            </dl>
          ) : (
            <p className="mt-3 text-sm text-muted-foreground">
              No signed order exists yet. Re-invocation will resume this operation without
              minting a second order identifier.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

export function DeviceLossPanel({ onChanged }: { onChanged?: () => void } = {}) {
  const [deviceId, setDeviceId] = useState("");
  const [staffUidInput, setStaffUidInput] = useState("");
  const [fixedDeviceOnly, setFixedDeviceOnly] = useState(false);
  const [incidentReference, setIncidentReference] = useState("");
  const [reason, setReason] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState<string | null>(null);
  const [operation, setOperation] = useState<ContinuityDeviceLossOperation | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const staffUids = useMemo(() => parseStaffUids(staffUidInput), [staffUidInput]);
  const invalidStaffUid = staffUids.some((uid) => !UUID_PATTERN.test(uid));
  const normalizedDeviceId = deviceId.trim();
  const canSubmit =
    UUID_PATTERN.test(normalizedDeviceId) &&
    (staffUids.length > 0 || fixedDeviceOnly) &&
    !invalidStaffUid &&
    incidentReference.trim().length >= 3 &&
    reason.trim().length >= 3 &&
    confirmation.trim() === normalizedDeviceId &&
    !submitting;

  const resetAttempt = () => {
    setIdempotencyKey(null);
    setOperation(null);
    setErrorMessage(null);
  };

  const submit = async () => {
    if (!canSubmit) return;
    const key = idempotencyKey ?? newIdempotencyKey();
    setIdempotencyKey(key);
    setSubmitting(true);
    setErrorMessage(null);
    try {
      const response = await orchestrateContinuityDeviceLoss(
        {
          stable_device_id: normalizedDeviceId,
          affected_staff_uids: staffUids,
          incident_reference: incidentReference.trim(),
          reason: reason.trim(),
        },
        key,
      );
      setOperation(response.data);
      onChanged?.();
    } catch (error) {
      const incomplete = extractContinuityDeviceLossOperation(error);
      if (incomplete) setOperation(incomplete);
      setErrorMessage(error instanceof Error ? error.message : "Device-loss orchestration failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section aria-labelledby="device-loss-execution" className="space-y-5">
      <div className="rounded-xl border border-destructive/40 bg-destructive/10 p-5 shadow-sm">
        <div className="flex items-start gap-3">
          <ShieldAlert className="mt-0.5 h-6 w-6 shrink-0 text-error-on-surface" />
          <div>
            <h2 id="device-loss-execution" className="text-lg font-semibold">
              Unified device-loss containment
            </h2>
            <p className="mt-2 text-sm text-foreground">
              One SUPER_ADMIN action executes the ordered server workflow: capture and edge-read
              revocation, C-D15 identity shutdown, token revocation, one signed wipe order, and
              C-D6 needs_review routing. Every step returns append-only audit evidence.
            </p>
            <p className="mt-2 text-sm font-medium text-foreground">
              A retry keeps the same idempotency key and resumes only unfinished work. Physical
              recovery, wipe delivery/execution verification, and accountable closure remain in
              the operator runbook.
            </p>
            <Link
              href={DEVICE_LOSS_RUNBOOK_URL}
              target="_blank"
              rel="noreferrer"
              className="mt-3 inline-flex items-center gap-2 text-sm font-semibold text-primary underline underline-offset-4"
            >
              Open physical handling and verification runbook
              <ExternalLink className="h-4 w-4" aria-hidden="true" />
            </Link>
          </div>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-4 rounded-xl border border-border bg-card p-5 shadow-sm">
          <Input
            id="device-loss-stable-device-id"
            label="Exact stable device UUID"
            value={deviceId}
            onChange={(event) => {
              setDeviceId(event.target.value);
              resetAttempt();
            }}
            placeholder="Paste the full server-proved device UUID"
            autoComplete="off"
            spellCheck={false}
          />
          <Textarea
            id="device-loss-staff-uids"
            label="Affected Staff UIDs"
            value={staffUidInput}
            onChange={(event) => {
              setStaffUidInput(event.target.value);
              resetAttempt();
            }}
            placeholder="One exact Staff UID per line"
            error={invalidStaffUid ? "Every affected Staff UID must be a UUID." : undefined}
            disabled={fixedDeviceOnly}
            spellCheck={false}
          />
          <label className="flex items-start gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={fixedDeviceOnly}
              onChange={(event) => {
                const checked = event.target.checked;
                setFixedDeviceOnly(checked);
                if (checked) setStaffUidInput("");
                resetAttempt();
              }}
              className="mt-1 h-4 w-4 rounded border-input"
            />
            <span>
              No Staff identity is affected. The server must prove an active
              fixed-device capture grant or it will reject the request before mutation.
            </span>
          </label>
          <Input
            id="device-loss-incident-reference"
            label="Incident reference"
            value={incidentReference}
            onChange={(event) => {
              setIncidentReference(event.target.value);
              resetAttempt();
            }}
            placeholder="Security or continuity incident reference"
          />
          <Textarea
            id="device-loss-reason"
            label="Containment reason"
            value={reason}
            onChange={(event) => {
              setReason(event.target.value);
              resetAttempt();
            }}
            placeholder="Incident-specific reason recorded in every audit step"
            maxLength={500}
          />
        </div>

        <div className="space-y-4 rounded-xl border border-border bg-card p-5 shadow-sm">
          <div>
            <h3 className="font-semibold text-foreground">Exact-target confirmation</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              Verify the device and affected identities against the authoritative incident record.
              Break-glass identities remain excluded exactly as C-D15 requires.
            </p>
          </div>
          <Input
            id="device-loss-confirmation"
            label="Type the exact stable device UUID to execute"
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <Button
            variant="destructive"
            className="w-full"
            disabled={!canSubmit}
            onClick={() => void submit()}
          >
            {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
            Execute ordered containment
          </Button>
          {idempotencyKey && (
            <p className="break-all font-mono text-xs text-muted-foreground">
              Retry key: {idempotencyKey}
            </p>
          )}
          {errorMessage && (
            <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-error-on-surface">
              {errorMessage}. Correct any preflight issue, or re-run the unchanged request to
              resume its first unfinished server step.
            </div>
          )}
        </div>
      </div>

      {operation && <Evidence operation={operation} />}
    </section>
  );
}
