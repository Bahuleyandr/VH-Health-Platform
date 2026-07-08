import type { Dispatch, SetStateAction } from "react";
import { Plus, Save } from "lucide-react";
import type {
  DeveloperPortalApiClient,
  DeveloperPortalClientStatus,
  DeveloperPortalEnvironment,
} from "@/lib/api/developerPortal";
import { type ClientFormState, formatDate } from "./helpers";

interface ClientProfilePanelProps {
  clients: DeveloperPortalApiClient[];
  selectedClient: DeveloperPortalApiClient | null;
  clientForm: ClientFormState;
  setClientForm: Dispatch<SetStateAction<ClientFormState>>;
  onNewClient: () => void;
  onSelectClient: (client: DeveloperPortalApiClient) => void;
  onSaveClient: () => void;
  saving: boolean;
}

export function ClientProfilePanel({
  clients,
  selectedClient,
  clientForm,
  setClientForm,
  onNewClient,
  onSelectClient,
  onSaveClient,
  saving,
}: ClientProfilePanelProps) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-slate-950">Clients</h2>
        <button
          type="button"
          onClick={onNewClient}
          className="inline-flex items-center gap-2 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          <Plus className="h-4 w-4" />
          New
        </button>
      </div>
      <div className="overflow-hidden rounded-md border border-slate-200 bg-white">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3">Client</th>
              <th className="px-4 py-3">Environment</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Keys</th>
              <th className="px-4 py-3">Updated</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {clients.map((client) => (
              <tr
                key={client.id}
                className={selectedClient?.id === client.id ? "bg-teal-50" : "hover:bg-slate-50"}
              >
                <td className="px-4 py-3">
                  <button type="button" onClick={() => onSelectClient(client)} className="text-left">
                    <span className="block font-medium text-slate-950">{client.display_name}</span>
                    <span className="block text-xs text-slate-500">{client.client_code}</span>
                  </button>
                </td>
                <td className="px-4 py-3 capitalize text-slate-700">{client.environment}</td>
                <td className="px-4 py-3 capitalize text-slate-700">{client.status}</td>
                <td className="px-4 py-3 text-slate-700">{client.active_key_count}/{client.key_count}</td>
                <td className="px-4 py-3 text-slate-500">{formatDate(client.updated_at)}</td>
              </tr>
            ))}
            {clients.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-slate-500">
                  No API clients yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="rounded-md border border-slate-200 bg-white p-4">
        <h2 className="text-lg font-semibold text-slate-950">Client profile</h2>
        <form
          className="mt-4 grid gap-4 md:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            onSaveClient();
          }}
        >
          <label className="space-y-1">
            <span className="text-sm font-medium text-slate-700">Client code</span>
            <input
              value={clientForm.client_code}
              onChange={(event) => setClientForm((form) => ({ ...form, client_code: event.target.value }))}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              required
            />
          </label>
          <label className="space-y-1">
            <span className="text-sm font-medium text-slate-700">Display name</span>
            <input
              value={clientForm.display_name}
              onChange={(event) => setClientForm((form) => ({ ...form, display_name: event.target.value }))}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              required
            />
          </label>
          <label className="space-y-1">
            <span className="text-sm font-medium text-slate-700">Kind</span>
            <select
              value={clientForm.client_kind}
              onChange={(event) => setClientForm((form) => ({ ...form, client_kind: event.target.value }))}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            >
              {["integration", "webhook", "mobile_app", "partner", "internal_service", "other"].map((kind) => (
                <option key={kind} value={kind}>{kind}</option>
              ))}
            </select>
          </label>
          <label className="space-y-1">
            <span className="text-sm font-medium text-slate-700">Environment</span>
            <select
              value={clientForm.environment}
              onChange={(event) => setClientForm((form) => ({
                ...form,
                environment: event.target.value as DeveloperPortalEnvironment,
              }))}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            >
              <option value="sandbox">sandbox</option>
              <option value="production">production</option>
            </select>
          </label>
          <label className="space-y-1">
            <span className="text-sm font-medium text-slate-700">Status</span>
            <select
              value={clientForm.status}
              onChange={(event) => setClientForm((form) => ({
                ...form,
                status: event.target.value as DeveloperPortalClientStatus,
              }))}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            >
              {["active", "paused", "revoked", "archived"].map((status) => (
                <option key={status} value={status}>{status}</option>
              ))}
            </select>
          </label>
          <label className="space-y-1">
            <span className="text-sm font-medium text-slate-700">Rate limit profile</span>
            <input
              value={clientForm.rate_limit_profile}
              onChange={(event) => setClientForm((form) => ({ ...form, rate_limit_profile: event.target.value }))}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="space-y-1 md:col-span-2">
            <span className="text-sm font-medium text-slate-700">Description</span>
            <textarea
              value={clientForm.description}
              onChange={(event) => setClientForm((form) => ({ ...form, description: event.target.value }))}
              rows={2}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="space-y-1">
            <span className="text-sm font-medium text-slate-700">Scopes</span>
            <textarea
              value={clientForm.scopesText}
              onChange={(event) => setClientForm((form) => ({ ...form, scopesText: event.target.value }))}
              rows={5}
              className="w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-sm"
            />
          </label>
          <label className="space-y-1">
            <span className="text-sm font-medium text-slate-700">Allowed IPs</span>
            <textarea
              value={clientForm.allowedIpsText}
              onChange={(event) => setClientForm((form) => ({ ...form, allowedIpsText: event.target.value }))}
              rows={5}
              className="w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-sm"
            />
          </label>
          <label className="space-y-1">
            <span className="text-sm font-medium text-slate-700">Contact email</span>
            <input
              value={clientForm.contact_email}
              onChange={(event) => setClientForm((form) => ({ ...form, contact_email: event.target.value }))}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="space-y-1">
            <span className="text-sm font-medium text-slate-700">Contact phone</span>
            <input
              value={clientForm.contact_phone}
              onChange={(event) => setClientForm((form) => ({ ...form, contact_phone: event.target.value }))}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
          </label>
          <div className="md:col-span-2">
            <button
              type="submit"
              disabled={saving}
              className="inline-flex items-center gap-2 rounded-md bg-teal-700 px-4 py-2 text-sm font-medium text-white hover:bg-teal-800 disabled:opacity-60"
            >
              <Save className="h-4 w-4" />
              Save client
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
