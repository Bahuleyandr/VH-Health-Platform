"use client";

import {
  describeGdprApiError,
  executeErasure,
  LEGAL_HOLD_ACTIVE,
  type ErasureResult,
  type ExecuteErasurePayload,
  type GdprApiErrorInfo,
} from "@/lib/api/gdprErasure";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Scale } from "lucide-react";
import { useState } from "react";
import { toast } from "react-hot-toast";

const inputClass =
  "w-full rounded-md border border-border bg-background px-3 py-2 text-sm";
const labelClass = "mb-1 block text-xs font-medium text-muted-foreground";

const CONFIRM_WORD = "ERASE";

export function ExecuteErasurePanel() {
  const queryClient = useQueryClient();
  const [uid, setUid] = useState("");
  const [phone, setPhone] = useState("");
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [error, setError] = useState<GdprApiErrorInfo | null>(null);
  const [result, setResult] = useState<ErasureResult | null>(null);

  const buildPayload = (): ExecuteErasurePayload => {
    const payload: ExecuteErasurePayload = { reason: reason.trim() };
    if (uid.trim()) payload.uid = uid.trim();
    if (phone.trim()) payload.phone = phone.trim();
    return payload;
  };

  const mutation = useMutation({
    mutationFn: () => executeErasure(buildPayload()),
    onSuccess: (res) => {
      setResult(res);
      setError(null);
      setConfirming(false);
      setConfirmText("");
      setUid("");
      setPhone("");
      setReason("");
      toast.success("Erasure completed");
      void queryClient.invalidateQueries({ queryKey: ["gdpr-erasure", "log"] });
    },
    onError: (err: unknown) => setError(describeGdprApiError(err)),
  });

  const hasSubject = uid.trim().length > 0 || phone.trim().length > 0;
  const canContinue = hasSubject && reason.trim().length > 0;
  const canExecute =
    canContinue && confirmText === CONFIRM_WORD && !mutation.isPending;

  const resetConfirm = () => {
    setConfirming(false);
    setConfirmText("");
  };

  return (
    <section className="space-y-3 rounded-md border border-border bg-card p-4">
      <h2 className="text-lg font-semibold text-foreground">
        Execute erasure
      </h2>
      <p className="text-sm text-muted-foreground">
        Permanently erases or anonymizes the subject&apos;s data across all
        processed tables. Irreversible; every run is recorded in the erasure
        log with your identity and the reason below.
      </p>

      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <label className={labelClass} htmlFor="erase-uid">
            Subject UID
          </label>
          <input
            id="erase-uid"
            aria-label="Subject UID"
            className={inputClass}
            value={uid}
            onChange={(e) => {
              setUid(e.target.value);
              resetConfirm();
            }}
            placeholder="user uuid"
          />
        </div>
        <div>
          <label className={labelClass} htmlFor="erase-phone">
            Subject phone (either UID or phone is required)
          </label>
          <input
            id="erase-phone"
            aria-label="Subject phone (either UID or phone is required)"
            className={inputClass}
            value={phone}
            onChange={(e) => {
              setPhone(e.target.value);
              resetConfirm();
            }}
            placeholder="+91..."
          />
        </div>
      </div>
      <div>
        <label className={labelClass} htmlFor="erase-reason">
          Reason (required — recorded in the audit trail)
        </label>
        <textarea
          id="erase-reason"
          aria-label="Reason (required — recorded in the audit trail)"
          className={`${inputClass} min-h-16`}
          value={reason}
          onChange={(e) => {
            setReason(e.target.value);
            resetConfirm();
          }}
          placeholder="e.g. DPDP/GDPR erasure request ref #..."
        />
      </div>

      {!confirming ? (
        <button
          type="button"
          disabled={!canContinue}
          onClick={() => {
            setError(null);
            setResult(null);
            setConfirming(true);
          }}
          className="rounded-md bg-red-600 px-3 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-60"
        >
          Continue to confirmation
        </button>
      ) : (
        <div className="space-y-3 rounded-md border border-red-300 bg-red-50 p-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-red-800">
            <AlertTriangle className="h-4 w-4" />
            Final confirmation — this action is irreversible
          </div>
          <div className="text-sm text-red-800">
            Erase all data for{" "}
            <span className="font-mono text-xs">
              {[
                uid.trim() && `uid ${uid.trim()}`,
                phone.trim() && `phone ${phone.trim()}`,
              ]
                .filter(Boolean)
                .join(" / ")}
            </span>
            <div className="mt-1 text-xs">Reason: {reason.trim()}</div>
          </div>
          <div>
            <label
              className="mb-1 block text-xs font-medium text-red-800"
              htmlFor="erase-confirm"
            >
              Type {CONFIRM_WORD} to confirm
            </label>
            <input
              id="erase-confirm"
              aria-label={`Type ${CONFIRM_WORD} to confirm`}
              className="w-full rounded-md border border-red-300 bg-white px-3 py-2 font-mono text-sm"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              autoComplete="off"
            />
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={resetConfirm}
              className="rounded-md border border-border bg-background px-3 py-2 text-sm font-medium hover:bg-muted"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!canExecute}
              onClick={() => mutation.mutate()}
              className="rounded-md bg-red-600 px-3 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-60"
            >
              {mutation.isPending ? "Erasing..." : "Erase permanently"}
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          {error.code === LEGAL_HOLD_ACTIVE ? (
            <div className="flex items-start gap-2">
              <Scale className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                <div className="font-semibold">Blocked by legal hold</div>
                {/* Backend refusal surfaced verbatim */}
                <div className="mt-1">{error.message}</div>
                <code className="mt-2 inline-block rounded bg-red-100 px-1.5 py-0.5 font-mono text-xs">
                  {LEGAL_HOLD_ACTIVE}
                </code>
                {error.requestId && (
                  <span className="ml-2 text-xs text-red-600">
                    request {error.requestId}
                  </span>
                )}
              </div>
            </div>
          ) : (
            <div>
              <div className="font-semibold">Erasure failed</div>
              <div className="mt-1">{error.message}</div>
              {error.code && (
                <code className="mt-2 inline-block rounded bg-red-100 px-1.5 py-0.5 font-mono text-xs">
                  {error.code}
                </code>
              )}
            </div>
          )}
        </div>
      )}

      {result && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
          <div className="flex items-center gap-2 font-semibold">
            <CheckCircle2 className="h-4 w-4" />
            Erasure completed
          </div>
          <div className="mt-1 text-xs">
            {result.uid ? `uid ${result.uid} · ` : ""}
            {result.erasedAt} · {result.duration_ms} ms ·{" "}
            {Object.keys(result.tables).length} tables processed
          </div>
          <ul className="mt-2 grid gap-x-6 gap-y-0.5 text-xs sm:grid-cols-2">
            {Object.entries(result.tables).map(([table, outcome]) => (
              <li key={table} className="font-mono">
                {table}: {outcome.action} ({outcome.count})
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
