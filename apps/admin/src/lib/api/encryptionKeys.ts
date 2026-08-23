// src/lib/api/encryptionKeys.ts
// Typed client for the PHI encryption key registry (backend
// routes/admin/encryptionKeyRoutes.js, mounted /api/v1/admin/encryption-keys;
// services/security/encryptionKeyRegistryService.js). The registry stores KEK
// METADATA only — the key material lives in the KMS provider.
// The generated OpenAPI spec types these operations as the generic `Success`
// envelope only, so row shapes are hand-written from the service RETURNING list.

import { getJSON, postJSON } from "./core";

export const KMS_PROVIDERS = [
  "env",
  "aws-kms",
  "gcp-kms",
  "vault",
  "azure-keyvault",
] as const;
export const KEY_STATUSES = [
  "active",
  "retiring",
  "retired",
  "compromised",
] as const;

export type KmsProvider = (typeof KMS_PROVIDERS)[number];
export type EncryptionKeyStatus = (typeof KEY_STATUSES)[number];

export interface EncryptionKey {
  id: number;
  tenant_id: string | null;
  key_id: string;
  provider: KmsProvider;
  provider_reference: string | null;
  algorithm: string | null;
  status: EncryptionKeyStatus;
  rotated_from: number | null;
  activated_at: string | null;
  retiring_at: string | null;
  retired_at: string | null;
  metadata: Record<string, unknown> | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface RegisterKeyPayload {
  key_id: string;
  provider?: KmsProvider;
  provider_reference?: string | null;
  algorithm?: string;
  metadata?: Record<string, unknown> | null;
}

export interface RotateKeyPayload {
  new_key_id: string;
  provider?: KmsProvider;
  provider_reference?: string | null;
  algorithm?: string;
  metadata?: Record<string, unknown> | null;
}

export async function listEncryptionKeys(
  params: { status?: EncryptionKeyStatus } = {},
) {
  const query: Record<string, string> = {};
  if (params.status) query.status = params.status;
  return getJSON<{ keys: EncryptionKey[]; count: number }>(
    "/admin/encryption-keys",
    query,
  );
}

/** Registers a brand-new ACTIVE key (409 if key_id already registered). */
export async function registerEncryptionKey(payload: RegisterKeyPayload) {
  return postJSON<EncryptionKey>("/admin/encryption-keys", payload);
}

/**
 * Marks the current active key `retiring` and registers the new key as
 * `active` with rotated_from linking back. Returns the NEW key row.
 */
export async function rotateEncryptionKey(payload: RotateKeyPayload) {
  return postJSON<EncryptionKey>("/admin/encryption-keys/rotate", payload);
}

/** active|retiring → retired. 404 if not found or already retired. */
export async function retireEncryptionKey(id: number) {
  return postJSON<EncryptionKey>(`/admin/encryption-keys/${id}/retire`);
}

/**
 * Any non-compromised status → compromised; reason is stamped into the
 * row metadata. Decryption paths move off the key immediately.
 */
export async function markEncryptionKeyCompromised(
  id: number,
  reason?: string | null,
) {
  return postJSON<EncryptionKey>(`/admin/encryption-keys/${id}/compromise`, {
    reason: reason ?? null,
  });
}
