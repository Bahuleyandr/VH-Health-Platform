"use client";

import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Plus, RefreshCw, Save, ShieldCheck, UsersRound } from "lucide-react";
import { fetchAdminAPI } from "@/lib/api";

type OidcRealm = "admin" | "staff";
type ProviderStatus = "draft" | "active" | "disabled";

interface OidcProvider {
  id?: number;
  realm?: OidcRealm;
  provider_key: string;
  display_name: string;
  status: ProviderStatus;
  oidc_issuer?: string | null;
  oidc_discovery_url?: string | null;
  oidc_jwks_uri?: string | null;
  oidc_authorization_endpoint?: string | null;
  oidc_token_endpoint?: string | null;
  oidc_client_id?: string | null;
  group_claim_name?: string | null;
  allowed_domains?: string[];
  has_oidc_client_secret?: boolean;
  policy?: Record<string, unknown>;
}

interface OidcMapping {
  idp_group: string;
  vh_role: string;
  status: "active" | "disabled";
  priority: number;
}

interface ProviderListResponse {
  providers: OidcProvider[];
}

interface MappingListResponse {
  mappings: OidcMapping[];
}

interface ProviderForm {
  provider_key: string;
  display_name: string;
  status: ProviderStatus;
  oidc_issuer: string;
  oidc_discovery_url: string;
  oidc_jwks_uri: string;
  oidc_authorization_endpoint: string;
  oidc_token_endpoint: string;
  oidc_client_id: string;
  oidc_client_secret: string;
  group_claim_name: string;
  allowed_domains: string;
  mapping_groups: string;
  staff_redirect_uris: string;
  staff_employee_id_claim: string;
  allow_https_app_links: boolean;
}

const STAFF_ROLE_OPTIONS = [
  "DOCTOR",
  "CONSULTANT",
  "JUNIOR_DOCTOR",
  "RESIDENT",
  "DUTY_DOCTOR",
  "NURSING_STAFF",
  "NURSING_INCHARGE",
  "OP_STAFF_NURSE",
  "OP_INCHARGE",
  "IP_STAFF_NURSE",
  "IP_INCHARGE",
  "OT_NURSE",
  "OT_INCHARGE",
  "CATH_LAB_STAFF",
  "CATH_LAB_INCHARGE",
  "RADIOLOGIST",
  "ANESTHETIST",
  "PHYSIOTHERAPIST",
  "DIETITIAN",
  "COUNSELLOR",
  "PHARMACY_STAFF",
  "PHARMACY_INCHARGE",
  "STORES_PURCHASE_INCHARGE",
  "LAB_STAFF",
  "LAB_INCHARGE",
  "PATHOLOGIST",
  "HR_STAFF",
  "GENERAL_STAFF",
  "DELIVERY_STAFF",
  "DRIVER",
  "HOUSEKEEPING_STAFF",
  "HOUSEKEEPING_INCHARGE",
  "MAINTENANCE",
  "RECEPTIONIST",
  "RECEPTION_INCHARGE",
  "MEDICAL_RECORDS",
  "OT_STAFF",
  "BLOOD_BANK_TECHNICIAN",
  "RADIOLOGY_STAFF",
  "EMERGENCY_RESPONDER",
  "SOCIAL_WORKER",
  "SECURITY",
  "BILLING_STAFF",
  "BILLING_INCHARGE",
  "FINANCE_INCHARGE",
  "INSURANCE_COORDINATOR",
  "ADMISSION_OFFICER",
  "IPD_COUNSELLOR",
  "QUALITY_OFFICER",
  "INFECTION_CONTROL_OFFICER",
  "CARE_COORDINATOR",
  "CLAIMS_MANAGER",
  "AMBULANCE_COORDINATOR",
  "CMO",
  "CNO",
  "DEPARTMENT_HEAD",
  "MEDICAL_SUPERINTENDENT",
  "INTEGRATION_ADMIN",
  "AI_GOVERNANCE_ADMIN",
  "DATA_PROTECTION_OFFICER",
];

const STAFF_ROLE_SET = new Set(STAFF_ROLE_OPTIONS);

function emptyForm(realm: OidcRealm): ProviderForm {
  return {
    provider_key: realm === "staff" ? "staff-okta" : "keycloak",
    display_name: realm === "staff" ? "Staff Okta" : "Keycloak",
    status: "draft",
    oidc_issuer: "",
    oidc_discovery_url: "",
    oidc_jwks_uri: "",
    oidc_authorization_endpoint: "",
    oidc_token_endpoint: "",
    oidc_client_id: "",
    oidc_client_secret: "",
    group_claim_name: "groups",
    allowed_domains: "",
    mapping_groups: "",
    staff_redirect_uris: "vhhealthstaff://sso/oidc/callback",
    staff_employee_id_claim: "employee_id",
    allow_https_app_links: false,
  };
}

function policyStringList(policy: Record<string, unknown> | undefined, keys: string[]) {
  for (const key of keys) {
    const value = policy?.[key];
    if (Array.isArray(value)) return value.map((entry) => String(entry)).join("\n");
  }
  return "";
}

function policyString(policy: Record<string, unknown> | undefined, keys: string[], fallback = "") {
  for (const key of keys) {
    const value = policy?.[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return fallback;
}

function formFromProvider(provider: OidcProvider, realm: OidcRealm): ProviderForm {
  return {
    provider_key: provider.provider_key,
    display_name: provider.display_name,
    status: provider.status,
    oidc_issuer: provider.oidc_issuer || "",
    oidc_discovery_url: provider.oidc_discovery_url || "",
    oidc_jwks_uri: provider.oidc_jwks_uri || "",
    oidc_authorization_endpoint: provider.oidc_authorization_endpoint || "",
    oidc_token_endpoint: provider.oidc_token_endpoint || "",
    oidc_client_id: provider.oidc_client_id || "",
    oidc_client_secret: "",
    group_claim_name: provider.group_claim_name || "groups",
    allowed_domains: (provider.allowed_domains || []).join(", "),
    mapping_groups: "",
    staff_redirect_uris:
      policyStringList(provider.policy, [
        "staff_redirect_uris",
        "staffRedirectUris",
        "allowed_staff_redirect_uris",
        "allowedStaffRedirectUris",
      ]) || (realm === "staff" ? "vhhealthstaff://sso/oidc/callback" : ""),
    staff_employee_id_claim: policyString(
      provider.policy,
      ["staff_employee_id_claim", "staffEmployeeIdClaim", "employee_id_claim", "employeeIdClaim"],
      "employee_id",
    ),
    allow_https_app_links:
      provider.policy?.allow_https_app_links === true || provider.policy?.allowHttpsAppLinks === true,
  };
}

function splitList(value: string) {
  return value
    .split(/[\n,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseStaffMappingLines(value: string) {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const match = line.match(/^(.+?)(?:\s*=\s*|\s*,\s*)([A-Z0-9_]+)$/i);
      if (!match) throw new Error("Staff mappings must use group=ROLE");
      const role = match[2].trim().toUpperCase();
      if (!STAFF_ROLE_SET.has(role)) throw new Error(`Invalid staff role: ${role}`);
      return {
        idp_group: match[1].trim(),
        vh_role: role,
        status: "active",
        priority: 100 + index,
      };
    });
}

function mappingText(mappings: OidcMapping[], realm: OidcRealm) {
  const active = mappings.filter((mapping) => mapping.status === "active");
  if (realm === "staff") {
    return active.map((mapping) => `${mapping.idp_group}=${mapping.vh_role}`).join("\n");
  }
  return active
    .filter((mapping) => mapping.vh_role === "ADMIN")
    .map((mapping) => mapping.idp_group)
    .join("\n");
}

function realmQuery(realm: OidcRealm) {
  return `realm=${encodeURIComponent(realm)}`;
}

export function AdminOidcSettingsPanel() {
  const queryClient = useQueryClient();
  const [realm, setRealm] = useState<OidcRealm>("admin");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [form, setForm] = useState<ProviderForm>(() => emptyForm("admin"));
  const [message, setMessage] = useState("");

  const providersQuery = useQuery({
    queryKey: ["identity-oidc-providers", realm],
    queryFn: async () => {
      const response = await fetchAdminAPI<ProviderListResponse>(
        `/admin/identity/sso/oidc/providers?${realmQuery(realm)}`,
        { method: "GET" },
      );
      return response.providers || [];
    },
  });

  const selectedProvider = useMemo(
    () => providersQuery.data?.find((provider) => provider.provider_key === selectedKey),
    [providersQuery.data, selectedKey],
  );

  const mappingsQuery = useQuery({
    queryKey: ["identity-oidc-mappings", realm, selectedKey],
    enabled: Boolean(selectedKey),
    queryFn: async () => {
      const response = await fetchAdminAPI<MappingListResponse>(
        `/admin/identity/sso/oidc/providers/${encodeURIComponent(selectedKey || "")}/mappings?${realmQuery(realm)}`,
        { method: "GET" },
      );
      return response.mappings || [];
    },
  });

  useEffect(() => {
    setSelectedKey(null);
    setForm(emptyForm(realm));
    setMessage("");
  }, [realm]);

  useEffect(() => {
    if (!selectedProvider) return;
    setForm(formFromProvider(selectedProvider, realm));
    setMessage("");
  }, [realm, selectedProvider]);

  useEffect(() => {
    if (!selectedKey || !mappingsQuery.data) return;
    setForm((current) => ({
      ...current,
      mapping_groups: mappingText(mappingsQuery.data, realm),
    }));
  }, [mappingsQuery.data, realm, selectedKey]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const providerKey = form.provider_key.trim().toLowerCase();
      if (!providerKey) throw new Error("Provider key is required");
      const commonBody = {
        realm,
        display_name: form.display_name.trim() || providerKey,
        status: form.status,
        oidc_issuer: form.oidc_issuer.trim() || null,
        oidc_discovery_url: form.oidc_discovery_url.trim() || null,
        oidc_jwks_uri: form.oidc_jwks_uri.trim() || null,
        oidc_authorization_endpoint: form.oidc_authorization_endpoint.trim() || null,
        oidc_token_endpoint: form.oidc_token_endpoint.trim() || null,
        oidc_client_id: form.oidc_client_id.trim() || null,
        ...(form.oidc_client_secret.trim()
          ? { oidc_client_secret: form.oidc_client_secret.trim() }
          : {}),
        group_claim_name: form.group_claim_name.trim() || "groups",
        allowed_domains: splitList(form.allowed_domains),
      };
      await fetchAdminAPI(
        `/admin/identity/sso/oidc/providers/${encodeURIComponent(providerKey)}?${realmQuery(realm)}`,
        {
          method: "PUT",
          body:
            realm === "staff"
              ? {
                  ...commonBody,
                  policy: {
                    ...(selectedProvider?.policy || {}),
                    staff_redirect_uris: splitList(form.staff_redirect_uris),
                    staff_employee_id_claim: form.staff_employee_id_claim.trim() || "employee_id",
                    allow_https_app_links: form.allow_https_app_links,
                  },
                }
              : commonBody,
        },
      );
      const mappings =
        realm === "staff"
          ? parseStaffMappingLines(form.mapping_groups)
          : splitList(form.mapping_groups).map((group, index) => ({
              idp_group: group,
              vh_role: "ADMIN",
              status: "active",
              priority: 100 + index,
            }));
      await fetchAdminAPI(
        `/admin/identity/sso/oidc/providers/${encodeURIComponent(providerKey)}/mappings?${realmQuery(realm)}`,
        {
          method: "PUT",
          body: {
            realm,
            mappings,
          },
        },
      );
      return providerKey;
    },
    onSuccess: async (providerKey) => {
      setSelectedKey(providerKey);
      setForm((current) => ({ ...current, oidc_client_secret: "" }));
      setMessage("Identity provider saved");
      await queryClient.invalidateQueries({ queryKey: ["identity-oidc-providers", realm] });
      await queryClient.invalidateQueries({ queryKey: ["identity-oidc-mappings", realm, providerKey] });
    },
    onError: (error: Error) => {
      setMessage(error.message || "Failed to save identity provider");
    },
  });

  const providers = providersQuery.data || [];
  const activeCount = providers.filter((provider) => provider.status === "active").length;
  const canSave =
    Boolean(form.provider_key.trim()) &&
    Boolean(form.display_name.trim()) &&
    !saveMutation.isPending;

  return (
    <section id="identity-sso" className="bg-card p-6 rounded-lg shadow space-y-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h3 className="text-lg font-semibold text-foreground flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-primary" />
            Identity SSO
          </h3>
          <p className="text-sm text-muted-foreground mt-1">
            Configure OIDC providers and group mappings for this tenant.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-md border border-border bg-background p-1">
            <RealmButton
              active={realm === "admin"}
              icon={<ShieldCheck className="h-4 w-4" />}
              label="Admin"
              onClick={() => setRealm("admin")}
            />
            <RealmButton
              active={realm === "staff"}
              icon={<UsersRound className="h-4 w-4" />}
              label="Staff"
              onClick={() => setRealm("staff")}
            />
          </div>
          <span className="rounded-md border border-border px-3 py-1.5 text-sm text-muted-foreground">
            {activeCount} active
          </span>
          <button
            type="button"
            onClick={() => providersQuery.refetch()}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-2 text-sm font-medium hover:bg-accent transition-colors"
            disabled={providersQuery.isFetching}
          >
            <RefreshCw className={`h-4 w-4 ${providersQuery.isFetching ? "animate-spin" : ""}`} />
            Refresh
          </button>
          <button
            type="button"
            onClick={() => {
              setSelectedKey(null);
              setForm(emptyForm(realm));
              setMessage("");
            }}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            <Plus className="h-4 w-4" />
            New Provider
          </button>
        </div>
      </div>

      {providersQuery.isLoading ? (
        <div className="rounded-md border border-border p-4 text-sm text-muted-foreground">
          Loading identity providers...
        </div>
      ) : providersQuery.error ? (
        <div className="rounded-md border border-destructive bg-destructive/10 p-4 text-sm text-destructive">
          {providersQuery.error instanceof Error
            ? providersQuery.error.message
            : "Failed to load identity providers"}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-5 xl:grid-cols-[280px_minmax(0,1fr)]">
          <div className="space-y-2">
            {providers.length === 0 ? (
              <div className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
                No {realm} OIDC providers configured.
              </div>
            ) : (
              providers.map((provider) => (
                <button
                  key={provider.provider_key}
                  type="button"
                  onClick={() => setSelectedKey(provider.provider_key)}
                  className={`w-full rounded-md border p-3 text-left transition-colors ${
                    selectedKey === provider.provider_key
                      ? "border-primary bg-primary/10"
                      : "border-border bg-background hover:bg-accent"
                  }`}
                >
                  <span className="flex items-center justify-between gap-3">
                    <span className="font-medium text-foreground">{provider.display_name}</span>
                    <span className="rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground">
                      {provider.status}
                    </span>
                  </span>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    {provider.provider_key}
                  </span>
                </button>
              ))
            )}
          </div>

          <form
            className="space-y-5"
            onSubmit={(event) => {
              event.preventDefault();
              saveMutation.mutate();
            }}
          >
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <label className="space-y-1 text-sm">
                <span className="font-medium text-foreground">Provider Key</span>
                <input
                  value={form.provider_key}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, provider_key: event.target.value }))
                  }
                  disabled={Boolean(selectedProvider)}
                  className="w-full rounded-md border border-border bg-background px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-70"
                  placeholder={realm === "staff" ? "staff-okta" : "keycloak"}
                />
              </label>
              <label className="space-y-1 text-sm">
                <span className="font-medium text-foreground">Display Name</span>
                <input
                  value={form.display_name}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, display_name: event.target.value }))
                  }
                  className="w-full rounded-md border border-border bg-background px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary"
                  placeholder={realm === "staff" ? "Staff Okta" : "Keycloak"}
                />
              </label>
              <label className="space-y-1 text-sm">
                <span className="font-medium text-foreground">Status</span>
                <select
                  value={form.status}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      status: event.target.value as ProviderStatus,
                    }))
                  }
                  className="w-full rounded-md border border-border bg-background px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary"
                >
                  <option value="draft">Draft</option>
                  <option value="active">Active</option>
                  <option value="disabled">Disabled</option>
                </select>
              </label>
            </div>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <TextField
                label="Issuer"
                value={form.oidc_issuer}
                onChange={(value) => setForm((current) => ({ ...current, oidc_issuer: value }))}
                placeholder={`https://idp.example.com/realms/vh-${realm}`}
              />
              <TextField
                label="Discovery URL"
                value={form.oidc_discovery_url}
                onChange={(value) =>
                  setForm((current) => ({ ...current, oidc_discovery_url: value }))
                }
                placeholder={`https://idp.example.com/realms/vh-${realm}/.well-known/openid-configuration`}
              />
              <TextField
                label="Authorization Endpoint"
                value={form.oidc_authorization_endpoint}
                onChange={(value) =>
                  setForm((current) => ({ ...current, oidc_authorization_endpoint: value }))
                }
                placeholder="https://idp.example.com/protocol/openid-connect/auth"
              />
              <TextField
                label="Token Endpoint"
                value={form.oidc_token_endpoint}
                onChange={(value) =>
                  setForm((current) => ({ ...current, oidc_token_endpoint: value }))
                }
                placeholder="https://idp.example.com/protocol/openid-connect/token"
              />
              <TextField
                label="JWKS URI"
                value={form.oidc_jwks_uri}
                onChange={(value) => setForm((current) => ({ ...current, oidc_jwks_uri: value }))}
                placeholder="https://idp.example.com/protocol/openid-connect/certs"
              />
              <TextField
                label="Client ID"
                value={form.oidc_client_id}
                onChange={(value) => setForm((current) => ({ ...current, oidc_client_id: value }))}
                placeholder={realm === "staff" ? "vh-staff-mobile" : "vh-admin"}
              />
              <TextField
                label="Client Secret"
                type="password"
                value={form.oidc_client_secret}
                onChange={(value) =>
                  setForm((current) => ({ ...current, oidc_client_secret: value }))
                }
                placeholder={
                  selectedProvider?.has_oidc_client_secret
                    ? "Stored; leave blank to keep"
                    : "Paste client secret"
                }
              />
              <TextField
                label="Group Claim"
                value={form.group_claim_name}
                onChange={(value) =>
                  setForm((current) => ({ ...current, group_claim_name: value }))
                }
                placeholder="groups"
              />
            </div>

            {realm === "staff" && (
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <TextAreaField
                  label="Staff Redirect URIs"
                  value={form.staff_redirect_uris}
                  onChange={(value) =>
                    setForm((current) => ({ ...current, staff_redirect_uris: value }))
                  }
                  placeholder="vhhealthstaff://sso/oidc/callback"
                />
                <div className="space-y-4">
                  <TextField
                    label="Employee ID Claim"
                    value={form.staff_employee_id_claim}
                    onChange={(value) =>
                      setForm((current) => ({ ...current, staff_employee_id_claim: value }))
                    }
                    placeholder="employee_id"
                  />
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={form.allow_https_app_links}
                      onChange={(event) =>
                        setForm((current) => ({
                          ...current,
                          allow_https_app_links: event.target.checked,
                        }))
                      }
                      className="h-4 w-4 rounded border-border text-primary focus:ring-primary"
                    />
                    <span className="font-medium text-foreground">Allow HTTPS app links</span>
                  </label>
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <TextAreaField
                label="Allowed Domains"
                value={form.allowed_domains}
                onChange={(value) =>
                  setForm((current) => ({ ...current, allowed_domains: value }))
                }
                placeholder="vhhealth.app, hospital.example"
              />
              <TextAreaField
                label={realm === "staff" ? "Staff Group Role Mappings" : "IdP Groups Mapped To ADMIN"}
                value={form.mapping_groups}
                onChange={(value) =>
                  setForm((current) => ({ ...current, mapping_groups: value }))
                }
                placeholder={realm === "staff" ? "vh-nursing=NURSING_STAFF" : "vh-admins"}
                loading={mappingsQuery.isFetching}
              />
            </div>

            <div className="flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <KeyRound className="h-4 w-4" />
                <span>Secrets are write-only.</span>
              </div>
              <div className="flex items-center gap-3">
                {message && (
                  <span
                    className={`text-sm ${
                      saveMutation.isError ? "text-destructive" : "text-success"
                    }`}
                  >
                    {message}
                  </span>
                )}
                <button
                  type="submit"
                  disabled={!canSave}
                  className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60 transition-colors"
                >
                  <Save className="h-4 w-4" />
                  {saveMutation.isPending ? "Saving..." : "Save SSO"}
                </button>
              </div>
            </div>
          </form>
        </div>
      )}
    </section>
  );
}

function RealmButton({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-sm font-medium transition-colors ${
        active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

function TextField({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <label className="space-y-1 text-sm">
      <span className="font-medium text-foreground">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-md border border-border bg-background px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary"
        placeholder={placeholder}
      />
    </label>
  );
}

function TextAreaField({
  label,
  value,
  onChange,
  placeholder,
  loading = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  loading?: boolean;
}) {
  return (
    <label className="space-y-1 text-sm">
      <span className="flex items-center justify-between gap-3 font-medium text-foreground">
        {label}
        {loading && <span className="text-xs text-muted-foreground">Loading...</span>}
      </span>
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="min-h-24 w-full resize-y rounded-md border border-border bg-background px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary"
        placeholder={placeholder}
      />
    </label>
  );
}
