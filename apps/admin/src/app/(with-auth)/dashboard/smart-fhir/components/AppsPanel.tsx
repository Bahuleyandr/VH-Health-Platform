"use client";

import { EmptyState } from "@/components/EmptyState";
import {
  SMART_APP_STATUSES,
  SMART_ENVIRONMENTS,
  type SmartApp,
} from "@/lib/api/smartFhir";
import { AppWindow, Plus } from "lucide-react";
import { useMemo, useState } from "react";

import { RegisterAppForm } from "./RegisterAppForm";
import { formatDateTime, ScopeChips, StatusPill } from "./shared";

const selectClass =
  "rounded-md border border-border bg-background px-2 py-1.5 text-sm";

export function AppsPanel({ apps }: { apps: SmartApp[] }) {
  const [showRegister, setShowRegister] = useState(false);
  const [envFilter, setEnvFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");

  const filtered = useMemo(
    () =>
      apps.filter(
        (app) =>
          (!envFilter || app.environment === envFilter) &&
          (!statusFilter || app.status === statusFilter),
      ),
    [apps, envFilter, statusFilter],
  );

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold text-foreground">
          Registered apps ({filtered.length})
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label="Filter apps by environment"
            className={selectClass}
            value={envFilter}
            onChange={(e) => setEnvFilter(e.target.value)}
          >
            <option value="">All environments</option>
            {SMART_ENVIRONMENTS.map((env) => (
              <option key={env} value={env}>
                {env}
              </option>
            ))}
          </select>
          <select
            aria-label="Filter apps by status"
            className={selectClass}
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            <option value="">All statuses</option>
            {SMART_APP_STATUSES.map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => setShowRegister((prev) => !prev)}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground"
          >
            <Plus className="h-4 w-4" />
            Register app
          </button>
        </div>
      </div>

      {showRegister && (
        <RegisterAppForm onDone={() => setShowRegister(false)} />
      )}

      {filtered.length === 0 ? (
        <div className="rounded-md border border-border bg-card">
          <EmptyState
            compact
            icon={<AppWindow className="h-10 w-10 text-muted-foreground" />}
            title="No SMART apps registered"
            description="Register a client app to let it request FHIR access through the public OAuth surface."
          />
        </div>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border bg-card">
          <table className="min-w-full divide-y divide-border text-sm">
            <thead className="bg-muted/40 text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-3 py-2">Client ID</th>
                <th className="px-3 py-2">Name</th>
                <th className="px-3 py-2">Kind</th>
                <th className="px-3 py-2">Env</th>
                <th className="px-3 py-2">Redirect URIs</th>
                <th className="px-3 py-2">Allowed scopes</th>
                <th className="px-3 py-2">Registration</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filtered.map((app) => (
                <tr key={app.id}>
                  <td className="px-3 py-3 font-mono text-xs">
                    {app.client_id}
                  </td>
                  <td className="px-3 py-3">
                    <div className="font-medium text-foreground">
                      {app.display_name}
                    </div>
                    {app.description && (
                      <div className="text-xs text-muted-foreground">
                        {app.description}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-3 text-xs">{app.app_kind}</td>
                  <td className="px-3 py-3 text-xs">{app.environment}</td>
                  <td
                    className="max-w-56 px-3 py-3 text-xs text-muted-foreground"
                    title={app.redirect_uris.join("\n")}
                  >
                    {app.redirect_uris.length === 0
                      ? "-"
                      : app.redirect_uris.length === 1
                        ? app.redirect_uris[0]
                        : `${app.redirect_uris[0]} (+${app.redirect_uris.length - 1})`}
                  </td>
                  <td className="px-3 py-3">
                    <ScopeChips scopes={app.allowed_scopes} />
                  </td>
                  <td className="px-3 py-3">
                    <StatusPill value={app.registration_status} />
                  </td>
                  <td className="px-3 py-3">
                    <StatusPill value={app.status} />
                  </td>
                  <td className="whitespace-nowrap px-3 py-3 text-xs text-muted-foreground">
                    {formatDateTime(app.created_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
