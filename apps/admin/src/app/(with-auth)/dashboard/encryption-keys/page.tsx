"use client";

import { EmptyState } from "@/components/EmptyState";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import {
  KEY_STATUSES,
  listEncryptionKeys,
  markEncryptionKeyCompromised,
  readEncryptionKeyRefusal,
  registerEncryptionKey,
  retireEncryptionKey,
  rotateEncryptionKey,
  type EncryptionKey,
  type EncryptionKeyStatus,
  type RegisterKeyPayload,
  type RotateKeyPayload,
} from "@/lib/api/encryptionKeys";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  KeyRound,
  Plus,
  RefreshCw,
  RotateCw,
} from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "react-hot-toast";

import {
  CompromiseKeyDialog,
  KeyFormDialog,
  RetireKeyDialog,
  type ActionError,
} from "./components/KeyActionDialogs";
import { WithheldKeysPanel } from "./components/WithheldKeysPanel";

type DialogState =
  | { kind: "register" }
  | { kind: "rotate" }
  | { kind: "retire"; encKey: EncryptionKey }
  | { kind: "compromise"; encKey: EncryptionKey }
  | null;

function StatusPill({ value }: { value: EncryptionKeyStatus }) {
  const color =
    value === "active"
      ? "border-emerald-200 bg-emerald-50 text-emerald-800"
      : value === "retiring"
        ? "border-amber-200 bg-amber-50 text-amber-800"
        : value === "compromised"
          ? "border-red-200 bg-red-50 text-red-800"
          : "border-slate-200 bg-slate-50 text-slate-700";
  return (
    <span
      className={`inline-flex whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium ${color}`}
    >
      {value}
    </span>
  );
}

function formatDateTime(value?: string | null) {
  if (!value) return "—";
  return new Date(value).toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function EncryptionKeysPage() {
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<"" | EncryptionKeyStatus>(
    "",
  );
  const [dialog, setDialog] = useState<DialogState>(null);
  const [actionError, setActionError] = useState<ActionError | null>(null);

  const keysQuery = useQuery({
    queryKey: ["encryption-keys", statusFilter],
    queryFn: () =>
      listEncryptionKeys(statusFilter ? { status: statusFilter } : {}),
  });

  const closeDialog = () => {
    setDialog(null);
    setActionError(null);
  };
  const onActionSuccess = (message: string) => {
    toast.success(message);
    closeDialog();
    void queryClient.invalidateQueries({ queryKey: ["encryption-keys"] });
  };
  // Surface the backend's error message verbatim inside the open dialog, plus
  // the machine-readable refusal when this is one of the registry fence's own
  // codes (null for anything else — see readEncryptionKeyRefusal).
  const onActionError = (err: Error) => {
    setActionError({
      message: err.message || "Request failed",
      refusal: readEncryptionKeyRefusal(err),
    });
  };

  const registerMutation = useMutation({
    mutationFn: (payload: RegisterKeyPayload) => registerEncryptionKey(payload),
    onSuccess: () => onActionSuccess("Encryption key registered"),
    onError: onActionError,
  });
  const rotateMutation = useMutation({
    mutationFn: (payload: RotateKeyPayload) => rotateEncryptionKey(payload),
    // `rotated_from` is NULL only when the tenant had no active key to demote —
    // the backend refuses rather than silently downgrading a blocked rotation
    // to a first-key insert, so this branch cannot mean "a predecessor was
    // skipped". Saying "rotated" there would describe a demotion that did not
    // happen.
    onSuccess: (row) =>
      onActionSuccess(
        row.rotated_from != null
          ? "Key rotated — the previous entry is now retiring"
          : "New key registered as active — there was no active entry to retire",
      ),
    onError: onActionError,
  });
  const retireMutation = useMutation({
    mutationFn: (id: number) => retireEncryptionKey(id),
    onSuccess: () => onActionSuccess("Encryption key retired"),
    onError: onActionError,
  });
  const compromiseMutation = useMutation({
    mutationFn: (input: { id: number; reason: string }) =>
      markEncryptionKeyCompromised(input.id, input.reason),
    onSuccess: () => onActionSuccess("Key marked compromised"),
    onError: onActionError,
  });

  const keys = useMemo(() => keysQuery.data?.keys ?? [], [keysQuery.data]);
  // Deliberately no "this key receives new writes" marker. The listing is
  // fenced to registry-managed rows, so the live per-tenant envelope KEKs that
  // actually wrap PHI are never in `keys`, and the list response carries no
  // field naming the key the write path is using. `status` is registry
  // bookkeeping; anything stronger than that would be a guess. See
  // src/lib/api/encryptionKeys.ts.
  //
  // The rows that ARE fenced out are not lost: the response reports each of
  // them in `protected`, and WithheldKeysPanel below is where they surface.
  const withheld = useMemo(
    () => keysQuery.data?.protected ?? [],
    [keysQuery.data],
  );
  const withheldCount = keysQuery.data?.protected_count ?? 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <p className="text-sm font-medium uppercase tracking-wide text-teal-700">
            Security
          </p>
          <h1 className="mt-1 text-3xl font-semibold text-foreground">
            Encryption Key Registry
          </h1>
          <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
            Registry bookkeeping for KEK versions: key id, KMS provider
            reference, algorithm and lifecycle status. The rows listed here
            carry no key material of their own — only a reference to the
            provider that is meant to hold it.
          </p>
          <div className="mt-3 flex max-w-3xl items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="space-y-1">
              <p>
                <b>This page is not the whole key store.</b> The same backend
                table also holds live key material — the per-tenant envelope
                KEKs that wrap PHI — and keys whose status other subsystems read
                as a gate. Rows like those are withheld from the table below
                rather than dropped: every one is named under{" "}
                <b>Withheld from this console</b> with the marker that withheld
                it, as is any other row this console cannot prove inert or
                cannot reach. Live key material is crypto-shredded and
                re-provisioned on the backend; a signing key is revoked by
                publishing a new policy version that lists it. Neither happens
                here.
              </p>
              <p>
                What a withheld row does to an action depends on the action.{" "}
                <b>Retire</b> and <b>mark compromised</b> name a row, so they
                refuse a withheld one outright (409) and report the class it
                landed in. <b>Rotate</b> names no row — it looks for the newest
                active entry it may demote; if this tenant has a visible active
                key but not one of those, the rotation is refused rather than
                adding a new entry beside the key that is really active.{" "}
                <b>Register</b> has no existing row to protect, so it refuses up
                front any entry that would be created and then withheld on the
                next read.
              </p>
              <p>
                The actions here only write registry rows. They do not create,
                move or destroy key material, and they never re-encrypt or
                re-wrap a stored record — carry the real change out in your KMS
                provider. Read <b>status</b> as the state of this registry
                entry, not as evidence of which key the platform is encrypting
                under, and confirm what depends on an entry you do not recognise
                before acting on it.
              </p>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void keysQuery.refetch()}
            className="inline-flex items-center gap-2 rounded-md border border-input bg-background px-3 py-2 text-sm font-medium text-foreground hover:bg-accent"
          >
            <RefreshCw className="h-4 w-4" />
            Refresh
          </button>
          <button
            type="button"
            onClick={() => {
              setActionError(null);
              setDialog({ kind: "rotate" });
            }}
            className="inline-flex items-center gap-2 rounded-md border border-input bg-background px-3 py-2 text-sm font-medium text-foreground hover:bg-accent"
          >
            <RotateCw className="h-4 w-4" />
            Rotate active key
          </button>
          <button
            type="button"
            onClick={() => {
              setActionError(null);
              setDialog({ kind: "register" });
            }}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="h-4 w-4" />
            Register key
          </button>
        </div>
      </div>

      <div className="rounded-md border border-border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <KeyRound className="h-4 w-4" />
            Registry entries
            {keysQuery.data && (
              /* Both server-side counts. `count` is the rows this console can
                 act on; `protected_count` is what the same response withheld.
                 Neither alone is a total for the backing table, and together
                 they are every row this tenant can see under the filter. */
              <span className="font-normal text-muted-foreground">
                ({keysQuery.data.count} listed · {withheldCount} withheld)
              </span>
            )}
          </div>
          <div>
            <label htmlFor="key-status-filter" className="sr-only">
              Filter by status
            </label>
            <select
              id="key-status-filter"
              className="rounded-md border border-border bg-background px-2 py-1.5 text-sm"
              value={statusFilter}
              onChange={(e) =>
                setStatusFilter(e.target.value as "" | EncryptionKeyStatus)
              }
            >
              <option value="">All statuses</option>
              {KEY_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
        </div>

        {keysQuery.isLoading ? (
          <LoadingSpinner label="Loading encryption keys…" />
        ) : keysQuery.error ? (
          <div className="p-4 text-sm text-red-700">
            {keysQuery.error instanceof Error
              ? keysQuery.error.message
              : "Failed to load encryption keys"}
          </div>
        ) : keys.length === 0 ? (
          <EmptyState
            compact
            icon={<KeyRound className="h-8 w-8 text-muted-foreground" />}
            title="No actionable registry entries"
            description={
              withheldCount > 0
                ? `No row reached this console's actionable list under the current filter. ${withheldCount} ${
                    withheldCount === 1 ? "row was" : "rows were"
                  } withheld from it — each one is listed below with the reason.`
                : "No row reached this console's actionable list under the current filter, and the response withheld none from it either."
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-border text-sm">
              <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left">Key id</th>
                  <th className="px-3 py-2 text-left">Provider</th>
                  <th className="px-3 py-2 text-left">Algorithm</th>
                  <th className="px-3 py-2 text-left">Status</th>
                  <th className="px-3 py-2 text-left">Activated</th>
                  <th className="px-3 py-2 text-left">Retiring / retired</th>
                  <th className="px-3 py-2 text-right">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {keys.map((key) => (
                  <tr key={key.id}>
                    <td className="px-3 py-3 align-top">
                      <span className="font-mono text-xs text-foreground">
                        {key.key_id}
                      </span>
                      {key.rotated_from != null && (
                        <div className="mt-0.5 text-[11px] text-muted-foreground">
                          rotated from #{key.rotated_from}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-3 align-top text-xs">
                      {key.provider}
                      {key.provider_reference && (
                        <div
                          className="max-w-[220px] truncate text-muted-foreground"
                          title={key.provider_reference}
                        >
                          {key.provider_reference}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-3 align-top text-xs">
                      {key.algorithm ?? "—"}
                    </td>
                    <td className="px-3 py-3 align-top">
                      <StatusPill value={key.status} />
                    </td>
                    <td className="px-3 py-3 align-top text-xs text-muted-foreground">
                      {formatDateTime(key.activated_at)}
                    </td>
                    <td className="px-3 py-3 align-top text-xs text-muted-foreground">
                      {formatDateTime(key.retired_at ?? key.retiring_at)}
                    </td>
                    <td className="px-3 py-3 text-right align-top">
                      <div className="flex justify-end gap-2">
                        {(key.status === "active" ||
                          key.status === "retiring") && (
                          <button
                            type="button"
                            onClick={() => {
                              setActionError(null);
                              setDialog({ kind: "retire", encKey: key });
                            }}
                            className="rounded-md border border-input bg-background px-2.5 py-1.5 text-xs font-medium text-foreground hover:bg-accent"
                          >
                            Retire
                          </button>
                        )}
                        {key.status !== "compromised" && (
                          <button
                            type="button"
                            onClick={() => {
                              setActionError(null);
                              setDialog({ kind: "compromise", encKey: key });
                            }}
                            className="rounded-md border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs font-medium text-red-700 hover:bg-red-100"
                          >
                            Mark compromised
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {keysQuery.data && (
        <WithheldKeysPanel
          rows={withheld}
          count={withheldCount}
          listedCount={keysQuery.data.count}
          statusFilterActive={statusFilter !== ""}
        />
      )}

      {(dialog?.kind === "register" || dialog?.kind === "rotate") && (
        <KeyFormDialog
          mode={dialog.kind}
          open
          onClose={closeDialog}
          submitting={registerMutation.isPending || rotateMutation.isPending}
          error={actionError}
          onRegister={(payload) => {
            setActionError(null);
            registerMutation.mutate(payload);
          }}
          onRotate={(payload) => {
            setActionError(null);
            rotateMutation.mutate(payload);
          }}
        />
      )}
      {dialog?.kind === "retire" && (
        <RetireKeyDialog
          encKey={dialog.encKey}
          onClose={closeDialog}
          submitting={retireMutation.isPending}
          error={actionError}
          onConfirm={() => {
            setActionError(null);
            retireMutation.mutate(dialog.encKey.id);
          }}
        />
      )}
      {dialog?.kind === "compromise" && (
        <CompromiseKeyDialog
          encKey={dialog.encKey}
          onClose={closeDialog}
          submitting={compromiseMutation.isPending}
          error={actionError}
          onConfirm={(reason) => {
            setActionError(null);
            compromiseMutation.mutate({ id: dialog.encKey.id, reason });
          }}
        />
      )}
    </div>
  );
}
