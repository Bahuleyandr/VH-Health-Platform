// src/lib/api/encryptionKeys.ts
// Typed client for the PHI encryption key registry (backend
// routes/admin/encryptionKeyRoutes.js, mounted /api/v1/admin/encryption-keys;
// services/security/encryptionKeyRegistryService.js).
//
// The rows these calls return carry KEK metadata + a provider reference and no
// key material of their own. The backing `encryption_keys` TABLE is a different
// thing from this registry view, and is NOT metadata-only:
//
//  - it is the live store for the per-tenant envelope KEKs (backend
//    services/security/tenantKekProvider.js writes them as provider
//    `local-tenant` rows keyed `t:<tenantId>:v<n>`, with the wrapped key
//    material in a column this console never reads); and
//  - other subsystems keep rows here whose `status` they read as a gate — e.g.
//    the clinical-continuity packet/policy signing keys, which are looked up by
//    `key_id` and rejected unless their status is what those services require
//    (backend services/downtime/clinicalContinuityIncidentPacketProvisioningService.js,
//    clinicalContinuityPolicyService.js).
//
// ★ THE FENCE IS AN ALLOWLIST, AND IT IS NOT UNIFORM ACROSS THE FIVE CALLS.
// A row is actionable only while every inertness marker holds; anything else —
// including a shape the backend cannot prove inert, and an inert row carrying
// no tenant_id — is withheld. But what each call DOES about a withheld row
// differs, so no single sentence is true of all five. A blanket "protected keys
// are refused" line is exactly what the round-2 console shipped, over a
// register and a rotate that refused nothing at all:
//
//  - listEncryptionKeys never refuses. It partitions what the tenant can see:
//    actionable rows in `keys`, EVERY other visible row in `protected` with the
//    class it landed in and the marker that put it there. Nothing is dropped,
//    so `count + protected_count` is every visible row (after the optional
//    status filter). Rendering `protected` is the only thing that makes that
//    promise visible to an operator.
//  - retireEncryptionKey and markEncryptionKeyCompromised name a row, so they
//    are the two that refuse a NAMED row: 409 with one of the four class codes
//    below and `details.key_class` / `details.reason`.
//  - rotateEncryptionKey names no row — it searches for the newest active entry
//    it may demote. A fenced search that finds nothing is ambiguous, so the
//    backend then asks whether the tenant has a visible active key at all: if
//    it does, rotation is refused (409 ROTATION_PREDECESSOR_PROTECTED) instead
//    of adding an unlinked row beside the key that is really active. Only a
//    tenant with no visible active key gets the bootstrap insert.
//  - registerEncryptionKey creates a row, so it has no predecessor to protect.
//    Its fence is a mint-time invariant instead: it classifies the row it is
//    about to write with the same predicate and refuses up front (400
//    WOULD_BE_UNMANAGEABLE) anything that would be created and then withheld on
//    the very next read.
//
// register and rotate both additionally refuse a key id inside the tenant's
// reserved `t:<tenantId>:v<n>` namespace (400 `ENCRYPTION_KEY_ID_RESERVED`).
// Every refusal message reaches the dialogs verbatim (core.ts lifts the
// envelope `message`; the page renders it unchanged) and the envelope `code` /
// `details` are readable via `readEncryptionKeyRefusal` below.
//
// The predicate and its codes live in backend
// services/security/encryptionKeyRegistryService.js, which is the authority —
// do not restate the SQL here, and do not assume it covers a category it has
// not been shown to cover. A row appearing in `keys` means the fence did not
// match it, NOT that nothing reads it; the UI must stay agnostic about what a
// listed entry is wired to. Live key lifecycle is crypto-shred / re-provision
// on the backend, and a signing key is revoked by publishing a new policy
// version that lists it in `revoked_key_ids` — never this surface.
//
// ★ Nothing in the list response identifies the key the PHI write path is
// actually using; the row that does is withheld from `keys`. `status` is the
// state of the registry entry and nothing more. The console must not badge,
// sort or label a listed row as "the key receiving writes" — a round-1 change
// did exactly that and put the claim on an inert row.
//
// The generated OpenAPI spec types these operations as the generic `Success`
// envelope only, so row shapes are hand-written from the service RETURNING list
// and from the documented `listEncryptionKeys` return shape.

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

/**
 * Algorithm values this console offers when it mints a registry row.
 *
 * This is NOT the backend's allowlist. The service takes `algorithm` as free
 * text — it trims it and truncates past 40 characters. Given the provider these
 * dialogs send and the metadata they omit (none), only two algorithm values are
 * actually refused: an empty one, and `ed25519` in any casing, which marks the
 * row as a clinical-continuity signing key. Both come back as 400
 * `ENCRYPTION_KEY_WOULD_BE_UNMANAGEABLE` from the mint-time check that
 * classifies the row before writing it.
 *
 * The list is deliberately narrower than that. A free-text field let an
 * operator type `Ed25519`, get a row that inserted cleanly, and then watch it
 * vanish from `keys` on the very next read — the trap the backend now closes
 * with a refusal and this input closes by not offering it. `aes-256-gcm` is the
 * cipher the platform's own envelope path uses (backend
 * services/security/phiEnvelopeService.js); the other two are symmetric AEAD
 * ciphers a KMS-held KEK may legitimately be. Registering a row with any other
 * algorithm has to go through the backend service directly.
 */
export const REGISTRY_ALGORITHMS = [
  "aes-256-gcm",
  "aes-192-gcm",
  "aes-128-gcm",
  "chacha20-poly1305",
] as const;

/**
 * How the backend classified a row it withheld from `keys`. These are the
 * KEY_CLASSES values from the registry service minus `registry_metadata`, which
 * by definition never appears in `protected`.
 */
export const WITHHELD_KEY_CLASSES = [
  "live_key_material",
  "signing_key",
  "unproven",
  "out_of_tenant_scope",
] as const;

export type KmsProvider = (typeof KMS_PROVIDERS)[number];
export type EncryptionKeyStatus = (typeof KEY_STATUSES)[number];
export type RegistryAlgorithm = (typeof REGISTRY_ALGORITHMS)[number];
export type WithheldKeyClass = (typeof WITHHELD_KEY_CLASSES)[number];

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

/**
 * A row the tenant can see that this console may not act on. Exactly seven
 * fields — the backend never puts key material, metadata or timestamps here.
 *
 * `provider` and `status` are plain strings rather than the unions above on
 * purpose: a withheld row is precisely one the allowlist did not match, so it
 * may carry a provider outside `KMS_PROVIDERS` (the live per-tenant KEKs are
 * `local-tenant`), and the deployed table carries no CHECK constraining either
 * column.
 */
export interface WithheldKey {
  id: number;
  tenant_id: string | null;
  key_id: string;
  provider: string;
  status: string;
  key_class: WithheldKeyClass;
  /** Non-empty human text naming the marker that withheld the row. */
  reason: string;
}

/**
 * The list response, whole. `protected` is a JS reserved word only as a binding
 * name — `data.protected` and `{ protected: withheld }` are both fine.
 */
export interface EncryptionKeyListResponse {
  /** Rows this console can retire, compromise, or rotate away from. */
  keys: EncryptionKey[];
  /** `keys.length`, server-side. */
  count: number;
  /** Every other row the tenant can see, with the reason it was withheld. */
  protected: WithheldKey[];
  /** `protected.length`, server-side. */
  protected_count: number;
}

export interface RegisterKeyPayload {
  key_id: string;
  provider?: KmsProvider;
  provider_reference?: string | null;
  algorithm?: RegistryAlgorithm;
  metadata?: Record<string, unknown> | null;
}

export interface RotateKeyPayload {
  new_key_id: string;
  provider?: KmsProvider;
  provider_reference?: string | null;
  algorithm?: RegistryAlgorithm;
  metadata?: Record<string, unknown> | null;
}

/**
 * The refusal codes the registry service raises, by the action that raises
 * them. Copied from ENCRYPTION_KEY_REFUSAL_CODES in
 * services/security/encryptionKeyRegistryService.js.
 */
export const ENCRYPTION_KEY_REFUSAL_CODES = {
  /** 409, retire + compromise — the row is live per-tenant envelope KEK material. */
  LIVE_MATERIAL: "ENCRYPTION_KEY_LIVE_MATERIAL",
  /** 409, retire + compromise — the row is a clinical-continuity signing key. */
  SIGNING: "ENCRYPTION_KEY_SIGNING_MATERIAL",
  /** 409, retire + compromise — inert, but carrying no tenant_id of this tenant's. */
  OUT_OF_TENANT_SCOPE: "ENCRYPTION_KEY_NOT_TENANT_SCOPED",
  /** 409, retire + compromise — the row cannot be proven inert. */
  UNPROVEN: "ENCRYPTION_KEY_NOT_PROVABLY_INERT",
  /** 400, register + rotate — the key id is inside the reserved KEK namespace. */
  RESERVED_KEY_ID: "ENCRYPTION_KEY_ID_RESERVED",
  /** 400, register + rotate — the row asked for would be created then withheld. */
  WOULD_BE_UNMANAGEABLE: "ENCRYPTION_KEY_WOULD_BE_UNMANAGEABLE",
  /** 400, register + rotate — `metadata` is not storable as jsonb. */
  METADATA_UNSTORABLE: "ENCRYPTION_KEY_METADATA_UNSTORABLE",
  /** 409, rotate — there is an active key to displace, but not one to demote. */
  ROTATION_PREDECESSOR_PROTECTED:
    "ENCRYPTION_KEY_ROTATION_PREDECESSOR_PROTECTED",
  /** 503, any call — the columns the fence is built from are missing. */
  SCHEMA_MISSING: "ENCRYPTION_KEY_REGISTRY_SCHEMA_MISSING",
} as const;

export type EncryptionKeyRefusalCode =
  (typeof ENCRYPTION_KEY_REFUSAL_CODES)[keyof typeof ENCRYPTION_KEY_REFUSAL_CODES];

const REFUSAL_CODE_VALUES: readonly string[] = Object.values(
  ENCRYPTION_KEY_REFUSAL_CODES,
);

/** A refusal this client recognises, lifted out of the error envelope. */
export interface EncryptionKeyRefusal {
  code: EncryptionKeyRefusalCode;
  /** `details.key_class`; absent on the two refusals that carry no details. */
  keyClass: string | null;
  /** `details.reason` — the marker that withheld the row. */
  reason: string | null;
  /** `details.key_id` — the row the refusal is about. */
  keyId: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/**
 * Read a registry refusal off a thrown error.
 *
 * `core.ts` throws `APIError` with `data` set to the parsed error envelope
 * (`{ success: false, message, code, details }`), so the machine code and the
 * class survive the trip even though `Error.message` is what gets rendered.
 * Returns null for anything that is not one of the codes above — a transport
 * failure, a 404, or the generic-`CONFLICT` 409 raised for a duplicate key_id —
 * so the console can never label an unrelated failure a fence refusal.
 */
export function readEncryptionKeyRefusal(
  err: unknown,
): EncryptionKeyRefusal | null {
  const envelope = asRecord(asRecord(err)?.data);
  const code = asStringOrNull(envelope?.code);
  if (!code || !REFUSAL_CODE_VALUES.includes(code)) return null;
  const details = asRecord(envelope?.details);
  return {
    code: code as EncryptionKeyRefusalCode,
    keyClass: asStringOrNull(details?.key_class),
    reason: asStringOrNull(details?.reason),
    keyId: asStringOrNull(details?.key_id),
  };
}

/**
 * The registry for the caller's tenant, partitioned — never filtered down.
 *
 * `keys` is what this console can act on: rows the allowlist matched that also
 * carry this tenant's `tenant_id`. `protected` is every OTHER row the tenant can
 * see, each with `key_class` and a `reason` naming the marker that withheld it.
 * `count` and `protected_count` are the two lengths, so `count +
 * protected_count` is every visible row under the optional status filter — a
 * row missing from both would be a backend bug, not policy.
 *
 * This call never refuses on fence grounds. It can still fail with 503
 * `ENCRYPTION_KEY_REGISTRY_SCHEMA_MISSING` when the columns the fence reads are
 * not there, which is deliberately not an empty list.
 */
export async function listEncryptionKeys(
  params: { status?: EncryptionKeyStatus } = {},
) {
  const query: Record<string, string> = {};
  if (params.status) query.status = params.status;
  return getJSON<EncryptionKeyListResponse>("/admin/encryption-keys", query);
}

/**
 * Creates a registry entry with status `active`. Writes one row and touches no
 * existing row — no key material is created and no encryption path is
 * repointed.
 *
 * Refusals: 409 if key_id is already registered for the tenant; 400
 * `ENCRYPTION_KEY_ID_RESERVED` if it falls inside the reserved per-tenant KEK
 * namespace; 400 `ENCRYPTION_KEY_WOULD_BE_UNMANAGEABLE` if the row it would
 * write is one the fence would then withhold — which is why `algorithm` is
 * constrained to `REGISTRY_ALGORITHMS` at the input rather than left free text.
 */
export async function registerEncryptionKey(payload: RegisterKeyPayload) {
  return postJSON<EncryptionKey>("/admin/encryption-keys", payload);
}

/**
 * Demotes the tenant's newest actionable `active` entry to `retiring` and
 * inserts the new entry as `active` with `rotated_from` linking back. Two row
 * writes — no key material moves and no stored record is re-wrapped. Returns
 * the NEW row.
 *
 * When the allowlisted predecessor search finds nothing, the outcome depends on
 * why: if the tenant has a visible `active` key that this console may not
 * demote, rotation is refused with 409
 * `ENCRYPTION_KEY_ROTATION_PREDECESSOR_PROTECTED` rather than leaving that key
 * active beside a new one claiming to have replaced it. Only a tenant with no
 * visible active key at all gets the insert, and the returned row then has
 * `rotated_from: null` — which is the one honest way to read that field as "no
 * predecessor", never "a predecessor was skipped".
 *
 * Also refuses 400 `ENCRYPTION_KEY_ID_RESERVED` / 400
 * `ENCRYPTION_KEY_WOULD_BE_UNMANAGEABLE` on the row it is about to insert, on
 * the same terms as register.
 */
export async function rotateEncryptionKey(payload: RotateKeyPayload) {
  return postJSON<EncryptionKey>("/admin/encryption-keys/rotate", payload);
}

/**
 * active|retiring → retired on the registry entry. Records the decision; it
 * does not destroy key material or re-wrap anything.
 *
 * 404 if not found or already retired. 409 with one of the four class codes —
 * LIVE_MATERIAL, SIGNING, OUT_OF_TENANT_SCOPE, UNPROVEN — when the row named is
 * one the listing withheld; the message names the key and the marker, and
 * `details.key_class` carries the class.
 */
export async function retireEncryptionKey(id: number) {
  return postJSON<EncryptionKey>(`/admin/encryption-keys/${id}/retire`);
}

/**
 * Any non-compromised status → compromised; `reason` is stamped into the row
 * metadata. This is an incident record on the registry entry: the request
 * updates that row's status and metadata only. It does not revoke, destroy or
 * rotate key material and does not re-wrap any stored record — the real
 * revocation happens in the KMS provider.
 *
 * Refuses on exactly the same terms as retire: 404 when absent or already
 * compromised, 409 by class for a row the listing withheld.
 */
export async function markEncryptionKeyCompromised(
  id: number,
  reason?: string | null,
) {
  return postJSON<EncryptionKey>(`/admin/encryption-keys/${id}/compromise`, {
    reason: reason ?? null,
  });
}
