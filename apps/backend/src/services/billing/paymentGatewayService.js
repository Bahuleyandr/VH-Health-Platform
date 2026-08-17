// src/services/billing/paymentGatewayService.js
//
// Provider-abstracted online payment gateway (UPI + cards) on top of the
// EXISTING billing money spine (migrations 693/694/695/697).
//
// Non-negotiables (see docs in the migrations + design notes):
//   * Money is booked EXCLUSIVELY through billingV2Service.collectPayment
//     inside ONE setTenantTx (the markPaymentLinkPaid shape), with
//     billing_payments.reference = provider_payment_id so migration 317's
//     (tenant_id, reference, mode) partial unique is the durable replay
//     backstop. The 694 paid-evidence CHECK makes it impossible to mark an
//     order paid without the booked billing_payments row in the same tx.
//   * The webhook intake path is a PRE-RLS public mount: every query here
//     carries an explicit tenant predicate and every INSERT/UPDATE writes
//     tenant_id explicitly. An unresolvable tenant is a rejected event,
//     never a default-tenant row.
//   * Payments are billing, not clinical: no clinical_timeline_events.
//     Audit rides the billing audit path (routes) + idempotent ledger posts.
//   * Feature is config-gated DEFAULT OFF: env kill switch
//     (PAYMENT_GATEWAY_ENABLED) AND tenants.settings.paymentGateway.enabled
//     AND an enabled provider config row must ALL hold.
//   * Provider secrets are encryptField() ciphertext, write-only.

import { randomBytes } from 'node:crypto';
import prisma, { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { encryptField, decryptField } from '../../utils/fieldEncryption.js';
import { toPaise } from '../../utils/money.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { getPaymentGatewaySettings } from '../tenant/tenantSettingsService.js';
import {
  collectPayment,
  markRefundPaid,
  deriveInvoicePaymentStateFromLedgerTx,
} from './billingV2Service.js';
import { postPaymentEntry } from './ledger/ledgerPostings.js';
import { resolveLedgerWiring } from './ledger/ledgerAuthoritativeMode.js';
import { resolveAdapter, GATEWAY_PROVIDERS } from './gatewayProviders/index.js';
import { sha256Hex } from './gatewayProviders/webhookSignature.js';

export const PAYMENT_GATEWAY_DISABLED = 'PAYMENT_GATEWAY_DISABLED';

const GATEWAY_ENVIRONMENTS = new Set(['sandbox', 'production']);
const GATEWAY_METHODS = new Set(['upi', 'card', 'netbanking', 'wallet']);
const DEFAULT_ORDER_EXPIRY_HOURS = 24;

// Provider "method" → billingV2 payment mode. VALID_PAYMENT_MODES carries no
// 'ONLINE', so an unrecognised electronic method follows the
// markPaymentLinkPaid modeMap precedent (other → UPI); every electronic mode
// debits BANK in the ledger regardless (ledgerPostings.paymentDebitAccount).
const METHOD_TO_MODE = {
  upi: 'UPI', card: 'CARD', netbanking: 'NETBANKING', wallet: 'WALLET',
};
export function paymentModeForMethod(method) {
  return METHOD_TO_MODE[String(method || '').trim().toLowerCase()] || 'UPI';
}

// 694 CHECK list for payment_gateway_orders.method.
function normalizeOrderMethod(method) {
  const value = String(method || '').trim().toLowerCase();
  return GATEWAY_METHODS.has(value) ? value : (value ? 'other' : null);
}

export function isGatewayEnvEnabled() {
  return process.env.PAYMENT_GATEWAY_ENABLED === 'true';
}

function generateWebhookToken() {
  return randomBytes(24).toString('base64url');
}

function generateReceipt() {
  // Razorpay caps receipt at 40 chars; 'pg-' + 24 hex = 27.
  return `pg-${randomBytes(12).toString('hex')}`;
}

function isUniqueViolation(err) {
  const code = err?.meta?.code
    || err?.meta?.driverAdapterError?.cause?.originalCode
    || err?.code;
  return code === '23505';
}

function isCheckViolation(err) {
  const code = err?.meta?.code
    || err?.meta?.driverAdapterError?.cause?.originalCode
    || err?.code;
  return code === '23514';
}

const CONFIG_VIEW_COLUMNS = `
  id, tenant_id, provider, environment, enabled, display_name, key_id,
  accepted_methods, metadata, created_at, updated_at,
  (key_secret_ciphertext IS NOT NULL) AS has_key_secret,
  (webhook_secret_ciphertext IS NOT NULL) AS has_webhook_secret`;

function toConfigView(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    provider: row.provider,
    environment: row.environment,
    enabled: row.enabled === true,
    display_name: row.display_name || null,
    key_id: row.key_id || null,
    accepted_methods: Array.isArray(row.accepted_methods) ? row.accepted_methods : [],
    has_key_secret: row.has_key_secret === true,
    has_webhook_secret: row.has_webhook_secret === true,
    // The per-tenant webhook path segment — an opaque random token, NOT a
    // secret credential (authenticity is the HMAC signature); it routes the
    // delivery to the right tenant fail-closed.
    webhook_path: row.metadata?.webhook_token
      ? `/webhooks/payments/${row.metadata.webhook_token}`
      : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// ───────────────────────────────────────────────────────────────────────
// Config / gating
// ───────────────────────────────────────────────────────────────────────

/** The tenant's single enabled provider config row, or null. Full row (with ciphertexts) — never return it to a client. */
async function getEnabledProviderConfigRow(tenantId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT * FROM payment_gateway_provider_configs
      WHERE tenant_id = $1::uuid AND enabled = true
      LIMIT 1`,
    requireTenantId(tenantId),
  );
  return rows[0] || null;
}

/**
 * Effective-on = env kill switch AND tenant settings gate AND enabled config
 * row. Never throws; returns a reason so reads can render honest markers.
 */
export async function resolveGatewayContext(tenantId) {
  if (!isGatewayEnvEnabled()) return { enabled: false, reason: 'env_disabled', config: null };
  let settings;
  try {
    settings = await getPaymentGatewaySettings(tenantId);
  } catch {
    return { enabled: false, reason: 'settings_unavailable', config: null };
  }
  if (!settings.enabled) return { enabled: false, reason: 'tenant_disabled', config: null };
  let config = null;
  try {
    config = await getEnabledProviderConfigRow(tenantId);
  } catch (err) {
    logger.error('payment gateway config lookup failed', { error: err?.message });
    return { enabled: false, reason: 'config_unavailable', config: null };
  }
  if (!config) return { enabled: false, reason: 'no_enabled_config', config: null };
  if (config.provider !== 'dry_run'
      && (!config.key_id || !config.key_secret_ciphertext || !config.webhook_secret_ciphertext)) {
    return { enabled: false, reason: 'credentials_incomplete', config: null };
  }
  return { enabled: true, reason: null, config };
}

/** Writes 403 with PAYMENT_GATEWAY_DISABLED when the feature is not effective. */
export async function requireGatewayContext(tenantId) {
  const context = await resolveGatewayContext(tenantId);
  if (!context.enabled) {
    throw AppError.forbidden(
      'Online payment gateway is not enabled for this tenant',
      PAYMENT_GATEWAY_DISABLED,
      { reason: context.reason },
    );
  }
  return context;
}

/** Admin read: config rows with write-only secrets reduced to booleans. */
export async function listGatewayConfigs(tenantId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT ${CONFIG_VIEW_COLUMNS}
       FROM payment_gateway_provider_configs
      WHERE tenant_id = $1::uuid
      ORDER BY enabled DESC, provider, environment`,
    requireTenantId(tenantId),
  );
  return {
    env_enabled: isGatewayEnvEnabled(),
    tenant_enabled: (await getPaymentGatewaySettings(tenantId)).enabled,
    configs: rows.map(toConfigView),
  };
}

/**
 * Admin upsert of the per-tenant provider config (one row per
 * tenant/provider/environment). Secrets are encrypted with encryptField and
 * only overwritten when a new plaintext is provided. A webhook routing token
 * is minted once per row and kept stable thereafter.
 */
export async function upsertGatewayConfig({
  tenantId, provider, environment = 'sandbox', enabled = false, display_name,
  key_id, key_secret, webhook_secret, accepted_methods, created_by,
}) {
  const tenant = requireTenantId(tenantId);
  const providerValue = String(provider || '').trim().toLowerCase();
  if (!GATEWAY_PROVIDERS.includes(providerValue)) {
    throw AppError.badRequest(
      `provider must be one of: ${GATEWAY_PROVIDERS.join(', ')}`,
      'PAYMENT_GATEWAY_UNKNOWN_PROVIDER',
    );
  }
  const environmentValue = String(environment || 'sandbox').trim().toLowerCase();
  if (!GATEWAY_ENVIRONMENTS.has(environmentValue)) {
    throw AppError.badRequest("environment must be 'sandbox' or 'production'");
  }
  let methods = null;
  if (accepted_methods !== undefined && accepted_methods !== null) {
    if (!Array.isArray(accepted_methods) || !accepted_methods.length) {
      throw AppError.badRequest('accepted_methods must be a non-empty array');
    }
    methods = accepted_methods.map((m) => String(m || '').trim().toLowerCase());
    const bad = methods.filter((m) => !GATEWAY_METHODS.has(m));
    if (bad.length) {
      throw AppError.badRequest(
        `accepted_methods entries must be one of: ${[...GATEWAY_METHODS].join(', ')}`,
      );
    }
  }

  const keySecretCipher = key_secret ? encryptField(String(key_secret), { tenantId: tenant }) : null;
  const webhookSecretCipher = webhook_secret ? encryptField(String(webhook_secret), { tenantId: tenant }) : null;
  const webhookToken = generateWebhookToken();

  let rows;
  try {
    rows = await prisma.$queryRawUnsafe(
      `INSERT INTO payment_gateway_provider_configs
         (tenant_id, provider, environment, enabled, display_name, key_id,
          key_secret_ciphertext, webhook_secret_ciphertext, accepted_methods,
          metadata, created_by)
       VALUES ($1::uuid, $2, $3, $4::boolean, $5, $6, $7, $8,
               COALESCE($9::text[], ARRAY['upi','card']::text[]),
               jsonb_build_object('webhook_token', $10::text), $11::uuid)
       ON CONFLICT (tenant_id, provider, environment) DO UPDATE SET
         enabled = EXCLUDED.enabled,
         display_name = COALESCE(EXCLUDED.display_name, payment_gateway_provider_configs.display_name),
         key_id = COALESCE(EXCLUDED.key_id, payment_gateway_provider_configs.key_id),
         key_secret_ciphertext = COALESCE(EXCLUDED.key_secret_ciphertext, payment_gateway_provider_configs.key_secret_ciphertext),
         webhook_secret_ciphertext = COALESCE(EXCLUDED.webhook_secret_ciphertext, payment_gateway_provider_configs.webhook_secret_ciphertext),
         accepted_methods = COALESCE($9::text[], payment_gateway_provider_configs.accepted_methods),
         -- Keep the existing webhook token stable across updates: providers
         -- are configured with the URL once; re-minting would break delivery.
         metadata = CASE
           WHEN payment_gateway_provider_configs.metadata ? 'webhook_token'
             THEN payment_gateway_provider_configs.metadata
           ELSE payment_gateway_provider_configs.metadata
                || jsonb_build_object('webhook_token', $10::text)
         END,
         updated_at = NOW()
       RETURNING ${CONFIG_VIEW_COLUMNS}`,
      tenant, providerValue, environmentValue, enabled === true,
      display_name ? String(display_name).slice(0, 120) : null,
      key_id ? String(key_id).slice(0, 120) : null,
      keySecretCipher, webhookSecretCipher,
      methods, webhookToken,
      created_by ? String(created_by) : null,
    );
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw AppError.conflict(
        'Another gateway config is already enabled for this tenant — disable it first (one live config per tenant).',
        'PAYMENT_GATEWAY_CONFIG_CONFLICT',
      );
    }
    if (isCheckViolation(err)) {
      throw AppError.badRequest(
        'An enabled non-dry_run config requires key_id, key_secret, and webhook_secret.',
        'PAYMENT_GATEWAY_CREDENTIALS_REQUIRED',
      );
    }
    throw err;
  }
  return toConfigView(rows[0]);
}

// ───────────────────────────────────────────────────────────────────────
// Orders
// ───────────────────────────────────────────────────────────────────────

function decryptedKeySecret(config) {
  return config.key_secret_ciphertext ? decryptField(config.key_secret_ciphertext) : null;
}

async function resolveOrderSubject({ tenantId, invoice_id, payment_link_token }) {
  if (payment_link_token) {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, invoice_id, patient_uid, amount, status, expires_at
         FROM billing_payment_links
        WHERE link_token = $1 AND tenant_id = $2::uuid
        LIMIT 1`,
      String(payment_link_token), requireTenantId(tenantId),
    );
    if (!rows.length) throw AppError.notFound('Payment link not found');
    const link = rows[0];
    const expired = link.expires_at && new Date(link.expires_at).getTime() <= Date.now();
    if (!['created', 'sent'].includes(String(link.status)) || expired) {
      throw AppError.badRequest(
        `Payment link is not payable (${expired ? 'expired' : link.status})`,
        'PAYMENT_GATEWAY_LINK_NOT_PAYABLE',
      );
    }
    return {
      invoiceId: link.invoice_id != null ? Number(link.invoice_id) : null,
      paymentLinkId: Number(link.id),
      patientUid: String(link.patient_uid),
      defaultAmount: Number(link.amount),
      maxAmount: Number(link.amount),
      linkExpiresAt: link.expires_at ? new Date(link.expires_at) : null,
    };
  }

  if (invoice_id) {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, patient_uid, status, amount_due
         FROM billing_invoices
        WHERE id = $1::int AND tenant_id = $2::uuid
        LIMIT 1`,
      Number(invoice_id), requireTenantId(tenantId),
    );
    if (!rows.length) throw AppError.notFound('Invoice not found');
    const invoice = rows[0];
    if (!['ISSUED', 'PARTIAL'].includes(String(invoice.status).toUpperCase())) {
      throw AppError.badRequest(
        `Cannot collect against ${invoice.status} invoice`,
        'PAYMENT_GATEWAY_INVOICE_NOT_PAYABLE',
      );
    }
    const due = Number(invoice.amount_due || 0);
    if (due <= 0) {
      throw AppError.badRequest('Invoice has no outstanding due', 'PAYMENT_GATEWAY_INVOICE_NOT_PAYABLE');
    }
    return {
      invoiceId: Number(invoice.id),
      paymentLinkId: null,
      patientUid: String(invoice.patient_uid),
      defaultAmount: due,
      maxAmount: due,
      linkExpiresAt: null,
    };
  }

  throw AppError.badRequest('One of invoice_id or payment_link_token is required');
}

/**
 * Create a provider order (Razorpay order / deterministic dry_run order) tied
 * to an invoice or a payment link. Client-facing and idempotency-guarded at
 * the route (scope payment_gateway_order, retainOnServerError).
 */
export async function createGatewayOrder({
  tenantId, invoice_id, payment_link_token, amount, created_by, actor = {},
}) {
  const tenant = requireTenantId(tenantId);
  const context = await requireGatewayContext(tenant);
  const { config } = context;

  const subject = await resolveOrderSubject({ tenantId: tenant, invoice_id, payment_link_token });

  // A PATIENT actor may only create orders for their own invoices/links.
  if (String(actor.role || '').toUpperCase() === 'PATIENT'
      && String(actor.uid || '').toLowerCase() !== String(subject.patientUid).toLowerCase()) {
    throw AppError.forbidden('Patients can only pay their own bills');
  }

  const orderAmount = amount != null ? Number(amount) : subject.defaultAmount;
  if (!Number.isFinite(orderAmount) || orderAmount <= 0) {
    throw AppError.badRequest('amount must be > 0');
  }
  if (orderAmount > subject.maxAmount + 0.01) {
    throw AppError.badRequest(
      `Amount ${orderAmount} exceeds the payable amount ${subject.maxAmount}`,
      'PAYMENT_GATEWAY_AMOUNT_EXCEEDS_DUE',
    );
  }

  const adapter = resolveAdapter(config.provider);
  const receipt = generateReceipt();
  const providerOrder = await adapter.createOrder({
    keyId: config.key_id,
    keySecret: decryptedKeySecret(config),
    amountPaise: toPaise(orderAmount),
    currency: 'INR',
    receipt,
    notes: {
      tenant_id: tenant,
      ...(subject.invoiceId ? { invoice_id: String(subject.invoiceId) } : {}),
      ...(subject.paymentLinkId ? { payment_link_id: String(subject.paymentLinkId) } : {}),
    },
  });

  const defaultExpiry = new Date(Date.now() + DEFAULT_ORDER_EXPIRY_HOURS * 3600 * 1000);
  const expiresAt = subject.linkExpiresAt && subject.linkExpiresAt < defaultExpiry
    ? subject.linkExpiresAt
    : defaultExpiry;

  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO payment_gateway_orders
       (tenant_id, provider, environment, provider_config_id, patient_uid,
        invoice_id, payment_link_id, amount, currency, receipt,
        provider_order_id, status, expires_at, created_by)
     VALUES ($1::uuid, $2, $3, $4::int, $5::uuid, $6, $7, $8::numeric, $9,
             $10, $11, 'created', $12::timestamptz, $13::uuid)
     RETURNING *`,
    tenant, config.provider, config.environment, Number(config.id),
    subject.patientUid,
    subject.invoiceId, subject.paymentLinkId,
    orderAmount, 'INR', receipt,
    providerOrder.providerOrderId, expiresAt.toISOString(),
    created_by ? String(created_by) : null,
  );
  const order = rows[0];
  return {
    orderId: Number(order.id),
    providerOrderId: order.provider_order_id,
    provider: order.provider,
    environment: order.environment,
    keyId: config.key_id || null,
    amount: Number(order.amount),
    currency: order.currency,
    acceptedMethods: Array.isArray(config.accepted_methods) ? config.accepted_methods : [],
    status: order.status,
    invoiceId: order.invoice_id != null ? Number(order.invoice_id) : null,
    paymentLinkId: order.payment_link_id != null ? Number(order.payment_link_id) : null,
    expiresAt: order.expires_at ? new Date(order.expires_at).toISOString() : null,
  };
}

const ORDER_VIEW_COLUMNS = `
  id, provider, environment, patient_uid, invoice_id, payment_link_id, amount,
  currency, receipt, provider_order_id, provider_payment_id, method, status,
  billing_payment_id, captured_at, reconciled_at, reconciliation_note,
  failure_code, failure_reason, expires_at, created_at, updated_at`;

export async function getGatewayOrder({ tenantId, id, actor = {} }) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT ${ORDER_VIEW_COLUMNS}
       FROM payment_gateway_orders
      WHERE id = $1::int AND tenant_id = $2::uuid
      LIMIT 1`,
    Number(id), requireTenantId(tenantId),
  );
  if (!rows.length) throw AppError.notFound('Payment gateway order not found');
  const order = rows[0];
  if (String(actor.role || '').toUpperCase() === 'PATIENT'
      && String(actor.uid || '').toLowerCase() !== String(order.patient_uid).toLowerCase()) {
    // Same response as unknown id — no cross-patient existence oracle.
    throw AppError.notFound('Payment gateway order not found');
  }
  return { ...order, id: Number(order.id), amount: Number(order.amount) };
}

export async function cancelGatewayOrder({ tenantId, id, actor = {} }) {
  await getGatewayOrder({ tenantId, id, actor }); // ownership + existence
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE payment_gateway_orders
        SET status = 'cancelled', updated_at = NOW()
      WHERE id = $1::int AND tenant_id = $2::uuid
        AND status IN ('created', 'attempted')
      RETURNING ${ORDER_VIEW_COLUMNS}`,
    Number(id), requireTenantId(tenantId),
  );
  if (!rows.length) {
    throw AppError.badRequest('Order is not cancellable in its current status', 'PAYMENT_GATEWAY_ORDER_NOT_CANCELLABLE');
  }
  return { ...rows[0], id: Number(rows[0].id), amount: Number(rows[0].amount) };
}

/**
 * Admin list of provider-captured-but-unbookable orders (the manual work
 * queue handleCaptureEvent parks into). Unresolved rows only by default;
 * include_resolved=true also returns rows an operator already stamped.
 */
export async function listReconciliationGatewayOrders({
  tenantId, include_resolved = false, limit = 50, offset = 0,
} = {}) {
  const tenant = requireTenantId(tenantId);
  const safeLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 50, 200));
  const safeOffset = Math.max(0, Number.parseInt(offset, 10) || 0);
  const rows = await prisma.$queryRawUnsafe(
    `SELECT ${ORDER_VIEW_COLUMNS}
       FROM payment_gateway_orders
      WHERE tenant_id = $1::uuid AND status = 'requires_reconciliation'
        AND ($2::boolean OR reconciled_at IS NULL)
      ORDER BY captured_at ASC NULLS LAST, id ASC
      LIMIT $3::int OFFSET $4::int`,
    tenant, include_resolved === true, safeLimit, safeOffset,
  );
  return {
    orders: rows.map((row) => ({ ...row, id: Number(row.id), amount: Number(row.amount) })),
    limit: safeLimit,
    offset: safeOffset,
  };
}

/**
 * Operator resolution of a requires_reconciliation order: stamps WHO decided
 * WHAT was done about the captured money (booked manually via collectPayment,
 * refunded at the provider dashboard, ...) as reconciled_at +
 * reconciliation_note. The status deliberately stays
 * 'requires_reconciliation' — 694's status vocabulary has no 'reconciled'
 * value, and the evidence CHECK guarantees the capture facts survive; the
 * list surface hides stamped rows by default.
 */
export async function resolveGatewayOrderReconciliation({ tenantId, id, note, resolved_by }) {
  const tenant = requireTenantId(tenantId);
  const trimmedNote = String(note || '').trim();
  if (trimmedNote.length < 10 || trimmedNote.length > 500) {
    throw AppError.badRequest(
      'A reconciliation note of 10-500 chars describing the manual resolution is required',
      'PAYMENT_GATEWAY_RECONCILIATION_NOTE_REQUIRED',
    );
  }
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE payment_gateway_orders
        SET reconciled_at = NOW(),
            reconciliation_note = $1,
            updated_at = NOW()
      WHERE id = $2::int AND tenant_id = $3::uuid
        AND status = 'requires_reconciliation'
        AND reconciled_at IS NULL
      RETURNING ${ORDER_VIEW_COLUMNS}`,
    trimmedNote.slice(0, 500), Number(id), tenant,
  );
  if (!rows.length) {
    const existing = await prisma.$queryRawUnsafe(
      `SELECT id, status, reconciled_at FROM payment_gateway_orders
        WHERE id = $1::int AND tenant_id = $2::uuid
        LIMIT 1`,
      Number(id), tenant,
    );
    if (!existing.length) throw AppError.notFound('Payment gateway order not found');
    throw AppError.conflict(
      existing[0].reconciled_at
        ? 'This order was already reconciled'
        : 'Order is not awaiting reconciliation',
      'PAYMENT_GATEWAY_ORDER_NOT_RECONCILABLE',
    );
  }
  logger.info('payment gateway order manually reconciled', {
    gateway_order_id: Number(rows[0].id),
    resolved_by: resolved_by ? String(resolved_by) : null,
  });
  return { ...rows[0], id: Number(rows[0].id), amount: Number(rows[0].amount) };
}

/** Cron sweep: expire created/attempted orders past expires_at. Idempotent. */
export async function expireStaleGatewayOrders() {
  const expired = await prisma.$executeRawUnsafe(
    `UPDATE payment_gateway_orders
        SET status = 'expired', updated_at = NOW()
      WHERE status IN ('created', 'attempted')
        AND expires_at IS NOT NULL AND expires_at < NOW()`,
  );
  return { expired };
}

// ───────────────────────────────────────────────────────────────────────
// Webhook intake (pre-RLS public mount — explicit tenant everywhere)
// ───────────────────────────────────────────────────────────────────────

const WEBHOOK_TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;

/**
 * Fail-closed tenant resolution for the public webhook mount: the URL's
 * opaque token selects exactly one ENABLED config row (and thereby the
 * tenant + webhook secret). Unknown token → null → the route answers 404
 * and NOTHING is written — never a default-tenant row.
 */
export async function resolveWebhookConfigByToken(webhookToken) {
  if (typeof webhookToken !== 'string' || !WEBHOOK_TOKEN_RE.test(webhookToken)) return null;
  // Cross-tenant by design (mirrors /pay's token-only lookup): the token is
  // the routing key and the tenant is derived FROM the row.
  const rows = await prisma.$queryRawUnsafe(
    `SELECT * FROM payment_gateway_provider_configs
      WHERE metadata->>'webhook_token' = $1
        AND enabled = true
      LIMIT 1`,
    String(webhookToken),
  );
  return rows[0] || null;
}

export function decryptedWebhookSecret(config) {
  return config?.webhook_secret_ciphertext ? decryptField(config.webhook_secret_ciphertext) : null;
}

/**
 * Durable intake: INSERT the event BEFORE processing. A unique violation on
 * (tenant_id, provider, provider_event_id) means the provider re-delivered —
 * return the existing row so the route can 200-ack without reprocessing
 * (or resume a row a crash left 'pending').
 */
export async function recordWebhookEvent({
  tenantId, provider, environment, providerEventId, eventType, payload, rawBody,
}) {
  const tenant = requireTenantId(tenantId);
  const entities = payload?.payload || {};
  const paymentEntity = entities.payment?.entity || {};
  const refundEntity = entities.refund?.entity || {};
  const orderEntity = entities.order?.entity || {};
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO payment_gateway_webhook_events
         (tenant_id, provider, environment, provider_event_id, event_type,
          signature_verified, payload, raw_body_sha256,
          provider_order_id, provider_payment_id, provider_refund_id)
       VALUES ($1::uuid, $2, $3, $4, $5, true, $6::jsonb, $7, $8, $9, $10)
       RETURNING *`,
      tenant, provider, environment,
      String(providerEventId), String(eventType || 'unknown'),
      JSON.stringify(payload || {}), sha256Hex(rawBody),
      paymentEntity.order_id || orderEntity.id || null,
      paymentEntity.id || refundEntity.payment_id || null,
      refundEntity.id || null,
    );
    return { duplicate: false, event: rows[0] };
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const rows = await prisma.$queryRawUnsafe(
      `SELECT * FROM payment_gateway_webhook_events
        WHERE tenant_id = $1::uuid AND provider = $2 AND provider_event_id = $3
        LIMIT 1`,
      tenant, provider, String(providerEventId),
    );
    return { duplicate: true, event: rows[0] || null };
  }
}

async function markWebhookEvent({ tenantId, eventId, status, failureReason = null, gatewayOrderId = null, note = null }) {
  await prisma.$executeRawUnsafe(
    `UPDATE payment_gateway_webhook_events
        SET status = $1, processed_at = NOW(),
            failure_reason = $2,
            gateway_order_id = COALESCE($3::int, gateway_order_id),
            metadata = CASE WHEN $4::text IS NULL THEN metadata
                            ELSE metadata || jsonb_build_object('note', $4::text) END
      WHERE id = $5::bigint AND tenant_id = $6::uuid`,
    String(status), failureReason ? String(failureReason).slice(0, 500) : null,
    gatewayOrderId != null ? Number(gatewayOrderId) : null,
    note ? String(note).slice(0, 500) : null,
    Number(eventId), requireTenantId(tenantId),
  );
}

// ───────────────────────────────────────────────────────────────────────
// Capture — the money-booking transaction (markPaymentLinkPaid shape)
// ───────────────────────────────────────────────────────────────────────

async function setOrderRequiresReconciliation({ tenantId, orderId, providerPaymentId, reason }) {
  await prisma.$executeRawUnsafe(
    `UPDATE payment_gateway_orders
        SET status = 'requires_reconciliation',
            provider_payment_id = COALESCE($1, provider_payment_id),
            captured_at = COALESCE(captured_at, NOW()),
            failure_reason = $2,
            updated_at = NOW()
      WHERE id = $3::int AND tenant_id = $4::uuid
        AND status <> 'paid'`,
    providerPaymentId || null, String(reason || '').slice(0, 500),
    Number(orderId), requireTenantId(tenantId),
  );
}

/**
 * Book a provider capture into the billing spine. ONE setTenantTx:
 * lock order → replay check → collectPayment({tx}) with reference =
 * provider_payment_id → flip order to paid (+ link row when link-tied) →
 * ledger per resolveLedgerWiring. Business failures (voided invoice,
 * overpayment...) park the order in requires_reconciliation — never a
 * silent 'paid', never a swallowed capture.
 */
export async function handleCaptureEvent({ tenantId, config, payload }) {
  const tenant = requireTenantId(tenantId);
  const entities = payload?.payload || {};
  const paymentEntity = entities.payment?.entity || {};
  const orderEntity = entities.order?.entity || {};
  const providerOrderId = paymentEntity.order_id || orderEntity.id || null;
  const providerPaymentId = paymentEntity.id || null;
  if (!providerOrderId || !providerPaymentId) {
    return { outcome: 'ignored', reason: 'missing payment/order entity identifiers' };
  }
  const providerAmountPaise = Number.isFinite(Number(paymentEntity.amount))
    ? Number(paymentEntity.amount)
    : null;
  const method = normalizeOrderMethod(paymentEntity.method);
  const mode = paymentModeForMethod(paymentEntity.method);

  const wiring = await resolveLedgerWiring(tenant);
  let result;
  try {
    result = await setTenantTx(tenant, async (tx) => {
      const orderRows = await tx.$queryRawUnsafe(
        `SELECT * FROM payment_gateway_orders
          WHERE tenant_id = $1::uuid AND provider = $2 AND provider_order_id = $3
          FOR UPDATE`,
        tenant, config.provider, String(providerOrderId),
      );
      if (!orderRows.length) {
        throw AppError.notFound(
          'No gateway order matches this capture event',
          'PAYMENT_GATEWAY_ORDER_NOT_FOUND',
        );
      }
      const order = orderRows[0];
      if (order.status === 'paid') {
        // Replay (or a second event for the already-booked capture).
        return {
          outcome: 'replay',
          orderId: Number(order.id),
          billingPaymentId: order.billing_payment_id != null ? Number(order.billing_payment_id) : null,
          payment: null,
        };
      }
      if (providerAmountPaise !== null && providerAmountPaise !== toPaise(order.amount)) {
        throw AppError.badRequest(
          `Captured amount ${providerAmountPaise} paise does not match order amount ${toPaise(order.amount)} paise`,
          'PAYMENT_GATEWAY_AMOUNT_MISMATCH',
        );
      }

      const payment = await collectPayment({
        tenantId: tenant,
        invoice_id: order.invoice_id != null ? Number(order.invoice_id) : null,
        patient_uid: order.patient_uid,
        amount: Number(order.amount),
        mode,
        // billing_payments.reference = provider_payment_id — migration 317's
        // (tenant_id, reference, mode) unique is the durable replay backstop.
        reference: String(providerPaymentId),
        notes: `Gateway ${config.provider} order ${order.receipt || order.provider_order_id}`,
      }, { tx });

      await tx.$executeRawUnsafe(
        `UPDATE payment_gateway_orders
            SET status = 'paid',
                provider_payment_id = $1,
                billing_payment_id = $2::int,
                captured_at = NOW(),
                method = $3,
                updated_at = NOW()
          WHERE id = $4::int AND tenant_id = $5::uuid`,
        String(providerPaymentId), Number(payment.id), method,
        Number(order.id), tenant,
      );

      if (order.payment_link_id != null) {
        // Same lock discipline as markPaymentLinkPaid — flip the link row in
        // the SAME tx so the cashier surface agrees with the money table.
        const linkRows = await tx.$queryRawUnsafe(
          `SELECT id, status FROM billing_payment_links
            WHERE id = $1::int AND tenant_id = $2::uuid
            FOR UPDATE`,
          Number(order.payment_link_id), tenant,
        );
        if (linkRows.length && linkRows[0].status !== 'paid') {
          await tx.$executeRawUnsafe(
            `UPDATE billing_payment_links
                SET status = 'paid', paid_at = NOW(),
                    paid_via = $1, paid_reference = $2,
                    linked_payment_id = $3::int, updated_at = NOW()
              WHERE id = $4::int AND tenant_id = $5::uuid`,
            method || 'other', String(providerPaymentId),
            Number(payment.id), Number(order.payment_link_id), tenant,
          );
        }
      }

      // collectPayment({tx}) skips its own ledger post (caller-owned tx) —
      // post here per the tenant's wiring, exactly like markPaymentLinkPaid.
      if (wiring.sameTx) {
        await postPaymentEntry({ payment, tenantId: tenant, tx });
        if (order.invoice_id != null) {
          await deriveInvoicePaymentStateFromLedgerTx(tx, Number(order.invoice_id));
        }
      }
      return {
        outcome: 'captured',
        orderId: Number(order.id),
        billingPaymentId: Number(payment.id),
        payment,
      };
    });
  } catch (err) {
    if (err instanceof AppError && err.code === 'DUPLICATE_PAYMENT_REFERENCE') {
      // 317 backstop fired: the money row already exists for this provider
      // payment id + mode. Collapse to replay semantics.
      logger.warn('payment gateway capture collapsed onto existing payment row (317 backstop)', {
        provider_order_id: String(providerOrderId),
      });
      return { outcome: 'replay', orderId: null, billingPaymentId: null, payment: null };
    }
    if (err instanceof AppError && err.statusCode >= 400 && err.statusCode < 500
        && err.code !== 'PAYMENT_GATEWAY_ORDER_NOT_FOUND') {
      // The provider captured money we could not book (voided invoice,
      // amount drift...). Park for manual reconciliation + alert — the
      // capture is real and must not be dropped.
      const orderRows = await prisma.$queryRawUnsafe(
        `SELECT id FROM payment_gateway_orders
          WHERE tenant_id = $1::uuid AND provider = $2 AND provider_order_id = $3
          LIMIT 1`,
        tenant, config.provider, String(providerOrderId),
      );
      if (orderRows.length) {
        await setOrderRequiresReconciliation({
          tenantId: tenant,
          orderId: orderRows[0].id,
          providerPaymentId,
          reason: `${err.code || 'BOOKING_FAILED'}: ${err.message}`,
        });
        logger.error('payment gateway capture requires manual reconciliation', {
          gateway_order_id: Number(orderRows[0].id),
          code: err.code,
          error: err.message,
        });
        return { outcome: 'requires_reconciliation', orderId: Number(orderRows[0].id), reason: err.code || err.message };
      }
    }
    throw err;
  }

  if (result.outcome === 'captured' && wiring.postCommit) {
    try {
      await postPaymentEntry({ payment: result.payment, tenantId: tenant });
    } catch (ledgerErr) {
      logger.error('Ledger PAYMENT post (gateway capture) failed (non-blocking)', {
        payment_id: result.billingPaymentId, error: ledgerErr.message,
      });
    }
  }
  return result;
}

async function handlePaymentFailedEvent({ tenantId, config, payload }) {
  const tenant = requireTenantId(tenantId);
  const entity = payload?.payload?.payment?.entity || {};
  if (!entity.order_id) return { outcome: 'ignored', reason: 'missing order id' };
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE payment_gateway_orders
        SET status = 'failed',
            failure_code = $1, failure_reason = $2, updated_at = NOW()
      WHERE tenant_id = $3::uuid AND provider = $4 AND provider_order_id = $5
        AND status IN ('created', 'attempted')
      RETURNING id`,
    entity.error_code ? String(entity.error_code).slice(0, 80) : null,
    entity.error_description ? String(entity.error_description).slice(0, 500) : null,
    tenant, config.provider, String(entity.order_id),
  );
  return rows.length
    ? { outcome: 'failed_recorded', orderId: Number(rows[0].id) }
    : { outcome: 'ignored', reason: 'no order in a failable status' };
}

async function handlePaymentAuthorizedEvent({ tenantId, config, payload }) {
  const tenant = requireTenantId(tenantId);
  const entity = payload?.payload?.payment?.entity || {};
  if (!entity.order_id) return { outcome: 'ignored', reason: 'missing order id' };
  await prisma.$executeRawUnsafe(
    `UPDATE payment_gateway_orders
        SET status = 'attempted', method = COALESCE($1, method), updated_at = NOW()
      WHERE tenant_id = $2::uuid AND provider = $3 AND provider_order_id = $4
        AND status = 'created'`,
    normalizeOrderMethod(entity.method),
    tenant, config.provider, String(entity.order_id),
  );
  return { outcome: 'attempt_recorded' };
}

// ───────────────────────────────────────────────────────────────────────
// Refund execution leg (authority stays in billing_refunds)
// ───────────────────────────────────────────────────────────────────────

function toGatewayRefundResult(row, replay) {
  const { provider_idempotency_key: _providerIdempotencyKey, ...safeRow } = row;
  return {
    ...safeRow,
    id: Number(row.id),
    amount: Number(row.amount),
    replay: replay === true,
  };
}

const PROVIDER_REFUND_STATUSES = new Set(['pending', 'processed', 'failed']);

function refundEvidenceMismatches(intent, evidence, { requireProcessed = false } = {}) {
  const mismatches = [];
  const providerRefundId = String(evidence?.providerRefundId || '').trim();
  if (!providerRefundId || providerRefundId.length > 120
      || (intent.provider_refund_id && String(intent.provider_refund_id) !== providerRefundId)) {
    mismatches.push('refund_id');
  }
  if (String(evidence?.providerPaymentId || '') !== String(intent.provider_payment_id)) {
    mismatches.push('payment_id');
  }
  if (!Number.isInteger(Number(evidence?.amountPaise))
      || Number(evidence.amountPaise) !== toPaise(intent.amount)) {
    mismatches.push('amount');
  }
  if (String(evidence?.currency || '').trim().toUpperCase()
      !== String(intent.currency || '').trim().toUpperCase()) {
    mismatches.push('currency');
  }
  const status = String(evidence?.status || '').trim().toLowerCase();
  if ((requireProcessed && status !== 'processed')
      || (!requireProcessed && !PROVIDER_REFUND_STATUSES.has(status))) {
    mismatches.push('status');
  }
  if (evidence?.billingRefundId !== undefined
      && Number(evidence.billingRefundId) !== Number(intent.billing_refund_id)) {
    mismatches.push('billing_refund_id');
  }
  return mismatches;
}

function refundEvidenceMismatchReason(mismatches) {
  return `Provider refund evidence mismatch: ${mismatches.join(', ')}`.slice(0, 500);
}

/**
 * Initiate the provider refund for an APPROVED billing_refunds row whose
 * invoice was gateway-collected. Execution/evidence only — the approval
 * authority and the ledger REFUND_PAID posting stay with billingV2
 * (markRefundPaid, driven by the refund.processed webhook).
 */
export async function initiateGatewayRefund({
  tenantId, billing_refund_id, gateway_order_id, initiated_by,
}) {
  const tenant = requireTenantId(tenantId);
  if (!Number.isInteger(Number(billing_refund_id)) || Number(billing_refund_id) <= 0
      || !Number.isInteger(Number(gateway_order_id)) || Number(gateway_order_id) <= 0) {
    throw AppError.badRequest(
      'billing_refund_id and gateway_order_id must be positive integers',
      'PAYMENT_GATEWAY_BAD_REFUND',
    );
  }
  await requireGatewayContext(tenant);
  const newProviderIdempotencyKey = `pgr_${randomBytes(16).toString('hex')}`;

  // Phase 1 commits the exact approved refund, payment source, payer, mode,
  // provider config and retry key before any irreversible provider request.
  const intent = await setTenantTx(tenant, async (tx) => {
    const refundRows = await tx.$queryRawUnsafe(
      `SELECT id, invoice_id, advance_id, patient_uid::text, amount, reason,
              mode, approval_status
         FROM billing_refunds
        WHERE id = $1::int AND tenant_id = $2::uuid
        FOR UPDATE`,
      Number(billing_refund_id), tenant,
    );
    if (!refundRows.length) throw AppError.notFound('Billing refund not found');
    const refund = refundRows[0];
    if (String(refund.approval_status).toUpperCase() !== 'APPROVED') {
      throw AppError.badRequest(
        `Refund must be APPROVED before gateway execution (is ${refund.approval_status})`,
        'PAYMENT_GATEWAY_REFUND_NOT_APPROVED',
      );
    }
    if (refund.invoice_id == null) {
      throw AppError.badRequest(
        'Only invoice-linked refunds can be executed through the gateway',
        'PAYMENT_GATEWAY_REFUND_NOT_GATEWAY_COLLECTED',
      );
    }

    const existingRows = await tx.$queryRawUnsafe(
      `SELECT * FROM payment_gateway_refunds
        WHERE tenant_id = $1::uuid AND billing_refund_id = $2::int
          AND status IN ('initiated', 'pending', 'requires_reconciliation', 'processed')
        ORDER BY id DESC
        LIMIT 1`,
      tenant, Number(refund.id),
    );
    const existing = existingRows[0] || null;
    if (existing && Number(existing.gateway_order_id) !== Number(gateway_order_id)) {
      throw AppError.conflict(
        'This approved refund is already bound to a different gateway payment',
        'PAYMENT_GATEWAY_REFUND_SOURCE_MISMATCH',
      );
    }
    if (existing && existing.status !== 'initiated') {
      return { row: existing, replay: true, callProvider: false };
    }

    const orderRows = await tx.$queryRawUnsafe(
      `SELECT o.id, o.provider, o.environment, o.provider_payment_id,
              o.amount, o.invoice_id, o.patient_uid::text, o.billing_payment_id,
              bp.invoice_id AS payment_invoice_id,
              bp.patient_uid::text AS payment_patient_uid, bp.mode AS payment_mode,
              pc.provider AS config_provider, pc.environment AS config_environment,
              pc.key_id, pc.key_secret_ciphertext
         FROM payment_gateway_orders o
         JOIN billing_payments bp
           ON bp.id = o.billing_payment_id AND bp.tenant_id = o.tenant_id
         JOIN payment_gateway_provider_configs pc
           ON pc.id = o.provider_config_id AND pc.tenant_id = o.tenant_id
        WHERE o.id = $1::int AND o.tenant_id = $2::uuid AND o.status = 'paid'
          AND o.provider_payment_id IS NOT NULL AND bp.reversed = false
          AND pc.enabled = true
        FOR UPDATE OF o`,
      Number(gateway_order_id), tenant,
    );
    if (!orderRows.length) {
      throw AppError.badRequest(
        'The selected payment was not collected through a bound gateway order',
        'PAYMENT_GATEWAY_REFUND_NOT_GATEWAY_COLLECTED',
      );
    }
    const order = orderRows[0];
    const sameInvoice = Number(order.invoice_id) === Number(refund.invoice_id)
      && Number(order.payment_invoice_id) === Number(refund.invoice_id);
    const samePatient = String(order.patient_uid).toLowerCase() === String(refund.patient_uid).toLowerCase()
      && String(order.payment_patient_uid).toLowerCase() === String(refund.patient_uid).toLowerCase();
    const sameMode = String(order.payment_mode).toUpperCase() === String(refund.mode).toUpperCase();
    const sameProvider = order.provider === order.config_provider
      && order.environment === order.config_environment;
    if (!sameInvoice || !samePatient || !sameMode || !sameProvider) {
      throw AppError.badRequest(
        'The approved refund does not match the selected payment source, payer, mode, or provider',
        'PAYMENT_GATEWAY_REFUND_SOURCE_MISMATCH',
      );
    }

    if (existing) {
      return {
        row: existing,
        replay: true,
        callProvider: true,
        order,
        refund,
      };
    }

    const totalRows = await tx.$queryRawUnsafe(
      `SELECT COALESCE(SUM(amount), 0)::numeric AS refunded_amount
         FROM payment_gateway_refunds
        WHERE tenant_id = $1::uuid AND gateway_order_id = $2::int
          AND status <> 'failed'`,
      tenant, Number(order.id),
    );
    const refundAmountPaise = toPaise(refund.amount);
    const alreadyRefundedPaise = toPaise(totalRows[0]?.refunded_amount || '0');
    const capturedAmountPaise = toPaise(order.amount);
    if (refundAmountPaise + alreadyRefundedPaise > capturedAmountPaise) {
      throw AppError.badRequest(
        `Refund amount ${Number(refund.amount)} exceeds the remaining gateway-captured amount`,
        'PAYMENT_GATEWAY_REFUND_EXCEEDS_CAPTURE',
      );
    }
    const refundAmount = refundAmountPaise / 100;

    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO payment_gateway_refunds
         (tenant_id, provider, environment, gateway_order_id, billing_refund_id,
          provider_payment_id, provider_idempotency_key, amount, currency, status,
          reason, initiated_by)
       VALUES ($1::uuid, $2, $3, $4::int, $5::int, $6, $7, $8::numeric, 'INR',
               'initiated', $9, $10::uuid)
       RETURNING *`,
      tenant, order.provider, order.environment, Number(order.id), Number(refund.id),
      String(order.provider_payment_id), newProviderIdempotencyKey, refundAmount,
      refund.reason ? String(refund.reason).slice(0, 500) : null,
      initiated_by ? String(initiated_by) : null,
    );
    return { row: rows[0], replay: false, callProvider: true, order, refund };
  }).catch((err) => {
    if (isUniqueViolation(err)) {
      throw AppError.conflict(
        'A gateway refund is already in flight (or processed) for this billing refund',
        'PAYMENT_GATEWAY_REFUND_ALREADY_EXECUTING',
      );
    }
    throw err;
  });

  if (!intent.callProvider) {
    return toGatewayRefundResult(intent.row, true);
  }

  // Phase 2 is safely replayable: Razorpay deduplicates this exact request by
  // X-Refund-Idempotency, and the dry-run adapter is deterministic by receipt.
  const adapter = resolveAdapter(intent.order.provider);
  let providerRefund;
  try {
    providerRefund = await adapter.createRefund({
      keyId: intent.order.key_id,
      keySecret: intent.order.key_secret_ciphertext
        ? decryptField(intent.order.key_secret_ciphertext)
        : null,
      // The request body comes from the committed intent, not mutable
      // authority/source rows, so every retry sends the same body with the
      // same provider idempotency key.
      providerPaymentId: intent.row.provider_payment_id,
      amountPaise: toPaise(intent.row.amount),
      receipt: `pgr-${intent.row.billing_refund_id}`,
      notes: { billing_refund_id: String(intent.row.billing_refund_id) },
      idempotencyKey: intent.row.provider_idempotency_key,
    });
  } catch (err) {
    if (err?.code === 'PAYMENT_GATEWAY_REFUND_IN_PROGRESS') {
      return toGatewayRefundResult(intent.row, true);
    }
    throw err;
  }

  const responseMismatches = refundEvidenceMismatches(intent.row, providerRefund);
  if (responseMismatches.length) {
    const safeProviderRefundId = String(providerRefund?.providerRefundId || '').trim();
    const completed = await setTenantTx(tenant, async (tx) => {
      const rows = await tx.$queryRawUnsafe(
        `UPDATE payment_gateway_refunds
            SET provider_refund_id = COALESCE($1::varchar, provider_refund_id),
                status = 'requires_reconciliation',
                failure_code = 'provider_evidence_mismatch',
                failure_reason = $2::text,
                updated_at = NOW()
          WHERE id = $3::int AND tenant_id = $4::uuid
            AND status IN ('initiated', 'pending', 'requires_reconciliation')
            AND provider_idempotency_key = $5::varchar
          RETURNING *`,
        safeProviderRefundId && safeProviderRefundId.length <= 120 ? safeProviderRefundId : null,
        refundEvidenceMismatchReason(responseMismatches),
        Number(intent.row.id), tenant, intent.row.provider_idempotency_key,
      );
      if (rows.length) return rows[0];
      const replayRows = await tx.$queryRawUnsafe(
        `SELECT * FROM payment_gateway_refunds
          WHERE id = $1::int AND tenant_id = $2::uuid
            AND provider_idempotency_key = $3
          LIMIT 1`,
        Number(intent.row.id), tenant, intent.row.provider_idempotency_key,
      );
      if (!replayRows.length) throw AppError.notFound('Gateway refund intent not found');
      return replayRows[0];
    });
    return toGatewayRefundResult(completed, intent.replay);
  }

  const providerStatus = providerRefund.status === 'failed' ? 'failed' : 'pending';
  const completed = await setTenantTx(tenant, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `UPDATE payment_gateway_refunds
          SET provider_refund_id = COALESCE($1::varchar, provider_refund_id),
              status = $2::varchar, updated_at = NOW(),
              failed_at = CASE WHEN $2::varchar = 'failed' THEN NOW() ELSE failed_at END
        WHERE id = $3::int AND tenant_id = $4::uuid AND status = 'initiated'
          AND provider_idempotency_key = $5::varchar
        RETURNING *`,
      providerRefund.providerRefundId || null,
      providerStatus,
      Number(intent.row.id), tenant, intent.row.provider_idempotency_key,
    );
    if (rows.length) return rows[0];
    const replayRows = await tx.$queryRawUnsafe(
      `SELECT * FROM payment_gateway_refunds
        WHERE id = $1::int AND tenant_id = $2::uuid
          AND provider_idempotency_key = $3
        LIMIT 1`,
      Number(intent.row.id), tenant, intent.row.provider_idempotency_key,
    );
    if (!replayRows.length) throw AppError.notFound('Gateway refund intent not found');
    return replayRows[0];
  });
  return toGatewayRefundResult(completed, intent.replay);
}

/**
 * refund.processed webhook → mark the execution leg processed and drive
 * markRefundPaid (billingV2 authority; posts REFUND_PAID per ledger wiring)
 * with reference = provider_refund_id. Idempotent under redelivery: an
 * already-PAID billing refund is accepted as done, and an already-processed
 * execution row short-circuits to replay.
 */
export async function handleRefundProcessedEvent({ tenantId, config, payload }) {
  const tenant = requireTenantId(tenantId);
  const entity = payload?.payload?.refund?.entity || {};
  const providerRefundId = entity.id || null;
  const providerPaymentId = entity.payment_id || null;
  const notedBillingRefundId = Number(entity.notes?.billing_refund_id);
  if (!providerRefundId) return { outcome: 'ignored', reason: 'missing refund entity id' };

  let rows = await prisma.$queryRawUnsafe(
    `SELECT * FROM payment_gateway_refunds
      WHERE tenant_id = $1::uuid AND provider = $2 AND provider_refund_id = $3
      LIMIT 1`,
    tenant, config.provider, String(providerRefundId),
  );
  if (!rows.length && providerPaymentId
      && Number.isInteger(notedBillingRefundId) && notedBillingRefundId > 0) {
    // A webhook can beat the phase-3 evidence update after the provider call.
    // Correlate that crash window by BOTH payment id and our billing-refund
    // note; payment id alone is ambiguous when one capture has partial refunds.
    rows = await prisma.$queryRawUnsafe(
      `SELECT * FROM payment_gateway_refunds
        WHERE tenant_id = $1::uuid AND provider = $2
          AND provider_payment_id = $3 AND billing_refund_id = $4::int
          AND status IN ('initiated', 'pending')
        ORDER BY id DESC
        LIMIT 1`,
      tenant, config.provider, String(providerPaymentId), notedBillingRefundId,
    );
  }
  if (!rows.length) {
    return { outcome: 'ignored', reason: 'no matching gateway refund row' };
  }
  const gatewayRefund = rows[0];
  if (gatewayRefund.status === 'processed') {
    return { outcome: 'replay', gatewayRefundId: Number(gatewayRefund.id) };
  }

  const evidenceMismatches = refundEvidenceMismatches(gatewayRefund, {
    providerRefundId,
    providerPaymentId,
    amountPaise: entity.amount,
    currency: entity.currency,
    status: entity.status,
    billingRefundId: notedBillingRefundId,
  }, { requireProcessed: true });
  if (evidenceMismatches.length) {
    await prisma.$queryRawUnsafe(
      `UPDATE payment_gateway_refunds
          SET status = 'requires_reconciliation',
              provider_refund_id = COALESCE(provider_refund_id, $1::varchar),
              failure_code = 'provider_evidence_mismatch',
              failure_reason = $2::text,
              updated_at = NOW()
        WHERE id = $3::int AND tenant_id = $4::uuid
          AND status IN ('initiated', 'pending', 'requires_reconciliation')
        RETURNING id`,
      String(providerRefundId), refundEvidenceMismatchReason(evidenceMismatches),
      Number(gatewayRefund.id), tenant,
    );
    return {
      outcome: 'requires_reconciliation',
      gatewayRefundId: Number(gatewayRefund.id),
      reason: refundEvidenceMismatchReason(evidenceMismatches),
    };
  }

  // Authority first: flip the billing refund APPROVED → PAID (its own
  // setTenantTx; idempotent via the status guard) with the provider refund id
  // as the payout reference. A crash between this and the execution-row
  // update self-heals on redelivery via the already-PAID acceptance below.
  if (gatewayRefund.billing_refund_id != null) {
    try {
      await markRefundPaid(Number(gatewayRefund.billing_refund_id), {
        tenantId: tenant,
        reference: String(providerRefundId),
        paid_by: null,
      });
    } catch (err) {
      const alreadyPaid = err instanceof AppError && err.statusCode === 404
        && (await prisma.$queryRawUnsafe(
          `SELECT approval_status FROM billing_refunds
            WHERE id = $1::int AND tenant_id = $2::uuid LIMIT 1`,
          Number(gatewayRefund.billing_refund_id), tenant,
        ))[0]?.approval_status === 'PAID';
      if (!alreadyPaid) throw err;
    }
  }

  const updated = await prisma.$queryRawUnsafe(
    `UPDATE payment_gateway_refunds
        SET status = 'processed',
            provider_refund_id = COALESCE(provider_refund_id, $1),
            processed_at = NOW(), updated_at = NOW()
      WHERE id = $2::int AND tenant_id = $3::uuid
        AND status IN ('initiated', 'pending', 'requires_reconciliation')
      RETURNING id`,
    String(providerRefundId), Number(gatewayRefund.id), tenant,
  );
  return {
    outcome: updated.length ? 'refund_processed' : 'replay',
    gatewayRefundId: Number(gatewayRefund.id),
    billingRefundId: gatewayRefund.billing_refund_id != null ? Number(gatewayRefund.billing_refund_id) : null,
  };
}

async function handleRefundFailedEvent({ tenantId, config, payload }) {
  const tenant = requireTenantId(tenantId);
  const entity = payload?.payload?.refund?.entity || {};
  if (!entity.id) return { outcome: 'ignored', reason: 'missing refund entity id' };
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE payment_gateway_refunds
        SET status = 'failed', failed_at = NOW(),
            failure_code = $1, failure_reason = $2, updated_at = NOW()
      WHERE tenant_id = $3::uuid AND provider = $4 AND provider_refund_id = $5
        AND status IN ('initiated', 'pending')
      RETURNING id`,
    entity.error_code ? String(entity.error_code).slice(0, 80) : null,
    entity.error_description ? String(entity.error_description).slice(0, 500) : 'provider reported refund failure',
    tenant, config.provider, String(entity.id),
  );
  return rows.length
    ? { outcome: 'refund_failed_recorded', gatewayRefundId: Number(rows[0].id) }
    : { outcome: 'ignored', reason: 'no matching in-flight gateway refund' };
}

// ───────────────────────────────────────────────────────────────────────
// Webhook dispatch
// ───────────────────────────────────────────────────────────────────────

/**
 * Dispatch one verified, recorded webhook event. Returns the handler outcome;
 * the caller marks the event row processed/ignored/failed.
 */
export async function processWebhookEvent({ tenantId, config, event, payload }) {
  const type = String(event.event_type || '').toLowerCase();
  switch (type) {
    case 'payment.captured':
    case 'order.paid':
      return handleCaptureEvent({ tenantId, config, payload });
    case 'payment.authorized':
      return handlePaymentAuthorizedEvent({ tenantId, config, payload });
    case 'payment.failed':
      return handlePaymentFailedEvent({ tenantId, config, payload });
    case 'refund.processed':
      return handleRefundProcessedEvent({ tenantId, config, payload });
    case 'refund.failed':
      return handleRefundFailedEvent({ tenantId, config, payload });
    default:
      return { outcome: 'ignored', reason: `unhandled event type ${type}` };
  }
}

export { markWebhookEvent };

// ───────────────────────────────────────────────────────────────────────
// Public /pay page enrichment
// ───────────────────────────────────────────────────────────────────────

/**
 * Gateway checkout bootstrap for the public payment page. Defensive: any
 * failure yields the disabled marker — the page then falls back to the raw
 * UPI intent exactly as today. Exposes NOTHING beyond the publishable
 * key_id, provider name, and an existing order's provider id.
 */
export async function getPublicGatewayViewForLink({ tenantId, paymentLinkId }) {
  const disabled = { enabled: false, provider: null, keyId: null, providerOrderId: null };
  try {
    if (!tenantId || !paymentLinkId) return disabled;
    const context = await resolveGatewayContext(tenantId);
    if (!context.enabled) return disabled;
    const rows = await prisma.$queryRawUnsafe(
      `SELECT provider_order_id
         FROM payment_gateway_orders
        WHERE tenant_id = $1::uuid AND payment_link_id = $2::int
          AND status IN ('created', 'attempted')
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
      requireTenantId(tenantId), Number(paymentLinkId),
    );
    return {
      enabled: true,
      provider: context.config.provider,
      keyId: context.config.key_id || null,
      providerOrderId: rows[0]?.provider_order_id || null,
    };
  } catch (err) {
    logger.warn('public gateway view resolution failed — rendering disabled marker', {
      error: err?.message,
    });
    return disabled;
  }
}

export default {
  PAYMENT_GATEWAY_DISABLED,
  isGatewayEnvEnabled,
  paymentModeForMethod,
  resolveGatewayContext,
  requireGatewayContext,
  listGatewayConfigs,
  upsertGatewayConfig,
  createGatewayOrder,
  getGatewayOrder,
  cancelGatewayOrder,
  listReconciliationGatewayOrders,
  resolveGatewayOrderReconciliation,
  expireStaleGatewayOrders,
  resolveWebhookConfigByToken,
  decryptedWebhookSecret,
  recordWebhookEvent,
  markWebhookEvent,
  processWebhookEvent,
  handleCaptureEvent,
  handleRefundProcessedEvent,
  initiateGatewayRefund,
  getPublicGatewayViewForLink,
};
