"use client";

import {
  KMS_PROVIDERS,
  type EncryptionKey,
  type KmsProvider,
  type RegisterKeyPayload,
  type RotateKeyPayload,
} from "@/lib/api/encryptionKeys";
import { AlertTriangle } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

const inputClass =
  "w-full rounded-md border border-border bg-background px-3 py-2 text-sm";

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

function ErrorStrip({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="mt-3 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
      {message}
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
  errorMessage,
}: {
  mode: "register" | "rotate";
  open: boolean;
  onClose: () => void;
  onRegister?: (payload: RegisterKeyPayload) => void;
  onRotate?: (payload: RotateKeyPayload) => void;
  submitting: boolean;
  errorMessage: string | null;
}) {
  const [keyId, setKeyId] = useState("");
  const [provider, setProvider] = useState<KmsProvider>("env");
  const [providerReference, setProviderReference] = useState("");
  const [algorithm, setAlgorithm] = useState("aes-256-gcm");

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
      algorithm: algorithm.trim() || "aes-256-gcm",
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
            placeholder="e.g. tenant-kek-v3"
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
          <input
            id="key-form-algorithm"
            aria-label="Algorithm"
            className={inputClass}
            value={algorithm}
            onChange={(e) => setAlgorithm(e.target.value)}
          />
        </div>
      </div>

      <Consequence>
        {isRotate ? (
          <>
            The current active key moves to <b>retiring</b> and the new key
            becomes <b>active for new writes immediately</b>. Existing records
            stay readable under the retiring key until they are re-wrapped.
          </>
        ) : (
          <>
            The key is registered <b>active immediately</b> and new writes may
            begin encrypting under it. The key material must already exist in
            the KMS provider — this registry stores metadata only.
          </>
        )}
      </Consequence>
      <ErrorStrip message={errorMessage} />

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
  errorMessage,
}: {
  encKey: EncryptionKey;
  onClose: () => void;
  onConfirm: () => void;
  submitting: boolean;
  errorMessage: string | null;
}) {
  const [typed, setTyped] = useState("");
  return (
    <DialogShell label="Retire encryption key" onClose={onClose}>
      <h2 className="text-lg font-semibold text-foreground">
        Retire key <span className="font-mono">{encKey.key_id}</span>
      </h2>
      <Consequence>
        The key is marked <b>retired</b> and can no longer serve new writes.
        Retire a key only when no records remain encrypted under it — records
        still wrapped under a retired key must be re-wrapped to stay readable.
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
      <ErrorStrip message={errorMessage} />
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
  errorMessage,
}: {
  encKey: EncryptionKey;
  onClose: () => void;
  onConfirm: (reason: string) => void;
  submitting: boolean;
  errorMessage: string | null;
}) {
  const [reason, setReason] = useState("");
  const [typed, setTyped] = useState("");
  return (
    <DialogShell label="Mark key compromised" onClose={onClose}>
      <h2 className="text-lg font-semibold text-foreground">
        Mark <span className="font-mono">{encKey.key_id}</span> compromised
      </h2>
      <Consequence tone="red">
        <b>Decryption paths move off this key immediately.</b> Records encrypted
        under it may become unreadable until they are re-wrapped under a healthy
        key. This cannot be undone from this console — treat it as a security
        incident action.
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
      <ErrorStrip message={errorMessage} />
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
