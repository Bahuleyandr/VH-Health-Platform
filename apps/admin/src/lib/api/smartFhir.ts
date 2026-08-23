// src/lib/api/smartFhir.ts
// SMART-on-FHIR admin registry + token lifecycle.
//
// Backend: apps/backend/src/routes/admin/smartFhirRoutes.js, mounted at
// /api/v1/admin/smart-fhir (via routes/admin/index.js). The generated
// OpenAPI spec types these operations only as the generic `Success`
// envelope, so payloads are hand-typed here against the service
// SELECT/RETURNING lists in
// apps/backend/src/services/smartFhir/smartOAuthService.js.
//
// Surface notes (verified against the routes):
// - Apps: POST /apps (register) + GET /apps only. There is NO app
//   update/edit endpoint on this surface.
// - Launch contexts: POST /launch-contexts issues one; there is NO list
//   endpoint for launch contexts.
// - Tokens: GET /tokens + PATCH /tokens/:id/revoke (accepts an optional
//   revoked_reason — the console requires it, since revocation is the
//   security-relevant path).

import { APIError, fetchAdminAPI, getJSON, postJSON } from "./core";

/* =========================
 * Enums (mirrors smartOAuthService.js constants)
 * ========================= */

export const SMART_APP_KINDS = [
  "public",
  "confidential",
  "backend_service",
] as const;
export type SmartAppKind = (typeof SMART_APP_KINDS)[number];

export const SMART_APP_STATUSES = [
  "active",
  "paused",
  "revoked",
  "archived",
] as const;
export type SmartAppStatus = (typeof SMART_APP_STATUSES)[number];

export const SMART_ENVIRONMENTS = ["sandbox", "production"] as const;
export type SmartEnvironment = (typeof SMART_ENVIRONMENTS)[number];

export const SMART_FHIR_VERSIONS = [
  "DSTU2",
  "STU3",
  "R4",
  "R4B",
  "R5",
] as const;
export type SmartFhirVersion = (typeof SMART_FHIR_VERSIONS)[number];

export type SmartRegistrationStatus =
  | "sandbox_pending"
  | "sandbox_approved"
  | "production_pending"
  | "production_approved"
  | "rejected";

export const SMART_TOKEN_STATUSES = [
  "active",
  "revoked",
  "expired",
  "rotated",
] as const;
export type SmartTokenStatus = (typeof SMART_TOKEN_STATUSES)[number];

/* =========================
 * Rows
 * ========================= */

export interface SmartApp {
  id: number;
  tenant_id: string;
  client_id: string;
  display_name: string;
  description: string | null;
  app_kind: SmartAppKind;
  redirect_uris: string[];
  allowed_scopes: string[];
  launch_uri: string | null;
  jwks_url: string | null;
  fhir_version: SmartFhirVersion;
  status: SmartAppStatus;
  environment: SmartEnvironment;
  registration_status: SmartRegistrationStatus;
  approved_by: string | null;
  approved_at: string | null;
  production_contract_ref: string | null;
  approval_notes: string | null;
  metadata: Record<string, unknown>;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface SmartAccessToken {
  id: number;
  tenant_id: string;
  smart_app_id: number;
  granted_scopes: string[];
  status: SmartTokenStatus;
  issued_at: string;
  access_expires_at: string | null;
  refresh_expires_at: string | null;
  last_used_at: string | null;
  last_used_ip: string | null;
  environment: SmartEnvironment;
}

export interface RegisterSmartAppPayload {
  client_id: string;
  display_name: string;
  description?: string | null;
  app_kind?: SmartAppKind;
  redirect_uris?: string[];
  allowed_scopes?: string[];
  launch_uri?: string | null;
  jwks_url?: string | null;
  fhir_version?: SmartFhirVersion;
  environment?: SmartEnvironment;
  status?: SmartAppStatus;
  /** production_approved requires SUPER_ADMIN (403 otherwise). */
  registration_status?: SmartRegistrationStatus;
  production_contract_ref?: string | null;
  approval_notes?: string | null;
  metadata?: Record<string, unknown>;
}

export interface RegisterSmartAppResult {
  app: SmartApp;
  /**
   * Only set for confidential apps, and only on this one response —
   * the backend stores a hash and cannot show the secret again.
   */
  plaintext_client_secret: string | null;
}

export interface SmartTokenRevocation {
  id: number;
  status: SmartTokenStatus;
  revoked_at: string;
}

/* =========================
 * Calls
 * ========================= */

export async function listSmartApps(
  params: { environment?: string; status?: string } = {},
) {
  const query: Record<string, string> = {};
  if (params.environment) query.environment = params.environment;
  if (params.status) query.status = params.status;
  return getJSON<{ apps: SmartApp[]; count: number }>(
    "/admin/smart-fhir/apps",
    query,
  );
}

export async function registerSmartApp(payload: RegisterSmartAppPayload) {
  return postJSON<RegisterSmartAppResult>("/admin/smart-fhir/apps", payload);
}

export async function listSmartTokens(
  params: { smartAppId?: number; status?: string; limit?: number } = {},
) {
  const query: Record<string, string | number> = {};
  if (params.smartAppId) query.smart_app_id = params.smartAppId;
  if (params.status) query.status = params.status;
  if (params.limit) query.limit = params.limit;
  return getJSON<{ tokens: SmartAccessToken[]; count: number }>(
    "/admin/smart-fhir/tokens",
    query,
  );
}

/** Revoke one access token. Reason is recorded as revoked_reason. */
export async function revokeSmartToken(id: number, revokedReason: string) {
  return fetchAdminAPI<SmartTokenRevocation>(
    `/admin/smart-fhir/tokens/${id}/revoke`,
    {
      method: "PATCH",
      body: { revoked_reason: revokedReason },
    },
  );
}

/* =========================
 * Error unwrapping
 * ========================= */

export interface SmartApiErrorInfo {
  message: string;
  code: string | null;
  requestId: string | null;
  status: number | null;
}

/**
 * Pull the backend envelope message/code out of an APIError. core.ts
 * collapses 403s to the literal "Forbidden", but the backend puts the
 * real reason (e.g. SMART_PRODUCTION_APPROVAL_ROLE_REQUIRED) into the
 * payload — surface that verbatim.
 */
export function describeSmartApiError(err: unknown): SmartApiErrorInfo {
  if (err instanceof APIError) {
    const payload = (err.data ?? null) as {
      message?: unknown;
      requestId?: unknown;
      code?: unknown;
      details?: { code?: unknown } | null;
    } | null;
    const message =
      typeof payload?.message === "string" && payload.message
        ? payload.message
        : err.message;
    const code =
      typeof payload?.code === "string"
        ? payload.code
        : typeof payload?.details?.code === "string"
          ? payload.details.code
          : null;
    const requestId =
      typeof payload?.requestId === "string" ? payload.requestId : null;
    return { message, code, requestId, status: err.status };
  }
  return {
    message: err instanceof Error ? err.message : "Request failed",
    code: null,
    requestId: null,
    status: null,
  };
}
