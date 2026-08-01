"use client";

import { Dialog, DialogPanel, DialogTitle } from "@headlessui/react";
import { useState, type FormEvent, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  classifyContinuityFacilityError,
  type ContinuityFacilityFailure,
  type ContinuityFacilityGrant,
  type ContinuityFacilityGrantPurpose,
  type ContinuityFacilityRevocation,
  type ContinuityFacilitySuccessEnvelope,
  type EnrollContinuityFacilityGrantBody,
  type RevokeContinuityFacilityGrantBody,
} from "@/lib/api/continuityFacilityContext";

export type EnrollGrant = (
  body: EnrollContinuityFacilityGrantBody,
) => Promise<
  ContinuityFacilitySuccessEnvelope<{ grant: ContinuityFacilityGrant }>
>;

export type RevokeGrant = (
  body: RevokeContinuityFacilityGrantBody,
) => Promise<
  ContinuityFacilitySuccessEnvelope<{
    revocation: ContinuityFacilityRevocation;
  }>
>;

type GrantReceipt =
  | {
      outcome: "success";
      message: string;
      requestId?: string;
      grant?: ContinuityFacilityGrant;
      revocation?: ContinuityFacilityRevocation;
    }
  | {
      outcome: "failure";
      failure: ContinuityFacilityFailure;
    };

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-1 break-all font-mono text-xs text-foreground">
        {children ?? "Unavailable from server"}
      </dd>
    </div>
  );
}

export function GrantDetails({ grant }: { grant: ContinuityFacilityGrant }) {
  return (
    <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      <Field label="Grant UUID">{grant.id}</Field>
      <Field label="Purpose">{grant.grant_purpose}</Field>
      <Field label="Subject kind">{grant.subject_kind}</Field>
      <Field label="Staff UID">{grant.staff_uid}</Field>
      <Field label="Stable device UUID">{grant.device_id}</Field>
      <Field label="Facility ID">{String(grant.facility_id)}</Field>
      <Field label="Capture revision">{grant.capture_revision}</Field>
      <Field label="Credential SHA-256">{grant.device_credential_sha256}</Field>
      <Field label="Policy UUID">{grant.policy_version_id}</Field>
      <Field label="Policy version">{grant.policy_version}</Field>
      <Field label="Valid from">{grant.valid_from}</Field>
      <Field label="Valid until">{grant.valid_until}</Field>
      <Field label="Created by">{grant.created_by}</Field>
      <Field label="Created at">{grant.created_at}</Field>
      <Field label="Revocation UUID">{grant.revocation_id}</Field>
      <Field label="Revocation revision">{grant.revocation_revision}</Field>
      <Field label="Revoked at">{grant.revoked_at}</Field>
      <Field label="Revocation reason">{grant.reason}</Field>
      <Field label="Historic revoker UID">Unavailable from list contract</Field>
    </dl>
  );
}

function ActionReceipt({ receipt }: { receipt: GrantReceipt | null }) {
  if (!receipt) return null;

  if (receipt.outcome === "failure") {
    return (
      <div
        role="status"
        className="rounded-xl border border-destructive/40 bg-destructive/10 p-4 text-sm"
      >
        <div className="flex items-start gap-3">
          <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-error-on-surface" />
          <div className="min-w-0">
            <p className="font-semibold text-error-on-surface">
              Action not completed
            </p>
            <p className="mt-1 text-foreground">{receipt.failure.message}</p>
            {receipt.failure.code && (
              <p className="mt-2 break-all font-mono text-xs">
                {receipt.failure.code}
              </p>
            )}
            <p className="mt-2 text-xs text-muted-foreground">
              Audit reference: {receipt.failure.requestId ?? "Not returned"}
            </p>
          </div>
        </div>
      </div>
    );
  }

  const record = receipt.grant ?? receipt.revocation;
  return (
    <div
      role="status"
      className="rounded-xl border border-success/40 bg-success/10 p-4 text-sm"
    >
      <div className="flex items-start gap-3">
        <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-success-on-surface" />
        <div className="min-w-0">
          <p className="font-semibold text-success-on-surface">
            Server receipt recorded
          </p>
          <p className="mt-1 text-foreground">{receipt.message}</p>
          {record && (
            <p className="mt-2 break-all font-mono text-xs">
              Record UUID: {record.id} · Capture revision:{" "}
              {record.capture_revision}
            </p>
          )}
          <p className="mt-2 text-xs text-muted-foreground">
            Audit reference: {receipt.requestId ?? "Not returned"}
          </p>
        </div>
      </div>
    </div>
  );
}

interface TypedConfirmationDialogProps {
  open: boolean;
  title: string;
  description: string;
  confirmationValue: string;
  confirmationLabel: string;
  pending: boolean;
  destructive?: boolean;
  children: ReactNode;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}

function TypedConfirmationDialog({
  open,
  title,
  description,
  confirmationValue,
  confirmationLabel,
  pending,
  destructive = false,
  children,
  onClose,
  onConfirm,
}: TypedConfirmationDialogProps) {
  const [typedValue, setTypedValue] = useState("");
  const close = () => {
    if (pending) return;
    setTypedValue("");
    onClose();
  };

  const confirm = async () => {
    if (typedValue !== confirmationValue || pending) return;
    await onConfirm();
    setTypedValue("");
  };

  return (
    <Dialog open={open} onClose={close} className="relative z-50">
      <div className="fixed inset-0 bg-black/40" aria-hidden="true" />
      <div className="fixed inset-0 overflow-y-auto p-4">
        <div className="flex min-h-full items-center justify-center">
          <DialogPanel className="w-full max-w-2xl rounded-xl border border-border bg-card p-6 shadow-2xl">
            <DialogTitle className="text-lg font-semibold text-foreground">
              {title}
            </DialogTitle>
            <p className="mt-2 text-sm text-muted-foreground">{description}</p>
            <div className="mt-5 rounded-xl border border-border bg-muted/50 p-4">
              {children}
            </div>
            <div className="mt-5">
              <Input
                id="typed-action-confirmation"
                label={`${confirmationLabel} to confirm`}
                value={typedValue}
                onChange={(event) => setTypedValue(event.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <div className="mt-6 flex justify-end gap-3">
              <Button variant="outline" onClick={close} disabled={pending}>
                Cancel
              </Button>
              <Button
                variant={destructive ? "destructive" : "default"}
                onClick={() => void confirm()}
                disabled={typedValue !== confirmationValue || pending}
              >
                {pending ? "Waiting for server…" : "Confirm exact action"}
              </Button>
            </div>
          </DialogPanel>
        </div>
      </div>
    </Dialog>
  );
}

interface EnrollmentFormProps {
  purpose: ContinuityFacilityGrantPurpose;
  onEnroll: EnrollGrant;
  onChanged: () => void;
}

export function EnrollmentForm({
  purpose,
  onEnroll,
  onChanged,
}: EnrollmentFormProps) {
  const requiresStaff = purpose === "capture_staff_facility";
  const [showForm, setShowForm] = useState(false);
  const [pendingBody, setPendingBody] =
    useState<EnrollContinuityFacilityGrantBody | null>(null);
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<GrantReceipt | null>(null);
  const [fields, setFields] = useState({
    facilityId: "",
    staffUid: "",
    deviceId: "",
    publicKey: "",
    validFrom: "",
    validUntil: "",
  });

  const updateField = (name: keyof typeof fields, value: string) => {
    setFields((current) => ({ ...current, [name]: value }));
  };

  const prepareConfirmation = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError(null);
    const facilityId = Number(fields.facilityId);
    const from = new Date(fields.validFrom);
    const until = new Date(fields.validUntil);
    if (!Number.isInteger(facilityId) || facilityId <= 0) {
      setFormError(
        "Facility ID must be a positive integer returned by the server.",
      );
      return;
    }
    if (Number.isNaN(from.valueOf()) || Number.isNaN(until.valueOf())) {
      setFormError("Both validity timestamps are required.");
      return;
    }
    if (until.valueOf() <= from.valueOf()) {
      setFormError("Valid until must be later than valid from.");
      return;
    }

    setPendingBody({
      facility_id: facilityId,
      grant_purpose: purpose,
      ...(requiresStaff ? { staff_uid: fields.staffUid.trim() } : {}),
      device_id: fields.deviceId.trim(),
      device_public_key_base64: fields.publicKey.trim(),
      valid_from: from.toISOString(),
      valid_until: until.toISOString(),
    });
  };

  const submit = async () => {
    if (!pendingBody) return;
    setPending(true);
    try {
      const response = await onEnroll(pendingBody);
      setReceipt({
        outcome: "success",
        message: response.message ?? "Facility-context grant created",
        requestId: response.requestId,
        grant: response.data.grant,
      });
      setPendingBody(null);
      setShowForm(false);
      setFields({
        facilityId: "",
        staffUid: "",
        deviceId: "",
        publicKey: "",
        validFrom: "",
        validUntil: "",
      });
      onChanged();
    } catch (error) {
      setReceipt({
        outcome: "failure",
        failure: classifyContinuityFacilityError(error),
      });
      setPendingBody(null);
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="space-y-4">
      <Button
        variant={showForm ? "secondary" : "default"}
        onClick={() => setShowForm((value) => !value)}
      >
        {showForm
          ? "Close enrollment form"
          : requiresStaff
            ? "Issue exact staff/device grant"
            : "Enroll fixed device"}
      </Button>

      {showForm && (
        <form
          onSubmit={prepareConfirmation}
          className="grid gap-4 rounded-xl border border-border bg-muted/30 p-4 md:grid-cols-2"
        >
          <Input
            id={`${purpose}-facility-id`}
            label="Facility ID"
            inputMode="numeric"
            required
            value={fields.facilityId}
            onChange={(event) => updateField("facilityId", event.target.value)}
          />
          {requiresStaff && (
            <Input
              id={`${purpose}-staff-uid`}
              label="Exact Staff UID"
              required
              value={fields.staffUid}
              onChange={(event) => updateField("staffUid", event.target.value)}
            />
          )}
          <Input
            id={`${purpose}-device-id`}
            label="Stable device UUID"
            required
            value={fields.deviceId}
            onChange={(event) => updateField("deviceId", event.target.value)}
          />
          <Input
            id={`${purpose}-valid-from`}
            label="Valid from"
            type="datetime-local"
            required
            value={fields.validFrom}
            onChange={(event) => updateField("validFrom", event.target.value)}
          />
          <Input
            id={`${purpose}-valid-until`}
            label="Valid until"
            type="datetime-local"
            required
            value={fields.validUntil}
            onChange={(event) => updateField("validUntil", event.target.value)}
          />
          <div className="md:col-span-2">
            <label
              htmlFor={`${purpose}-public-key`}
              className="mb-1 block text-sm font-medium text-foreground"
            >
              Operator-supplied Ed25519 public key (base64)
            </label>
            <Textarea
              id={`${purpose}-public-key`}
              required
              rows={3}
              value={fields.publicKey}
              onChange={(event) => updateField("publicKey", event.target.value)}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Unverified provisioning input until the server accepts it. The
              portal does not derive device identity from FCM, browser, host, or
              clinical-device records.
            </p>
          </div>
          {formError && (
            <p
              role="alert"
              className="text-sm text-error-on-surface md:col-span-2"
            >
              {formError}
            </p>
          )}
          <div className="md:col-span-2 flex justify-end">
            <Button type="submit">Review exact enrollment</Button>
          </div>
        </form>
      )}

      <ActionReceipt receipt={receipt} />

      {pendingBody && (
        <TypedConfirmationDialog
          open
          title="Confirm exact enrollment"
          description="The server will append a new grant. Review every value and type the full stable device UUID."
          confirmationValue={pendingBody.device_id}
          confirmationLabel="Stable device UUID"
          pending={pending}
          onClose={() => setPendingBody(null)}
          onConfirm={submit}
        >
          <dl className="grid gap-3 sm:grid-cols-2">
            <Field label="Purpose">{pendingBody.grant_purpose}</Field>
            <Field label="Staff UID">{pendingBody.staff_uid}</Field>
            <Field label="Stable device UUID">{pendingBody.device_id}</Field>
            <Field label="Facility ID">{String(pendingBody.facility_id)}</Field>
            <Field label="Valid from">{pendingBody.valid_from}</Field>
            <Field label="Valid until">{pendingBody.valid_until}</Field>
            <Field label="Operator-supplied public key">
              {pendingBody.device_public_key_base64}
            </Field>
          </dl>
        </TypedConfirmationDialog>
      )}
    </div>
  );
}

interface RevokeGrantButtonProps {
  grant: ContinuityFacilityGrant;
  onRevoke: RevokeGrant;
  onChanged: () => void;
  defaultReason?: string;
}

export function RevokeGrantButton({
  grant,
  onRevoke,
  onChanged,
  defaultReason = "",
}: RevokeGrantButtonProps) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState(defaultReason);
  const [typedGrantId, setTypedGrantId] = useState("");
  const [pending, setPending] = useState(false);
  const [receipt, setReceipt] = useState<GrantReceipt | null>(null);
  const hasControlCharacter = [...reason].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
  const reasonValid =
    reason.trim().length > 0 && reason.length <= 500 && !hasControlCharacter;

  const close = () => {
    if (pending) return;
    setOpen(false);
    setTypedGrantId("");
  };

  const submit = async () => {
    if (!reasonValid || typedGrantId !== grant.id || pending) return;
    setPending(true);
    try {
      const response = await onRevoke({
        facility_id: grant.facility_id,
        grant_id: grant.id,
        reason: reason.trim(),
      });
      setReceipt({
        outcome: "success",
        message: response.message ?? "Facility-context grant revoked",
        requestId: response.requestId,
        revocation: response.data.revocation,
      });
      setOpen(false);
      setTypedGrantId("");
      onChanged();
    } catch (error) {
      setReceipt({
        outcome: "failure",
        failure: classifyContinuityFacilityError(error),
      });
      setOpen(false);
      setTypedGrantId("");
    } finally {
      setPending(false);
    }
  };

  if (grant.revocation_id) return null;

  return (
    <div className="space-y-3">
      <Button variant="destructive" size="sm" onClick={() => setOpen(true)}>
        Revoke this exact grant
      </Button>
      <ActionReceipt receipt={receipt} />
      <Dialog open={open} onClose={close} className="relative z-50">
        <div className="fixed inset-0 bg-black/40" aria-hidden="true" />
        <div className="fixed inset-0 overflow-y-auto p-4">
          <div className="flex min-h-full items-center justify-center">
            <DialogPanel className="w-full max-w-2xl rounded-xl border border-border bg-card p-6 shadow-2xl">
              <DialogTitle className="flex items-center gap-2 text-lg font-semibold text-foreground">
                <AlertTriangle className="h-5 w-5 text-error-on-surface" />
                Confirm one exact revocation
              </DialogTitle>
              <p className="mt-2 text-sm text-muted-foreground">
                This appends one revocation. It does not revoke sessions,
                edge-read grants, issue a wipe order, or route needs_review.
              </p>
              <div className="mt-5 rounded-xl border border-border bg-muted/50 p-4">
                <dl className="grid gap-3 sm:grid-cols-2">
                  <Field label="Grant UUID">{grant.id}</Field>
                  <Field label="Purpose">{grant.grant_purpose}</Field>
                  <Field label="Staff UID">{grant.staff_uid}</Field>
                  <Field label="Stable device UUID">{grant.device_id}</Field>
                  <Field label="Facility ID">{String(grant.facility_id)}</Field>
                  <Field label="Validity">
                    {grant.valid_from} — {grant.valid_until}
                  </Field>
                </dl>
              </div>
              <div className="mt-5 space-y-4">
                <div>
                  <label
                    htmlFor={`revoke-reason-${grant.id}`}
                    className="mb-1 block text-sm font-medium"
                  >
                    Revocation reason
                  </label>
                  <Textarea
                    id={`revoke-reason-${grant.id}`}
                    rows={3}
                    maxLength={500}
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    Required, at most 500 characters, with no control
                    characters.
                  </p>
                </div>
                <Input
                  id={`revoke-confirm-${grant.id}`}
                  label="Type the full grant UUID to confirm"
                  value={typedGrantId}
                  onChange={(event) => setTypedGrantId(event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
              <div className="mt-6 flex justify-end gap-3">
                <Button variant="outline" onClick={close} disabled={pending}>
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => void submit()}
                  disabled={
                    !reasonValid || typedGrantId !== grant.id || pending
                  }
                >
                  {pending ? "Waiting for server…" : "Append revocation"}
                </Button>
              </div>
            </DialogPanel>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
