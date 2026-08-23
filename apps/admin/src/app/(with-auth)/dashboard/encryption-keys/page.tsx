"use client";

import { EmptyState } from "@/components/EmptyState";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import {
  KEY_STATUSES,
  listEncryptionKeys,
  markEncryptionKeyCompromised,
  registerEncryptionKey,
  retireEncryptionKey,
  rotateEncryptionKey,
  type EncryptionKey,
  type EncryptionKeyStatus,
  type RegisterKeyPayload,
  type RotateKeyPayload,
} from "@/lib/api/encryptionKeys";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Plus, RefreshCw, RotateCw } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "react-hot-toast";

import {
  CompromiseKeyDialog,
  KeyFormDialog,
  RetireKeyDialog,
} from "./components/KeyActionDialogs";

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
  const [actionError, setActionError] = useState<string | null>(null);

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
  // Surface the backend's error message verbatim inside the open dialog.
  const onActionError = (err: Error) => {
    setActionError(err.message || "Request failed");
  };

  const registerMutation = useMutation({
    mutationFn: (payload: RegisterKeyPayload) => registerEncryptionKey(payload),
    onSuccess: () => onActionSuccess("Encryption key registered"),
    onError: onActionError,
  });
  const rotateMutation = useMutation({
    mutationFn: (payload: RotateKeyPayload) => rotateEncryptionKey(payload),
    onSuccess: () => onActionSuccess("Key rotated — new key is active"),
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
  // List comes back ordered activated_at DESC; the newest 'active' row is the
  // key new writes encrypt under.
  const activeWriteKeyId = useMemo(
    () => keys.find((k) => k.status === "active")?.id ?? null,
    [keys],
  );

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
            KEK versions for PHI encryption: which key is active for new writes,
            which are retiring or retired. Key material lives in the KMS
            provider — this registry stores metadata and provider references
            only.
          </p>
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
            Keys
            {keysQuery.data && (
              <span className="font-normal text-muted-foreground">
                ({keysQuery.data.count})
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
            title="No encryption keys registered"
            description="Register a key to begin tracking KEK versions for this tenant."
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
                      {key.id === activeWriteKeyId && (
                        <span className="ml-2 inline-flex items-center gap-1 rounded-full border border-teal-200 bg-teal-50 px-2 py-0.5 text-[11px] font-semibold text-teal-800">
                          <span className="h-1.5 w-1.5 rounded-full bg-teal-600" />
                          Active — new writes
                        </span>
                      )}
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

      {(dialog?.kind === "register" || dialog?.kind === "rotate") && (
        <KeyFormDialog
          mode={dialog.kind}
          open
          onClose={closeDialog}
          submitting={registerMutation.isPending || rotateMutation.isPending}
          errorMessage={actionError}
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
          errorMessage={actionError}
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
          errorMessage={actionError}
          onConfirm={(reason) => {
            setActionError(null);
            compromiseMutation.mutate({ id: dialog.encKey.id, reason });
          }}
        />
      )}
    </div>
  );
}
