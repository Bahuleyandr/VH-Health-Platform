"use client";

/**
 * Phase A3 integration + webhook admin page.
 *
 * Three tabs over the unified backend surface:
 *   1. Integrations: list + create + status toggle + click-through
 *      detail (recent integration_logs + subscription list +
 *      add-subscription form). Signing-credential is shown by ID only.
 *   2. Webhook deliveries: cross-integration list + status filter,
 *      payload viewer drawer per row, mark-dead + redrive actions.
 *   3. Debug: "dispatch now" button + manual enqueue form (event_type
 *      + JSON payload textarea). Lets ops force a delivery for E2E
 *      testing without waiting for the cron tick.
 */

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity, AlertTriangle, ArrowRightCircle, BookOpen, CheckCircle2,
  Network, Plus, RefreshCw, Send, Skull, Trash2, X,
} from "lucide-react";
import { toast } from "react-hot-toast";

import {
  archiveIntegration,
  createIntegration,
  createSubscription,
  deleteSubscription,
  dispatchNow,
  enqueueDelivery,
  getDelivery,
  listDeliveries,
  listIntegrationLogs,
  listIntegrationSubscriptions,
  listIntegrations,
  markDeliveryDead,
  redriveDelivery,
  updateIntegration,
  updateSubscription,
  type Integration,
  type IntegrationLog,
  type IntegrationLogSeverity,
  type IntegrationStatus,
  type WebhookDelivery,
  type WebhookDeliveryStatus,
  type WebhookSigningAlgorithm,
  type WebhookSubscription,
} from "@/lib/api/integrationAdmin";
import {
  activateInterfaceVersion,
  createInterfaceChannel,
  createInterfaceReplayBatch,
  createInterfaceTransformTest,
  createInterfaceVersion,
  dispatchInterfaceOutbound,
  getInterfaceMessage,
  listInterfaceChannels,
  listInterfaceMessages,
  listInterfaceReplayBatches,
  markInterfaceMessageDead,
  runInterfaceTransformTest,
  type InteropConnectorKind,
  type InteropDirection,
  type InteropMessage,
  type InteropMessageStatus,
  type InteropProtocol,
} from "@/lib/api/interfaceEngine";

const INTEGRATION_STATUSES: IntegrationStatus[] = ["active", "paused", "failed", "archived"];
const DELIVERY_STATUSES: WebhookDeliveryStatus[] = ["pending", "in_flight", "succeeded", "failed", "dead"];
const SIGNING_ALGORITHMS: WebhookSigningAlgorithm[] = ["hmac-sha256", "hmac-sha512", "none"];
const INTEROP_CONNECTORS: InteropConnectorKind[] = ["http_inbound", "mllp_listener", "http_outbound", "manual_upload", "file_sftp_poll", "internal_backend"];
const INTEROP_DIRECTIONS: InteropDirection[] = ["inbound", "outbound", "bidirectional"];
const INTEROP_PROTOCOLS: InteropProtocol[] = ["hl7v2", "csv", "json", "fhir_json", "other"];
const INTEROP_MESSAGE_STATUSES: InteropMessageStatus[] = ["failed", "dead", "queued", "received", "transformed", "delivered", "ignored_duplicate"];

type Tab = "integrations" | "deliveries" | "debug" | "interface-engine";

function fmt(value?: string | null) {
  if (!value) return "-";
  try {
    return new Date(value).toLocaleString("en-IN", {
      day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
    });
  } catch {
    return value;
  }
}

function statusPillClass(status: string) {
  switch (status) {
    case "active":
    case "succeeded":
      return "border-emerald-200 bg-emerald-50 text-emerald-800";
    case "paused":
    case "pending":
    case "in_flight":
      return "border-amber-200 bg-amber-50 text-amber-800";
    case "failed":
      return "border-orange-200 bg-orange-50 text-orange-800";
    case "archived":
      return "border-slate-200 bg-slate-100 text-slate-700";
    case "dead":
      return "border-red-200 bg-red-50 text-red-800";
    default:
      return "border-slate-200 bg-slate-50 text-slate-700";
  }
}

function severityPillClass(severity: IntegrationLogSeverity) {
  switch (severity) {
    case "error":
      return "border-red-200 bg-red-50 text-red-800";
    case "warn":
      return "border-amber-200 bg-amber-50 text-amber-800";
    case "info":
      return "border-blue-200 bg-blue-50 text-blue-800";
    default:
      return "border-slate-200 bg-slate-100 text-slate-700";
  }
}

export default function IntegrationsPage() {
  const [tab, setTab] = useState<Tab>("integrations");
  return (
    <div className="space-y-4 p-4">
      <header className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <Network className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-2xl font-semibold">Integrations</h1>
        </div>
        <p className="text-xs text-muted-foreground">
          Backed by /api/v1/admin/integrations and /webhook-{`{subscriptions,deliveries}`}. Signing secrets are server-side only.
        </p>
      </header>

      <div className="flex flex-wrap gap-1 rounded-lg border border-border bg-muted/30 p-1">
        {([
          { key: "integrations", label: "Integrations", icon: BookOpen },
          { key: "interface-engine", label: "Interface Engine", icon: Network },
          { key: "deliveries", label: "Deliveries", icon: ArrowRightCircle },
          { key: "debug", label: "Debug", icon: Send },
        ] as const).map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium ${
              tab === key
                ? "bg-emerald-100 text-emerald-800 border border-emerald-200"
                : "text-muted-foreground hover:bg-card"
            }`}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </button>
        ))}
      </div>

      {tab === "integrations" ? <IntegrationsTab /> : null}
      {tab === "interface-engine" ? <InterfaceEngineTab /> : null}
      {tab === "deliveries" ? <DeliveriesTab /> : null}
      {tab === "debug" ? <DebugTab /> : null}
    </div>
  );
}

// ===========================================================================
// Integrations tab
// ===========================================================================
function IntegrationsTab() {
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<IntegrationStatus | "all">("active");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [draft, setDraft] = useState({ name: "", integration_type: "", description: "" });

  const list = useQuery({
    queryKey: ["integrations", "list", statusFilter],
    queryFn: () => listIntegrations(statusFilter === "all" ? {} : { status: statusFilter }),
  });
  const integrations = useMemo(
    () => list.data?.integrations ?? [],
    [list.data?.integrations],
  );

  useEffect(() => {
    if (selectedId == null && integrations.length) {
      setSelectedId(integrations[0].id);
    } else if (selectedId != null && !integrations.some((i) => i.id === selectedId)) {
      setSelectedId(integrations[0]?.id ?? null);
    }
  }, [integrations, selectedId]);

  const create = useMutation({
    mutationFn: () => createIntegration({
      name: draft.name.trim(),
      integration_type: draft.integration_type.trim(),
      description: draft.description.trim() || null,
    }),
    onSuccess: (row) => {
      toast.success(`Integration "${row.name}" created`);
      setDraft({ name: "", integration_type: "", description: "" });
      setSelectedId(row.id);
      queryClient.invalidateQueries({ queryKey: ["integrations", "list"] });
    },
    onError: (err: Error) => toast.error(err.message || "Create failed"),
  });

  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: number; status: IntegrationStatus }) =>
      status === "archived" ? archiveIntegration(id) : updateIntegration(id, { status }),
    onSuccess: (row) => {
      toast.success(`Status → ${row.status}`);
      queryClient.invalidateQueries({ queryKey: ["integrations", "list"] });
      queryClient.invalidateQueries({ queryKey: ["integrations", "detail", row.id] });
    },
    onError: (err: Error) => toast.error(err.message || "Status change failed"),
  });

  const selected = integrations.find((i) => i.id === selectedId) ?? null;

  return (
    <section className="space-y-3">
      <div className="rounded-md border border-border bg-card p-3">
        <p className="mb-2 text-xs font-semibold text-muted-foreground">Create integration</p>
        <div className="grid gap-2 lg:grid-cols-12">
          <input
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            placeholder="Name (e.g. Stripe billing)"
            className="lg:col-span-4 rounded-md border border-border bg-background px-3 py-2 text-sm"
          />
          <input
            value={draft.integration_type}
            onChange={(e) => setDraft({ ...draft, integration_type: e.target.value })}
            placeholder="Type (e.g. stripe / fhir / abdm)"
            className="lg:col-span-3 rounded-md border border-border bg-background px-3 py-2 text-sm font-mono"
          />
          <input
            value={draft.description}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            placeholder="Description (optional)"
            className="lg:col-span-3 rounded-md border border-border bg-background px-3 py-2 text-sm"
          />
          <button
            type="button"
            onClick={() => create.mutate()}
            disabled={create.isPending || !draft.name.trim() || !draft.integration_type.trim()}
            className="lg:col-span-2 inline-flex items-center justify-center gap-1.5 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
          >
            <Plus className="h-4 w-4" />
            {create.isPending ? "Creating…" : "Create"}
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1">
        {(["all", ...INTEGRATION_STATUSES] as const).map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => setStatusFilter(value)}
            className={`rounded-md border px-2.5 py-1 text-xs font-medium ${
              statusFilter === value
                ? "border-emerald-200 bg-emerald-100 text-emerald-800"
                : "border-border bg-card hover:bg-accent"
            }`}
          >
            {value}
          </button>
        ))}
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        <div className="lg:col-span-1 space-y-1">
          {list.isLoading ? (
            <p className="text-xs text-muted-foreground">Loading integrations…</p>
          ) : integrations.length === 0 ? (
            <p className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
              No integrations in {statusFilter} status.
            </p>
          ) : (
            integrations.map((row) => (
              <button
                key={row.id}
                type="button"
                onClick={() => setSelectedId(row.id)}
                className={`w-full rounded-md border px-3 py-2 text-left text-xs ${
                  row.id === selectedId ? "border-emerald-300 bg-emerald-50" : "border-border bg-card hover:bg-accent"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold">{row.name}</span>
                  <span className={`rounded-full border px-2 py-0.5 ${statusPillClass(row.status)}`}>
                    {row.status}
                  </span>
                </div>
                <p className="mt-0.5 font-mono text-[0.65rem] text-muted-foreground">
                  {row.integration_type}
                  {typeof row.active_subscription_count === "number"
                    ? ` · ${row.active_subscription_count} active sub${row.active_subscription_count === 1 ? "" : "s"}`
                    : ""}
                </p>
              </button>
            ))
          )}
        </div>

        <div className="lg:col-span-2">
          {selected ? (
            <IntegrationDetail
              integration={selected}
              onChangeStatus={(status) => setStatus.mutate({ id: selected.id, status })}
              statusBusy={setStatus.isPending}
            />
          ) : (
            <p className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
              Select an integration to manage subscriptions.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

function IntegrationDetail({
  integration, onChangeStatus, statusBusy,
}: {
  integration: Integration;
  onChangeStatus: (status: IntegrationStatus) => void;
  statusBusy: boolean;
}) {
  const queryClient = useQueryClient();
  const [subDraft, setSubDraft] = useState({
    event_type: "",
    endpoint_url: "",
    signing_credential_id: "",
    signing_algorithm: "hmac-sha256" as WebhookSigningAlgorithm,
    is_active: true,
  });

  const subs = useQuery({
    queryKey: ["integrations", "detail", integration.id, "subscriptions"],
    queryFn: () => listIntegrationSubscriptions(integration.id),
  });
  const logs = useQuery({
    queryKey: ["integrations", "detail", integration.id, "logs"],
    queryFn: () => listIntegrationLogs(integration.id, { limit: 25 }),
  });

  const addSub = useMutation({
    mutationFn: () => {
      const credId = subDraft.signing_credential_id.trim();
      const credIdParsed = credId ? Number.parseInt(credId, 10) : null;
      return createSubscription(integration.id, {
        event_type: subDraft.event_type.trim(),
        endpoint_url: subDraft.endpoint_url.trim(),
        signing_credential_id: credIdParsed != null && Number.isFinite(credIdParsed) ? credIdParsed : null,
        signing_algorithm: subDraft.signing_algorithm,
        is_active: subDraft.is_active,
      });
    },
    onSuccess: () => {
      toast.success("Subscription added");
      setSubDraft({
        event_type: "", endpoint_url: "", signing_credential_id: "",
        signing_algorithm: "hmac-sha256", is_active: true,
      });
      queryClient.invalidateQueries({ queryKey: ["integrations", "detail", integration.id, "subscriptions"] });
      queryClient.invalidateQueries({ queryKey: ["integrations", "list"] });
    },
    onError: (err: Error) => toast.error(err.message || "Subscription create failed"),
  });

  const toggleSub = useMutation({
    mutationFn: ({ id, isActive }: { id: number; isActive: boolean }) =>
      updateSubscription(id, { is_active: !isActive }),
    onSuccess: (row) => {
      toast.success(`Subscription ${row.is_active ? "activated" : "paused"}`);
      queryClient.invalidateQueries({ queryKey: ["integrations", "detail", integration.id, "subscriptions"] });
    },
    onError: (err: Error) => toast.error(err.message || "Toggle failed"),
  });

  const removeSub = useMutation({
    mutationFn: (id: number) => deleteSubscription(id),
    onSuccess: () => {
      toast.success("Subscription deleted");
      queryClient.invalidateQueries({ queryKey: ["integrations", "detail", integration.id, "subscriptions"] });
      queryClient.invalidateQueries({ queryKey: ["integrations", "list"] });
    },
    onError: (err: Error) => toast.error(err.message || "Delete failed"),
  });

  const canSubmit =
    subDraft.event_type.trim().length > 0 &&
    subDraft.endpoint_url.trim().startsWith("http") &&
    !addSub.isPending;

  return (
    <div className="space-y-3 rounded-md border border-border bg-card p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-base font-semibold">{integration.name}</h3>
          <p className="font-mono text-xs text-muted-foreground">
            {integration.integration_type} · created {fmt(integration.created_at)}
          </p>
        </div>
        <div className="flex flex-wrap gap-1">
          {INTEGRATION_STATUSES.map((status) => (
            <button
              key={status}
              type="button"
              onClick={() => onChangeStatus(status)}
              disabled={statusBusy || integration.status === status}
              className={`rounded-md border px-2.5 py-1 text-xs font-medium ${
                integration.status === status
                  ? "border-emerald-300 bg-emerald-50 text-emerald-900"
                  : "border-border bg-card hover:bg-accent"
              } disabled:cursor-default`}
            >
              {status}
            </button>
          ))}
        </div>
      </div>

      <div>
        <p className="mb-1 text-xs font-semibold text-muted-foreground">Add subscription</p>
        <div className="grid gap-2 lg:grid-cols-12">
          <input
            value={subDraft.event_type}
            onChange={(e) => setSubDraft({ ...subDraft, event_type: e.target.value })}
            placeholder="event_type (e.g. patient.admitted)"
            className="lg:col-span-3 rounded-md border border-border bg-background px-3 py-2 text-xs font-mono"
          />
          <input
            value={subDraft.endpoint_url}
            onChange={(e) => setSubDraft({ ...subDraft, endpoint_url: e.target.value })}
            placeholder="https://example.com/hook"
            className="lg:col-span-4 rounded-md border border-border bg-background px-3 py-2 text-xs"
          />
          <input
            value={subDraft.signing_credential_id}
            onChange={(e) => setSubDraft({ ...subDraft, signing_credential_id: e.target.value })}
            placeholder="signing_credential_id (int)"
            inputMode="numeric"
            className="lg:col-span-2 rounded-md border border-border bg-background px-3 py-2 text-xs"
          />
          <select
            value={subDraft.signing_algorithm}
            onChange={(e) => setSubDraft({ ...subDraft, signing_algorithm: e.target.value as WebhookSigningAlgorithm })}
            className="lg:col-span-2 rounded-md border border-border bg-background px-3 py-2 text-xs"
          >
            {SIGNING_ALGORITHMS.map((algo) => (
              <option key={algo} value={algo}>{algo}</option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => addSub.mutate()}
            disabled={!canSubmit}
            className="lg:col-span-1 inline-flex items-center justify-center gap-1 rounded-md border border-emerald-200 bg-emerald-50 px-2 py-2 text-xs font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
          >
            <Plus className="h-3.5 w-3.5" />
            Add
          </button>
        </div>
      </div>

      <SubscriptionList
        subs={subs.data?.subscriptions ?? []}
        loading={subs.isLoading}
        onToggle={(s) => toggleSub.mutate({ id: s.id, isActive: s.is_active })}
        onDelete={(id) => {
          if (window.confirm("Delete this subscription? Outstanding deliveries will lose their target.")) {
            removeSub.mutate(id);
          }
        }}
        busy={toggleSub.isPending || removeSub.isPending}
      />

      <LogTail logs={logs.data?.logs ?? []} loading={logs.isLoading} />
    </div>
  );
}

function SubscriptionList({
  subs, loading, onToggle, onDelete, busy,
}: {
  subs: WebhookSubscription[];
  loading: boolean;
  onToggle: (s: WebhookSubscription) => void;
  onDelete: (id: number) => void;
  busy: boolean;
}) {
  return (
    <div>
      <p className="mb-1 text-xs font-semibold text-muted-foreground">Subscriptions</p>
      {loading ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : subs.length === 0 ? (
        <p className="rounded-md border border-dashed border-border p-2 text-xs text-muted-foreground">
          No subscriptions yet — add one above.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full text-xs">
            <thead className="bg-muted/50">
              <tr>
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">event_type</th>
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">endpoint</th>
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">signing</th>
                <th className="px-3 py-2 text-right font-medium text-muted-foreground">failures</th>
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">last delivered</th>
                <th className="px-3 py-2 text-right font-medium text-muted-foreground">actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {subs.map((s) => (
                <tr key={s.id}>
                  <td className="px-3 py-1.5 font-mono">{s.event_type}</td>
                  <td className="px-3 py-1.5 font-mono break-all">{s.endpoint_url}</td>
                  <td className="px-3 py-1.5">
                    <span className="font-mono">{s.signing_algorithm}</span>
                    {s.signing_credential_id != null
                      ? <span className="ml-1 text-muted-foreground">#{s.signing_credential_id}</span>
                      : null}
                  </td>
                  <td className="px-3 py-1.5 text-right">
                    {s.consecutive_failures} / {s.max_consecutive_failures}
                  </td>
                  <td className="px-3 py-1.5 text-muted-foreground">{fmt(s.last_delivered_at)}</td>
                  <td className="px-3 py-1.5 space-x-1 text-right">
                    <button
                      type="button"
                      onClick={() => onToggle(s)}
                      disabled={busy}
                      className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium disabled:opacity-50 ${
                        s.is_active
                          ? "border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100"
                          : "border-emerald-200 bg-emerald-50 text-emerald-800 hover:bg-emerald-100"
                      }`}
                    >
                      {s.is_active ? "Pause" : "Activate"}
                    </button>
                    <button
                      type="button"
                      onClick={() => onDelete(s.id)}
                      disabled={busy}
                      className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-red-50 px-2 py-1 text-xs font-medium text-red-800 hover:bg-red-100 disabled:opacity-50"
                    >
                      <Trash2 className="h-3 w-3" />
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function LogTail({ logs, loading }: { logs: IntegrationLog[]; loading: boolean }) {
  return (
    <div>
      <p className="mb-1 text-xs font-semibold text-muted-foreground">Recent integration logs</p>
      {loading ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : logs.length === 0 ? (
        <p className="rounded-md border border-dashed border-border p-2 text-xs text-muted-foreground">
          No log entries yet.
        </p>
      ) : (
        <ul className="space-y-1">
          {logs.slice(0, 20).map((log) => (
            <li
              key={log.id}
              className={`rounded-md border px-2 py-1 text-xs ${severityPillClass(log.severity)}`}
            >
              <span className="font-mono uppercase text-[0.6rem] tracking-wide">
                {log.severity}
              </span>{" "}
              <span className="font-mono">{log.log_type}</span>
              {log.message ? <> — {log.message}</> : null}
              <span className="ml-2 text-muted-foreground">{fmt(log.created_at)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ===========================================================================
// Deliveries tab
// ===========================================================================
function DeliveriesTab() {
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<WebhookDeliveryStatus | "all">("dead");
  const [drawerId, setDrawerId] = useState<number | null>(null);

  const list = useQuery({
    queryKey: ["webhook-deliveries", statusFilter],
    queryFn: () => listDeliveries(statusFilter === "all" ? { limit: 100 } : { status: statusFilter, limit: 100 }),
  });
  const detail = useQuery({
    queryKey: ["webhook-deliveries", "detail", drawerId],
    queryFn: () => getDelivery(drawerId as number),
    enabled: drawerId != null,
  });

  const markDead = useMutation({
    mutationFn: ({ id, reason }: { id: number; reason: string }) =>
      markDeliveryDead(id, { reason }),
    onSuccess: () => {
      toast.success("Delivery marked dead");
      queryClient.invalidateQueries({ queryKey: ["webhook-deliveries"] });
    },
    onError: (err: Error) => toast.error(err.message || "Mark-dead failed"),
  });

  const redrive = useMutation({
    mutationFn: ({ id, reason }: { id: number; reason: string }) =>
      redriveDelivery(id, { reason }),
    onSuccess: () => {
      toast.success("Delivery redriven — next dispatch tick will pick it up");
      queryClient.invalidateQueries({ queryKey: ["webhook-deliveries"] });
    },
    onError: (err: Error) => toast.error(err.message || "Redrive failed"),
  });

  const rows = list.data?.deliveries ?? [];

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center gap-1">
        {(["all", ...DELIVERY_STATUSES] as const).map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => setStatusFilter(value)}
            className={`rounded-md border px-2.5 py-1 text-xs font-medium ${
              statusFilter === value
                ? "border-emerald-200 bg-emerald-100 text-emerald-800"
                : "border-border bg-card hover:bg-accent"
            }`}
          >
            {value}
          </button>
        ))}
      </div>

      {list.isLoading ? (
        <p className="text-xs text-muted-foreground">Loading deliveries…</p>
      ) : rows.length === 0 ? (
        <p className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
          No deliveries in {statusFilter} status.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full text-xs">
            <thead className="bg-muted/50">
              <tr>
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">id</th>
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">event_type</th>
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">status</th>
                <th className="px-3 py-2 text-right font-medium text-muted-foreground">attempt</th>
                <th className="px-3 py-2 text-right font-medium text-muted-foreground">http</th>
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">next retry</th>
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">created</th>
                <th className="px-3 py-2 text-right font-medium text-muted-foreground">actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((row) => (
                <tr key={row.id} className="hover:bg-muted/20">
                  <td className="px-3 py-1.5 font-mono">
                    <button
                      type="button"
                      onClick={() => setDrawerId(row.id)}
                      className="hover:underline"
                    >
                      #{row.id}
                    </button>
                  </td>
                  <td className="px-3 py-1.5 font-mono">{row.event_type}</td>
                  <td className="px-3 py-1.5">
                    <span className={`rounded-full border px-2 py-0.5 ${statusPillClass(row.status)}`}>
                      {row.status}
                    </span>
                  </td>
                  <td className="px-3 py-1.5 text-right">{row.attempt_number}</td>
                  <td className="px-3 py-1.5 text-right font-mono">
                    {row.http_status ?? "—"}
                  </td>
                  <td className="px-3 py-1.5 text-muted-foreground">{fmt(row.next_retry_at)}</td>
                  <td className="px-3 py-1.5 text-muted-foreground">{fmt(row.created_at)}</td>
                  <td className="px-3 py-1.5 space-x-1 text-right">
                    {(row.status === "pending" || row.status === "failed") ? (
                      <button
                        type="button"
                        onClick={() => {
                          const reason = window.prompt(`Mark delivery #${row.id} dead? Reason:`, "");
                          if (reason == null) return;
                          const normalized = reason.trim();
                          if (!normalized) {
                            toast.error("A reason is required to mark a delivery dead");
                            return;
                          }
                          markDead.mutate({ id: row.id, reason: normalized });
                        }}
                        disabled={markDead.isPending}
                        className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-red-50 px-2 py-1 text-xs font-medium text-red-800 hover:bg-red-100 disabled:opacity-50"
                      >
                        <Skull className="h-3 w-3" />
                        Mark dead
                      </button>
                    ) : null}
                    {row.status === "dead" ? (
                      <button
                        type="button"
                        onClick={() => {
                          const reason = window.prompt(`Redrive delivery #${row.id}? Reason:`, "");
                          if (reason == null) return;
                          const normalized = reason.trim();
                          if (!normalized) {
                            toast.error("A reason is required to redrive a delivery");
                            return;
                          }
                          redrive.mutate({ id: row.id, reason: normalized });
                        }}
                        disabled={redrive.isPending}
                        className="inline-flex items-center gap-1 rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
                      >
                        <RefreshCw className="h-3 w-3" />
                        Redrive
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {drawerId != null ? (
        <DeliveryDetailDrawer
          delivery={detail.data ?? null}
          loading={detail.isLoading}
          onClose={() => setDrawerId(null)}
        />
      ) : null}
    </section>
  );
}

function DeliveryDetailDrawer({
  delivery, loading, onClose,
}: {
  delivery: WebhookDelivery | null;
  loading: boolean;
  onClose: () => void;
}) {
  return (
    <div className="rounded-md border border-border bg-card p-3">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold">
          <Activity className="h-4 w-4 text-muted-foreground" />
          Delivery detail
        </h3>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border border-border bg-card p-1 hover:bg-accent"
        >
          <X className="h-3 w-3" />
        </button>
      </div>
      {loading || !delivery ? (
        <p className="mt-2 text-xs text-muted-foreground">Loading…</p>
      ) : (
        <div className="mt-2 space-y-2 text-xs">
          <p className="font-mono">
            #{delivery.id} · {delivery.event_type} · attempt {delivery.attempt_number} ·{" "}
            <span className={`rounded-full border px-2 py-0.5 ${statusPillClass(delivery.status)}`}>
              {delivery.status}
            </span>
          </p>
          {delivery.error_message ? (
            <div className="rounded-md border border-red-200 bg-red-50 p-2 text-red-900">
              <p className="font-semibold">Error</p>
              <p className="font-mono text-[0.7rem]">{delivery.error_message}</p>
            </div>
          ) : null}
          {delivery.response_excerpt ? (
            <div>
              <p className="font-semibold text-muted-foreground">
                Response · HTTP {delivery.http_status ?? "—"}
              </p>
              <pre className="mt-1 max-h-40 overflow-auto rounded-md border border-border bg-muted/30 p-2 font-mono text-[0.7rem]">
                {delivery.response_excerpt}
              </pre>
            </div>
          ) : null}
          <div>
            <p className="font-semibold text-muted-foreground">Payload</p>
            <pre className="mt-1 max-h-72 overflow-auto rounded-md border border-border bg-muted/30 p-2 font-mono text-[0.7rem]">
              {JSON.stringify(delivery.payload ?? {}, null, 2)}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

// ===========================================================================
// Debug tab
// ===========================================================================
function DebugTab() {
  const queryClient = useQueryClient();
  const [eventType, setEventType] = useState("patient.admitted");
  const [payloadText, setPayloadText] = useState('{\n  "patient_uid": "",\n  "admission_id": null\n}');

  const dispatch = useMutation({
    mutationFn: () => dispatchNow({ batch_size: 25 }),
    onSuccess: (result) => {
      if (result.halted) {
        toast.error(`Dispatch halted: ${result.reason ?? "unknown"}`);
      } else {
        toast.success(
          `Dispatched ${result.dispatched} · succeeded ${result.succeeded} · failed ${result.failed} · dead ${result.dead}`,
        );
      }
      queryClient.invalidateQueries({ queryKey: ["webhook-deliveries"] });
    },
    onError: (err: Error) => toast.error(err.message || "Dispatch failed"),
  });

  const enqueue = useMutation({
    mutationFn: () => {
      let parsed: Record<string, unknown> = {};
      const text = payloadText.trim();
      if (text) {
        try {
          parsed = JSON.parse(text) as Record<string, unknown>;
        } catch {
          throw new Error("Payload must be a JSON object");
        }
      }
      return enqueueDelivery({ event_type: eventType.trim(), payload: parsed });
    },
    onSuccess: (result) => {
      toast.success(`Matched ${result.matched} subscription${result.matched === 1 ? "" : "s"}; enqueued ${result.enqueued.length}.`);
      queryClient.invalidateQueries({ queryKey: ["webhook-deliveries"] });
    },
    onError: (err: Error) => toast.error(err.message || "Enqueue failed"),
  });

  return (
    <section className="space-y-3">
      <div className="rounded-md border border-border bg-card p-3 space-y-2">
        <p className="flex items-center gap-2 text-xs font-semibold">
          <CheckCircle2 className="h-4 w-4 text-emerald-700" />
          Force a dispatcher tick
        </p>
        <p className="text-xs text-muted-foreground">
          Equivalent to the cron tick (batch=25, FOR UPDATE SKIP LOCKED) firing right now. Useful when an admin wants an immediate retry without waiting up to 30 seconds.
        </p>
        <button
          type="button"
          onClick={() => dispatch.mutate()}
          disabled={dispatch.isPending}
          className="inline-flex items-center gap-1.5 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
        >
          <Send className="h-4 w-4" />
          {dispatch.isPending ? "Dispatching…" : "Dispatch now"}
        </button>
      </div>

      <div className="rounded-md border border-border bg-card p-3 space-y-2">
        <p className="flex items-center gap-2 text-xs font-semibold">
          <AlertTriangle className="h-4 w-4 text-amber-700" />
          Manual enqueue (test / replay)
        </p>
        <p className="text-xs text-muted-foreground">
          Fans out one webhook_deliveries row per active subscription matching event_type. Use sparingly — every enqueue ends up exercising real subscribers.
        </p>
        <div className="grid gap-2 lg:grid-cols-12">
          <input
            value={eventType}
            onChange={(e) => setEventType(e.target.value)}
            placeholder="event_type"
            className="lg:col-span-4 rounded-md border border-border bg-background px-3 py-2 text-xs font-mono"
          />
          <button
            type="button"
            onClick={() => enqueue.mutate()}
            disabled={enqueue.isPending || !eventType.trim()}
            className="lg:col-span-2 inline-flex items-center justify-center gap-1.5 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-50"
          >
            <Send className="h-3.5 w-3.5" />
            {enqueue.isPending ? "Enqueuing…" : "Enqueue"}
          </button>
          <textarea
            value={payloadText}
            onChange={(e) => setPayloadText(e.target.value)}
            rows={8}
            spellCheck={false}
            className="lg:col-span-12 rounded-md border border-border bg-background px-3 py-2 font-mono text-xs"
            placeholder='{ "patient_uid": "..." }'
          />
        </div>
      </div>
    </section>
  );
}

// ===========================================================================
// Interface Engine tab
// ===========================================================================
const DEFAULT_HL7 = "MSH|^~\\&|ACME_HIS|ACME_FAC|VH|VH_HOSP|202607080930||ADT^A01|CTRL123|P|2.5\rPID|||11111111-1111-4111-8111-111111111111||KUMAR^Asha\rPV1||I|WARD^101^A||||DR01";
const DEFAULT_DSL = `{
  "kind": "hl7v2-to-backend-adapter",
  "output": {
    "patientUid": { "select": "PID.3" },
    "messageType": { "select": "MSH.9" },
    "controlId": { "select": "MSH.10" },
    "ward": { "select": "PV1.3" }
  },
  "validate": [
    { "path": "patientUid", "required": true },
    { "path": "controlId", "required": true }
  ],
  "emit": {
    "adapter": "backend.interop.preview",
    "idempotencyKey": ["channel", "MSH.10", "messageType"]
  }
}`;

function parseJsonObject(text: string, label: string) {
  try {
    const parsed = JSON.parse(text || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${label} must be a JSON object`);
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : `${label} must be valid JSON`);
  }
}

function InterfaceEngineTab() {
  const queryClient = useQueryClient();
  const [selectedChannelId, setSelectedChannelId] = useState<number | null>(null);
  const [messageStatus, setMessageStatus] = useState<InteropMessageStatus | "all">("failed");
  const [detailId, setDetailId] = useState<number | null>(null);
  const [lastVersionId, setLastVersionId] = useState<number | null>(null);
  const [lastTestId, setLastTestId] = useState<number | null>(null);
  const [channelDraft, setChannelDraft] = useState({
    channel_key: "his-adt-inbound",
    display_name: "HIS ADT inbound",
    direction: "inbound" as InteropDirection,
    connector_kind: "http_inbound" as InteropConnectorKind,
    protocol: "hl7v2" as InteropProtocol,
    message_types: "ADT^A01,ADT^A03",
    auth_sender_identifier: "VH_HOSP",
  });
  const [versionDraft, setVersionDraft] = useState({
    connector_config: '{ "endpointPath": "/api/v1/interface-engine/channels/his-adt-inbound/hl7", "ackMode": "durable_accept" }',
    transform_dsl: DEFAULT_DSL,
  });
  const [testDraft, setTestDraft] = useState({
    name: "ADT A01 synthetic fixture",
    message_type: "ADT^A01",
    input_payload: DEFAULT_HL7,
    expected_output: '{ "patientUid": "11111111-1111-4111-8111-111111111111", "messageType": "ADT^A01", "controlId": "CTRL123", "ward": "WARD^101^A" }',
  });

  const channelsQuery = useQuery({
    queryKey: ["interface-engine", "channels"],
    queryFn: () => listInterfaceChannels({ limit: 100 }),
  });
  const channels = useMemo(() => channelsQuery.data?.channels ?? [], [channelsQuery.data?.channels]);
  const selectedChannel = channels.find((row) => row.id === selectedChannelId) ?? channels[0] ?? null;
  const effectiveChannelId = selectedChannel?.id ?? null;

  useEffect(() => {
    if (selectedChannelId == null && channels.length) setSelectedChannelId(channels[0].id);
  }, [channels, selectedChannelId]);

  const messagesQuery = useQuery({
    queryKey: ["interface-engine", "messages", effectiveChannelId, messageStatus],
    queryFn: () => listInterfaceMessages({
      channel_id: effectiveChannelId ?? undefined,
      status: messageStatus === "all" ? undefined : messageStatus,
      limit: 100,
    }),
    enabled: effectiveChannelId != null,
  });
  const detailQuery = useQuery({
    queryKey: ["interface-engine", "message", detailId],
    queryFn: () => getInterfaceMessage(detailId as number),
    enabled: detailId != null,
  });
  const replayQuery = useQuery({
    queryKey: ["interface-engine", "replay-batches", effectiveChannelId],
    queryFn: () => listInterfaceReplayBatches({ channel_id: effectiveChannelId ?? undefined, limit: 10 }),
    enabled: effectiveChannelId != null,
  });

  const createChannelMutation = useMutation({
    mutationFn: () => createInterfaceChannel({
      ...channelDraft,
      message_types: channelDraft.message_types.split(",").map((v) => v.trim()).filter(Boolean),
      auth_kind: channelDraft.connector_kind === "http_inbound" || channelDraft.connector_kind === "mllp_listener"
        ? "tenant_interop_secret"
        : "none",
      auth_sender_identifier: channelDraft.auth_sender_identifier.trim() || null,
    }),
    onSuccess: (row) => {
      toast.success("Channel created");
      setSelectedChannelId(row.id);
      queryClient.invalidateQueries({ queryKey: ["interface-engine", "channels"] });
    },
    onError: (err: Error) => toast.error(err.message || "Channel create failed"),
  });

  const createVersionMutation = useMutation({
    mutationFn: () => {
      if (!effectiveChannelId) throw new Error("Select a channel first");
      return createInterfaceVersion(effectiveChannelId, {
        connector_config: parseJsonObject(versionDraft.connector_config, "connector_config"),
        transform_dsl: parseJsonObject(versionDraft.transform_dsl, "transform_dsl"),
        routing_policy: { adapter: "backend.interop.preview" },
      });
    },
    onSuccess: (row) => {
      toast.success(`Version ${row.version_number} created`);
      setLastVersionId(row.id);
    },
    onError: (err: Error) => toast.error(err.message || "Version create failed"),
  });

  const createTestMutation = useMutation({
    mutationFn: () => {
      if (!lastVersionId) throw new Error("Create a candidate version first");
      return createInterfaceTransformTest(lastVersionId, {
        name: testDraft.name,
        message_type: testDraft.message_type,
        input_payload: testDraft.input_payload,
        input_payload_is_synthetic: true,
        expected_output: parseJsonObject(testDraft.expected_output, "expected_output"),
      });
    },
    onSuccess: (row) => {
      toast.success("Transform test saved");
      setLastTestId(row.id);
    },
    onError: (err: Error) => toast.error(err.message || "Transform test create failed"),
  });

  const runTestMutation = useMutation({
    mutationFn: () => {
      if (!lastTestId) throw new Error("Create a transform test first");
      return runInterfaceTransformTest(lastTestId);
    },
    onSuccess: (row) => toast.success(`Transform test ${row.last_run_status}`),
    onError: (err: Error) => toast.error(err.message || "Transform test failed"),
  });

  const activateMutation = useMutation({
    mutationFn: () => {
      if (!lastVersionId) throw new Error("Create a candidate version first");
      return activateInterfaceVersion(lastVersionId);
    },
    onSuccess: () => {
      toast.success("Version activated");
      queryClient.invalidateQueries({ queryKey: ["interface-engine", "channels"] });
    },
    onError: (err: Error) => toast.error(err.message || "Activation failed"),
  });

  const markDeadMutation = useMutation({
    mutationFn: ({ id, reason }: { id: number; reason: string | null }) =>
      markInterfaceMessageDead(id, { reason }),
    onSuccess: () => {
      toast.success("Message moved to dead-letter");
      queryClient.invalidateQueries({ queryKey: ["interface-engine", "messages"] });
    },
    onError: (err: Error) => toast.error(err.message || "Dead-letter failed"),
  });

  const replayMutation = useMutation({
    mutationFn: () => {
      if (!effectiveChannelId) throw new Error("Select a channel first");
      return createInterfaceReplayBatch({
        channel_id: effectiveChannelId,
        reason: "Operator retry from interface engine dashboard",
        mode: "retry_delivery",
        selection_filter: { statuses: ["failed", "dead"], limit: 50 },
      });
    },
    onSuccess: (row) => {
      toast.success(`Replay queued ${row.message_count} message${row.message_count === 1 ? "" : "s"}`);
      queryClient.invalidateQueries({ queryKey: ["interface-engine", "messages"] });
      queryClient.invalidateQueries({ queryKey: ["interface-engine", "replay-batches"] });
    },
    onError: (err: Error) => toast.error(err.message || "Replay failed"),
  });

  const dispatchMutation = useMutation({
    mutationFn: () => dispatchInterfaceOutbound({ batch_size: 25 }),
    onSuccess: (result) => {
      toast.success(`Picked ${result.picked} · delivered ${result.delivered} · failed ${result.failed} · dead ${result.dead}`);
      queryClient.invalidateQueries({ queryKey: ["interface-engine", "messages"] });
    },
    onError: (err: Error) => toast.error(err.message || "Dispatch failed"),
  });

  const rows = messagesQuery.data?.messages ?? [];

  return (
    <section className="space-y-3">
      <div className="grid gap-3 xl:grid-cols-3">
        <div className="rounded-md border border-border bg-card p-3">
          <p className="mb-2 text-xs font-semibold text-muted-foreground">Channels</p>
          <div className="space-y-2">
            <input value={channelDraft.channel_key} onChange={(e) => setChannelDraft({ ...channelDraft, channel_key: e.target.value })} className="w-full rounded-md border border-border bg-background px-3 py-2 text-xs font-mono" />
            <input value={channelDraft.display_name} onChange={(e) => setChannelDraft({ ...channelDraft, display_name: e.target.value })} className="w-full rounded-md border border-border bg-background px-3 py-2 text-xs" />
            <div className="grid grid-cols-2 gap-2">
              <select value={channelDraft.direction} onChange={(e) => setChannelDraft({ ...channelDraft, direction: e.target.value as InteropDirection })} className="rounded-md border border-border bg-background px-3 py-2 text-xs">
                {INTEROP_DIRECTIONS.map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
              <select value={channelDraft.connector_kind} onChange={(e) => setChannelDraft({ ...channelDraft, connector_kind: e.target.value as InteropConnectorKind })} className="rounded-md border border-border bg-background px-3 py-2 text-xs">
                {INTEROP_CONNECTORS.map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
              <select value={channelDraft.protocol} onChange={(e) => setChannelDraft({ ...channelDraft, protocol: e.target.value as InteropProtocol })} className="rounded-md border border-border bg-background px-3 py-2 text-xs">
                {INTEROP_PROTOCOLS.map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
              <input value={channelDraft.auth_sender_identifier} onChange={(e) => setChannelDraft({ ...channelDraft, auth_sender_identifier: e.target.value })} className="rounded-md border border-border bg-background px-3 py-2 text-xs font-mono" />
            </div>
            <input value={channelDraft.message_types} onChange={(e) => setChannelDraft({ ...channelDraft, message_types: e.target.value })} className="w-full rounded-md border border-border bg-background px-3 py-2 text-xs font-mono" />
            <button type="button" onClick={() => createChannelMutation.mutate()} disabled={createChannelMutation.isPending} className="inline-flex items-center gap-1.5 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-50">
              <Plus className="h-3.5 w-3.5" />
              Create channel
            </button>
          </div>
          <div className="mt-3 space-y-1">
            {channelsQuery.isLoading ? <p className="text-xs text-muted-foreground">Loading…</p> : channels.map((channel) => (
              <button key={channel.id} type="button" onClick={() => setSelectedChannelId(channel.id)} className={`w-full rounded-md border px-3 py-2 text-left text-xs ${effectiveChannelId === channel.id ? "border-emerald-300 bg-emerald-50" : "border-border bg-background hover:bg-accent"}`}>
                <span className="font-semibold">{channel.display_name}</span>
                <span className={`ml-2 rounded-full border px-2 py-0.5 ${statusPillClass(channel.status)}`}>{channel.status}</span>
                <p className="mt-0.5 font-mono text-[0.65rem] text-muted-foreground">{channel.channel_key} · {channel.connector_kind} · v{channel.active_version_id ?? "-"}</p>
              </button>
            ))}
          </div>
        </div>

        <div className="rounded-md border border-border bg-card p-3 xl:col-span-2">
          <p className="mb-2 text-xs font-semibold text-muted-foreground">Version and transform fixture</p>
          <div className="grid gap-2 lg:grid-cols-2">
            <textarea value={versionDraft.connector_config} onChange={(e) => setVersionDraft({ ...versionDraft, connector_config: e.target.value })} rows={6} spellCheck={false} className="rounded-md border border-border bg-background px-3 py-2 font-mono text-[0.7rem]" />
            <textarea value={versionDraft.transform_dsl} onChange={(e) => setVersionDraft({ ...versionDraft, transform_dsl: e.target.value })} rows={6} spellCheck={false} className="rounded-md border border-border bg-background px-3 py-2 font-mono text-[0.7rem]" />
            <input value={testDraft.name} onChange={(e) => setTestDraft({ ...testDraft, name: e.target.value })} className="rounded-md border border-border bg-background px-3 py-2 text-xs" />
            <input value={testDraft.message_type} onChange={(e) => setTestDraft({ ...testDraft, message_type: e.target.value })} className="rounded-md border border-border bg-background px-3 py-2 text-xs font-mono" />
            <textarea value={testDraft.input_payload} onChange={(e) => setTestDraft({ ...testDraft, input_payload: e.target.value })} rows={4} spellCheck={false} className="rounded-md border border-border bg-background px-3 py-2 font-mono text-[0.7rem]" />
            <textarea value={testDraft.expected_output} onChange={(e) => setTestDraft({ ...testDraft, expected_output: e.target.value })} rows={4} spellCheck={false} className="rounded-md border border-border bg-background px-3 py-2 font-mono text-[0.7rem]" />
          </div>
          <div className="mt-2 flex flex-wrap gap-1">
            <button type="button" onClick={() => createVersionMutation.mutate()} disabled={createVersionMutation.isPending || !effectiveChannelId} className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-800 disabled:opacity-50">Create version</button>
            <button type="button" onClick={() => createTestMutation.mutate()} disabled={createTestMutation.isPending || !lastVersionId} className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs font-medium text-blue-800 disabled:opacity-50">Save test</button>
            <button type="button" onClick={() => runTestMutation.mutate()} disabled={runTestMutation.isPending || !lastTestId} className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800 disabled:opacity-50">Run test</button>
            <button type="button" onClick={() => activateMutation.mutate()} disabled={activateMutation.isPending || !lastVersionId} className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-800 disabled:opacity-50">Activate</button>
            {lastVersionId ? <span className="rounded-md border border-border px-3 py-2 text-xs text-muted-foreground">version #{lastVersionId}</span> : null}
            {lastTestId ? <span className="rounded-md border border-border px-3 py-2 text-xs text-muted-foreground">test #{lastTestId}</span> : null}
          </div>
        </div>
      </div>

      <div className="rounded-md border border-border bg-card p-3">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap gap-1">
            {(["all", ...INTEROP_MESSAGE_STATUSES] as const).map((value) => (
              <button key={value} type="button" onClick={() => setMessageStatus(value)} className={`rounded-md border px-2.5 py-1 text-xs font-medium ${messageStatus === value ? "border-emerald-200 bg-emerald-100 text-emerald-800" : "border-border bg-background hover:bg-accent"}`}>
                {value}
              </button>
            ))}
          </div>
          <div className="flex gap-1">
            <button type="button" onClick={() => replayMutation.mutate()} disabled={replayMutation.isPending || !effectiveChannelId} className="inline-flex items-center gap-1 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-800 disabled:opacity-50">
              <RefreshCw className="h-3 w-3" />
              Replay failed
            </button>
            <button type="button" onClick={() => dispatchMutation.mutate()} disabled={dispatchMutation.isPending} className="inline-flex items-center gap-1 rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-800 disabled:opacity-50">
              <Send className="h-3 w-3" />
              Dispatch
            </button>
          </div>
        </div>
        {rows.length === 0 ? (
          <p className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">No interface messages.</p>
        ) : (
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full text-xs">
              <thead className="bg-muted/50">
                <tr>
                  <th className="px-3 py-2 text-left font-medium text-muted-foreground">id</th>
                  <th className="px-3 py-2 text-left font-medium text-muted-foreground">type</th>
                  <th className="px-3 py-2 text-left font-medium text-muted-foreground">status</th>
                  <th className="px-3 py-2 text-left font-medium text-muted-foreground">preview</th>
                  <th className="px-3 py-2 text-left font-medium text-muted-foreground">error</th>
                  <th className="px-3 py-2 text-right font-medium text-muted-foreground">actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td className="px-3 py-1.5 font-mono">
                      <button type="button" onClick={() => setDetailId(row.id)} className="hover:underline">#{row.id}</button>
                    </td>
                    <td className="px-3 py-1.5 font-mono">{row.message_type ?? row.protocol}</td>
                    <td className="px-3 py-1.5"><span className={`rounded-full border px-2 py-0.5 ${statusPillClass(row.status)}`}>{row.status}</span></td>
                    <td className="px-3 py-1.5 font-mono text-[0.65rem] text-muted-foreground">{row.redacted_preview ?? "-"}</td>
                    <td className="px-3 py-1.5 font-mono text-[0.65rem] text-red-700">{row.last_error_safe ?? "-"}</td>
                    <td className="px-3 py-1.5 text-right">
                      {row.status !== "dead" ? (
                        <button type="button" onClick={() => markDeadMutation.mutate({ id: row.id, reason: "Operator dead-letter from dashboard" })} disabled={markDeadMutation.isPending} className="rounded-md border border-red-200 bg-red-50 px-2 py-1 text-xs font-medium text-red-800 disabled:opacity-50">Mark dead</button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {detailId != null ? (
        <InterfaceMessageDetail
          message={detailQuery.data ?? null}
          loading={detailQuery.isLoading}
          onClose={() => setDetailId(null)}
        />
      ) : null}

      {(replayQuery.data?.batches ?? []).length > 0 ? (
        <div className="rounded-md border border-border bg-card p-3">
          <p className="mb-1 text-xs font-semibold text-muted-foreground">Replay batches</p>
          <div className="space-y-1">
            {(replayQuery.data?.batches ?? []).map((batch) => (
              <p key={batch.id} className="rounded-md border border-border bg-background px-3 py-2 text-xs">
                <span className="font-mono">#{batch.id}</span> · {batch.mode} · {batch.message_count} · {fmt(batch.created_at)}
              </p>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function InterfaceMessageDetail({
  message, loading, onClose,
}: {
  message: InteropMessage | null;
  loading: boolean;
  onClose: () => void;
}) {
  return (
    <div className="rounded-md border border-border bg-card p-3">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold">
          <Activity className="h-4 w-4 text-muted-foreground" />
          Interface message
        </h3>
        <button type="button" onClick={onClose} className="rounded-md border border-border bg-card p-1 hover:bg-accent">
          <X className="h-3 w-3" />
        </button>
      </div>
      {loading || !message ? (
        <p className="mt-2 text-xs text-muted-foreground">Loading…</p>
      ) : (
        <div className="mt-2 space-y-2 text-xs">
          <p className="font-mono">#{message.id} · {message.direction} · {message.protocol} · {message.message_type ?? "-"}</p>
          <pre className="max-h-40 overflow-auto rounded-md border border-border bg-muted/30 p-2 font-mono text-[0.7rem]">
            {JSON.stringify(message.parsed_summary ?? {}, null, 2)}
          </pre>
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full text-xs">
              <thead className="bg-muted/50">
                <tr>
                  <th className="px-3 py-2 text-left font-medium text-muted-foreground">attempt</th>
                  <th className="px-3 py-2 text-left font-medium text-muted-foreground">phase</th>
                  <th className="px-3 py-2 text-left font-medium text-muted-foreground">status</th>
                  <th className="px-3 py-2 text-left font-medium text-muted-foreground">safe error</th>
                  <th className="px-3 py-2 text-left font-medium text-muted-foreground">time</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {(message.attempts ?? []).map((attempt) => (
                  <tr key={attempt.id}>
                    <td className="px-3 py-1.5 font-mono">{attempt.attempt_number}</td>
                    <td className="px-3 py-1.5 font-mono">{attempt.phase}</td>
                    <td className="px-3 py-1.5">{attempt.status}</td>
                    <td className="px-3 py-1.5 font-mono text-[0.65rem] text-red-700">{attempt.safe_error ?? "-"}</td>
                    <td className="px-3 py-1.5 text-muted-foreground">{fmt(attempt.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
