/**
 * Webhook subscription CRUD + signing helper (Phase A3 PR1).
 *
 * Each subscription pairs an integration with an event_type and a
 * destination URL, optionally with a signing credential whose secret
 * the dispatcher (PR2) uses to HMAC-sign the payload before POSTing
 * upstream.
 *
 * The signing helper is exported here so PR2's dispatcher (and tests)
 * import a single source of truth for the signature shape.
 *
 * Decision-support only: subscriptions describe intent; the dispatcher
 * decides what actually goes out and writes every attempt to
 * webhook_deliveries with full audit detail.
 */

import crypto from 'crypto';

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { encryptField, isEncrypted } from '../../utils/fieldEncryption.js';
import { assertSafeOutboundUrl } from '../../utils/ssrfGuard.js';
import { DEFAULT_TENANT_ID } from '../tenant/tenantService.js';

export const SIGNING_ALGORITHMS = ['hmac-sha256', 'hmac-sha512', 'none'];

const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 500;
const ENDPOINT_MAX = 2_000;
const EVENT_TYPE_MAX = 120;
const SECRET_MAX = 8_000;

function resolveTenantId(options = {}) {
  return options.tenantId || DEFAULT_TENANT_ID;
}

function isMissingSchemaError(err) {
  return /does not exist|relation .* does not exist/i.test(String(err?.message || ''));
}

function isUniqueViolation(err) {
  return /duplicate key value/i.test(String(err?.message || ''));
}

function safeText(value, max) {
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

function normalizeLimit(value, fallback = DEFAULT_LIST_LIMIT, max = MAX_LIST_LIMIT) {
  return Math.min(Math.max(Number.parseInt(value, 10) || fallback, 1), max);
}

function normalizeAlgorithm(value) {
  const v = String(value || 'hmac-sha256').toLowerCase();
  if (!SIGNING_ALGORITHMS.includes(v)) {
    throw AppError.badRequest(`signing_algorithm must be one of: ${SIGNING_ALGORITHMS.join(', ')}`);
  }
  return v;
}

function normalizeJsonObject(value, label) {
  if (!value) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw AppError.badRequest(`${label} must be a JSON object`);
  }
  return value;
}

function isValidUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function encryptSecretValue(value) {
  const text = safeText(value, SECRET_MAX);
  if (!text) return null;
  return isEncrypted(text) ? text : encryptField(text);
}

function fingerprintSecret(value) {
  return crypto.createHash('sha256').update(`vh-webhook-secret:${value}`).digest('hex');
}

export function encryptWebhookSigningSecret(secret) {
  const text = safeText(secret, SECRET_MAX);
  if (!text) throw AppError.badRequest('signing secret is required');
  return {
    ciphertext: encryptSecretValue(text),
    ciphertext_hash: fingerprintSecret(text),
  };
}

async function assertIntegrationOwnedByTenant({ tenantId, integrationId }) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id FROM integrations WHERE id = $1 AND tenant_id = $2::uuid LIMIT 1`,
    integrationId,
    tenantId,
  );
  if (!rows[0]) throw AppError.notFound('Integration not found');
  return rows[0];
}

async function assertSigningCredentialOwned({ tenantId, integrationId, credentialId }) {
  const cid = normalizeId(credentialId, 'signing_credential_id');
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id FROM integration_credentials
     WHERE id = $1 AND tenant_id = $2::uuid AND integration_id = $3
     LIMIT 1`,
    cid,
    tenantId,
    integrationId,
  );
  if (!rows[0]) {
    throw AppError.forbidden(
      'signing_credential_id does not belong to this tenant integration',
      'WEBHOOK_SIGNING_CREDENTIAL_FORBIDDEN',
    );
  }
  return cid;
}

async function loadSubscriptionOwnership({ tenantId, id }) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, tenant_id, integration_id, signing_credential_id, signing_algorithm
     FROM webhook_subscriptions
     WHERE id = $1 AND tenant_id = $2::uuid
     LIMIT 1`,
    id,
    tenantId,
  );
  if (!rows[0]) throw AppError.notFound('Webhook subscription not found');
  return rows[0];
}

// ---------------------------------------------------------------------------
// Signing helper — exported so PR2 dispatcher + tests share one impl.
// ---------------------------------------------------------------------------

/**
 * Sign a webhook payload. Output shape:
 *   { signature, header_value, algorithm, timestamp }
 *
 * The header_value is what the dispatcher should set on the
 * `X-VHHealth-Signature` outgoing header — `t={ts},sig={hexHmac}` —
 * matching the Stripe / GitHub convention so consumers can verify
 * without VH-specific docs.
 */
export function signWebhookPayload({
  payload,
  secret,
  algorithm = 'hmac-sha256',
  timestamp = null,
} = {}) {
  const algo = normalizeAlgorithm(algorithm);
  if (algo === 'none') {
    return { signature: '', header_value: '', algorithm: 'none', timestamp: null };
  }
  if (!secret) {
    throw AppError.badRequest('signing secret is required for hmac signing');
  }
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload || {});
  // Treat null / undefined as "use now"; explicit 0 is a valid (albeit
  // ancient) timestamp callers may pass to test the staleness guard.
  const ts = (timestamp === null || timestamp === undefined)
    ? Math.floor(Date.now() / 1000)
    : Number(timestamp);
  const hmacAlgo = algo === 'hmac-sha512' ? 'sha512' : 'sha256';
  const signedPayload = `${ts}.${body}`;
  const hmac = crypto.createHmac(hmacAlgo, secret).update(signedPayload).digest('hex');
  return {
    signature: hmac,
    header_value: `t=${ts},sig=${hmac},algo=${algo}`,
    algorithm: algo,
    timestamp: ts,
  };
}

/**
 * Verify a webhook signature header. Used by webhook receivers (a
 * future receiver-side endpoint and tests) and exported so external
 * consumers of our signing convention can cross-check the
 * implementation.
 */
export function verifyWebhookSignature({
  payload,
  headerValue,
  secret,
  toleranceSeconds = 300,
  now = null,
} = {}) {
  if (!secret || !headerValue) return false;
  const parts = String(headerValue).split(',').reduce((acc, part) => {
    const [k, v] = part.split('=');
    if (k && v) acc[k.trim()] = v.trim();
    return acc;
  }, {});
  if (!parts.t || !parts.sig) return false;
  const ts = Number(parts.t);
  if (!Number.isFinite(ts)) return false;
  const reference = now ? Number(now) : Math.floor(Date.now() / 1000);
  if (Math.abs(reference - ts) > toleranceSeconds) return false;
  const algo = (parts.algo || 'hmac-sha256').toLowerCase();
  if (!SIGNING_ALGORITHMS.includes(algo) || algo === 'none') return false;
  const hmacAlgo = algo === 'hmac-sha512' ? 'sha512' : 'sha256';
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload || {});
  const expected = crypto.createHmac(hmacAlgo, secret).update(`${ts}.${body}`).digest('hex');
  // timing-safe equality
  if (expected.length !== parts.sig.length) return false;
  return crypto.timingSafeEqual(
    Buffer.from(expected, 'hex'),
    Buffer.from(parts.sig, 'hex'),
  );
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function createSubscription({
  tenantId = null,
  integrationId,
  eventType,
  endpointUrl,
  eventFilter = {},
  signingCredentialId = null,
  signingAlgorithm = 'hmac-sha256',
  isActive = true,
  maxConsecutiveFailures = 10,
  metadata = {},
  createdBy = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const intId = normalizeId(integrationId, 'integration_id');
  const cleanEvent = safeText(eventType, EVENT_TYPE_MAX);
  if (!cleanEvent) throw AppError.badRequest('event_type is required');
  const cleanUrl = safeText(endpointUrl, ENDPOINT_MAX);
  if (!cleanUrl) throw AppError.badRequest('endpoint_url is required');
  if (!isValidUrl(cleanUrl)) {
    throw AppError.badRequest('endpoint_url must be a valid http(s) URL');
  }
  await assertSafeOutboundUrl(cleanUrl, {
    label: 'endpoint_url',
    allowlistEnv: 'WEBHOOK_DELIVERY_HOST_ALLOWLIST',
    allowPrivateEnv: 'WEBHOOK_DELIVERY_ALLOW_PRIVATE_TARGETS',
  });
  const algo = normalizeAlgorithm(signingAlgorithm);
  if (algo !== 'none' && !signingCredentialId) {
    throw AppError.badRequest('signing_credential_id is required for hmac signing');
  }
  await assertIntegrationOwnedByTenant({ tenantId: tid, integrationId: intId });
  const credentialId = signingCredentialId
    ? await assertSigningCredentialOwned({ tenantId: tid, integrationId: intId, credentialId: signingCredentialId })
    : null;
  const cleanFilter = normalizeJsonObject(eventFilter, 'event_filter');
  const cleanMetadata = normalizeJsonObject(metadata, 'metadata');
  const cap = Math.max(1, Math.min(Number.parseInt(maxConsecutiveFailures, 10) || 10, 1_000));

  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO webhook_subscriptions
         (integration_id, tenant_id, event_type, event_filter, endpoint_url,
          signing_credential_id, signing_algorithm, is_active,
          max_consecutive_failures, metadata, created_by)
       VALUES ($1, $2::uuid, $3, $4::jsonb, $5, $6, $7, $8, $9, $10::jsonb, $11::uuid)
       RETURNING id, integration_id, tenant_id, event_type, event_filter,
                 endpoint_url, signing_credential_id, signing_algorithm,
                 is_active, last_delivered_at, last_failure_at,
                 consecutive_failures, max_consecutive_failures, metadata,
                 created_by, created_at, updated_at`,
      intId, tid, cleanEvent, JSON.stringify(cleanFilter), cleanUrl,
      credentialId,
      algo, Boolean(isActive), cap,
      JSON.stringify(cleanMetadata), createdBy,
    );
    return rows[0];
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw AppError.conflict(
        'A subscription for this (integration, event_type, endpoint_url) already exists',
      );
    }
    throw err;
  }
}

export async function listSubscriptions({
  tenantId = null,
  integrationId = null,
  eventType = null,
  isActive = null,
  limit = DEFAULT_LIST_LIMIT,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const filters = ['tenant_id = $1::uuid'];
  const params = [tid];
  if (integrationId) {
    params.push(normalizeId(integrationId, 'integration_id'));
    filters.push(`integration_id = $${params.length}`);
  }
  if (eventType) {
    params.push(safeText(eventType, EVENT_TYPE_MAX));
    filters.push(`event_type = $${params.length}`);
  }
  if (isActive != null) {
    params.push(Boolean(isActive));
    filters.push(`is_active = $${params.length}`);
  }
  const safeLimit = normalizeLimit(limit);
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, integration_id, tenant_id, event_type, event_filter,
              endpoint_url, signing_credential_id, signing_algorithm,
              is_active, last_delivered_at, last_failure_at,
              consecutive_failures, max_consecutive_failures, metadata,
              created_by, created_at, updated_at
       FROM webhook_subscriptions
       WHERE ${filters.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT $${params.length + 1}`,
      ...params, safeLimit,
    );
    return { subscriptions: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { subscriptions: [], count: 0 };
    throw err;
  }
}

export async function getSubscription({ tenantId = null, id } = {}) {
  const tid = resolveTenantId({ tenantId });
  const sid = normalizeId(id, 'subscription id');
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, integration_id, tenant_id, event_type, event_filter,
            endpoint_url, signing_credential_id, signing_algorithm,
            is_active, last_delivered_at, last_failure_at,
            consecutive_failures, max_consecutive_failures, metadata,
            created_by, created_at, updated_at
     FROM webhook_subscriptions
     WHERE id = $1 AND tenant_id = $2::uuid
     LIMIT 1`,
    sid, tid,
  );
  if (!rows[0]) throw AppError.notFound('Webhook subscription not found');
  return rows[0];
}

export async function updateSubscription({
  tenantId = null,
  id,
  endpointUrl = undefined,
  eventFilter = undefined,
  signingCredentialId = undefined,
  signingAlgorithm = undefined,
  isActive = undefined,
  maxConsecutiveFailures = undefined,
  metadata = undefined,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const sid = normalizeId(id, 'subscription id');
  const needsSigningOwnership = signingCredentialId !== undefined || signingAlgorithm !== undefined;
  const current = needsSigningOwnership
    ? await loadSubscriptionOwnership({ tenantId: tid, id: sid })
    : null;
  const updates = [];
  const params = [];
  if (endpointUrl !== undefined) {
    const v = safeText(endpointUrl, ENDPOINT_MAX);
    if (!v) throw AppError.badRequest('endpoint_url cannot be empty');
    if (!isValidUrl(v)) throw AppError.badRequest('endpoint_url must be a valid http(s) URL');
    await assertSafeOutboundUrl(v, {
      label: 'endpoint_url',
      allowlistEnv: 'WEBHOOK_DELIVERY_HOST_ALLOWLIST',
      allowPrivateEnv: 'WEBHOOK_DELIVERY_ALLOW_PRIVATE_TARGETS',
    });
    params.push(v);
    updates.push(`endpoint_url = $${params.length}`);
  }
  if (eventFilter !== undefined) {
    params.push(JSON.stringify(normalizeJsonObject(eventFilter, 'event_filter')));
    updates.push(`event_filter = $${params.length}::jsonb`);
  }
  let nextSigningCredentialId = current?.signing_credential_id ?? null;
  if (signingCredentialId !== undefined) {
    nextSigningCredentialId = signingCredentialId
      ? await assertSigningCredentialOwned({
        tenantId: tid,
        integrationId: current.integration_id,
        credentialId: signingCredentialId,
      })
      : null;
    params.push(nextSigningCredentialId);
    updates.push(`signing_credential_id = $${params.length}`);
  }
  let nextSigningAlgorithm = current?.signing_algorithm ?? null;
  if (signingAlgorithm !== undefined) {
    nextSigningAlgorithm = normalizeAlgorithm(signingAlgorithm);
    params.push(nextSigningAlgorithm);
    updates.push(`signing_algorithm = $${params.length}`);
  }
  if (needsSigningOwnership && nextSigningAlgorithm !== 'none' && !nextSigningCredentialId) {
    throw AppError.badRequest('signing_credential_id is required for hmac signing');
  }
  if (isActive !== undefined) {
    params.push(Boolean(isActive));
    updates.push(`is_active = $${params.length}`);
  }
  if (maxConsecutiveFailures !== undefined) {
    const cap = Math.max(1, Math.min(Number.parseInt(maxConsecutiveFailures, 10) || 10, 1_000));
    params.push(cap);
    updates.push(`max_consecutive_failures = $${params.length}`);
  }
  if (metadata !== undefined) {
    params.push(JSON.stringify(normalizeJsonObject(metadata, 'metadata')));
    updates.push(`metadata = $${params.length}::jsonb`);
  }
  if (!updates.length) {
    return getSubscription({ tenantId: tid, id: sid });
  }
  updates.push('updated_at = NOW()');
  params.push(sid);
  params.push(tid);
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE webhook_subscriptions
     SET ${updates.join(', ')}
     WHERE id = $${params.length - 1} AND tenant_id = $${params.length}::uuid
     RETURNING id, integration_id, tenant_id, event_type, event_filter,
               endpoint_url, signing_credential_id, signing_algorithm,
               is_active, consecutive_failures, max_consecutive_failures,
               metadata, created_at, updated_at`,
    ...params,
  );
  if (!rows[0]) throw AppError.notFound('Webhook subscription not found');
  return rows[0];
}

export async function deleteSubscription({ tenantId = null, id } = {}) {
  const tid = resolveTenantId({ tenantId });
  const sid = normalizeId(id, 'subscription id');
  const rows = await prisma.$queryRawUnsafe(
    `DELETE FROM webhook_subscriptions
     WHERE id = $1 AND tenant_id = $2::uuid
     RETURNING id, integration_id, event_type, endpoint_url`,
    sid, tid,
  );
  if (!rows[0]) throw AppError.notFound('Webhook subscription not found');
  return rows[0];
}

/**
 * Internal helper used by PR2's dispatcher when a delivery fails. Bumps
 * consecutive_failures and auto-pauses the subscription if the cap is
 * exceeded so a wedged endpoint stops eating retry slots.
 */
export async function recordSubscriptionFailure({ tx = null, tenantId, id }) {
  const runner = tx ? tx.$queryRawUnsafe.bind(tx) : prisma.$queryRawUnsafe.bind(prisma);
  const tid = resolveTenantId({ tenantId });
  const sid = Number.parseInt(id, 10);
  if (!Number.isFinite(sid) || sid <= 0) return null;
  try {
    const rows = await runner(
      `UPDATE webhook_subscriptions
       SET consecutive_failures = consecutive_failures + 1,
           last_failure_at = NOW(),
           is_active = CASE
             WHEN consecutive_failures + 1 >= max_consecutive_failures THEN false
             ELSE is_active
           END,
           updated_at = NOW()
       WHERE id = $1 AND tenant_id = $2::uuid
       RETURNING id, consecutive_failures, max_consecutive_failures, is_active`,
      sid, tid,
    );
    return rows[0] || null;
  } catch (err) {
    logger.warn('webhook subscription failure-counter update failed', { error: err.message });
    return null;
  }
}

/**
 * Internal helper used by PR2's dispatcher on success. Resets the
 * failure counter and stamps last_delivered_at.
 */
export async function recordSubscriptionSuccess({ tx = null, tenantId, id }) {
  const runner = tx ? tx.$queryRawUnsafe.bind(tx) : prisma.$queryRawUnsafe.bind(prisma);
  const tid = resolveTenantId({ tenantId });
  const sid = Number.parseInt(id, 10);
  if (!Number.isFinite(sid) || sid <= 0) return null;
  try {
    const rows = await runner(
      `UPDATE webhook_subscriptions
       SET consecutive_failures = 0,
           last_delivered_at = NOW(),
           updated_at = NOW()
       WHERE id = $1 AND tenant_id = $2::uuid
       RETURNING id, consecutive_failures, last_delivered_at`,
      sid, tid,
    );
    return rows[0] || null;
  } catch (err) {
    logger.warn('webhook subscription success-counter update failed', { error: err.message });
    return null;
  }
}

export const __testing__ = {
  SIGNING_ALGORITHMS,
  isValidUrl,
};

export default {
  createSubscription,
  deleteSubscription,
  getSubscription,
  listSubscriptions,
  recordSubscriptionFailure,
  recordSubscriptionSuccess,
  signWebhookPayload,
  updateSubscription,
  verifyWebhookSignature,
};
