import {
  type DeveloperPortalApiClient,
  type DeveloperPortalClientPayload,
  type DeveloperPortalClientStatus,
  type DeveloperPortalEnvironment,
} from "@/lib/api/developerPortal";

export type ClientFormState = {
  id?: number;
  client_code: string;
  display_name: string;
  description: string;
  client_kind: string;
  status: DeveloperPortalClientStatus;
  environment: DeveloperPortalEnvironment;
  scopesText: string;
  allowedIpsText: string;
  rate_limit_profile: string;
  contact_email: string;
  contact_phone: string;
};

export const blankClientForm: ClientFormState = {
  client_code: "",
  display_name: "",
  description: "",
  client_kind: "integration",
  status: "active",
  environment: "sandbox",
  scopesText: "system.read\nopenapi.read",
  allowedIpsText: "",
  rate_limit_profile: "sandbox_default",
  contact_email: "",
  contact_phone: "",
};

export function splitLines(value: string) {
  return value
    .split(/\r?\n|,/)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function clientToForm(client: DeveloperPortalApiClient): ClientFormState {
  return {
    id: client.id,
    client_code: client.client_code,
    display_name: client.display_name,
    description: client.description ?? "",
    client_kind: client.client_kind,
    status: client.status,
    environment: client.environment,
    scopesText: client.scopes.join("\n"),
    allowedIpsText: client.allowed_ips.join("\n"),
    rate_limit_profile: client.rate_limit_profile ?? "",
    contact_email: client.contact_email ?? "",
    contact_phone: client.contact_phone ?? "",
  };
}

export function formToPayload(form: ClientFormState): DeveloperPortalClientPayload {
  return {
    id: form.id,
    client_code: form.client_code.trim(),
    display_name: form.display_name.trim(),
    description: form.description.trim() || null,
    client_kind: form.client_kind,
    status: form.status,
    environment: form.environment,
    scopes: splitLines(form.scopesText),
    allowed_ips: splitLines(form.allowedIpsText),
    rate_limit_profile: form.rate_limit_profile.trim() || null,
    contact_email: form.contact_email.trim() || null,
    contact_phone: form.contact_phone.trim() || null,
    metadata: { managed_by: "developer_portal" },
  };
}

export function formatDate(value: string | null | undefined) {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function downloadJson(filename: string, payload: unknown) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
