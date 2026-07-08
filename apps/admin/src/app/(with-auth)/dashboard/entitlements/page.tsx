"use client";

import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  PackageCheck,
  RefreshCw,
  Route,
  Save,
  ShieldCheck,
  Smartphone,
} from "lucide-react";
import { toast } from "react-hot-toast";
import {
  getCurrentEntitlementSummary,
  getTenantEntitlementAudit,
  getTenantEntitlementSummary,
  updateTenantEntitlement,
  type EntitlementAuditEvent,
  type ProductFeature,
  type ProductPackage,
  type TenantEntitlementSummary,
} from "@/lib/api/entitlements";

function formatDate(value?: string | null) {
  if (!value) return "-";
  try {
    return new Date(value).toLocaleString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return value;
  }
}

function statusClass(status: string) {
  const normalized = status.toLowerCase();
  if (
    normalized === "active" ||
    normalized === "allow" ||
    normalized === "default_visible"
  ) {
    return "border-emerald-200 bg-emerald-50 text-emerald-800";
  }
  if (normalized === "grace" || normalized === "status_only") {
    return "border-amber-200 bg-amber-50 text-amber-800";
  }
  return "border-red-200 bg-red-50 text-red-800";
}

function StatusPill({ value }: { value: string }) {
  return (
    <span
      className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${statusClass(value)}`}
    >
      {value.replace(/_/g, " ")}
    </span>
  );
}

function FeatureRows({ features }: { features: ProductFeature[] }) {
  return (
    <div className="overflow-hidden rounded-md border border-border">
      <table className="min-w-full divide-y divide-border text-sm">
        <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="px-3 py-2">Feature</th>
            <th className="px-3 py-2">Category</th>
            <th className="px-3 py-2">Enforcement</th>
            <th className="px-3 py-2">Status</th>
            <th className="px-3 py-2">Package</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border bg-card">
          {features.map((feature) => (
            <tr key={feature.featureKey}>
              <td className="px-3 py-3">
                <div className="font-medium text-foreground">
                  {feature.displayName}
                </div>
                <div className="text-xs text-muted-foreground">
                  {feature.featureKey}
                </div>
              </td>
              <td className="px-3 py-3 capitalize">{feature.category}</td>
              <td className="px-3 py-3">
                <div className="flex items-center gap-2">
                  {feature.urgentClinical ? (
                    <ShieldCheck className="h-4 w-4 text-emerald-600" />
                  ) : feature.enforcementMode === "hard_block" ? (
                    <AlertTriangle className="h-4 w-4 text-amber-600" />
                  ) : (
                    <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
                  )}
                  <span>{feature.enforcementMode.replace(/_/g, " ")}</span>
                </div>
              </td>
              <td className="px-3 py-3">
                <StatusPill value={feature.decision?.status ?? "unknown"} />
              </td>
              <td className="px-3 py-3 text-muted-foreground">
                {feature.decision?.packageDisplayName ?? "-"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PackageGrid({ packages }: { packages: ProductPackage[] }) {
  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
      {packages.map((pkg) => (
        <div
          key={pkg.packageKey}
          className="rounded-md border border-border bg-card p-4"
        >
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-foreground">
              {pkg.displayName}
            </h2>
            <StatusPill value={pkg.packageTier} />
          </div>
          <p className="mt-2 min-h-10 text-sm text-muted-foreground">
            {pkg.description}
          </p>
          <div className="mt-3 text-xs text-muted-foreground">
            {pkg.features.length} features · {pkg.gracePeriodDays} grace days
          </div>
        </div>
      ))}
    </div>
  );
}

function SurfaceList({
  title,
  icon,
  rows,
}: {
  title: string;
  icon: ReactNode;
  rows: TenantEntitlementSummary["nav"];
}) {
  return (
    <div className="rounded-md border border-border bg-card p-4">
      <div className="flex items-center gap-2 text-sm font-semibold">
        {icon}
        {title}
      </div>
      <div className="mt-3 space-y-2">
        {rows.map((row) => (
          <div
            key={`${row.surface}:${row.featureKey}`}
            className="flex items-center justify-between gap-3 text-sm"
          >
            <span className="truncate text-muted-foreground">
              {row.surface}
            </span>
            <StatusPill value={row.visible ? row.status : "hidden"} />
          </div>
        ))}
      </div>
    </div>
  );
}

function AuditList({ events }: { events: EntitlementAuditEvent[] }) {
  return (
    <div className="rounded-md border border-border bg-card">
      <div className="border-b border-border px-4 py-3 text-sm font-semibold">
        Recent Decisions
      </div>
      <div className="divide-y divide-border">
        {events.length === 0 ? (
          <div className="px-4 py-6 text-sm text-muted-foreground">
            No entitlement audit events yet.
          </div>
        ) : (
          events.slice(0, 8).map((event) => (
            <div
              key={event.id}
              className="grid gap-2 px-4 py-3 text-sm md:grid-cols-[1fr_auto_auto] md:items-center"
            >
              <div>
                <div className="font-medium text-foreground">
                  {event.action}
                </div>
                <div className="text-xs text-muted-foreground">
                  {event.featureKey ?? event.packageKey ?? "package"}
                </div>
              </div>
              <StatusPill value={event.decision} />
              <div className="text-xs text-muted-foreground">
                {formatDate(event.createdAt)}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export default function EntitlementsPage() {
  const queryClient = useQueryClient();
  const [tenantIdInput, setTenantIdInput] = useState("");
  const [packageKey, setPackageKey] = useState("enterprise");
  const [status, setStatus] = useState("active");
  const [expiresAt, setExpiresAt] = useState("");
  const [graceEndsAt, setGraceEndsAt] = useState("");

  const currentQuery = useQuery({
    queryKey: ["entitlements", "current"],
    queryFn: getCurrentEntitlementSummary,
  });

  useEffect(() => {
    if (currentQuery.data?.tenantId && !tenantIdInput) {
      setTenantIdInput(currentQuery.data.tenantId);
    }
  }, [currentQuery.data?.tenantId, tenantIdInput]);

  const tenantId = tenantIdInput.trim();
  const summaryQuery = useQuery({
    queryKey: ["entitlements", "tenant", tenantId],
    queryFn: () => getTenantEntitlementSummary(tenantId),
    enabled: tenantId.length > 0,
  });
  const auditQuery = useQuery({
    queryKey: ["entitlements", "tenant", tenantId, "audit"],
    queryFn: () => getTenantEntitlementAudit(tenantId),
    enabled: tenantId.length > 0,
  });

  const summary = summaryQuery.data ?? currentQuery.data;
  const packages = useMemo(
    () => summary?.catalog.packages ?? [],
    [summary?.catalog.packages],
  );
  const selectedPackage = useMemo(
    () => packages.find((pkg) => pkg.packageKey === packageKey) ?? packages[0],
    [packageKey, packages],
  );

  useEffect(() => {
    if (selectedPackage && packageKey !== selectedPackage.packageKey) {
      setPackageKey(selectedPackage.packageKey);
    }
  }, [packageKey, selectedPackage]);

  const updateMutation = useMutation({
    mutationFn: () =>
      updateTenantEntitlement(tenantId, {
        packageKey,
        status,
        expiresAt: expiresAt || null,
        graceEndsAt: graceEndsAt || null,
        source: "admin",
      }),
    onSuccess: () => {
      toast.success("Entitlement updated");
      queryClient.invalidateQueries({ queryKey: ["entitlements"] });
    },
    onError: (err: Error) =>
      toast.error(err.message || "Failed to update entitlement"),
  });

  const loading = currentQuery.isLoading || summaryQuery.isLoading;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <PackageCheck className="h-6 w-6 text-primary" />
            <h1 className="text-2xl font-bold text-foreground">Entitlements</h1>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Package catalog, route gates, navigation visibility, and mobile
            capabilities
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            currentQuery.refetch();
            summaryQuery.refetch();
            auditQuery.refetch();
          }}
          className="inline-flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm font-medium hover:bg-muted"
        >
          <RefreshCw className="h-4 w-4" />
          Refresh
        </button>
      </div>

      <div className="rounded-md border border-border bg-card p-4">
        <div className="grid gap-4 lg:grid-cols-[1.2fr_1fr_1fr_1fr_auto] lg:items-end">
          <label className="space-y-1 text-sm">
            <span className="font-medium text-muted-foreground">Tenant ID</span>
            <input
              value={tenantIdInput}
              onChange={(event) => setTenantIdInput(event.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-2"
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="font-medium text-muted-foreground">Package</span>
            <select
              value={packageKey}
              onChange={(event) => setPackageKey(event.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-2"
            >
              {packages.map((pkg) => (
                <option key={pkg.packageKey} value={pkg.packageKey}>
                  {pkg.displayName}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-sm">
            <span className="font-medium text-muted-foreground">Status</span>
            <select
              value={status}
              onChange={(event) => setStatus(event.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-2"
            >
              <option value="active">Active</option>
              <option value="grace">Grace</option>
              <option value="expired">Expired</option>
              <option value="suspended">Suspended</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </label>
          <label className="space-y-1 text-sm">
            <span className="font-medium text-muted-foreground">Expiry</span>
            <input
              type="datetime-local"
              value={expiresAt}
              onChange={(event) => setExpiresAt(event.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-2"
            />
          </label>
          <button
            type="button"
            disabled={!tenantId || !packageKey || updateMutation.isPending}
            onClick={() => updateMutation.mutate()}
            className="inline-flex items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            <Save className="h-4 w-4" />
            Save
          </button>
        </div>
        <label className="mt-4 block max-w-sm space-y-1 text-sm">
          <span className="font-medium text-muted-foreground">Grace ends</span>
          <input
            type="datetime-local"
            value={graceEndsAt}
            onChange={(event) => setGraceEndsAt(event.target.value)}
            className="w-full rounded-md border border-border bg-background px-3 py-2"
          />
        </label>
      </div>

      {loading ? (
        <div className="rounded-md border border-border bg-card p-6 text-sm text-muted-foreground">
          Loading entitlements...
        </div>
      ) : !summary ? (
        <div className="rounded-md border border-border bg-card p-6 text-sm text-muted-foreground">
          No entitlement summary available.
        </div>
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-4">
            <div className="rounded-md border border-border bg-card p-4">
              <div className="text-xs uppercase text-muted-foreground">
                Tenant
              </div>
              <div className="mt-2 break-all text-sm font-semibold">
                {summary.tenantId}
              </div>
            </div>
            <div className="rounded-md border border-border bg-card p-4">
              <div className="text-xs uppercase text-muted-foreground">
                Assigned packages
              </div>
              <div className="mt-2 text-2xl font-semibold">
                {summary.packages.length}
              </div>
            </div>
            <div className="rounded-md border border-border bg-card p-4">
              <div className="text-xs uppercase text-muted-foreground">
                Visible mobile surfaces
              </div>
              <div className="mt-2 text-2xl font-semibold">
                {summary.mobile.filter((row) => row.visible).length}
              </div>
            </div>
            <div className="rounded-md border border-border bg-card p-4">
              <div className="text-xs uppercase text-muted-foreground">
                Hard-block categories
              </div>
              <div className="mt-2 text-sm font-semibold">
                {summary.invariants.hardBlockCategories.join(", ")}
              </div>
            </div>
          </div>

          <PackageGrid packages={packages} />

          <div className="grid gap-4 lg:grid-cols-2">
            <SurfaceList
              title="Navigation"
              icon={<Route className="h-4 w-4" />}
              rows={summary.nav}
            />
            <SurfaceList
              title="Mobile"
              icon={<Smartphone className="h-4 w-4" />}
              rows={summary.mobile}
            />
          </div>

          <FeatureRows features={summary.features} />
          <AuditList events={auditQuery.data ?? []} />
        </>
      )}
    </div>
  );
}
