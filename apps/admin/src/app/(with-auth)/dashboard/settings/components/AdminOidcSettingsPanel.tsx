"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Plus, RefreshCw, Save, ShieldCheck } from "lucide-react";
import { fetchAdminAPI } from "@/lib/api";

type ProviderStatus = "draft" | "active" | "disabled";

interface AdminOidcProvider {
  id?: number;
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
}

interface AdminOidcMapping {
  idp_group: string;
  vh_role: "ADMIN";
  status: "active" | "disabled";
  priority: number;
}

interface ProviderListResponse {
  providers: AdminOidcProvider[];
}

interface MappingListResponse {
  mappings: AdminOidcMapping[];
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
}

function emptyForm(): ProviderForm {
  return {
    provider_key: "keycloak",
    display_name: "Keycloak",
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
  };
}

function formFromProvider(provider: AdminOidcProvider): ProviderForm {
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
  };
}

function splitList(value: string) {
  return value
    .split(/[\n,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function AdminOidcSettingsPanel() {
  const queryClient = useQueryClient();
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [form, setForm] = useState<ProviderForm>(() => emptyForm());
  const [message, setMessage] = useState("");

  const providersQuery = useQuery({
    queryKey: ["admin-oidc-providers"],
    queryFn: async () => {
      const response = await fetchAdminAPI<ProviderListResponse>(
        "/admin/identity/sso/oidc/providers",
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
    queryKey: ["admin-oidc-mappings", selectedKey],
    enabled: Boolean(selectedKey),
    queryFn: async () => {
      const response = await fetchAdminAPI<MappingListResponse>(
        `/admin/identity/sso/oidc/providers/${encodeURIComponent(selectedKey || "")}/mappings`,
        { method: "GET" },
      );
      return response.mappings || [];
    },
  });

  useEffect(() => {
    if (!selectedProvider) return;
    setForm(formFromProvider(selectedProvider));
    setMessage("");
  }, [selectedProvider]);

  useEffect(() => {
    if (!selectedKey || !mappingsQuery.data) return;
    setForm((current) => ({
      ...current,
      mapping_groups: mappingsQuery.data
        .filter((mapping) => mapping.status === "active" && mapping.vh_role === "ADMIN")
        .map((mapping) => mapping.idp_group)
        .join("\n"),
    }));
  }, [mappingsQuery.data, selectedKey]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const providerKey = form.provider_key.trim().toLowerCase();
      const groups = splitList(form.mapping_groups);
      if (!providerKey) throw new Error("Provider key is required");
      await fetchAdminAPI(
        `/admin/identity/sso/oidc/providers/${encodeURIComponent(providerKey)}`,
        {
          method: "PUT",
          body: {
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
          },
        },
      );
      await fetchAdminAPI(
        `/admin/identity/sso/oidc/providers/${encodeURIComponent(providerKey)}/mappings`,
        {
          method: "PUT",
          body: {
            mappings: groups.map((group, index) => ({
              idp_group: group,
              vh_role: "ADMIN",
              status: "active",
              priority: 100 + index,
            })),
          },
        },
      );
      return providerKey;
    },
    onSuccess: async (providerKey) => {
      setSelectedKey(providerKey);
      setForm((current) => ({ ...current, oidc_client_secret: "" }));
      setMessage("Identity provider saved");
      await queryClient.invalidateQueries({ queryKey: ["admin-oidc-providers"] });
      await queryClient.invalidateQueries({ queryKey: ["admin-oidc-mappings", providerKey] });
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
            Configure admin OIDC providers and group mappings for this tenant.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
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
              setForm(emptyForm());
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
                No admin OIDC providers configured.
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
                  placeholder="keycloak"
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
                  placeholder="Keycloak"
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
                placeholder="https://idp.example.com/realms/vh-admin"
              />
              <TextField
                label="Discovery URL"
                value={form.oidc_discovery_url}
                onChange={(value) =>
                  setForm((current) => ({ ...current, oidc_discovery_url: value }))
                }
                placeholder="https://idp.example.com/realms/vh-admin/.well-known/openid-configuration"
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
                placeholder="vh-admin"
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
                label="IdP Groups Mapped To ADMIN"
                value={form.mapping_groups}
                onChange={(value) =>
                  setForm((current) => ({ ...current, mapping_groups: value }))
                }
                placeholder="vh-admins"
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
