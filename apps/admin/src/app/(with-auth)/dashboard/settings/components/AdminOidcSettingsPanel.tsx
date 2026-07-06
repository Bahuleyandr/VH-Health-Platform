"use client";

import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileKey2, KeyRound, Plus, RefreshCw, Save, ShieldCheck, UsersRound } from "lucide-react";
import { fetchAdminAPI } from "@/lib/api";

type OidcRealm = "admin" | "staff";
type SsoProtocol = "oidc" | "saml";
type ProviderStatus = "draft" | "active" | "disabled";

interface OidcProvider {
  id?: number;
  realm?: OidcRealm;
  protocol?: SsoProtocol;
  provider_key: string;
  display_name: string;
  status: ProviderStatus;
  oidc_issuer?: string | null;
  oidc_discovery_url?: string | null;
  oidc_jwks_uri?: string | null;
  oidc_authorization_endpoint?: string | null;
  oidc_token_endpoint?: string | null;
  oidc_client_id?: string | null;
  saml_entity_id?: string | null;
  saml_sp_entity_id?: string | null;
  saml_metadata_url?: string | null;
  saml_acs_url?: string | null;
  saml_sso_url?: string | null;
  saml_nameid_format?: string | null;
  saml_require_signed_response?: boolean;
  saml_require_signed_assertion?: boolean;
  saml_encrypted_assertions?: boolean;
  group_claim_name?: string | null;
  allowed_domains?: string[];
  has_oidc_client_secret?: boolean;
  has_saml_metadata_xml?: boolean;
  has_saml_idp_signing_certs?: boolean;
  has_saml_signing_key?: boolean;
  has_saml_signing_cert?: boolean;
  has_saml_decryption_key?: boolean;
  has_saml_decryption_cert?: boolean;
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
  saml_entity_id: string;
  saml_sp_entity_id: string;
  saml_metadata_url: string;
  saml_metadata_xml: string;
  saml_acs_url: string;
  saml_sso_url: string;
  saml_idp_signing_certs: string;
  saml_signing_key: string;
  saml_signing_cert: string;
  saml_decryption_key: string;
  saml_decryption_cert: string;
  saml_nameid_format: string;
  saml_require_signed_response: boolean;
  saml_require_signed_assertion: boolean;
  saml_encrypted_assertions: boolean;
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

function emptyForm(realm: OidcRealm, protocol: SsoProtocol): ProviderForm {
  const saml = protocol === "saml";
  return {
    provider_key: realm === "staff" ? (saml ? "staff-saml" : "staff-okta") : saml ? "hospital-saml" : "keycloak",
    display_name: realm === "staff" ? (saml ? "Staff SAML" : "Staff Okta") : saml ? "Hospital SAML" : "Keycloak",
    status: "draft",
    oidc_issuer: "",
    oidc_discovery_url: "",
    oidc_jwks_uri: "",
    oidc_authorization_endpoint: "",
    oidc_token_endpoint: "",
    oidc_client_id: "",
    oidc_client_secret: "",
    saml_entity_id: "",
    saml_sp_entity_id: "",
    saml_metadata_url: "",
    saml_metadata_xml: "",
    saml_acs_url: "",
    saml_sso_url: "",
    saml_idp_signing_certs: "",
    saml_signing_key: "",
    saml_signing_cert: "",
    saml_decryption_key: "",
    saml_decryption_cert: "",
    saml_nameid_format: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
    saml_require_signed_response: false,
    saml_require_signed_assertion: false,
    saml_encrypted_assertions: false,
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
    saml_entity_id: provider.saml_entity_id || "",
    saml_sp_entity_id: provider.saml_sp_entity_id || "",
    saml_metadata_url: provider.saml_metadata_url || "",
    saml_metadata_xml: "",
    saml_acs_url: provider.saml_acs_url || "",
    saml_sso_url: provider.saml_sso_url || "",
    saml_idp_signing_certs: "",
    saml_signing_key: "",
    saml_signing_cert: "",
    saml_decryption_key: "",
    saml_decryption_cert: "",
    saml_nameid_format: provider.saml_nameid_format || "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
    saml_require_signed_response: provider.saml_require_signed_response === true,
    saml_require_signed_assertion: provider.saml_require_signed_assertion === true,
    saml_encrypted_assertions: provider.saml_encrypted_assertions === true,
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
  const [protocol, setProtocol] = useState<SsoProtocol>("oidc");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [form, setForm] = useState<ProviderForm>(() => emptyForm("admin", "oidc"));
  const [message, setMessage] = useState("");

  const providersQuery = useQuery({
    queryKey: ["identity-sso-providers", protocol, realm],
    queryFn: async () => {
      const response = await fetchAdminAPI<ProviderListResponse>(
        `/admin/identity/sso/${protocol}/providers?${realmQuery(realm)}`,
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
    queryKey: ["identity-sso-mappings", protocol, realm, selectedKey],
    enabled: Boolean(selectedKey),
    queryFn: async () => {
      const response = await fetchAdminAPI<MappingListResponse>(
        `/admin/identity/sso/${protocol}/providers/${encodeURIComponent(selectedKey || "")}/mappings?${realmQuery(realm)}`,
        { method: "GET" },
      );
      return response.mappings || [];
    },
  });

  useEffect(() => {
    setSelectedKey(null);
    setForm(emptyForm(realm, protocol));
    setMessage("");
  }, [protocol, realm]);

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
      const commonBody =
        protocol === "oidc"
          ? {
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
            }
          : {
              realm,
              display_name: form.display_name.trim() || providerKey,
              status: form.status,
              saml_entity_id: form.saml_entity_id.trim() || null,
              saml_sp_entity_id: form.saml_sp_entity_id.trim() || null,
              saml_metadata_url: form.saml_metadata_url.trim() || null,
              ...(form.saml_metadata_xml.trim() ? { saml_metadata_xml: form.saml_metadata_xml.trim() } : {}),
              saml_acs_url: form.saml_acs_url.trim() || null,
              saml_sso_url: form.saml_sso_url.trim() || null,
              ...(form.saml_idp_signing_certs.trim()
                ? { saml_idp_signing_certs: form.saml_idp_signing_certs.trim() }
                : {}),
              ...(form.saml_signing_key.trim() ? { saml_signing_key: form.saml_signing_key.trim() } : {}),
              ...(form.saml_signing_cert.trim() ? { saml_signing_cert: form.saml_signing_cert.trim() } : {}),
              ...(form.saml_decryption_key.trim()
                ? { saml_decryption_key: form.saml_decryption_key.trim() }
                : {}),
              ...(form.saml_decryption_cert.trim()
                ? { saml_decryption_cert: form.saml_decryption_cert.trim() }
                : {}),
              saml_nameid_format: form.saml_nameid_format.trim() || null,
              saml_require_signed_response: form.saml_require_signed_response,
              saml_require_signed_assertion: form.saml_require_signed_assertion,
              saml_encrypted_assertions: form.saml_encrypted_assertions,
              group_claim_name: form.group_claim_name.trim() || "groups",
              allowed_domains: splitList(form.allowed_domains),
            };
      const body = {
        ...commonBody,
        ...(realm === "staff"
          ? {
              policy: {
                ...(selectedProvider?.policy || {}),
                ...(protocol === "oidc"
                  ? {
                      staff_redirect_uris: splitList(form.staff_redirect_uris),
                      allow_https_app_links: form.allow_https_app_links,
                    }
                  : {}),
                staff_employee_id_claim: form.staff_employee_id_claim.trim() || "employee_id",
              },
            }
          : {}),
      };
      await fetchAdminAPI(
        `/admin/identity/sso/${protocol}/providers/${encodeURIComponent(providerKey)}?${realmQuery(realm)}`,
        {
          method: "PUT",
          body,
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
        `/admin/identity/sso/${protocol}/providers/${encodeURIComponent(providerKey)}/mappings?${realmQuery(realm)}`,
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
      setForm((current) => ({
        ...current,
        oidc_client_secret: "",
        saml_metadata_xml: "",
        saml_idp_signing_certs: "",
        saml_signing_key: "",
        saml_signing_cert: "",
        saml_decryption_key: "",
        saml_decryption_cert: "",
      }));
      setMessage("Identity provider saved");
      await queryClient.invalidateQueries({ queryKey: ["identity-sso-providers", protocol, realm] });
      await queryClient.invalidateQueries({ queryKey: ["identity-sso-mappings", protocol, realm, providerKey] });
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
            Configure enterprise identity providers and group mappings for this tenant.
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
          <div className="inline-flex rounded-md border border-border bg-background p-1">
            <RealmButton
              active={protocol === "oidc"}
              icon={<KeyRound className="h-4 w-4" />}
              label="OIDC"
              onClick={() => setProtocol("oidc")}
            />
            <RealmButton
              active={protocol === "saml"}
              icon={<FileKey2 className="h-4 w-4" />}
              label="SAML"
              onClick={() => setProtocol("saml")}
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
              setForm(emptyForm(realm, protocol));
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
                No {realm} {protocol.toUpperCase()} providers configured.
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
                  placeholder={realm === "staff" ? (protocol === "saml" ? "staff-saml" : "staff-okta") : protocol === "saml" ? "hospital-saml" : "keycloak"}
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
                  placeholder={realm === "staff" ? (protocol === "saml" ? "Staff SAML" : "Staff Okta") : protocol === "saml" ? "Hospital SAML" : "Keycloak"}
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

            {protocol === "oidc" ? (
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
            ) : (
              <div className="space-y-4">
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <TextField
                    label="IdP Entity ID"
                    value={form.saml_entity_id}
                    onChange={(value) => setForm((current) => ({ ...current, saml_entity_id: value }))}
                    placeholder="https://idp.example.com/saml/metadata"
                  />
                  <TextField
                    label="SP Entity ID"
                    value={form.saml_sp_entity_id}
                    onChange={(value) => setForm((current) => ({ ...current, saml_sp_entity_id: value }))}
                    placeholder={`https://api.vhhealth.app/saml/${realm}`}
                  />
                  <TextField
                    label="Metadata URL"
                    value={form.saml_metadata_url}
                    onChange={(value) => setForm((current) => ({ ...current, saml_metadata_url: value }))}
                    placeholder="https://idp.example.com/app/vh/sso/saml/metadata"
                  />
                  <TextField
                    label="IdP SSO URL"
                    value={form.saml_sso_url}
                    onChange={(value) => setForm((current) => ({ ...current, saml_sso_url: value }))}
                    placeholder="https://idp.example.com/app/vh/sso/saml"
                  />
                  <TextField
                    label="ACS URL"
                    value={form.saml_acs_url}
                    onChange={(value) => setForm((current) => ({ ...current, saml_acs_url: value }))}
                    placeholder={`/api/v1/auth/${realm}/sso/saml/${form.provider_key || "provider"}/acs`}
                  />
                  <TextField
                    label="NameID Format"
                    value={form.saml_nameid_format}
                    onChange={(value) => setForm((current) => ({ ...current, saml_nameid_format: value }))}
                    placeholder="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress"
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
                <TextAreaField
                  label="Metadata XML"
                  value={form.saml_metadata_xml}
                  onChange={(value) => setForm((current) => ({ ...current, saml_metadata_xml: value }))}
                  placeholder={
                    selectedProvider?.has_saml_metadata_xml
                      ? "Stored; paste new XML to replace"
                      : "<EntityDescriptor ...>"
                  }
                />
                <TextAreaField
                  label="IdP Signing Certificates"
                  value={form.saml_idp_signing_certs}
                  onChange={(value) => setForm((current) => ({ ...current, saml_idp_signing_certs: value }))}
                  placeholder={
                    selectedProvider?.has_saml_idp_signing_certs
                      ? "Stored; paste one or two certs to rotate"
                      : "Paste one or two PEM certificates"
                  }
                />
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <TextAreaField
                    label="SP Signing Private Key"
                    value={form.saml_signing_key}
                    onChange={(value) => setForm((current) => ({ ...current, saml_signing_key: value }))}
                    placeholder={selectedProvider?.has_saml_signing_key ? "Stored; leave blank to keep" : "Optional PEM private key"}
                  />
                  <TextAreaField
                    label="SP Signing Certificate"
                    value={form.saml_signing_cert}
                    onChange={(value) => setForm((current) => ({ ...current, saml_signing_cert: value }))}
                    placeholder={selectedProvider?.has_saml_signing_cert ? "Stored; leave blank to keep" : "Optional PEM certificate"}
                  />
                  <TextAreaField
                    label="SP Decryption Private Key"
                    value={form.saml_decryption_key}
                    onChange={(value) => setForm((current) => ({ ...current, saml_decryption_key: value }))}
                    placeholder={selectedProvider?.has_saml_decryption_key ? "Stored; leave blank to keep" : "Required for encrypted assertions"}
                  />
                  <TextAreaField
                    label="SP Decryption Certificate"
                    value={form.saml_decryption_cert}
                    onChange={(value) => setForm((current) => ({ ...current, saml_decryption_cert: value }))}
                    placeholder={selectedProvider?.has_saml_decryption_cert ? "Stored; leave blank to keep" : "Optional PEM certificate"}
                  />
                </div>
                <div className="flex flex-wrap gap-4">
                  <CheckboxField
                    label="Require signed response"
                    checked={form.saml_require_signed_response}
                    onChange={(checked) =>
                      setForm((current) => ({ ...current, saml_require_signed_response: checked }))
                    }
                  />
                  <CheckboxField
                    label="Require signed assertion"
                    checked={form.saml_require_signed_assertion}
                    onChange={(checked) =>
                      setForm((current) => ({ ...current, saml_require_signed_assertion: checked }))
                    }
                  />
                  <CheckboxField
                    label="Encrypted assertions"
                    checked={form.saml_encrypted_assertions}
                    onChange={(checked) =>
                      setForm((current) => ({ ...current, saml_encrypted_assertions: checked }))
                    }
                  />
                </div>
              </div>
            )}

            {realm === "staff" && (
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                {protocol === "oidc" && (
                  <TextAreaField
                    label="Staff Redirect URIs"
                    value={form.staff_redirect_uris}
                    onChange={(value) =>
                      setForm((current) => ({ ...current, staff_redirect_uris: value }))
                    }
                    placeholder="vhhealthstaff://sso/oidc/callback"
                  />
                )}
                <div className="space-y-4">
                  <TextField
                    label="Employee ID Claim"
                    value={form.staff_employee_id_claim}
                    onChange={(value) =>
                      setForm((current) => ({ ...current, staff_employee_id_claim: value }))
                    }
                    placeholder="employee_id"
                  />
                  {protocol === "oidc" && (
                    <CheckboxField
                      label="Allow HTTPS app links"
                      checked={form.allow_https_app_links}
                      onChange={(checked) =>
                        setForm((current) => ({
                          ...current,
                          allow_https_app_links: checked,
                        }))
                      }
                    />
                  )}
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
                <span>Secrets and certificates are write-only.</span>
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

function CheckboxField({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="h-4 w-4 rounded border-border text-primary focus:ring-primary"
      />
      <span className="font-medium text-foreground">{label}</span>
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
