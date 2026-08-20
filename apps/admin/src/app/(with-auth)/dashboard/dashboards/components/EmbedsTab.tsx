"use client";

// Embeds tab of the BI Dashboards page: gate notice, dashboard cards, and
// the sandboxed embed viewer with per-dashboard failure states.

import { useState } from "react";
import Link from "next/link";
import { ExternalLink, ShieldOff, X } from "lucide-react";
import { APIError } from "@/lib/api";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import type { AnalyticsBiGate, DashboardEntry } from "./types";
import { compactRoles, embedErrorInfo, statusClass } from "./helpers";

/**
 * Clear "not enabled" state for the fail-closed embed gate, instead of
 * dead-looking cards or a broken iframe. Which layer is dark decides the
 * wording; the enable path is the Integrations & Gates console (SUPER_ADMIN).
 */
function GateNotice({ gate }: { gate: AnalyticsBiGate }) {
  return (
    <div
      role="status"
      className="flex items-start gap-3 rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"
    >
      <ShieldOff className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
      <div>
        <p className="font-semibold">
          {gate.tenantEnabled
            ? "Metabase embedding is not configured for this deployment"
            : "Analytics embedding is not enabled for this hospital"}
        </p>
        <p className="mt-1">
          {gate.tenantEnabled
            ? "The backend is missing METABASE_URL / METABASE_EMBED_SECRET. Dashboards stay listed below but cannot be opened until the deployment is configured."
            : "Dashboards stay listed below but cannot be opened until a super-admin turns on the analytics BI flag for this hospital."}{" "}
          <Link
            href="/dashboard/integration-gates"
            className="font-medium underline underline-offset-2"
          >
            Integrations &amp; Gates
          </Link>{" "}
          (SUPER_ADMIN) shows every layer of this gate.
        </p>
      </div>
    </div>
  );
}

/**
 * Per-dashboard embed failure, mapped from the backend's fail-closed codes
 * instead of a generic banner.
 */
function EmbedFailure({ error }: { error: unknown }) {
  const { code, message } = embedErrorInfo(error);
  if (code === "ANALYTICS_BI_TENANT_DISABLED") {
    return (
      <div className="p-8 text-sm">
        <p className="font-medium text-foreground">
          Analytics embedding is not enabled for this hospital.
        </p>
        <p className="mt-1 text-muted-foreground">
          A super-admin can enable the analytics BI flag under{" "}
          <Link
            href="/dashboard/integration-gates"
            className="font-medium text-primary underline underline-offset-2"
          >
            Integrations &amp; Gates
          </Link>
          .
        </p>
      </div>
    );
  }
  if (code === "DASHBOARD_ROLE_FORBIDDEN") {
    return (
      <div className="p-8 text-sm text-muted-foreground">
        This dashboard is not available for your role.
      </div>
    );
  }
  const notConfigured = error instanceof APIError && error.status === 400;
  return (
    <div className="p-8 text-sm text-muted-foreground">
      {notConfigured
        ? "Metabase embedding is not configured for this deployment (METABASE_URL + METABASE_EMBED_SECRET)."
        : message || "Failed to load this dashboard embed."}
    </div>
  );
}

/**
 * Sandboxed Metabase iframe with a load-error fallback. allow-scripts +
 * allow-same-origin are what a signed static Metabase embed needs;
 * allow-downloads covers result exports. No top-navigation, no popups, no
 * forms. NOTE: the admin CSP only opens frame-src when
 * NEXT_PUBLIC_METABASE_ORIGIN is configured (src/middleware.ts).
 */
function EmbedFrame({ src, title }: { src: string; title: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <div className="p-8 text-sm text-muted-foreground">
        The dashboard frame failed to load. Check that the Metabase origin is
        reachable from this browser and allowed by NEXT_PUBLIC_METABASE_ORIGIN.
      </div>
    );
  }
  return (
    <iframe
      src={src}
      className="w-full"
      style={{ height: "70vh", border: 0 }}
      title={title}
      sandbox="allow-scripts allow-same-origin allow-downloads"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}

export default function EmbedsTab({
  dashboards,
  gate,
  openKey,
  embedUrl,
  embedError,
  loadingEmbed,
  onOpen,
  onClose,
}: {
  dashboards: DashboardEntry[];
  gate: AnalyticsBiGate | null;
  openKey: string | null;
  embedUrl: string | null;
  embedError: unknown;
  loadingEmbed: boolean;
  onOpen: (dashboard: DashboardEntry) => void;
  onClose: () => void;
}) {
  const activeDashboard = dashboards.find(
    (dashboard) => dashboard.key === openKey,
  );
  const gateOff = gate !== null && !gate.effective;

  return (
    <div className="space-y-4">
      {gate !== null && !gate.effective && <GateNotice gate={gate} />}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {dashboards.map((dashboard) => {
          const canOpen =
            dashboard.status === "active" && dashboard.available && !gateOff;
          return (
            <button
              key={dashboard.key}
              type="button"
              onClick={() => canOpen && onOpen(dashboard)}
              disabled={!canOpen}
              className={`min-h-44 rounded-md border bg-card p-4 text-left shadow-sm transition hover:border-primary/50 hover:bg-muted/30 disabled:cursor-not-allowed disabled:opacity-70 ${
                openKey === dashboard.key ? "ring-2 ring-primary" : ""
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="text-base font-semibold text-foreground">
                    {dashboard.title}
                  </h2>
                  <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                    {dashboard.description}
                  </p>
                </div>
                <span
                  className={`shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium ${
                    dashboard.status === "active" &&
                    dashboard.available &&
                    gateOff
                      ? "border-amber-200 bg-amber-50 text-amber-800"
                      : statusClass(dashboard.status)
                  }`}
                >
                  {dashboard.status === "active" && dashboard.available
                    ? gateOff
                      ? "Not enabled"
                      : "Ready"
                    : dashboard.status === "held"
                      ? "Held"
                      : "Config"}
                </span>
              </div>
              <div className="mt-4 space-y-2 text-xs text-muted-foreground">
                <p>
                  <span className="font-medium text-foreground">Owner:</span>{" "}
                  {dashboard.ownerRole}
                </p>
                <p>
                  <span className="font-medium text-foreground">Datasets:</span>{" "}
                  {dashboard.datasetKeys.length
                    ? dashboard.datasetKeys.join(", ")
                    : "Pending"}
                </p>
                <p>
                  <span className="font-medium text-foreground">Roles:</span>{" "}
                  {compactRoles(dashboard.embedRoles)}
                </p>
              </div>
              {canOpen && (
                <span className="mt-4 inline-flex items-center gap-2 text-sm font-medium text-primary">
                  <ExternalLink className="h-4 w-4" aria-hidden="true" />
                  Open embed
                </span>
              )}
            </button>
          );
        })}
      </div>

      {openKey !== null && (
        <div className="rounded-md border bg-card shadow-sm">
          <div className="flex items-center justify-between gap-3 border-b p-3">
            <div>
              <h2 className="text-base font-semibold">
                {activeDashboard?.title}
              </h2>
              <p className="text-xs text-muted-foreground">
                {activeDashboard?.datasetKeys.join(", ")}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-9 w-9 items-center justify-center rounded border border-border text-muted-foreground hover:text-foreground"
              aria-label="Close embed"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
          {loadingEmbed ? (
            <LoadingSpinner />
          ) : embedUrl ? (
            <EmbedFrame
              key={embedUrl}
              src={embedUrl}
              title={openKey ?? "embed"}
            />
          ) : embedError ? (
            <EmbedFailure error={embedError} />
          ) : (
            <div className="p-8 text-sm text-muted-foreground">
              Embed URL unavailable for this dashboard.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
