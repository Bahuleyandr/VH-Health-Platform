"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, ChevronDown, Globe2, KeyRound, Palette, RefreshCw, RotateCcw, ShieldCheck } from "lucide-react";
import { toast } from "react-hot-toast";
import {
  createTenant,
  getTenantKekRewrapJob,
  listTenantInteropSecrets,
  listTenants,
  startTenantKekRewrapJob,
  updateTenant,
  updateTenantBrandKit,
  upsertTenantInteropSecret,
  type Tenant,
  type TenantBrandKitPatch,
  type TenantComplianceProfile,
  type TenantInteropSecret,
  type TenantKekRewrapJob,
  type TenantRegion,
} from "@/lib/api/tenants";
import { usePermissions } from "@/hooks/usePermissions";
import { useActingTenant } from "@/contexts/ActingTenantContext";

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

function interopKindLabel(kind: TenantInteropSecret["kind"]) {
  if (kind === "abdm_callback") return "ABDM callback";
  if (kind === "hl7_inbound") return "HL7 inbound";
  return kind;
}

function jobStatusBadge(status?: TenantKekRewrapJob["status"]) {
  if (status === "succeeded") return "bg-emerald-100 text-emerald-800 border-emerald-200";
  if (status === "failed") return "bg-red-100 text-red-800 border-red-200";
  if (status === "running" || status === "queued") return "bg-blue-100 text-blue-800 border-blue-200";
  return "bg-slate-100 text-slate-700 border-slate-200";
}

type BrandDraft = {
  name: string;
  primaryColor: string;
  logoUrl: string;
  logoStorageKey: string;
  supportEmail: string;
  helpCenterUrl: string;
  legalName: string;
  legalFooter: string;
  documentLetterheadStorageKey: string;
  documentFooterText: string;
  emailFromName: string;
  emailReplyTo: string;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asText(value: unknown) {
  return typeof value === "string" ? value : "";
}

function blankToNull(value: string) {
  const text = value.trim();
  return text ? text : null;
}

function brandDraftFromTenant(tenant: Tenant): BrandDraft {
  const branding = asRecord(tenant.settings?.branding);
  const assets = asRecord(branding.assets);
  const document = asRecord(branding.document);
  const email = asRecord(branding.email);
  const logoAsset = asRecord(assets.logo);
  const letterheadAsset = asRecord(assets.documentLetterhead);
  return {
    name: asText(branding.name),
    primaryColor: asText(branding.primaryColor),
    logoUrl: asText(branding.logoUrl),
    logoStorageKey: asText(logoAsset.storageKey),
    supportEmail: asText(branding.supportEmail),
    helpCenterUrl: asText(branding.helpCenterUrl),
    legalName: asText(branding.legalName),
    legalFooter: asText(branding.legalFooter),
    documentLetterheadStorageKey: asText(letterheadAsset.storageKey),
    documentFooterText: asText(document.footerText),
    emailFromName: asText(email.fromName),
    emailReplyTo: asText(email.replyTo),
  };
}

function brandPatchFromDraft(draft: BrandDraft): TenantBrandKitPatch {
  return {
    name: blankToNull(draft.name),
    primaryColor: blankToNull(draft.primaryColor),
    logoUrl: blankToNull(draft.logoUrl),
    supportEmail: blankToNull(draft.supportEmail),
    helpCenterUrl: blankToNull(draft.helpCenterUrl),
    legalName: blankToNull(draft.legalName),
    legalFooter: blankToNull(draft.legalFooter),
    document: {
      footerText: blankToNull(draft.documentFooterText),
    },
    email: {
      fromName: blankToNull(draft.emailFromName),
      replyTo: blankToNull(draft.emailReplyTo),
    },
    assets: {
      logo: draft.logoStorageKey.trim() ? { storageKey: draft.logoStorageKey.trim() } : null,
      documentLetterhead: draft.documentLetterheadStorageKey.trim()
        ? { storageKey: draft.documentLetterheadStorageKey.trim() }
        : null,
    },
  };
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
  const [selectedTenantId, setSelectedTenantId] = useState<string | null>(null);
  const [secretDraft, setSecretDraft] = useState({
    kind: "abdm_callback" as TenantInteropSecret["kind"],
    senderIdentifier: "",
    secret: "",
  });
  const [brandDrafts, setBrandDrafts] = useState<Record<string, BrandDraft>>({});
  const [jobIds, setJobIds] = useState<Record<string, string>>({});

  const tenants = useQuery({
    queryKey: ["tenants"],
    queryFn: () => listTenants(),
  });

  const selectedTenant = tenants.data?.tenants.find((tenant) => tenant.id === selectedTenantId) ?? null;
  const selectedJobId = selectedTenantId ? jobIds[selectedTenantId] : undefined;
  const selectedBrandDraft = selectedTenant
    ? brandDrafts[selectedTenant.id] ?? brandDraftFromTenant(selectedTenant)
    : null;

  const interopSecrets = useQuery({
    queryKey: ["tenant-interop-secrets", selectedTenantId],
    queryFn: () => listTenantInteropSecrets(selectedTenantId as string),
    enabled: Boolean(selectedTenantId),
  });

  const kekJob = useQuery({
    queryKey: ["tenant-kek-rewrap-job", selectedTenantId, selectedJobId],
    queryFn: () => getTenantKekRewrapJob(selectedTenantId as string, selectedJobId as string),
    enabled: Boolean(selectedTenantId && selectedJobId),
    refetchInterval: (query) => {
      const status = (query.state.data as TenantKekRewrapJob | undefined)?.status;
      return status === "queued" || status === "running" ? 2000 : false;
    },
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

  const saveBrandKit = useMutation({
    mutationFn: (payload: { id: string; draft: BrandDraft }) =>
      updateTenantBrandKit(payload.id, brandPatchFromDraft(payload.draft)),
    onSuccess: () => {
      toast.success("Brand kit updated");
      queryClient.invalidateQueries({ queryKey: ["tenants"] });
      queryClient.invalidateQueries({ queryKey: ["tenant-context"] });
    },
    onError: (err: Error) => toast.error(err.message || "Brand kit update failed"),
  });

  const saveInteropSecret = useMutation({
    mutationFn: () => {
      if (!selectedTenantId) throw new Error("Tenant is required");
      return upsertTenantInteropSecret(selectedTenantId, secretDraft);
    },
    onSuccess: () => {
      toast.success("Interop secret stored");
      setSecretDraft((current) => ({ ...current, secret: "" }));
      queryClient.invalidateQueries({ queryKey: ["tenant-interop-secrets", selectedTenantId] });
    },
    onError: (err: Error) => toast.error(err.message || "Secret update failed"),
  });

  const queueKekRewrap = useMutation({
    mutationFn: () => {
      if (!selectedTenantId) throw new Error("Tenant is required");
      return startTenantKekRewrapJob(selectedTenantId);
    },
    onSuccess: (job) => {
      toast.success("KEK re-wrap queued");
      setJobIds((current) => ({ ...current, [job.tenant_id]: job.job_id }));
      queryClient.invalidateQueries({ queryKey: ["tenant-kek-rewrap-job", job.tenant_id, job.job_id] });
    },
    onError: (err: Error) => toast.error(err.message || "KEK re-wrap failed"),
  });

  // W5 S3 — begin operating inside a tenant (SUPER_ADMIN only; the backend
  // audits every override). A reason (>= 8 chars) is required and recorded.
  const { setActAs, actingTenant, isPending: actingPending } = useActingTenant();
  const toggleDetails = (row: Tenant) => {
    setSelectedTenantId((current) => {
      const next = current === row.id ? null : row.id;
      if (next) {
        setBrandDrafts((drafts) => ({
          ...drafts,
          [row.id]: drafts[row.id] ?? brandDraftFromTenant(row),
        }));
      }
      return next;
    });
  };
  const setBrandField = (field: keyof BrandDraft, value: string) => {
    if (!selectedTenant) return;
    setBrandDrafts((drafts) => ({
      ...drafts,
      [selectedTenant.id]: {
        ...(drafts[selectedTenant.id] ?? brandDraftFromTenant(selectedTenant)),
        [field]: value,
      },
    }));
  };
  const handleActAs = async (row: Tenant) => {
    const reason = typeof window !== "undefined" ? window.prompt(`Reason for acting as "${row.name}" (audited, min 8 chars):`) : null;
    if (reason == null) return; // cancelled
    if (reason.trim().length < 8) {
      toast.error("Reason must be at least 8 characters");
      return;
    }
    try {
      await setActAs({ tenantId: row.id, slug: row.slug, reason: reason.trim() });
      toast.success(`Now acting as ${row.name}`);
    } catch (err) {
      toast.error((err as Error).message || "Failed to act as tenant");
    }
  };

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
  const currentJob =
    kekJob.data ??
    (queueKekRewrap.data?.tenant_id === selectedTenantId ? queueKekRewrap.data : null);

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
                      <button
                        onClick={() => toggleDetails(row)}
                        className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-xs font-medium hover:bg-accent"
                      >
                        <ChevronDown className={`h-3.5 w-3.5 transition-transform ${selectedTenantId === row.id ? "rotate-180" : ""}`} />
                        Details
                      </button>
                      <button
                        onClick={() => void handleActAs(row)}
                        disabled={actingPending || actingTenant?.id === row.id}
                        title={actingTenant?.id === row.id ? "Already acting as this tenant" : "Operate inside this tenant (audited)"}
                        className="rounded-md border border-sky-200 bg-sky-50 px-2 py-1 text-xs font-medium text-sky-800 hover:bg-sky-100 disabled:opacity-50"
                      >
                        {actingTenant?.id === row.id ? "Acting" : "Act as"}
                      </button>
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

      {selectedTenant ? (
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="flex flex-col gap-3 border-b border-border pb-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-base font-semibold">{selectedTenant.name}</h2>
              <div className="mt-1 text-xs font-mono text-muted-foreground">{selectedTenant.slug} / {selectedTenant.id}</div>
            </div>
            <button
              onClick={() => {
                interopSecrets.refetch();
                if (selectedJobId) kekJob.refetch();
              }}
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-2 text-sm font-medium hover:bg-accent"
            >
              <RefreshCw className="h-4 w-4" />
              Refresh
            </button>
          </div>

          {selectedBrandDraft ? (
            <section className="mt-4 space-y-3 border-b border-border pb-4">
              <div className="flex items-center justify-between gap-3">
                <h3 className="inline-flex items-center gap-2 text-sm font-semibold">
                  <Palette className="h-4 w-4" />
                  Brand kit
                </h3>
                <button
                  onClick={() => saveBrandKit.mutate({ id: selectedTenant.id, draft: selectedBrandDraft })}
                  disabled={saveBrandKit.isPending}
                  className="inline-flex items-center gap-1.5 rounded-md border border-border bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                >
                  Save brand kit
                </button>
              </div>
              <div className="grid gap-3 md:grid-cols-3">
                <label className="text-xs text-muted-foreground">
                  Brand name
                  <input
                    value={selectedBrandDraft.name}
                    onChange={(event) => setBrandField("name", event.target.value)}
                    placeholder={selectedTenant.name}
                    className="mt-1 w-full rounded-md border border-border bg-card px-2 py-1 text-sm"
                  />
                </label>
                <label className="text-xs text-muted-foreground">
                  Primary color
                  <input
                    value={selectedBrandDraft.primaryColor}
                    onChange={(event) => setBrandField("primaryColor", event.target.value)}
                    placeholder="#007A64"
                    className="mt-1 w-full rounded-md border border-border bg-card px-2 py-1 font-mono text-sm"
                  />
                </label>
                <label className="text-xs text-muted-foreground">
                  Support email
                  <input
                    value={selectedBrandDraft.supportEmail}
                    onChange={(event) => setBrandField("supportEmail", event.target.value)}
                    placeholder="support@example.com"
                    className="mt-1 w-full rounded-md border border-border bg-card px-2 py-1 text-sm"
                  />
                </label>
                <label className="text-xs text-muted-foreground">
                  Logo URL
                  <input
                    value={selectedBrandDraft.logoUrl}
                    onChange={(event) => setBrandField("logoUrl", event.target.value)}
                    placeholder="https://..."
                    className="mt-1 w-full rounded-md border border-border bg-card px-2 py-1 text-sm"
                  />
                </label>
                <label className="text-xs text-muted-foreground md:col-span-2">
                  Logo storage key
                  <input
                    value={selectedBrandDraft.logoStorageKey}
                    onChange={(event) => setBrandField("logoStorageKey", event.target.value)}
                    placeholder="uploads/<admin-uid>/logo.png"
                    className="mt-1 w-full rounded-md border border-border bg-card px-2 py-1 font-mono text-sm"
                  />
                </label>
                <label className="text-xs text-muted-foreground">
                  Help center URL
                  <input
                    value={selectedBrandDraft.helpCenterUrl}
                    onChange={(event) => setBrandField("helpCenterUrl", event.target.value)}
                    placeholder="https://..."
                    className="mt-1 w-full rounded-md border border-border bg-card px-2 py-1 text-sm"
                  />
                </label>
                <label className="text-xs text-muted-foreground md:col-span-2">
                  Legal name
                  <input
                    value={selectedBrandDraft.legalName}
                    onChange={(event) => setBrandField("legalName", event.target.value)}
                    placeholder={selectedTenant.name}
                    className="mt-1 w-full rounded-md border border-border bg-card px-2 py-1 text-sm"
                  />
                </label>
                <label className="text-xs text-muted-foreground md:col-span-3">
                  Legal footer
                  <input
                    value={selectedBrandDraft.legalFooter}
                    onChange={(event) => setBrandField("legalFooter", event.target.value)}
                    placeholder="Registered hospital footer"
                    className="mt-1 w-full rounded-md border border-border bg-card px-2 py-1 text-sm"
                  />
                </label>
                <label className="text-xs text-muted-foreground md:col-span-2">
                  Letterhead storage key
                  <input
                    value={selectedBrandDraft.documentLetterheadStorageKey}
                    onChange={(event) => setBrandField("documentLetterheadStorageKey", event.target.value)}
                    placeholder="uploads/<admin-uid>/letterhead.png"
                    className="mt-1 w-full rounded-md border border-border bg-card px-2 py-1 font-mono text-sm"
                  />
                </label>
                <label className="text-xs text-muted-foreground">
                  Document footer
                  <input
                    value={selectedBrandDraft.documentFooterText}
                    onChange={(event) => setBrandField("documentFooterText", event.target.value)}
                    placeholder="Document footer"
                    className="mt-1 w-full rounded-md border border-border bg-card px-2 py-1 text-sm"
                  />
                </label>
                <label className="text-xs text-muted-foreground">
                  Email from name
                  <input
                    value={selectedBrandDraft.emailFromName}
                    onChange={(event) => setBrandField("emailFromName", event.target.value)}
                    placeholder={selectedBrandDraft.name || selectedTenant.name}
                    className="mt-1 w-full rounded-md border border-border bg-card px-2 py-1 text-sm"
                  />
                </label>
                <label className="text-xs text-muted-foreground">
                  Email reply-to
                  <input
                    value={selectedBrandDraft.emailReplyTo}
                    onChange={(event) => setBrandField("emailReplyTo", event.target.value)}
                    placeholder={selectedBrandDraft.supportEmail || "support@example.com"}
                    className="mt-1 w-full rounded-md border border-border bg-card px-2 py-1 text-sm"
                  />
                </label>
              </div>
            </section>
          ) : null}

          <div className="mt-4 grid gap-4 xl:grid-cols-[1.4fr_1fr]">
            <section className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="inline-flex items-center gap-2 text-sm font-semibold">
                  <KeyRound className="h-4 w-4" />
                  Interop secrets
                </h3>
                <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs text-slate-700">
                  {interopSecrets.data?.count ?? 0}
                </span>
              </div>

              <div className="overflow-x-auto rounded-md border border-border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50">
                    <tr>
                      <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Kind</th>
                      <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Sender</th>
                      <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Secret</th>
                      <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Updated</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {(interopSecrets.data?.secrets ?? []).length === 0 ? (
                      <tr>
                        <td className="px-3 py-5 text-center text-sm text-muted-foreground" colSpan={4}>
                          No interop secrets
                        </td>
                      </tr>
                    ) : (
                      (interopSecrets.data?.secrets ?? []).map((secret) => (
                        <tr key={`${secret.kind}:${secret.sender_identifier}`}>
                          <td className="px-3 py-2">{interopKindLabel(secret.kind)}</td>
                          <td className="px-3 py-2 font-mono text-xs">{secret.sender_identifier}</td>
                          <td className="px-3 py-2 font-mono text-xs">{secret.secret_masked ?? "-"}</td>
                          <td className="px-3 py-2 text-xs text-muted-foreground">{fmt(secret.updated_at)}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>

              <div className="grid gap-2 md:grid-cols-[180px_1fr_1fr_auto]">
                <select
                  aria-label="Interop kind"
                  value={secretDraft.kind}
                  onChange={(event) => setSecretDraft({ ...secretDraft, kind: event.target.value as TenantInteropSecret["kind"] })}
                  className="rounded-md border border-border bg-card px-2 py-2 text-sm"
                >
                  <option value="abdm_callback">ABDM callback</option>
                  <option value="hl7_inbound">HL7 inbound</option>
                </select>
                <input
                  aria-label="Sender identifier"
                  value={secretDraft.senderIdentifier}
                  onChange={(event) => setSecretDraft({ ...secretDraft, senderIdentifier: event.target.value })}
                  placeholder="Sender identifier"
                  className="rounded-md border border-border bg-card px-2 py-2 text-sm"
                />
                <input
                  aria-label="Secret value"
                  type="password"
                  value={secretDraft.secret}
                  onChange={(event) => setSecretDraft({ ...secretDraft, secret: event.target.value })}
                  placeholder="Secret value"
                  className="rounded-md border border-border bg-card px-2 py-2 text-sm"
                />
                <button
                  onClick={() => saveInteropSecret.mutate()}
                  disabled={!secretDraft.senderIdentifier.trim() || !secretDraft.secret || saveInteropSecret.isPending}
                  className="inline-flex items-center justify-center gap-1.5 rounded-md border border-border bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                >
                  <KeyRound className="h-4 w-4" />
                  Store
                </button>
              </div>
            </section>

            <section className="space-y-3">
              <h3 className="inline-flex items-center gap-2 text-sm font-semibold">
                <RotateCcw className="h-4 w-4" />
                KEK re-wrap
              </h3>
              <div className="rounded-md border border-border p-3">
                <div className="flex items-center justify-between gap-3">
                  <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${jobStatusBadge(currentJob?.status)}`}>
                    {currentJob?.status ?? "idle"}
                  </span>
                  <button
                    onClick={() => queueKekRewrap.mutate()}
                    disabled={queueKekRewrap.isPending || currentJob?.status === "queued" || currentJob?.status === "running"}
                    className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-2 text-sm font-medium hover:bg-accent disabled:opacity-50"
                  >
                    <RotateCcw className="h-4 w-4" />
                    Queue re-wrap
                  </button>
                </div>
                {currentJob ? (
                  <div className="mt-3 space-y-1 text-xs text-muted-foreground">
                    <div className="font-mono">{currentJob.job_id}</div>
                    <div>Updated {fmt(currentJob.updated_at)}</div>
                    {currentJob.summary ? (
                      <div>
                        Re-wrapped {currentJob.summary.rewrapped} value{currentJob.summary.rewrapped === 1 ? "" : "s"}
                      </div>
                    ) : null}
                    {currentJob.error ? (
                      <div className="text-red-700">{currentJob.error.message}</div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </section>
          </div>
        </div>
      ) : null}
    </div>
  );
}
