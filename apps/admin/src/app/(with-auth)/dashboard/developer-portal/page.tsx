"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Download, RefreshCw } from "lucide-react";
import { toast } from "react-hot-toast";
import {
  getDeveloperPortalOpenApi,
  getDeveloperPortalSummary,
  issueDeveloperPortalKey,
  revokeDeveloperPortalKey,
  rotateDeveloperPortalKey,
  saveDeveloperPortalClient,
} from "@/lib/api/developerPortal";
import { ClientProfilePanel } from "./components/ClientProfilePanel";
import { KeyLifecyclePanel } from "./components/KeyLifecyclePanel";
import { MetricCards } from "./components/MetricCards";
import {
  AuditTrailPanel,
  IntegrationGuidePanel,
  ScopeDictionaryPanel,
} from "./components/ReferencePanels";
import {
  blankClientForm,
  clientToForm,
  downloadJson,
  formToPayload,
  type ClientFormState,
} from "./components/helpers";

export default function DeveloperPortalPage() {
  const queryClient = useQueryClient();
  const [selectedClientId, setSelectedClientId] = useState<number | null>(null);
  const [clientForm, setClientForm] = useState<ClientFormState>({ ...blankClientForm });
  const [keyDisplayName, setKeyDisplayName] = useState("Sandbox integration key");
  const [keyExpiry, setKeyExpiry] = useState("");
  const [revokeReason, setRevokeReason] = useState("rotated from developer portal");
  const [revealedKey, setRevealedKey] = useState<string | null>(null);

  const portalQuery = useQuery({
    queryKey: ["developer-portal"],
    queryFn: () => getDeveloperPortalSummary(),
  });

  const portal = portalQuery.data;
  const clients = portal?.clients ?? [];
  const selectedClient = clients.find((client) => client.id === selectedClientId) ?? clients[0] ?? null;

  const refreshPortal = () => queryClient.invalidateQueries({ queryKey: ["developer-portal"] });

  const saveClientMutation = useMutation({
    mutationFn: () => saveDeveloperPortalClient(formToPayload(clientForm)),
    onSuccess: (client) => {
      setSelectedClientId(client.id);
      setClientForm(clientToForm({ ...client, keys: [], key_count: 0, active_key_count: 0 }));
      void refreshPortal();
      toast.success("API client saved");
    },
    onError: (err: Error) => toast.error(err.message || "Could not save API client"),
  });

  const issueKeyMutation = useMutation({
    mutationFn: () => {
      if (!selectedClient) throw new Error("Select an API client first");
      return issueDeveloperPortalKey(selectedClient.id, {
        display_name: keyDisplayName.trim() || null,
        expires_at: keyExpiry ? new Date(keyExpiry).toISOString() : null,
      });
    },
    onSuccess: (result) => {
      setRevealedKey(result.plaintext);
      void refreshPortal();
      toast.success("API key issued");
    },
    onError: (err: Error) => toast.error(err.message || "Could not issue API key"),
  });

  const rotateKeyMutation = useMutation({
    mutationFn: (keyId: number) => {
      if (!selectedClient) throw new Error("Select an API client first");
      return rotateDeveloperPortalKey(selectedClient.id, keyId, {
        display_name: keyDisplayName.trim() || "Rotated key",
        expires_at: keyExpiry ? new Date(keyExpiry).toISOString() : null,
        revoked_reason: revokeReason.trim() || "rotated",
      });
    },
    onSuccess: (result) => {
      setRevealedKey(result.plaintext);
      void refreshPortal();
      toast.success("API key rotated");
    },
    onError: (err: Error) => toast.error(err.message || "Could not rotate API key"),
  });

  const revokeKeyMutation = useMutation({
    mutationFn: (keyId: number) => revokeDeveloperPortalKey(keyId, {
      revoked_reason: revokeReason.trim() || "revoked from developer portal",
    }),
    onSuccess: () => {
      void refreshPortal();
      toast.success("API key revoked");
    },
    onError: (err: Error) => toast.error(err.message || "Could not revoke API key"),
  });

  const openApiMutation = useMutation({
    mutationFn: () => getDeveloperPortalOpenApi(),
    onSuccess: ({ document }) => {
      downloadJson(portal?.openapi_download.filename ?? "vh-health-openapi.json", document);
      toast.success("OpenAPI downloaded");
    },
    onError: (err: Error) => toast.error(err.message || "OpenAPI download failed"),
  });

  const copyRevealedKey = async () => {
    if (!revealedKey) return;
    await navigator.clipboard.writeText(revealedKey);
    toast.success("Key copied");
  };

  const resetClientForm = () => {
    setSelectedClientId(null);
    setClientForm({ ...blankClientForm });
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <p className="text-sm font-medium uppercase tracking-wide text-teal-700">NL-11 Developer Portal</p>
          <h1 className="mt-1 text-3xl font-semibold text-slate-950">API clients</h1>
          <p className="mt-2 max-w-3xl text-sm text-slate-600">
            Sandbox clients, key lifecycle, integration scopes, OpenAPI contracts, and audit events.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void portalQuery.refetch()}
            className="inline-flex items-center gap-2 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            <RefreshCw className="h-4 w-4" />
            Refresh
          </button>
          <button
            type="button"
            onClick={() => openApiMutation.mutate()}
            disabled={openApiMutation.isPending}
            className="inline-flex items-center gap-2 rounded-md bg-teal-700 px-3 py-2 text-sm font-medium text-white hover:bg-teal-800 disabled:opacity-60"
          >
            <Download className="h-4 w-4" />
            OpenAPI
          </button>
        </div>
      </div>

      {revealedKey && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <p className="text-sm font-semibold text-amber-950">One-time key value</p>
              <p className="mt-1 break-all font-mono text-sm text-amber-900">{revealedKey}</p>
            </div>
            <button
              type="button"
              onClick={() => void copyRevealedKey()}
              className="inline-flex items-center justify-center gap-2 rounded-md border border-amber-400 px-3 py-2 text-sm font-medium text-amber-900 hover:bg-amber-100"
            >
              <Copy className="h-4 w-4" />
              Copy
            </button>
          </div>
        </div>
      )}

      {portalQuery.isLoading && (
        <div className="rounded-md border border-slate-200 bg-white p-6 text-sm text-slate-500">
          Loading developer portal...
        </div>
      )}

      {portalQuery.error instanceof Error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {portalQuery.error.message}
        </div>
      )}

      {portal && (
        <>
          <MetricCards portal={portal} />
          <div className="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(360px,1fr)]">
            <ClientProfilePanel
              clients={portal.clients}
              selectedClient={selectedClient}
              clientForm={clientForm}
              setClientForm={setClientForm}
              onNewClient={resetClientForm}
              onSelectClient={(client) => {
                setSelectedClientId(client.id);
                setClientForm(clientToForm(client));
              }}
              onSaveClient={() => saveClientMutation.mutate()}
              saving={saveClientMutation.isPending}
            />
            <div className="space-y-6">
              <KeyLifecyclePanel
                selectedClient={selectedClient}
                keyDisplayName={keyDisplayName}
                setKeyDisplayName={setKeyDisplayName}
                keyExpiry={keyExpiry}
                setKeyExpiry={setKeyExpiry}
                revokeReason={revokeReason}
                setRevokeReason={setRevokeReason}
                onIssueKey={() => issueKeyMutation.mutate()}
                onRotateKey={(keyId) => rotateKeyMutation.mutate(keyId)}
                onRevokeKey={(keyId) => revokeKeyMutation.mutate(keyId)}
                issuing={issueKeyMutation.isPending}
                rotating={rotateKeyMutation.isPending}
                revoking={revokeKeyMutation.isPending}
              />
              <IntegrationGuidePanel portal={portal} />
            </div>
          </div>
          <div className="grid gap-6 xl:grid-cols-2">
            <ScopeDictionaryPanel portal={portal} />
            <AuditTrailPanel portal={portal} />
          </div>
        </>
      )}
    </div>
  );
}
