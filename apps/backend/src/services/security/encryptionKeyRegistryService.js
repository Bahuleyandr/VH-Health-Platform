/**
 * Encryption key registry (Phase E3) — the SUPER_ADMIN console over the
 * `encryption_keys` table (migration 129; routes/admin/encryptionKeyRoutes.js).
 *
 * A REGISTRY row is inert bookkeeping: KEK metadata plus a provider reference,
 * with the key material itself in the configured KMS. Nothing in the platform
 * reads such a row's `status`.
 *
 * The TABLE is not inert, though. Three further classes of LIVE key share it,
 * and every one of them has a consumer that requires a particular `status`:
 *
 *  1. **Per-tenant envelope KEKs** — provider `'local-tenant'`, key id
 *     `t:<tenant_id>:v<n>`, the wrapped 32-byte KEK in `wrapped_key_material`
 *     (migration 337; 669 + 672 make that material write-once).
 *     `tenantKekProvider.preloadAllTenantKeks()` re-registers exactly the
 *     `status='active'` rows that still hold material at every startup, and the
 *     key id is stamped into every enc:v2 payload. Demote, retire or compromise
 *     one and every record encrypted under it stops decrypting after the next
 *     restart.
 *  2. **Clinical-continuity policy / pack signing keys** — Ed25519, with
 *     `metadata.purpose` of `'clinical_continuity_policy_signing'` or
 *     `'clinical_continuity_pack_signing'` and the SPKI PEM in
 *     `metadata.public_key_spki_pem`. Migration 600 raises SQLSTATE 23514 on a
 *     policy-version write whose policy key is not `active`/`retiring`
 *     (600:1071-1078), whose current pack key is not `active`/`retiring`
 *     (600:1079-1086) and not `active` at all while the policy is live
 *     (600:1116-1128), or whose next pack key is not `active` (600:1101-1109).
 *     Publication is stricter still: trigger `trg_downtime_cc_governance`
 *     (600:1472-1474) refuses to insert a `downtime_snapshots` row of
 *     `scope='clinical_continuity_pack'` unless the key its `signing_key_id`
 *     names is Ed25519, `status='active'` and pack-signing-purposed
 *     (600:1315-1334). `retiring` is not good enough there. The
 *     "downtime-snapshot signing key" is not a fourth class — it is this same
 *     pack key, reached through `downtime_snapshots.signing_key_id` and its FK
 *     `fk_downtime_snapshots_cc_signing_key` (600:818-823).
 *  3. **Incident-packet signing keys** — `metadata.purpose` of
 *     `'clinical_continuity_incident_packet_signing'`.
 *     `clinical_continuity_issue_incident_packet` fails closed unless that row
 *     is algorithm `'Ed25519'` with `status='active'` (630:718-723).
 *
 * The fence is therefore an ALLOWLIST: a row is mutable only when EVERY
 * inertness marker holds — see `REGISTRY_MANAGED_SQL` and its JS twin
 * `classifyEncryptionKeyRow`, which must agree before this service will touch a
 * row. Everything else, INCLUDING a row whose shape this console does not
 * recognise, is kept out of the mutable set: withheld by the listing, and
 * refused by name — with the class it landed in and the marker that put it
 * there — by the actions that name a row. A denylist was tried first and
 * missed classes 2 and 3.
 *
 * Inertness is necessary but not sufficient. Every lifecycle statement here is
 * scoped `WHERE ... tenant_id = $n::uuid`, while the listing is deliberately
 * wider (`OR tenant_id IS NULL`, for the untenanted rows migration 129 still
 * permits). `NULL = <uuid>` is NULL and never TRUE, so such a row can never be
 * matched however inert it is — `classifyForTenant` therefore refuses it as
 * `OUT_OF_TENANT_SCOPE` rather than letting it look mutable and then 404.
 *
 * WHAT EACH ACTION ACTUALLY DOES. The fence is not uniform across the five
 * entry points: one withholds, two refuse a named row, one refuses an
 * operation, one refuses a shape — so a single blanket "protected keys are
 * refused" line cannot be true of all of them, and round 2 shipped exactly
 * that line over a rotate and a register that refused nothing at all.
 * `ENCRYPTION_KEY_ACTION_FENCE` below is this paragraph in machine-readable
 * form, exported so the route layer can serve the truth per action rather than
 * leaving the console to restate a blanket claim. Nothing serves it today —
 * routes/admin/encryptionKeyRoutes.js does not read it yet:
 *
 *  - `listEncryptionKeys` never refuses anything. It returns the actionable
 *    rows in `keys` and EVERY other visible row in `protected`, each with the
 *    class it landed in and the marker that put it there, plus `count` and
 *    `protected_count`. Withheld is not dropped.
 *  - `retireEncryptionKey` and `markKeyCompromised` are the two that refuse a
 *    NAMED row. Their guarded UPDATE carries the allowlist, and when it matches
 *    nothing they re-read the row and refuse by class (409) rather than 404.
 *  - `rotateActiveKey` carries the allowlist on BOTH its statements — the
 *    predecessor search and the UPDATE that demotes the predecessor to
 *    'retiring'. That narrowing alone is not a refusal, though: a fenced search
 *    that finds nothing is indistinguishable from a tenant with no keys, and
 *    round 2 inserted an unlinked new row in both cases. So when the search
 *    comes up empty, `assertNothingToRotateFrom` asks whether the tenant has an
 *    active key at all. If it does, every one of them is a row this console may
 *    not demote, the operator's intent is unsatisfiable, and rotation is
 *    refused (409 `ENCRYPTION_KEY_ROTATION_PREDECESSOR_PROTECTED`) rather than
 *    leaving the real active key active beside a new one that claims to have
 *    replaced it. `rotated_from` is NULL only in the bootstrap case — no active
 *    key at all — where nothing ends up misdescribed.
 *  - `registerEncryptionKey` creates a row rather than mutating one, so it has
 *    no predecessor to protect. Its fence is a mint-time invariant instead:
 *    ANYTHING THIS MODULE CAN CREATE, THIS MODULE CAN MANAGE. `algorithm` and
 *    `metadata` are caller text, so before this fix a row registered as
 *    'Ed25519', or with a signing `metadata.purpose`, was created normally and
 *    then vanished from `keys` forever — unretirable, uncompromisable, a trap
 *    the allowlist itself introduced. Both INSERT paths (register and the
 *    rotate insert) now classify the row they are about to write with the same
 *    `classifyForTenant` the lifecycle paths use and refuse it up front
 *    (400 `ENCRYPTION_KEY_WOULD_BE_UNMANAGEABLE`). Minting an id inside the
 *    tenant's reserved per-tenant KEK namespace stays a separate, earlier
 *    refusal with its own code.
 *
 * Live KEKs have their own lifecycle (`provisionTenantKek` / `cryptoShredTenant`
 * in services/security/tenantKekProvider.js); a signing key is revoked by
 * publishing a new `clinical_continuity_policy_versions` row that lists it in
 * `revoked_key_ids` (600:1087-1088, 600:1303). Never this console.
 *
 * Migration 129.
 */

import prisma from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';

const SHORT_MAX = 255;

export const KMS_PROVIDERS = ['env', 'aws-kms', 'gcp-kms', 'vault', 'azure-keyvault'];
export const KEY_STATUSES = ['active', 'retiring', 'retired', 'compromised'];

/** Provider stamped on the live per-tenant envelope KEK rows (tenantKekProvider). */
export const LIVE_KEY_MATERIAL_PROVIDER = 'local-tenant';

/**
 * `metadata.purpose` values that mark a row as a signing key some other
 * subsystem verifies against. Sourced from services/downtime/clinicalContinuityPolicyService.js
 * (POLICY_KEY_PURPOSE, PACK_KEY_PURPOSE, INCIDENT_PACKET_SIGNING_KEY_PURPOSE)
 * and asserted by migrations 600 and 630.
 */
export const SIGNING_KEY_PURPOSES = Object.freeze([
  'clinical_continuity_policy_signing',
  'clinical_continuity_pack_signing',
  'clinical_continuity_incident_packet_signing',
]);

/**
 * Signature algorithms, lower-cased. A KEK registry row describes a symmetric
 * envelope key; an Ed25519 row in this table is always a signing key (600
 * compares `LOWER(algorithm) <> 'ed25519'`, 630 compares `<> 'Ed25519'`).
 */
const SIGNING_ALGORITHMS = Object.freeze(['ed25519']);

/** Metadata key carrying a signing key's published public half. */
const PUBLIC_KEY_METADATA_FIELD = 'public_key_spki_pem';

export const KEY_CLASSES = Object.freeze({
  /** Inert bookkeeping. The only class this console may mutate. */
  REGISTRY: 'registry_metadata',
  /** Per-tenant envelope KEK lifecycle (tenantKekProvider). */
  LIVE_MATERIAL: 'live_key_material',
  /** Verified against by clinical continuity (migrations 600 / 630). */
  SIGNING: 'signing_key',
  /** Shape this console cannot prove inert — refused, fail-closed. */
  UNPROVEN: 'unproven',
  /** Inert, but outside the tenant scope every lifecycle statement carries. */
  OUT_OF_TENANT_SCOPE: 'out_of_tenant_scope',
});

/**
 * Every code this module refuses with, in one place, because the console has
 * to render each one differently.
 *
 * The first four are the CLASS refusals: `retireEncryptionKey` and
 * `markKeyCompromised` raise them for a named row the allowlist withholds, and
 * each carries `details.key_class` (a `KEY_CLASSES` value) plus
 * `details.reason`. The rest are raised before anything is written.
 * `SCHEMA_MISSING` is cross-cutting — all five entry points can raise it — so
 * it is deliberately not listed against any single action below.
 */
export const ENCRYPTION_KEY_REFUSAL_CODES = Object.freeze({
  /** 409 — the row is live per-tenant envelope KEK material. */
  LIVE_MATERIAL: 'ENCRYPTION_KEY_LIVE_MATERIAL',
  /** 409 — the row is a clinical-continuity signing key. */
  SIGNING: 'ENCRYPTION_KEY_SIGNING_MATERIAL',
  /** 409 — inert, but not stamped with the acting tenant's tenant_id. */
  OUT_OF_TENANT_SCOPE: 'ENCRYPTION_KEY_NOT_TENANT_SCOPED',
  /** 409 — the row cannot be proven inert, including twin disagreement. */
  UNPROVEN: 'ENCRYPTION_KEY_NOT_PROVABLY_INERT',
  /** 400 — the requested id is inside this tenant's reserved KEK namespace. */
  RESERVED_KEY_ID: 'ENCRYPTION_KEY_ID_RESERVED',
  /** 400 — the row asked for would be created and then never manageable. */
  WOULD_BE_UNMANAGEABLE: 'ENCRYPTION_KEY_WOULD_BE_UNMANAGEABLE',
  /** 400 — `metadata` is not representable as the jsonb the row stores. */
  METADATA_UNSTORABLE: 'ENCRYPTION_KEY_METADATA_UNSTORABLE',
  /** 409 — rotation has an active key to displace but may not demote it. */
  ROTATION_PREDECESSOR_PROTECTED: 'ENCRYPTION_KEY_ROTATION_PREDECESSOR_PROTECTED',
  /** 503 — the columns the fence is built from are missing. */
  SCHEMA_MISSING: 'ENCRYPTION_KEY_REGISTRY_SCHEMA_MISSING',
});

/**
 * The per-action truth the console must render, machine-readable.
 *
 * `mutates_existing_rows` and `creates_rows` describe the statements an action
 * actually issues on its success path; `refusal_codes` is the set of fence
 * refusals it can raise (never `SCHEMA_MISSING`, which any of them can raise
 * for a reason that is not about a key). Both halves are pinned against real
 * behaviour in src/tests/unit/encryptionKeyRegistryService.test.js — a caller
 * that reads this object is reading something a test can falsify, which a
 * hand-written line of console copy is not.
 */
export const ENCRYPTION_KEY_ACTION_FENCE = Object.freeze({
  list: Object.freeze({
    mutates_existing_rows: false,
    creates_rows: false,
    refusal_codes: Object.freeze([]),
    behaviour: 'Never refuses. Returns actionable rows in `keys` and every other visible row in `protected`, each with its key_class and reason.',
  }),
  register: Object.freeze({
    mutates_existing_rows: false,
    creates_rows: true,
    refusal_codes: Object.freeze([
      ENCRYPTION_KEY_REFUSAL_CODES.RESERVED_KEY_ID,
      ENCRYPTION_KEY_REFUSAL_CODES.WOULD_BE_UNMANAGEABLE,
      ENCRYPTION_KEY_REFUSAL_CODES.METADATA_UNSTORABLE,
    ]),
    behaviour: 'Creates one active row and touches no existing row. Refuses before writing anything the fence would then withhold, so every row this console mints stays one it can manage.',
  }),
  rotate: Object.freeze({
    mutates_existing_rows: true,
    creates_rows: true,
    refusal_codes: Object.freeze([
      ENCRYPTION_KEY_REFUSAL_CODES.RESERVED_KEY_ID,
      ENCRYPTION_KEY_REFUSAL_CODES.WOULD_BE_UNMANAGEABLE,
      ENCRYPTION_KEY_REFUSAL_CODES.METADATA_UNSTORABLE,
      ENCRYPTION_KEY_REFUSAL_CODES.ROTATION_PREDECESSOR_PROTECTED,
    ]),
    behaviour: "Demotes the tenant's newest allowlisted active key to 'retiring' and inserts a new active key linked to it. Refuses when the tenant has an active key but none this console may demote; inserts with rotated_from NULL only when the tenant has no active key at all.",
  }),
  retire: Object.freeze({
    mutates_existing_rows: true,
    creates_rows: false,
    refusal_codes: Object.freeze([
      ENCRYPTION_KEY_REFUSAL_CODES.LIVE_MATERIAL,
      ENCRYPTION_KEY_REFUSAL_CODES.SIGNING,
      ENCRYPTION_KEY_REFUSAL_CODES.OUT_OF_TENANT_SCOPE,
      ENCRYPTION_KEY_REFUSAL_CODES.UNPROVEN,
    ]),
    behaviour: "Sets one allowlisted, tenant-scoped row to 'retired'. Refuses a withheld row by class (409); 404s a row that is absent or already retired/compromised.",
  }),
  compromise: Object.freeze({
    mutates_existing_rows: true,
    creates_rows: false,
    refusal_codes: Object.freeze([
      ENCRYPTION_KEY_REFUSAL_CODES.LIVE_MATERIAL,
      ENCRYPTION_KEY_REFUSAL_CODES.SIGNING,
      ENCRYPTION_KEY_REFUSAL_CODES.OUT_OF_TENANT_SCOPE,
      ENCRYPTION_KEY_REFUSAL_CODES.UNPROVEN,
    ]),
    behaviour: "Sets one allowlisted, tenant-scoped row to 'compromised' and records the reason in metadata. Refuses a withheld row by class (409); 404s a row that is absent or already compromised.",
  }),
});

/**
 * The reserved per-tenant KEK key-id namespace, ANCHORED TO ONE TENANT — the
 * same shape tenantKekProvider anchors its own SQL to
 * (`'^t:' || tenant_id::text || ':v[0-9]+$'`, tenantKekProvider.js:111/228/250).
 * A looser `^t:.+:v\d+$` would swallow an operator id such as `t:acme:v2`,
 * which no tenant's KEK lifecycle can ever produce, and make it both invisible
 * and unmutable forever.
 */
function tenantKekKeyIdPattern(tenantId) {
  return new RegExp(`^t:${escapeRegExp(String(tenantId))}:v[0-9]+$`);
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * SQL literal list of the KMS providers. These are module constants, never
 * caller input; the assertion below is what keeps that true — a provider name
 * containing a quote would break out of the literal, so refuse to load at all.
 */
const PROVIDER_LITERAL_PATTERN = /^[a-z0-9-]+$/;
for (const provider of [...KMS_PROVIDERS, LIVE_KEY_MATERIAL_PROVIDER]) {
  if (!PROVIDER_LITERAL_PATTERN.test(provider)) {
    throw new Error(`Unsafe KMS provider name for SQL interpolation: ${provider}`);
  }
}
const KMS_PROVIDER_SQL_LIST = KMS_PROVIDERS.map((provider) => `'${provider}'`).join(', ');

/** `TRUE` exactly when `key_id` is this row's OWN tenant's reserved KEK id. */
const TENANT_KEK_KEY_ID_SQL =
  "(tenant_id IS NOT NULL AND key_id ~ ('^t:' || tenant_id::text || ':v[0-9]+$'))";

/**
 * The allowlist. TRUE only for INERT registry metadata — every marker of a live
 * role must be absent. `provider`, `key_id`, `algorithm` and `metadata` are all
 * NOT NULL in the schema and `tenant_id` is handled explicitly, so this
 * predicate is total: `NOT (...)` is its exact complement, which is what lets
 * `listEncryptionKeys` partition the table with one pass.
 *
 * It answers inertness and nothing else. WHICH tenant a row belongs to is a
 * separate gate — the `tenant_id = $n::uuid` each statement carries, mirrored in
 * JS by `classifyForTenant` — because the parameter positions differ per
 * statement and one shared literal cannot name them all.
 *
 * Kept in lockstep with `classifyEncryptionKeyRow` below; both must agree
 * before a row is treated as mutable.
 */
const REGISTRY_MANAGED_SQL = `(provider IN (${KMS_PROVIDER_SQL_LIST})
        AND wrapped_key_material IS NULL
        AND NOT ${TENANT_KEK_KEY_ID_SQL}
        AND LOWER(algorithm) <> 'ed25519'
        AND metadata ->> 'purpose' IS NULL
        AND metadata ->> '${PUBLIC_KEY_METADATA_FIELD}' IS NULL)`;

function hasField(row, field) {
  return Boolean(row) && Object.hasOwn(row, field);
}

/**
 * Does the row carry wrapped key material? `'unknown'` when neither the column
 * nor its existence probe is present — the caller then fails closed.
 *
 * Both shapes are accepted on purpose: `assertRegistryManagedKey` selects
 * `(wrapped_key_material IS NOT NULL) AS has_key_material` so the material
 * itself never enters this process, while a caller holding a row selected with
 * the real column name must not be silently read as "no material" (the
 * fail-OPEN twin this replaces keyed on `has_key_material` alone, so any such
 * row scored `undefined !== true` and looked mutable).
 */
function materialState(row) {
  if (hasField(row, 'wrapped_key_material')) {
    const value = row.wrapped_key_material;
    if (value === undefined) return 'unknown';
    // Exactly `wrapped_key_material IS NULL`, which is the whole of the SQL
    // twin's test. An empty string is NOT NULL there, so it has to read as
    // material here too — otherwise the two fences disagree about one row.
    return value === null ? 'absent' : 'present';
  }
  if (hasField(row, 'has_key_material')) {
    if (row.has_key_material === true) return 'present';
    if (row.has_key_material === false) return 'absent';
    return 'unknown';
  }
  return 'unknown';
}

/** Row metadata as a plain object, or `null` when it cannot be read. */
function metadataObject(row) {
  if (!hasField(row, 'metadata')) return null;
  const raw = row.metadata;
  // jsonb NULL and SQL NULL both make `metadata ->> 'purpose'` NULL, i.e. "no
  // purpose declared" — mirror that rather than failing closed on it.
  if (raw === null) return {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (parsed === null) return {};
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Is a jsonb field present with a non-null value? This is exactly when
 * `metadata ->> '<field>' IS NULL` is FALSE in the SQL twin — including for
 * numbers and objects, which `->>` renders as text rather than NULL. Keeping
 * the two definitions identical is what stops a row from being mutable on one
 * side of the fence and not the other.
 */
function metadataDeclares(metadata, field) {
  if (!metadata) return false;
  const value = metadata[field];
  return value !== null && value !== undefined;
}

function tenantKekNamespaceState(row) {
  if (!hasField(row, 'key_id') || !hasField(row, 'tenant_id')) return 'unknown';
  const keyId = row.key_id;
  if (typeof keyId !== 'string') return 'unknown';
  const tenantId = row.tenant_id;
  // A row with no tenant cannot be a per-tenant KEK: every write in
  // tenantKekProvider stamps tenant_id, and TENANT_KEK_KEY_ID_SQL is FALSE here.
  if (tenantId === null || String(tenantId).trim() === '') return 'outside';
  return tenantKekKeyIdPattern(tenantId).test(keyId) ? 'inside' : 'outside';
}

function verdict(keyClass, markers) {
  return { mutable: false, keyClass, reason: markers.join('; ') };
}

/**
 * The JS twin of REGISTRY_MANAGED_SQL, for rows already fetched.
 *
 * Fail-closed by construction: a marker this function cannot evaluate — because
 * the row was selected without the column it needs — is UNPROVEN, never
 * "absent". Only a row on which every inertness marker is positively observed
 * comes back mutable.
 *
 * @returns {{mutable: boolean, keyClass: string, reason: string|null}}
 */
export function classifyEncryptionKeyRow(row) {
  if (!row || typeof row !== 'object') {
    return verdict(KEY_CLASSES.UNPROVEN, ['the row could not be read']);
  }

  const material = materialState(row);
  const namespace = tenantKekNamespaceState(row);
  const metadata = metadataObject(row);
  const provider = hasField(row, 'provider') ? row.provider : undefined;
  const algorithm = hasField(row, 'algorithm') ? row.algorithm : undefined;

  // 1. Live envelope key material — the per-tenant KEK lifecycle.
  const liveMarkers = [];
  if (provider === LIVE_KEY_MATERIAL_PROVIDER) {
    liveMarkers.push(`provider '${LIVE_KEY_MATERIAL_PROVIDER}'`);
  }
  if (namespace === 'inside') {
    liveMarkers.push('a key id inside its own tenant\'s reserved t:<tenantId>:v<n> namespace');
  }
  if (material === 'present') liveMarkers.push('wrapped key material on the row');
  if (liveMarkers.length > 0) return verdict(KEY_CLASSES.LIVE_MATERIAL, liveMarkers);

  // 2. Signing keys other subsystems verify against.
  const signingMarkers = [];
  const purpose = metadata?.purpose;
  if (typeof purpose === 'string' && SIGNING_KEY_PURPOSES.includes(purpose)) {
    signingMarkers.push(`metadata.purpose '${purpose}'`);
  }
  if (typeof algorithm === 'string' && SIGNING_ALGORITHMS.includes(algorithm.toLowerCase())) {
    signingMarkers.push(`signature algorithm '${algorithm}'`);
  }
  if (metadataDeclares(metadata, PUBLIC_KEY_METADATA_FIELD)) {
    signingMarkers.push(`a published metadata.${PUBLIC_KEY_METADATA_FIELD}`);
  }
  if (signingMarkers.length > 0) return verdict(KEY_CLASSES.SIGNING, signingMarkers);

  // 3. Anything left that is not positively inert.
  const unproven = [];
  if (typeof provider !== 'string') unproven.push('the row carries no readable provider');
  else if (!KMS_PROVIDERS.includes(provider)) {
    unproven.push(`provider '${provider}' is not one of the KMS metadata providers`);
  }
  if (material === 'unknown') unproven.push('the row does not say whether it holds key material');
  if (namespace === 'unknown') {
    unproven.push('the row lacks the tenant_id/key_id needed to test the reserved KEK namespace');
  }
  if (metadata === null) unproven.push('the row metadata could not be read');
  else if (metadataDeclares(metadata, 'purpose')) {
    unproven.push(`metadata.purpose ${JSON.stringify(metadata.purpose)} declares a role this console cannot prove inert`);
  }
  if (typeof algorithm !== 'string') unproven.push('the row carries no readable algorithm');
  if (unproven.length > 0) return verdict(KEY_CLASSES.UNPROVEN, unproven);

  return { mutable: true, keyClass: KEY_CLASSES.REGISTRY, reason: null };
}

/**
 * Convenience predicate over `classifyEncryptionKeyRow` — inertness only, which
 * is why it is not what the lifecycle paths call. Fail-closed for the same
 * reason `classifyEncryptionKeyRow` is: anything short of "every marker
 * positively observed" is `false`.
 */
function isRegistryManagedRow(row) {
  return classifyEncryptionKeyRow(row).mutable === true;
}

/**
 * Can this console's SQL reach the row at all?
 *
 *  - `owned`    — the row carries the acting tenant's `tenant_id`.
 *  - `unscoped` — `tenant_id IS NULL`. Migration 129 leaves the column
 *                 nullable, `listEncryptionKeys` deliberately shows such rows
 *                 (`OR tenant_id IS NULL`), and no lifecycle statement can ever
 *                 match one, because `NULL = <uuid>` is NULL, not TRUE.
 *  - `foreign`  — some other tenant's row. No query here can return one; the
 *                 branch exists so a future widening cannot fail open.
 *  - `unknown`  — the row was selected without `tenant_id`.
 */
function tenantScopeState(row, tenantId) {
  if (!hasField(row, 'tenant_id')) return 'unknown';
  const rowTenant = row.tenant_id;
  if (rowTenant === null || rowTenant === undefined) return 'unscoped';
  const text = String(rowTenant).trim();
  if (text === '') return 'unscoped';
  return text === String(tenantId).trim() ? 'owned' : 'foreign';
}

const SCOPE_REASONS = {
  unscoped: 'the row carries no tenant_id at all',
  foreign: 'the row is not scoped to the tenant this request is acting for',
  unknown: 'the row was read without the tenant_id needed to place it',
};

/**
 * The verdict the lifecycle paths and the listing both act on: inert AND
 * reachable.
 *
 * Inertness is decided first so that the far more informative refusal wins — an
 * untenanted per-tenant KEK should still be reported as live key material, not
 * as a scoping problem. Only a row that already passed the allowlist can be
 * re-labelled `OUT_OF_TENANT_SCOPE`.
 */
function classifyForTenant(row, tenantId) {
  const inertness = classifyEncryptionKeyRow(row);
  if (!inertness.mutable) return inertness;
  const scope = tenantScopeState(row, tenantId);
  if (scope === 'owned') return inertness;
  return verdict(KEY_CLASSES.OUT_OF_TENANT_SCOPE, [SCOPE_REASONS[scope]]);
}

function resolveTenantId(options = {}) {
  return requireTenantId(options.tenantId);
}

function isMissingSchemaError(err) {
  return /does not exist|relation .* does not exist/i.test(String(err?.message || ''));
}

function isUniqueViolation(err) {
  return /duplicate key value/i.test(String(err?.message || ''));
}

/**
 * Every statement that has to decide whether a row is mutable names
 * `wrapped_key_material` and `metadata`, because the allowlist is built out of
 * them. If either column is missing the fence cannot be evaluated, so no
 * operation may proceed — including the read. Returning an empty registry there
 * (the round-1 behaviour of `listEncryptionKeys`) told an operator "this tenant
 * has no keys" when the truth was "this console cannot see them", while the
 * lifecycle calls surfaced a raw 500 for the same cause. One explicit failure
 * for all five.
 */
function schemaUnavailable() {
  return AppError.serviceUnavailable(
    'The encryption key registry is unavailable: the encryption_keys columns this console fences on are missing, so no row can be proven safe to read or mutate. Apply the pending migrations (129, 337) and retry.',
    ENCRYPTION_KEY_REFUSAL_CODES.SCHEMA_MISSING,
  );
}

async function runFenced(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (isMissingSchemaError(err)) throw schemaUnavailable();
    throw err;
  }
}

function safeText(value, max = SHORT_MAX) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  return max ? text.slice(0, max) : text;
}

function normalizeId(value, label = 'id') {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw AppError.badRequest(`${label} must be a positive integer`);
  }
  return parsed;
}

function maybeUuid(value, label = 'uid') {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) {
    throw AppError.badRequest(`${label} must be a UUID`);
  }
  return text;
}

function normalizeEnum(value, allowed, label, { required = false } = {}) {
  if (value === null || value === undefined || value === '') {
    if (required) throw AppError.badRequest(`${label} is required`);
    return null;
  }
  const text = String(value).trim();
  if (!allowed.includes(text)) {
    throw AppError.badRequest(`${label} must be one of: ${allowed.join(', ')}`);
  }
  return text;
}

const RETURNING = `id, tenant_id, key_id, provider, provider_reference,
  algorithm, status, rotated_from, activated_at, retiring_at, retired_at,
  metadata, created_by, created_at, updated_at`;

/**
 * The console may not mint ids inside the live per-tenant KEK namespace OF THE
 * TENANT IT IS WRITING FOR: the provider allocates versions there by scanning
 * key ids (tenantKekProvider.js:106-116), so a metadata row squatting on
 * `t:<tenantId>:v<n>` burns a version number the live keys need. Ids that only
 * look similar — `t:acme:v2`, or another tenant's uuid — are outside that
 * namespace and stay registrable.
 */
function assertRegistryKeyId(tenantId, keyId, label) {
  if (tenantKekKeyIdPattern(tenantId).test(keyId)) {
    throw AppError.badRequest(
      `${label} '${keyId}' is inside this tenant's reserved per-tenant KEK namespace (t:${tenantId}:v<n>); the live envelope keys own those ids`,
      ENCRYPTION_KEY_REFUSAL_CODES.RESERVED_KEY_ID,
    );
  }
  return keyId;
}

/**
 * The one reading of twin drift that is safe. Used by the listing and by the
 * rotation probe, which is why it is a shared constant rather than two strings.
 */
const TWIN_DISAGREEMENT_REASON = 'the SQL allowlist and its JS twin disagree about this row';

/**
 * Serialize `metadata` exactly the way the INSERTs bind it, and hand back both
 * the text to bind and the value that will come back out of jsonb — so the
 * mint-time fence classifies precisely what will be stored, not what was
 * passed. (A string argument, for instance, is stored as a jsonb string scalar
 * and read back as a string, which `classifyEncryptionKeyRow` then parses.)
 *
 * `metadata || {}` reproduces the pre-existing binding, falsy included.
 */
function serializeMetadata(metadata, label) {
  try {
    const text = JSON.stringify(metadata || {});
    return { text, value: JSON.parse(text) };
  } catch {
    throw AppError.badRequest(
      `${label} is refused: metadata must be JSON that can be stored in the jsonb column, and this value cannot be serialised and read back, so the row could not be written at all.`,
      ENCRYPTION_KEY_REFUSAL_CODES.METADATA_UNSTORABLE,
    );
  }
}

/**
 * THE MINT-TIME INVARIANT: anything this module can create, this module can
 * manage.
 *
 * `REGISTRY_MANAGED_SQL` excludes rows by algorithm and by metadata, and both
 * arrive here as caller text. An operator typing 'Ed25519' — or a
 * `metadata.purpose` of any kind — used to get a row that inserted cleanly,
 * disappeared from `keys` on the very next read, and could never be retired or
 * marked compromised. The allowlist created that trap; this closes it, by
 * running the row about to be written through the same `classifyForTenant`
 * every lifecycle path uses and refusing before the INSERT.
 *
 * Returns the metadata text to bind, so the caller cannot serialise a second,
 * different value than the one that was judged.
 */
function prepareRegistryRowInsert(tid, { keyId, provider, algorithm, metadata }, label) {
  const serialized = serializeMetadata(metadata, label);
  const candidate = {
    tenant_id: tid,
    key_id: keyId,
    provider,
    algorithm,
    metadata: serialized.value,
    // Neither INSERT names the column and migration 337 adds it with no
    // default, so the row is written with NULL material.
    wrapped_key_material: null,
  };
  const classification = classifyForTenant(candidate, tid);
  if (classification.mutable) return serialized.text;
  throw AppError.badRequest(
    `${label} would create an encryption_keys row this console could never offer as actionable: ${classification.reason}. A row reaches the actionable list only while every inertness marker holds, so this one would be registered and then withheld on the very next read — minted by the one console that would then refuse to list it. Clinical-continuity signing keys are published through their own subsystem (migrations 600 and 630) and per-tenant envelope KEKs through services/security/tenantKekProvider.js; neither is registered here. A registrable KEK metadata row has a provider in (${KMS_PROVIDERS.join(', ')}), a non-Ed25519 algorithm, no metadata.purpose, no metadata.${PUBLIC_KEY_METADATA_FIELD}, readable object metadata, and a key id outside its tenant's reserved t:<tenantId>:v<n> namespace.`,
    ENCRYPTION_KEY_REFUSAL_CODES.WOULD_BE_UNMANAGEABLE,
    {
      key_id: candidate.key_id,
      provider: candidate.provider,
      algorithm: candidate.algorithm,
      key_class: classification.keyClass,
      reason: classification.reason,
    },
  );
}

const REFUSAL_BY_CLASS = {
  [KEY_CLASSES.LIVE_MATERIAL]: {
    code: ENCRYPTION_KEY_REFUSAL_CODES.LIVE_MATERIAL,
    message: (keyId, action, reason) =>
      `Encryption key '${keyId}' belongs to the per-tenant envelope KEK lifecycle, not this registry (${reason}) — ${action} it here is refused: preloadAllTenantKeks() re-registers only the 'active' versions at startup, so moving one out of 'active' strands the PHI encrypted under it. Use crypto-shred / re-provision (services/security/tenantKekProvider.js) instead.`,
  },
  [KEY_CLASSES.SIGNING]: {
    code: ENCRYPTION_KEY_REFUSAL_CODES.SIGNING,
    message: (keyId, action, reason) =>
      `Encryption key '${keyId}' is a signing key other subsystems verify against (${reason}) — ${action} it would move it out of 'active', and clinical-continuity pack publication (migration 600) and incident-packet issuance (migration 630) both refuse to run unless the signing key row is 'active'. Revoke a signing key by publishing a new policy version that lists it in revoked_key_ids, never from this console.`,
  },
  [KEY_CLASSES.OUT_OF_TENANT_SCOPE]: {
    code: ENCRYPTION_KEY_REFUSAL_CODES.OUT_OF_TENANT_SCOPE,
    message: (keyId, action, reason) =>
      `Encryption key '${keyId}' is visible to this console but sits outside the tenant scope its lifecycle statements carry (${reason}), so ${action} it would match no row at all. Only a row stamped with the acting tenant's tenant_id can be retired, compromised or picked as a rotation predecessor here. An untenanted row predates per-tenant registration; giving it a tenant is a database change, not something this console can do.`,
  },
  [KEY_CLASSES.UNPROVEN]: {
    code: ENCRYPTION_KEY_REFUSAL_CODES.UNPROVEN,
    message: (keyId, action, reason) =>
      `Encryption key '${keyId}' cannot be proven to be inert registry metadata (${reason}), so ${action} it is refused. This console mutates a row only when every marker holds: provider in (${KMS_PROVIDERS.join(', ')}), no wrapped_key_material, no metadata.purpose, no metadata.${PUBLIC_KEY_METADATA_FIELD}, a non-Ed25519 algorithm, and a key id outside its tenant's reserved t:<tenantId>:v<n> namespace.`,
  },
};

function refusalFor(row, action, keyRowId, classification) {
  const template = REFUSAL_BY_CLASS[classification.keyClass] || REFUSAL_BY_CLASS[KEY_CLASSES.UNPROVEN];
  return AppError.conflict(
    template.message(row?.key_id ?? String(keyRowId), action, classification.reason),
    template.code,
    {
      id: keyRowId,
      key_id: row?.key_id ?? null,
      provider: row?.provider ?? null,
      key_class: classification.keyClass,
      reason: classification.reason,
    },
  );
}

/**
 * Explain a no-op guarded UPDATE. The lifecycle statements below cannot match a
 * row outside the allowlist, so an operator who aims one at a live KEK or a
 * continuity signing key would otherwise get a bare 404 and simply try harder.
 * Re-read the row — whether it HAS material, never the material itself — and
 * refuse by name, naming the class and the marker that put it there.
 *
 * The probe matches the same rows `listEncryptionKeys` shows, not the narrower
 * set the UPDATEs can reach: an untenanted row is listed, so a refusal for it
 * has to be explainable too. It never widens past that — `id` is the primary
 * key, and a row belonging to another tenant is still unreadable here, so this
 * cannot become a cross-tenant probe.
 *
 * Returns quietly when the row is missing (the caller's 404 is then correct) or
 * genuinely mutable (the caller's 404 means "already retired").
 */
async function assertRegistryManagedKey(tid, keyRowId, action) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, tenant_id, key_id, provider, status, algorithm, metadata,
            (wrapped_key_material IS NOT NULL) AS has_key_material
       FROM encryption_keys
      WHERE id = $1 AND (tenant_id = $2::uuid OR tenant_id IS NULL)`,
    keyRowId, tid,
  );
  const row = rows[0];
  if (!row) return;
  const classification = classifyForTenant(row, tid);
  if (classification.mutable) return;
  throw refusalFor(row, action, keyRowId, classification);
}

export async function registerEncryptionKey({
  tenantId = null, keyId, provider = 'env', providerReference = null,
  algorithm = 'aes-256-gcm', metadata = null, createdBy = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const cleanKid = safeText(keyId, 64);
  if (!cleanKid) throw AppError.badRequest('key_id is required');
  assertRegistryKeyId(tid, cleanKid, 'key_id');
  const cleanProv = normalizeEnum(provider, KMS_PROVIDERS, 'provider') || 'env';
  const cleanAlgorithm = safeText(algorithm, 40);
  const metadataText = prepareRegistryRowInsert(
    tid,
    { keyId: cleanKid, provider: cleanProv, algorithm: cleanAlgorithm, metadata },
    'Registering this key',
  );
  return runFenced(async () => {
    try {
      const rows = await prisma.$queryRawUnsafe(
        `INSERT INTO encryption_keys
           (tenant_id, key_id, provider, provider_reference, algorithm,
            status, metadata, created_by)
         VALUES ($1::uuid, $2, $3, $4, $5, 'active', $6::jsonb, $7::uuid)
         RETURNING ${RETURNING}`,
        tid, cleanKid, cleanProv, safeText(providerReference, 512), cleanAlgorithm,
        metadataText,
        maybeUuid(createdBy, 'created_by'),
      );
      return rows[0];
    } catch (err) {
      if (isUniqueViolation(err)) throw AppError.conflict('key_id already registered for this tenant');
      throw err;
    }
  });
}

/**
 * The registry, partitioned.
 *
 * `keys` holds the rows the actions on this console can actually act on:
 * allowlisted by both fences AND carrying this tenant's `tenant_id`. Every
 * other visible row is reported in `protected` with its class and the marker
 * that put it there, so a row is never simply missing: the caller can tell "no
 * such key" from "that key is live material" from "that key has no tenant".
 * `wrapped_key_material` is only ever tested for existence, never selected.
 *
 * The exact shape, because the console renders it:
 *
 *   {
 *     keys:            [ <the RETURNING columns, no material, no verdicts> ],
 *     count:           keys.length,
 *     protected:       [ { id, tenant_id, key_id, provider, status,
 *                          key_class, reason } ],
 *     protected_count: protected.length,
 *   }
 *
 * `count + protected_count` is every row this tenant can see, so a row missing
 * from both is a bug, not a policy.
 */
export async function listEncryptionKeys({ tenantId = null, status = null } = {}) {
  const tid = resolveTenantId({ tenantId });
  const filters = ['(tenant_id = $1::uuid OR tenant_id IS NULL)'];
  const params = [tid];
  if (status) {
    params.push(normalizeEnum(status, KEY_STATUSES, 'status'));
    filters.push(`status = $${params.length}`);
  }
  return runFenced(async () => {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT ${RETURNING},
              ${REGISTRY_MANAGED_SQL} AS is_registry_managed,
              (wrapped_key_material IS NOT NULL) AS has_key_material
         FROM encryption_keys
        WHERE ${filters.join(' AND ')}
        ORDER BY activated_at DESC`,
      ...params,
    );

    const keys = [];
    const withheld = [];
    for (const row of rows) {
      const { is_registry_managed: sqlVerdict, has_key_material: _material, ...key } = row;
      const classification = classifyForTenant(row, tid);
      // Both fences must agree on INERTNESS. `OUT_OF_TENANT_SCOPE` is only ever
      // reached after the JS allowlist passed, so it counts as "JS says inert"
      // when comparing the twins; tenant scope itself has no SQL opinion to
      // compare against, since `$1` is already bound to this tenant. A
      // disagreement means one twin has drifted, and the only safe reading of
      // that is "not provably inert".
      const jsSaysInert = classification.mutable === true
        || classification.keyClass === KEY_CLASSES.OUT_OF_TENANT_SCOPE;
      const inertnessDisagrees = (sqlVerdict === true) !== jsSaysInert;
      if (sqlVerdict === true && classification.mutable) {
        keys.push(key);
        continue;
      }
      withheld.push({
        id: row.id,
        tenant_id: row.tenant_id,
        key_id: row.key_id,
        provider: row.provider,
        status: row.status,
        key_class: inertnessDisagrees ? KEY_CLASSES.UNPROVEN : classification.keyClass,
        reason: inertnessDisagrees ? TWIN_DISAGREEMENT_REASON : classification.reason,
      });
    }
    return { keys, count: keys.length, protected: withheld, protected_count: withheld.length };
  });
}

/**
 * What to tell an operator whose rotation is blocked, per class of blocker.
 * Each line names the lifecycle that DOES own the blocking key, because
 * "refused" without an alternative just gets tried again.
 */
const ROTATION_REMEDY_BY_CLASS = {
  [KEY_CLASSES.LIVE_MATERIAL]: "That key belongs to the per-tenant envelope KEK lifecycle, which is not rotated from this console at all: preloadAllTenantKeks() re-registers only the 'active' versions at startup, so demoting one would strand the PHI encrypted under it, and its material is never replaced in place because the key id is stamped into ciphertext that already exists — crypto-shred then re-provision (cryptoShredTenant / provisionTenantKek in services/security/tenantKekProvider.js) is the sanctioned path",
  [KEY_CLASSES.SIGNING]: 'That key is a signing key other subsystems verify against, and both clinical-continuity pack publication (migration 600) and incident-packet issuance (migration 630) refuse to run unless it is active; it is revoked by publishing a new policy version that lists it in revoked_key_ids, never from this console',
  [KEY_CLASSES.OUT_OF_TENANT_SCOPE]: 'That key sits outside the tenant scope every lifecycle statement here carries, so no statement in this console can reach it; an untenanted row predates per-tenant registration and giving it a tenant is a database change',
  [KEY_CLASSES.UNPROVEN]: 'That key cannot be proven to be inert registry metadata, and this console demotes a row only when every inertness marker holds',
};

/**
 * Explain a rotation that has no predecessor to demote.
 *
 * The predecessor search below is both allowlisted and tenant-scoped, so it
 * comes up empty for two entirely different reasons: the tenant has no active
 * key at all, or the tenant's active keys are all rows this console may not
 * demote. Round 2 treated both as the first — an operator rotating a tenant
 * whose only active key is live KEK material got a brand-new metadata row, no
 * error, and two active keys, while the console told them protected keys are
 * refused. This probe separates the two cases and refuses the second, because
 * the operator's intent — replace the key that is active now — cannot be
 * satisfied here at all.
 *
 * It matches the same rows `listEncryptionKeys` shows (`OR tenant_id IS NULL`):
 * a row the operator can SEE as active is one they expect rotation to displace,
 * so a refusal for it must be explainable. It never widens past that, and it
 * reads `wrapped_key_material` for existence only.
 *
 * A row this says is mutable is one the fenced search should have picked and
 * did not, i.e. the twins have drifted. Both are built from the same markers,
 * so that branch should be unreachable — it is a fail-closed guard, not a
 * routine path, and it resolves the way the listing resolves drift: not
 * provably inert. Without it a `mutable` verdict would print a null reason and
 * read as a licence to insert.
 *
 * Returns quietly only when the tenant has no visible active key at all.
 */
async function assertNothingToRotateFrom(tid, newKeyId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, tenant_id, key_id, provider, status, algorithm, metadata,
            (wrapped_key_material IS NOT NULL) AS has_key_material
       FROM encryption_keys
      WHERE (tenant_id = $1::uuid OR tenant_id IS NULL) AND status = 'active'
      ORDER BY activated_at DESC`,
    tid,
  );
  if (rows.length === 0) return;

  const blocking = rows[0];
  const classification = classifyForTenant(blocking, tid);
  const drifted = classification.mutable === true;
  const keyClass = drifted ? KEY_CLASSES.UNPROVEN : classification.keyClass;
  const reason = drifted ? TWIN_DISAGREEMENT_REASON : classification.reason;
  throw AppError.conflict(
    `Rotation is refused for this tenant: its newest active encryption key '${blocking.key_id}' is not one this console may demote (${reason}), and the allowlisted predecessor search found no other candidate. Rotation means demoting the outgoing active key and linking the new one to it, so writing '${newKeyId}' here would leave '${blocking.key_id}' active and add an unlinked row beside it — a rotation in name only. ${ROTATION_REMEDY_BY_CLASS[keyClass] || ROTATION_REMEDY_BY_CLASS[KEY_CLASSES.UNPROVEN]}. If an independent registry metadata row is what you want, register '${newKeyId}' instead of rotating.`,
    ENCRYPTION_KEY_REFUSAL_CODES.ROTATION_PREDECESSOR_PROTECTED,
    {
      id: blocking.id,
      key_id: blocking.key_id,
      provider: blocking.provider,
      key_class: keyClass,
      reason,
      new_key_id: newKeyId,
      // Every active key visible to this console for this tenant — none of
      // which the fenced predecessor search was able to pick.
      withheld_active_count: rows.length,
    },
  );
}

/**
 * Begin rotation: demote the tenant's newest MUTABLE 'active' key to 'retiring'
 * and register a new 'active' key with `rotated_from` linking back to it.
 * Returns the new key row. Reads still work against the retiring key for as
 * long as records remain unrotated.
 *
 * "Mutable" is load-bearing and not the same as "newest active" — see the
 * predecessor search below.
 *
 * `rotated_from` on the returned row is NULL exactly when the tenant had no
 * active key at all. It is never NULL because a predecessor was withheld:
 * that case is refused, not quietly downgraded to a first-key insert.
 */
export async function rotateActiveKey({
  tenantId = null, newKeyId, provider = 'env', providerReference = null,
  algorithm = 'aes-256-gcm', metadata = null, createdBy = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const cleanNew = safeText(newKeyId, 64);
  if (!cleanNew) throw AppError.badRequest('newKeyId is required');
  assertRegistryKeyId(tid, cleanNew, 'new_key_id');
  const cleanProv = normalizeEnum(provider, KMS_PROVIDERS, 'provider') || 'env';
  const cleanAlgorithm = safeText(algorithm, 40);
  // Rotation inserts a row too, so it is bound by the same mint-time invariant:
  // a rotation must not be the way an unmanageable row gets into the table.
  const metadataText = prepareRegistryRowInsert(
    tid,
    { keyId: cleanNew, provider: cleanProv, algorithm: cleanAlgorithm, metadata },
    'Rotating into this key',
  );

  return runFenced(async () => {
    // The tenant's most recent active row is very often NOT a registry row — it
    // is the live KEK, or a continuity pack signing key that migration 600
    // requires to stay 'active'. Demoting one of those to 'retiring' is exactly
    // the move that strands PHI or halts pack publication, so the predecessor
    // search sees allowlisted rows only. It is tenant-scoped for the same
    // reason: an untenanted row can be the newest active one, and the demotion
    // below could never reach it — picking it would report a rotation that only
    // half happened. An empty result does NOT mean "no keys": whether it is
    // safe to insert without a predecessor is decided by the probe below.
    const active = await prisma.$queryRawUnsafe(
      `SELECT id, key_id FROM encryption_keys
       WHERE tenant_id = $1::uuid AND status = 'active'
         AND ${REGISTRY_MANAGED_SQL}
       ORDER BY activated_at DESC LIMIT 1`,
      tid,
    );
    const previousId = active[0]?.id || null;
    // No predecessor is honest only when there is genuinely nothing active to
    // rotate away from. Otherwise this refuses instead of inserting.
    if (!previousId) await assertNothingToRotateFrom(tid, cleanNew);

    const inserted = await prisma.$queryRawUnsafe(
      `INSERT INTO encryption_keys
         (tenant_id, key_id, provider, provider_reference, algorithm,
          status, rotated_from, metadata, created_by)
       VALUES ($1::uuid, $2, $3, $4, $5, 'active', $6, $7::jsonb, $8::uuid)
       RETURNING ${RETURNING}`,
      tid, cleanNew, cleanProv, safeText(providerReference, 512), cleanAlgorithm,
      previousId, metadataText,
      maybeUuid(createdBy, 'created_by'),
    );
    if (previousId) {
      // The tenant predicate is redundant with the search above — and stated
      // anyway, so the statement that demotes a key is scoped on its own face
      // rather than by an argument about where its id came from.
      await prisma.$queryRawUnsafe(
        `UPDATE encryption_keys
         SET status = 'retiring', retiring_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND tenant_id = $2::uuid AND ${REGISTRY_MANAGED_SQL}`,
        previousId, tid,
      );
    }
    return inserted[0];
  });
}

export async function retireEncryptionKey({ tenantId = null, id } = {}) {
  const tid = resolveTenantId({ tenantId });
  const keyRowId = normalizeId(id, 'encryption_keys id');
  return runFenced(async () => {
    const rows = await prisma.$queryRawUnsafe(
      `UPDATE encryption_keys
       SET status = 'retired', retired_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND tenant_id = $2::uuid AND status IN ('active', 'retiring')
         AND ${REGISTRY_MANAGED_SQL}
       RETURNING ${RETURNING}`,
      keyRowId, tid,
    );
    if (!rows[0]) {
      await assertRegistryManagedKey(tid, keyRowId, 'retiring');
      throw AppError.notFound('Encryption key not found or already retired');
    }
    return rows[0];
  });
}

export async function markKeyCompromised({ tenantId = null, id, reason = null } = {}) {
  const tid = resolveTenantId({ tenantId });
  const keyRowId = normalizeId(id, 'encryption_keys id');
  return runFenced(async () => {
    const rows = await prisma.$queryRawUnsafe(
      `UPDATE encryption_keys
       SET status = 'compromised', updated_at = NOW(),
           metadata = metadata || jsonb_build_object('compromised_reason', $1::text, 'compromised_at', NOW()::text)
       WHERE id = $2 AND tenant_id = $3::uuid AND status <> 'compromised'
         AND ${REGISTRY_MANAGED_SQL}
       RETURNING ${RETURNING}`,
      safeText(reason), keyRowId, tid,
    );
    if (!rows[0]) {
      await assertRegistryManagedKey(tid, keyRowId, 'compromising');
      throw AppError.notFound('Encryption key not found or already compromised');
    }
    return rows[0];
  });
}

export const __testing__ = {
  KMS_PROVIDERS,
  KEY_STATUSES,
  KEY_CLASSES,
  ENCRYPTION_KEY_REFUSAL_CODES,
  ENCRYPTION_KEY_ACTION_FENCE,
  TWIN_DISAGREEMENT_REASON,
  LIVE_KEY_MATERIAL_PROVIDER,
  SIGNING_KEY_PURPOSES,
  SIGNING_ALGORITHMS,
  PUBLIC_KEY_METADATA_FIELD,
  TENANT_KEK_KEY_ID_SQL,
  REGISTRY_MANAGED_SQL,
  classifyEncryptionKeyRow,
  classifyForTenant,
  isRegistryManagedRow,
  tenantScopeState,
  tenantKekKeyIdPattern,
};

export default {
  registerEncryptionKey,
  listEncryptionKeys,
  rotateActiveKey,
  retireEncryptionKey,
  markKeyCompromised,
};
