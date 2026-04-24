"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, Globe2, RefreshCw, ShieldCheck } from "lucide-react";
import { toast } from "react-hot-toast";
import {
  createTenant,
  listTenants,
  updateTenant,
  type Tenant,
  type TenantComplianceProfile,
  type TenantRegion,
} from "@/lib/api/tenants";
import { usePermissions } from "@/hooks/usePermissions";

function fmt(value?: string | null) {
  if (!value) return "-";
  try {
    return new Date(value).toLocaleString("en-IN", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return value;
  }
}

function regionBadge(region: TenantRegion) {
  const map: Record<TenantRegion, string> = {
    IN: "bg-orange-100 text-orange-800 border-orange-200",
    EU: "bg-blue-100 text-blue-800 border-blue-200",
    US: "bg-sky-100 text-sky-800 border-sky-200",
    AP: "bg-teal-100 text-teal-800 border-teal-200",
    OTHER: "bg-slate-100 text-slate-700 border-slate-200",
  };
  return map[region];
}

function complianceBadge(profile: TenantComplianceProfile) {
  const map: Record<TenantComplianceProfile, string> = {
    DPDP: "bg-emerald-100 text-emerald-800 border-emerald-200",
    HIPAA: "bg-violet-100 text-violet-800 border-violet-200",
    GDPR: "bg-indigo-100 text-indigo-800 border-indigo-200",
    NONE: "bg-slate-100 text-slate-700 border-slate-200",
  };
  return map[profile];
}

function statusBadge(status: string) {
  if (status === "active") return "bg-emerald-100 text-emerald-800 border-emerald-200";
  if (status === "suspended") return "bg-red-100 text-red-800 border-red-200";
  return "bg-amber-100 text-amber-800 border-amber-200";
}

export default function TenantsAdminPage() {
  const queryClient = useQueryClient();
  const { isSuperAdmin, loading: permLoading } = usePermissions();
  const [showCreate, setShowCreate] = useState(false);
  const [draft, setDraft] = useState({
    slug: "",
    name: "",
    region: "IN" as TenantRegion,
    compliance_profile: "DPDP" as TenantComplianceProfile,
  });

  const tenants = useQuery({
    queryKey: ["tenants"],
    queryFn: () => listTenants(),
  });

  const create = useMutation({
    mutationFn: () => createTenant(draft),
    onSuccess: () => {
      toast.success("Tenant created");
      setShowCreate(false);
      setDraft({ slug: "", name: "", region: "IN", compliance_profile: "DPDP" });
      queryClient.invalidateQueries({ queryKey: ["tenants"] });
    },
    onError: (err: Error) => toast.error(err.message || "Create failed"),
  });

  const update = useMutation({
    mutationFn: (payload: { id: string; patch: Partial<Tenant> }) => updateTenant(payload.id, payload.patch),
    onSuccess: () => {
      toast.success("Tenant updated");
      queryClient.invalidateQueries({ queryKey: ["tenants"] });
    },
    onError: (err: Error) => toast.error(err.message || "Update failed"),
  });

  if (permLoading) {
    return <div className="p-6 text-sm text-muted-foreground">Checking permissions…</div>;
  }
  if (!isSuperAdmin) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-6 text-red-900">
        <div className="flex items-center gap-2 font-semibold">
          <ShieldCheck className="h-5 w-5" />
          Super-admin only
        </div>
        <p className="mt-2 text-sm">
          Tenant administration is restricted to platform-level super-admins. Switch accounts to proceed.
        </p>
      </div>
    );
  }

  const rows: Tenant[] = tenants.data?.tenants ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <Building2 className="h-6 w-6" />
            Tenants
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Each tenant is a hospital or clinic. Region + compliance profile shape which AI providers and data-residency rules apply.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => tenants.refetch()}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-2 text-sm font-medium hover:bg-accent"
          >
            <RefreshCw className="h-4 w-4" />
            Refresh
          </button>
          <button
            onClick={() => setShowCreate((current) => !current)}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            {showCreate ? "Cancel" : "+ New Tenant"}
          </button>
        </div>
      </div>

      {showCreate ? (
        <div className="rounded-lg border border-border bg-muted/30 p-4">
          <div className="grid gap-3 md:grid-cols-4">
            <label className="text-xs text-muted-foreground">
              Slug
              <input
                value={draft.slug}
                onChange={(event) => setDraft({ ...draft, slug: event.target.value })}
                placeholder="acme-hospital"
                className="mt-1 w-full rounded-md border border-border bg-card px-2 py-1 text-sm font-mono"
              />
            </label>
            <label className="text-xs text-muted-foreground md:col-span-2">
              Hospital name
              <input
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                placeholder="Acme Hospital Pvt Ltd"
                className="mt-1 w-full rounded-md border border-border bg-card px-2 py-1 text-sm"
              />
            </label>
            <label className="text-xs text-muted-foreground">
              Region
              <select
                value={draft.region}
                onChange={(event) => setDraft({ ...draft, region: event.target.value as TenantRegion })}
                className="mt-1 w-full rounded-md border border-border bg-card px-2 py-1 text-sm"
              >
                <option value="IN">IN — India</option>
                <option value="EU">EU — European Union</option>
                <option value="US">US — United States</option>
                <option value="AP">AP — Asia-Pacific (non-IN)</option>
                <option value="OTHER">Other</option>
              </select>
            </label>
            <label className="text-xs text-muted-foreground">
              Compliance profile
              <select
                value={draft.compliance_profile}
                onChange={(event) => setDraft({ ...draft, compliance_profile: event.target.value as TenantComplianceProfile })}
                className="mt-1 w-full rounded-md border border-border bg-card px-2 py-1 text-sm"
              >
                <option value="DPDP">DPDP (India)</option>
                <option value="HIPAA">HIPAA (US)</option>
                <option value="GDPR">GDPR (EU)</option>
                <option value="NONE">None</option>
              </select>
            </label>
          </div>
          <div className="mt-3 flex justify-end">
            <button
              onClick={() => create.mutate()}
              disabled={!draft.slug || !draft.name || create.isPending}
              className="rounded-md border border-border bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              Create Tenant
            </button>
          </div>
        </div>
      ) : null}

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Tenant</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                <span className="inline-flex items-center gap-1">
                  <Globe2 className="h-3.5 w-3.5" />
                  Region
                </span>
              </th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Compliance</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Status</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Created</th>
              <th className="px-4 py-3 text-right font-medium text-muted-foreground">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.length === 0 ? (
              <tr>
                <td className="px-4 py-8 text-center text-muted-foreground" colSpan={6}>
                  No tenants
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.id}>
                  <td className="px-4 py-3">
                    <div className="font-medium">{row.name}</div>
                    <div className="text-xs text-muted-foreground font-mono">{row.slug} / {row.id.slice(0, 8)}</div>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${regionBadge(row.region)}`}>
                      {row.region}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${complianceBadge(row.compliance_profile)}`}>
                      {row.compliance_profile}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${statusBadge(row.status)}`}>
                      {row.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">{fmt(row.created_at)}</td>
                  <td className="px-4 py-3 text-right">
                    <div className="inline-flex gap-1">
                      {row.status === "active" ? (
                        <button
                          onClick={() => update.mutate({ id: row.id, patch: { status: "suspended" } })}
                          disabled={update.isPending || row.slug === "default"}
                          title={row.slug === "default" ? "Default tenant cannot be suspended" : undefined}
                          className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-xs font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-50"
                        >
                          Suspend
                        </button>
                      ) : (
                        <button
                          onClick={() => update.mutate({ id: row.id, patch: { status: "active" } })}
                          disabled={update.isPending}
                          className="rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
                        >
                          Reactivate
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
