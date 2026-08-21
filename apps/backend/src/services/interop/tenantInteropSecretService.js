// src/services/interop/tenantInteropSecretService.js
//
// W3 (multi-tenancy program) WS6 — per-tenant inbound interop secrets.
//
// ABDM/HL7 inbound callbacks are HMAC-signed. The verifying secret is now
// PER-TENANT (tenant_interop_secrets, mig 338), keyed by a sender_identifier the
// caller presents BEFORE the signature is checked:
//   - ABDM: the `x-hip-id` request header.
//   - HL7:  the MSH-6 receiving facility.
// The route resolves the tenant from that identifier, then verifies the HMAC with
// THAT tenant's secret — so one hospital's secret can never authenticate a
// callback aimed at another. An unresolved sender is rejected (no global
// fallback); the default tenant's rows are seeded from the legacy env secrets, so
// single-tenant operation is unchanged.

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { encryptField, decryptField } from '../../utils/fieldEncryption.js';
import { AppError } from '../../utils/AppError.js';

export const VALID_INTEROP_SECRET_KINDS = [
  'abdm_callback',
  'hl7_inbound',
  'nhcx_api_token',
  'nhcx_jwe_private_key',
  'nhcx_callback_secret',
  // UHI webhook (migration 705): the stored "secret" is the counterparty's
  // ed25519 PUBLIC verification key (base64 raw), keyed by the tenant's HSP
  // subscriber id — resolveTenantBySender('uhi_callback', providerId) is the
  // fail-closed tenant resolution on the pre-RLS UHI mount.
  'uhi_callback',
];
const KINDS = new Set(VALID_INTEROP_SECRET_KINDS);

function normalizeKind(kind) {
  return String(kind || '').trim();
}

function normalizeSender(senderIdentifier) {
  return String(senderIdentifier || '').trim();
}

function maskedRow(row) {
  if (!row) return null;
  const hasSecret = row.has_secret === true || row.has_secret === 'true' || row.has_secret === 1;
  return {
    id: Number(row.id),
    tenant_id: row.tenant_id,
    kind: row.kind,
    sender_identifier: row.sender_identifier,
    status: row.status,
    has_secret: hasSecret,
    secret_masked: hasSecret ? '********' : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Resolve one active credential row and its secret as a single snapshot. The
 * sender identifier participates in the same query that selects the row, so a
 * caller can never resolve one credential identity and then decrypt another
 * row for the tenant.
 */
export async function resolveInteropCredentialSnapshot(
  kind,
  senderIdentifier,
  { failClosed = true } = {},
) {
  const cleanKind = normalizeKind(kind);
  const sid = normalizeSender(senderIdentifier);
  if (!KINDS.has(cleanKind) || !sid) return null;

  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id::text, tenant_id::text AS tenant_id, kind,
              sender_identifier, status, secret_ciphertext
         FROM tenant_interop_secrets
        WHERE kind = $1::text
          AND sender_identifier = $2::text
          AND status = 'active'`,
      cleanKind,
      sid,
    );
    if (rows.length === 0) return null;
    if (rows.length !== 1 || !rows[0].secret_ciphertext) {
      throw new Error('Active interop credential snapshot is ambiguous or incomplete');
    }
    const row = rows[0];
    return Object.freeze({
      id: row.id,
      tenant_id: row.tenant_id,
      kind: row.kind,
      sender_identifier: row.sender_identifier,
      status: row.status,
      secret: decryptField(row.secret_ciphertext),
    });
  } catch (err) {
    logger.warn('resolveInteropCredentialSnapshot: lookup failed', {
      kind: cleanKind,
      code: err?.code,
    });
    if (!failClosed) return null;
    throw AppError.internal(
      'Interop credential lookup is unavailable',
      'INTEROP_CREDENTIAL_LOOKUP_FAILED',
    );
  }
}

/**
 * Resolve the tenant for an inbound callback BEFORE the HMAC check, from a
 * DB-backed per-tenant row. Runs cross-tenant (the tenant is not known yet); the
 * (kind, sender_identifier) GLOBAL unique guarantees at most one match. Returns
 * the tenant_id (uuid string), or null when there is no per-tenant row — the
 * route then applies its env-backed default-tenant fallback (single-tenant) and
 * rejects if that also misses. Defensive: a DB/schema error yields null so the
 * route degrades to the env default rather than 500-ing an authentic callback.
 */
export async function resolveTenantBySender(kind, senderIdentifier) {
  const sid = String(senderIdentifier || '').trim();
  if (!KINDS.has(kind) || !sid) return null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT tenant_id::text AS tenant_id FROM tenant_interop_secrets
        WHERE kind = $1 AND sender_identifier = $2 AND status = 'active'
        LIMIT 1`,
      kind, sid,
    );
    return rows[0]?.tenant_id || null;
  } catch (err) {
    logger.warn('resolveTenantBySender: lookup failed, deferring to env default', { kind, message: err?.message });
    return null;
  }
}

/**
 * Fetch + decrypt a tenant's interop secret for a kind from the DB. The caller
 * passes the tenant resolved by resolveTenantBySender(); the explicit WHERE
 * scopes the read (RLS is permissive pre-auth). Returns the plaintext secret, or
 * null when there is no per-tenant row (the route falls back to the env secret
 * for the default tenant).
 */
export async function getInteropSecret(tenantId, kind, { senderIdentifier = null } = {}) {
  if (!tenantId || !KINDS.has(kind)) return null;
  const sid = normalizeSender(senderIdentifier) || null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT secret_ciphertext FROM tenant_interop_secrets
        WHERE tenant_id = $1::uuid AND kind = $2 AND status = 'active'
          AND ($3::text IS NULL OR sender_identifier = $3)
        ORDER BY updated_at DESC, id DESC
        LIMIT 1`,
      tenantId, kind, sid,
    );
    const ct = rows[0]?.secret_ciphertext;
    return ct ? decryptField(ct) : null;
  } catch (err) {
    logger.warn('getInteropSecret: lookup failed', { kind, message: err?.message });
    return null;
  }
}

/**
 * Super-admin console list surface. Never decrypts or returns secret material;
 * only reports masked metadata for the selected tenant.
 */
export async function listInteropSecretsForTenant(tenantId) {
  if (!tenantId) throw AppError.badRequest('tenantId is required', 'TENANT_ID_REQUIRED');
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id,
            tenant_id::text AS tenant_id,
            kind,
            sender_identifier,
            status,
            (secret_ciphertext IS NOT NULL) AS has_secret,
            created_at,
            updated_at
       FROM tenant_interop_secrets
      WHERE tenant_id = $1::uuid
      ORDER BY kind ASC, sender_identifier ASC`,
    tenantId,
  );
  return rows.map(maskedRow);
}

/**
 * Upsert a tenant's interop secret (stored encrypted). (kind, sender_identifier)
 * is globally unique so a sender maps to exactly one tenant — re-pointing a
 * sender to a different tenant updates the existing row.
 */
export async function upsertInteropSecret({ tenantId, kind, senderIdentifier, secret }) {
  if (!tenantId) throw AppError.badRequest('tenantId is required', 'TENANT_ID_REQUIRED');
  const cleanKind = normalizeKind(kind);
  if (!KINDS.has(cleanKind)) {
    throw AppError.badRequest(`Unknown interop secret kind: ${kind}`, 'INTEROP_SECRET_KIND_INVALID', {
      allowed: VALID_INTEROP_SECRET_KINDS,
    });
  }
  const sid = normalizeSender(senderIdentifier);
  if (!sid) throw AppError.badRequest('senderIdentifier is required', 'INTEROP_SECRET_SENDER_REQUIRED');
  if (!secret) throw AppError.badRequest('secret is required', 'INTEROP_SECRET_VALUE_REQUIRED');
  const ciphertext = encryptField(String(secret));
  await prisma.$executeRawUnsafe(
    `INSERT INTO tenant_interop_secrets
       (tenant_id, kind, sender_identifier, secret_ciphertext, status, created_at, updated_at)
     VALUES ($1::uuid, $2, $3, $4, 'active', NOW(), NOW())
     ON CONFLICT (kind, sender_identifier) DO UPDATE SET
       tenant_id = EXCLUDED.tenant_id,
       secret_ciphertext = EXCLUDED.secret_ciphertext,
       status = 'active',
       updated_at = NOW()`,
    tenantId, cleanKind, sid, ciphertext,
  );
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id,
            tenant_id::text AS tenant_id,
            kind,
            sender_identifier,
            status,
            (secret_ciphertext IS NOT NULL) AS has_secret,
            created_at,
            updated_at
       FROM tenant_interop_secrets
      WHERE tenant_id = $1::uuid
        AND kind = $2
        AND sender_identifier = $3
      LIMIT 1`,
    tenantId, cleanKind, sid,
  );
  return maskedRow(rows[0]);
}

export default {
  resolveInteropCredentialSnapshot,
  resolveTenantBySender,
  getInteropSecret,
  listInteropSecretsForTenant,
  upsertInteropSecret,
};
