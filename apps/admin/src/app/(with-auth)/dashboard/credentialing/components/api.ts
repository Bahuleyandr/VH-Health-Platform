import { fetchAdminAPI } from "@/lib/api";
import { apiFetch } from "@/lib/api-fetch";
import type {
  AlertsResponse,
  ApprovalsResponse,
  CatalogResponse,
  CredentialsResponse,
  CredentialStatus,
} from "./types";

interface ApiEnvelope<T> {
  data?: T;
  message?: string;
}

export function listCatalog() {
  return fetchAdminAPI<CatalogResponse>("/credentials/catalog");
}

export function saveCatalogEntry(body: unknown) {
  return fetchAdminAPI("/credentials/catalog", { method: "PUT", body });
}

export function listCredentials(staffUid: string) {
  return fetchAdminAPI<CredentialsResponse>(
    `/credentials/staff/${encodeURIComponent(staffUid)}`,
  );
}

export function addCredential(body: unknown) {
  return fetchAdminAPI("/credentials", { method: "POST", body });
}

export function requestPrivilegeGrant(body: unknown) {
  return fetchAdminAPI("/credentials/privilege-requests", {
    method: "POST",
    body,
  });
}

export function listApprovals(status = "pending") {
  return fetchAdminAPI<ApprovalsResponse>(
    `/credentials/approvals?status=${encodeURIComponent(status)}&limit=100`,
  );
}

export function decideApproval(id: number, decision: "approved" | "rejected") {
  return fetchAdminAPI(`/credentials/approvals/${id}/decide`, {
    method: "POST",
    body: { decision },
  });
}

export function updateCredentialStatus(id: number, status: CredentialStatus) {
  return fetchAdminAPI(`/credentials/${id}/status`, {
    method: "PATCH",
    body: { status },
  });
}

export function listExpiryAlerts() {
  return fetchAdminAPI<AlertsResponse>("/credentials/expiry-alerts?status=open&limit=300");
}

export function scanExpiryAlerts() {
  return fetchAdminAPI("/credentials/expiry-alerts/scan", {
    method: "POST",
    body: { days: 90 },
  });
}

export function acknowledgeExpiryAlert(id: number) {
  return fetchAdminAPI(`/credentials/expiry-alerts/${id}/acknowledge`, {
    method: "PATCH",
    body: { resolution: "acknowledged" },
  });
}

export async function uploadCredentialDocument(credentialId: number, file: File) {
  const form = new FormData();
  form.append("file", file);
  const res = await apiFetch(`/api/v1/credentials/${credentialId}/document`, {
    method: "POST",
    body: form,
    headers: { Accept: "application/json" },
  });
  const payload = (await res.json().catch(() => null)) as ApiEnvelope<unknown> | null;
  if (!res.ok) {
    throw new Error(payload?.message || `Upload failed with HTTP ${res.status}`);
  }
  return payload?.data ?? payload;
}
