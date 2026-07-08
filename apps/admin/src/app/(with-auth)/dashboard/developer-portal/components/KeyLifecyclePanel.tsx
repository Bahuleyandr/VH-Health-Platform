import type { Dispatch, SetStateAction } from "react";
import { Ban, KeyRound, RefreshCw } from "lucide-react";
import type { DeveloperPortalApiClient } from "@/lib/api/developerPortal";
import { formatDate } from "./helpers";

interface KeyLifecyclePanelProps {
  selectedClient: DeveloperPortalApiClient | null;
  keyDisplayName: string;
  setKeyDisplayName: Dispatch<SetStateAction<string>>;
  keyExpiry: string;
  setKeyExpiry: Dispatch<SetStateAction<string>>;
  revokeReason: string;
  setRevokeReason: Dispatch<SetStateAction<string>>;
  onIssueKey: () => void;
  onRotateKey: (keyId: number) => void;
  onRevokeKey: (keyId: number) => void;
  issuing: boolean;
  rotating: boolean;
  revoking: boolean;
}

export function KeyLifecyclePanel({
  selectedClient,
  keyDisplayName,
  setKeyDisplayName,
  keyExpiry,
  setKeyExpiry,
  revokeReason,
  setRevokeReason,
  onIssueKey,
  onRotateKey,
  onRevokeKey,
  issuing,
  rotating,
  revoking,
}: KeyLifecyclePanelProps) {
  return (
    <div className="rounded-md border border-slate-200 bg-white p-4">
      <h2 className="text-lg font-semibold text-slate-950">Key lifecycle</h2>
      {selectedClient ? (
        <div className="mt-4 space-y-4">
          <div className="rounded-md bg-slate-50 p-3">
            <p className="font-medium text-slate-950">{selectedClient.display_name}</p>
            <p className="text-xs text-slate-500">{selectedClient.client_code}</p>
          </div>
          <label className="block space-y-1">
            <span className="text-sm font-medium text-slate-700">Key label</span>
            <input
              value={keyDisplayName}
              onChange={(event) => setKeyDisplayName(event.target.value)}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-sm font-medium text-slate-700">Expires at</span>
            <input
              type="datetime-local"
              value={keyExpiry}
              onChange={(event) => setKeyExpiry(event.target.value)}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-sm font-medium text-slate-700">Revoke reason</span>
            <input
              value={revokeReason}
              onChange={(event) => setRevokeReason(event.target.value)}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
          </label>
          <button
            type="button"
            onClick={onIssueKey}
            disabled={issuing}
            className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-slate-950 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-60"
          >
            <KeyRound className="h-4 w-4" />
            Issue key
          </button>
          <div className="space-y-2">
            {selectedClient.keys.map((key) => (
              <div key={key.id} className="rounded-md border border-slate-200 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-mono text-sm font-semibold text-slate-950">{key.key_prefix}</p>
                    <p className="text-xs text-slate-500">{key.display_name || "Unnamed key"}</p>
                  </div>
                  <span className="rounded-full bg-slate-100 px-2 py-1 text-xs capitalize text-slate-700">
                    {key.status}
                  </span>
                </div>
                <div className="mt-3 grid gap-1 text-xs text-slate-500">
                  <span>Last used: {formatDate(key.last_used_at)}</span>
                  <span>Expires: {formatDate(key.expires_at)}</span>
                </div>
                {key.status === "active" && (
                  <div className="mt-3 flex gap-2">
                    <button
                      type="button"
                      onClick={() => onRotateKey(key.id)}
                      disabled={rotating}
                      className="inline-flex flex-1 items-center justify-center gap-2 rounded-md border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
                    >
                      <RefreshCw className="h-4 w-4" />
                      Rotate
                    </button>
                    <button
                      type="button"
                      onClick={() => onRevokeKey(key.id)}
                      disabled={revoking}
                      className="inline-flex flex-1 items-center justify-center gap-2 rounded-md border border-red-300 px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-60"
                    >
                      <Ban className="h-4 w-4" />
                      Revoke
                    </button>
                  </div>
                )}
              </div>
            ))}
            {selectedClient.keys.length === 0 && (
              <p className="rounded-md bg-slate-50 p-3 text-sm text-slate-500">No keys issued.</p>
            )}
          </div>
        </div>
      ) : (
        <p className="mt-4 text-sm text-slate-500">Select or create an API client.</p>
      )}
    </div>
  );
}
