"use client";

import {
  KMS_PROVIDERS,
  REGISTRY_ALGORITHMS,
  type EncryptionKey,
  type EncryptionKeyRefusal,
  type KmsProvider,
  type RegisterKeyPayload,
  type RegistryAlgorithm,
  type RotateKeyPayload,
} from "@/lib/api/encryptionKeys";
import { AlertTriangle } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

const inputClass =
  "w-full rounded-md border border-border bg-background px-3 py-2 text-sm";

/**
 * A failed action, as the dialogs render it: the backend's message verbatim,
 * plus the machine-readable refusal when `readEncryptionKeyRefusal` recognised
 * one. `refusal` is null for anything that is not a registry-fence code — a
 * transport failure, a 404, a duplicate key_id — so the strip never labels an
 * unrelated failure a fence refusal.
 */
export interface ActionError {
  message: string;
  refusal: EncryptionKeyRefusal | null;
}

function DialogShell({
  label,
  onClose,
  children,
}: {
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={label}
      className="fixed inset-0 z-40 flex items-center justify-center"
    >
      <div
        className="absolute inset-0 bg-black/50"
        onClick={onClose}
        aria-hidden="true"
      />
      <div className="relative z-10 mx-4 max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-lg border border-border bg-background p-6 shadow-lg">
        {children}
      </div>
    </div>
  );
}

function Consequence({
  children,
  tone = "amber",
}: {
  children: ReactNode;
  tone?: "amber" | "red";
}) {
  const color =
    tone === "red"
      ? "border-red-300 bg-red-50 text-red-900"
      : "border-amber-300 bg-amber-50 text-amber-900";
  return (
    <div
      className={`mt-3 flex items-start gap-2 rounded-md border p-3 text-sm ${color}`}
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <div>{children}</div>
    </div>
  );
}

/**
 * The backend's message, unedited, plus the refusal code when there is one.
 *
 * Every code `readEncryptionKeyRefusal` recognises is raised either before the
 * request's write statement runs or by a guarded statement that matched no row,
 * so "no row was created or changed" holds for all of them.
 */
function ErrorStrip({ error }: { error: ActionError | null }) {
  if (!error) return null;
  return (
    <div className="mt-3 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
      <p>{error.message}</p>
      {error.refusal && (
        <p className="mt-2 text-xs">
          Refused by the backend registry fence — no row was created or changed.
          Code <span className="font-mono">{error.refusal.code}</span>
          {error.refusal.keyClass ? (
            <>
              , class{" "}
              <span className="font-mono">{error.refusal.keyClass}</span>
            </>
          ) : null}
          .
        </p>
      )}
    </div>
  );
}

function FooterButtons({
  onClose,
  onConfirm,
  confirmLabel,
  disabled,
  submitting,
  destructive,
}: {
  onClose: () => void;
  onConfirm: () => void;
  confirmLabel: string;
  disabled?: boolean;
  submitting: boolean;
  destructive?: boolean;
}) {
  return (
    <div className="mt-6 flex justify-end gap-3">
      <button
        type="button"
        onClick={onClose}
        disabled={submitting}
        className="rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground hover:bg-accent disabled:opacity-50"
      >
        Cancel
      </button>
      <button
        type="button"
        onClick={onConfirm}
        disabled={disabled || submitting}
        className={`rounded-md px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 ${
          destructive
            ? "bg-red-600 text-white hover:bg-red-700"
            : "bg-primary text-primary-foreground hover:bg-primary/90"
        }`}
      >
        {submitting ? "Working…" : confirmLabel}
      </button>
    </div>
  );
}

/* =========================
 * Register / Rotate (shared form)
 * ========================= */

export function KeyFormDialog({
  mode,
  open,
  onClose,
  onRegister,
  onRotate,
  submitting,
  error,
}: {
  mode: "register" | "rotate";
  open: boolean;
  onClose: () => void;
  onRegister?: (payload: RegisterKeyPayload) => void;
  onRotate?: (payload: RotateKeyPayload) => void;
  submitting: boolean;
  error: ActionError | null;
}) {
  const [keyId, setKeyId] = useState("");
  const [provider, setProvider] = useState<KmsProvider>("env");
  const [providerReference, setProviderReference] = useState("");
  // Constrained, not free text: a typed algorithm the fence excludes (Ed25519)
  // used to mint a row that vanished from the next read. See
  // REGISTRY_ALGORITHMS in lib/api/encryptionKeys.ts.
  const [algorithm, setAlgorithm] = useState<RegistryAlgorithm>("aes-256-gcm");

  useEffect(() => {
    if (open) {
      setKeyId("");
      setProvider("env");
      setProviderReference("");
      setAlgorithm("aes-256-gcm");
    }
  }, [open]);

  if (!open) return null;

  const isRotate = mode === "rotate";
  const title = isRotate ? "Rotate active key" : "Register new key";
  const keyLabel = isRotate ? "New key id" : "Key id";

  const submit = () => {
    const base = {
      provider,
      provider_reference: providerReference.trim() || null,
      algorithm,
    };
    if (isRotate) {
      onRotate?.({ new_key_id: keyId.trim(), ...base });
    } else {
      onRegister?.({ key_id: keyId.trim(), ...base });
    }
  };

  return (
    <DialogShell label={title} onClose={onClose}>
      <h2 className="text-lg font-semibold text-foreground">{title}</h2>
      <div className="mt-4 space-y-3">
        <div>
          <label
            htmlFor="key-form-key-id"
            className="mb-1 block text-xs font-medium text-muted-foreground"
          >
            {keyLabel}
          </label>
          <input
            id="key-form-key-id"
            aria-label={keyLabel}
            className={inputClass}
            value={keyId}
            onChange={(e) => setKeyId(e.target.value)}
            placeholder="e.g. phi-kek-v3"
          />
        </div>
        <div>
          <label
            htmlFor="key-form-provider"
            className="mb-1 block text-xs font-medium text-muted-foreground"
          >
            KMS provider
          </label>
          <select
            id="key-form-provider"
            className={inputClass}
            value={provider}
            onChange={(e) => setProvider(e.target.value as KmsProvider)}
          >
            {KMS_PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label
            htmlFor="key-form-provider-ref"
            className="mb-1 block text-xs font-medium text-muted-foreground"
          >
            Provider reference (ARN / resource name, optional)
          </label>
          <input
            id="key-form-provider-ref"
            aria-label="Provider reference (ARN / resource name, optional)"
            className={inputClass}
            value={providerReference}
            onChange={(e) => setProviderReference(e.target.value)}
          />
        </div>
        <div>
          <label
            htmlFor="key-form-algorithm"
            className="mb-1 block text-xs font-medium text-muted-foreground"
          >
            Algorithm
          </label>
          <select
            id="key-form-algorithm"
            aria-label="Algorithm"
            className={inputClass}
            value={algorithm}
            onChange={(e) => setAlgorithm(e.target.value as RegistryAlgorithm)}
          >
            {REGISTRY_ALGORITHMS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-muted-foreground">
            The symmetric envelope ciphers this platform provisions. A signature
            algorithm such as Ed25519 marks the row as a clinical-continuity
            signing key, which this console does not manage — the backend
            refuses to create one here, so it is not offered. For a cipher
            outside this list, register the key through the provisioning runbook
            rather than the console.
          </p>
        </div>
      </div>

      <Consequence>
        {isRotate ? (
          <>
            The newest <b>active</b> entry this console may demote moves to{" "}
            <b>retiring</b> and the new entry is created <b>active</b>, linked
            back to it by <code>rotated_from</code>. This rewrites registry
            bookkeeping only: no key material is created or moved, and no stored
            record is re-encrypted or re-wrapped. If this tenant has a visible
            active key but not one this console may demote, the backend refuses
            the rotation rather than adding an unlinked entry beside the key
            that is really active; an entry with no predecessor is created only
            when there is no visible active key at all.
          </>
        ) : (
          <>
            The entry is created with status <b>active</b> in the registry. That
            is bookkeeping only — it creates no key material and repoints no
            encryption path. The key should already exist in the KMS provider
            before you record it here.
          </>
        )}
      </Consequence>
      <Consequence>
        The backend refuses up front any row it would then withhold from this
        console, so an unmanageable entry is rejected (400) rather than
        registered and lost — that is what the fixed algorithm list above avoids
        running into. A key id inside this tenant&apos;s reserved{" "}
        <code>t:&lt;tenantId&gt;:v&lt;n&gt;</code> namespace is refused (400)
        separately: those ids belong to the live envelope keys, and a metadata
        row squatting on one burns a version the provider needs.
      </Consequence>
      <ErrorStrip error={error} />

      <FooterButtons
        onClose={onClose}
        onConfirm={submit}
        confirmLabel={isRotate ? "Rotate now" : "Register key"}
        disabled={!keyId.trim()}
        submitting={submitting}
      />
    </DialogShell>
  );
}

/* =========================
 * Retire
 * ========================= */

export function RetireKeyDialog({
  encKey,
  onClose,
  onConfirm,
  submitting,
  error,
}: {
  encKey: EncryptionKey;
  onClose: () => void;
  onConfirm: () => void;
  submitting: boolean;
  error: ActionError | null;
}) {
  const [typed, setTyped] = useState("");
  return (
    <DialogShell label="Retire encryption key" onClose={onClose}>
      <h2 className="text-lg font-semibold text-foreground">
        Retire key <span className="font-mono">{encKey.key_id}</span>
      </h2>
      <Consequence>
        The entry is marked <b>retired</b> in the registry. Retiring records the
        decision; it does not carry it out — no key material is destroyed and no
        stored record is re-wrapped. Retire an entry only once the key it
        references is genuinely out of use, and complete the retirement in the
        KMS provider.
      </Consequence>
      <div className="mt-4">
        <label
          htmlFor="retire-confirm-input"
          className="mb-1 block text-xs font-medium text-muted-foreground"
        >
          Type the key id <span className="font-mono">{encKey.key_id}</span> to
          confirm
        </label>
        <input
          id="retire-confirm-input"
          aria-label={`Type the key id ${encKey.key_id} to confirm`}
          className={inputClass}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          autoComplete="off"
        />
      </div>
      <ErrorStrip error={error} />
      <FooterButtons
        onClose={onClose}
        onConfirm={onConfirm}
        confirmLabel="Confirm retire"
        disabled={typed !== encKey.key_id}
        submitting={submitting}
        destructive
      />
    </DialogShell>
  );
}

/* =========================
 * Mark compromised
 * ========================= */

export function CompromiseKeyDialog({
  encKey,
  onClose,
  onConfirm,
  submitting,
  error,
}: {
  encKey: EncryptionKey;
  onClose: () => void;
  onConfirm: (reason: string) => void;
  submitting: boolean;
  error: ActionError | null;
}) {
  const [reason, setReason] = useState("");
  const [typed, setTyped] = useState("");
  return (
    <DialogShell label="Mark key compromised" onClose={onClose}>
      <h2 className="text-lg font-semibold text-foreground">
        Mark <span className="font-mono">{encKey.key_id}</span> compromised
      </h2>
      <Consequence tone="red">
        <b>This stamps an incident record on the registry entry.</b> It does not
        revoke, destroy or rotate key material, and it does not re-wrap any
        stored record — carry the actual revocation out in the KMS provider, or
        this entry will say &quot;compromised&quot; while the key keeps working.
        This cannot be undone from this console.
      </Consequence>
      <div className="mt-4 space-y-3">
        <div>
          <label
            htmlFor="compromise-reason"
            className="mb-1 block text-xs font-medium text-muted-foreground"
          >
            Reason (recorded in the key&apos;s audit metadata)
          </label>
          <textarea
            id="compromise-reason"
            aria-label="Reason (recorded in the key's audit metadata)"
            className={`${inputClass} min-h-20`}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. KMS provider reported unauthorized access on 2026-08-23"
          />
        </div>
        <div>
          <label
            htmlFor="compromise-confirm-input"
            className="mb-1 block text-xs font-medium text-muted-foreground"
          >
            Type the key id <span className="font-mono">{encKey.key_id}</span>{" "}
            to confirm
          </label>
          <input
            id="compromise-confirm-input"
            aria-label={`Type the key id ${encKey.key_id} to confirm`}
            className={inputClass}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
          />
        </div>
      </div>
      <ErrorStrip error={error} />
      <FooterButtons
        onClose={onClose}
        onConfirm={() => onConfirm(reason.trim())}
        confirmLabel="Confirm compromise"
        disabled={typed !== encKey.key_id || !reason.trim()}
        submitting={submitting}
        destructive
      />
    </DialogShell>
  );
}
