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
  markGatewayRefundPaid,
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

function requirePositivePaise(amount) {
  const parsed = Number(amount);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw AppError.badRequest('amount must be > 0', 'PAYMENT_GATEWAY_BAD_AMOUNT');
  }
  try {
    if (typeof amount === 'number'
        && Math.abs(parsed - Math.round(parsed * 100) / 100) > 1e-9) {
      throw new Error('sub-paisa precision');
    }
    return toPaise(typeof amount === 'number' ? amount : String(amount).trim());
  } catch {
    throw AppError.badRequest(
      'amount must have at most 2 decimal places',
      'PAYMENT_GATEWAY_BAD_AMOUNT',
    );
  }
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

function orderReceiptForRequest({
  tenantId, actorUid, patientUid, subjectKind, subjectId, scope,
  requestedAmountIdentity, idempotencyKey,
}) {
  const key = String(idempotencyKey || '').trim();
  if (!key) return generateReceipt();
  // The caller's key is not disclosed to the provider. The deterministic
  // digest is the durable recovery handle for a local-intent-first saga. Its
  // identity includes every authority boundary that the HTTP idempotency
  // envelope includes; a reused client key cannot collide across patients,
  // request scopes, or invoice/payment-link paths inside one tenant.
  const identity = JSON.stringify([
    String(tenantId),
    String(actorUid).toLowerCase(),
    String(patientUid).toLowerCase(),
    String(scope),
    String(subjectKind),
    String(subjectId),
    String(requestedAmountIdentity),
    key,
  ]);
  return `pg-${sha256Hex(identity).slice(0, 32)}`;
}

const RAZORPAY_IDENTIFIER_PATTERNS = {
  order: /^order_[A-Za-z0-9]+$/,
  payment: /^pay_[A-Za-z0-9]+$/,
  refund: /^rfnd_[A-Za-z0-9]+$/,
};

function isExactProviderIdentifier(provider, kind, value) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized.length > 120) return false;
  if (String(provider) !== 'razorpay') return !/(?:\*{2,}|masked|redacted)/i.test(normalized);
  return RAZORPAY_IDENTIFIER_PATTERNS[kind]?.test(normalized) === true;
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
  let webhookSecretCipher = webhook_secret ? encryptField(String(webhook_secret), { tenantId: tenant }) : null;
  const webhookToken = generateWebhookToken();

  let rows;
  try {
    rows = await setTenantTx(tenant, async (tx) => {
      const existingRows = await tx.$queryRawUnsafe(
        `SELECT webhook_secret_ciphertext, webhook_credential_version, metadata,
                clock_timestamp() AS rotation_cutoff
           FROM payment_gateway_provider_configs
          WHERE tenant_id = $1::uuid AND provider = $2 AND environment = $3
          FOR UPDATE`,
        tenant, providerValue, environmentValue,
      );
      const existing = existingRows[0] || null;
      const existingMetadata = existing?.metadata && typeof existing.metadata === 'object'
        ? existing.metadata
        : {};
      const priorVersions = Array.isArray(existingMetadata.webhook_secret_versions)
        ? existingMetadata.webhook_secret_versions.filter((entry) => (
          entry && Number.isInteger(Number(entry.version)) && Number(entry.version) > 0
          && typeof entry.ciphertext === 'string' && entry.ciphertext.length > 0
          && typeof entry.retired_at === 'string'
        ))
        : [];
      const currentVersion = Number(existing?.webhook_credential_version || 1);
      let nextVersion = currentVersion;
      let rotatingWebhookSecret = false;
      if (webhookSecretCipher && existing?.webhook_secret_ciphertext) {
        const existingPlaintext = decryptField(existing.webhook_secret_ciphertext);
        rotatingWebhookSecret = existingPlaintext !== String(webhook_secret);
        if (rotatingWebhookSecret) {
          priorVersions.unshift({
            version: currentVersion,
            ciphertext: existing.webhook_secret_ciphertext,
            retired_at: new Date(existing.rotation_cutoff).toISOString(),
          });
          nextVersion = currentVersion + 1;
        } else {
          // Encryption is nonce-randomized. Keeping the existing ciphertext
          // avoids manufacturing a credential rotation when the plaintext is
          // unchanged.
          webhookSecretCipher = null;
        }
      }
      const metadata = {
        ...existingMetadata,
        webhook_token: existingMetadata.webhook_token || webhookToken,
        ...(priorVersions.length
          ? { webhook_secret_versions: priorVersions.slice(0, 10) }
          : {}),
      };
      delete metadata.webhook_secret_history;
      return tx.$queryRawUnsafe(
      `INSERT INTO payment_gateway_provider_configs
         (tenant_id, provider, environment, enabled, display_name, key_id,
          key_secret_ciphertext, webhook_secret_ciphertext, accepted_methods,
          metadata, created_by, webhook_credential_version)
       VALUES ($1::uuid, $2, $3, $4::boolean, $5, $6, $7, $8,
               COALESCE($9::text[], ARRAY['upi','card']::text[]),
               $10::jsonb, $11::uuid, $12::int)
       ON CONFLICT (tenant_id, provider, environment) DO UPDATE SET
         enabled = EXCLUDED.enabled,
         display_name = COALESCE(EXCLUDED.display_name, payment_gateway_provider_configs.display_name),
         key_id = COALESCE(EXCLUDED.key_id, payment_gateway_provider_configs.key_id),
         key_secret_ciphertext = COALESCE(EXCLUDED.key_secret_ciphertext, payment_gateway_provider_configs.key_secret_ciphertext),
         webhook_secret_ciphertext = COALESCE(EXCLUDED.webhook_secret_ciphertext, payment_gateway_provider_configs.webhook_secret_ciphertext),
         accepted_methods = COALESCE($9::text[], payment_gateway_provider_configs.accepted_methods),
         metadata = $10::jsonb,
         webhook_credential_version = $12::int,
         updated_at = NOW()
       RETURNING ${CONFIG_VIEW_COLUMNS}`,
      tenant, providerValue, environmentValue, enabled === true,
      display_name ? String(display_name).slice(0, 120) : null,
      key_id ? String(key_id).slice(0, 120) : null,
      keySecretCipher, webhookSecretCipher,
      methods, JSON.stringify(metadata),
      created_by ? String(created_by) : null,
      rotatingWebhookSecret ? nextVersion : currentVersion,
      );
    });
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
  idempotency_key,
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

  const orderAmountPaise = requirePositivePaise(
    amount != null ? amount : subject.defaultAmount,
  );
  const maxAmountPaise = toPaise(subject.maxAmount);
  const orderAmount = orderAmountPaise / 100;
  if (orderAmountPaise > maxAmountPaise) {
    throw AppError.badRequest(
      `Amount ${orderAmount} exceeds the payable amount ${subject.maxAmount}`,
      'PAYMENT_GATEWAY_AMOUNT_EXCEEDS_DUE',
    );
  }

  const subjectKind = subject.paymentLinkId != null ? 'payment_link' : 'invoice';
  const subjectId = subject.paymentLinkId ?? subject.invoiceId;
  const requestActorUid = String(actor?.uid || created_by || '').toLowerCase();
  const receipt = orderReceiptForRequest({
    tenantId: tenant,
    actorUid: requestActorUid,
    patientUid: subject.patientUid,
    subjectKind,
    subjectId,
    scope: 'payment_gateway_order',
    requestedAmountIdentity: amount == null ? 'default_due' : orderAmountPaise,
    idempotencyKey: idempotency_key,
  });
  const defaultExpiry = new Date(Date.now() + DEFAULT_ORDER_EXPIRY_HOURS * 3600 * 1000);
  const expiresAt = subject.linkExpiresAt && subject.linkExpiresAt < defaultExpiry
    ? subject.linkExpiresAt
    : defaultExpiry;
  const intentRows = await prisma.$queryRawUnsafe(
    `INSERT INTO payment_gateway_orders
       (tenant_id, provider, environment, provider_config_id, patient_uid,
        invoice_id, payment_link_id, amount, currency, receipt,
        provider_order_id, status, expires_at, created_by, metadata,
        webhook_credential_version)
     VALUES ($1::uuid, $2, $3, $4::int, $5::uuid, $6, $7, $8::numeric, 'INR',
             $9, NULL, 'created', $10::timestamptz, $11::uuid,
             jsonb_build_object('order_create_state', 'intent_persisted'), $12::int)
     ON CONFLICT (tenant_id, receipt) WHERE receipt IS NOT NULL DO UPDATE
       SET updated_at = payment_gateway_orders.updated_at
     RETURNING *, (xmax = 0) AS inserted`,
    tenant, config.provider, config.environment, Number(config.id),
    subject.patientUid, subject.invoiceId, subject.paymentLinkId,
    orderAmount, receipt, expiresAt.toISOString(),
    requestActorUid || null,
    Number(config.webhook_credential_version || 1),
  );
  const intent = intentRows[0];
  if (!intent) throw new AppError('Payment gateway order intent could not be persisted', 503, 'PAYMENT_GATEWAY_ORDER_INTENT_UNAVAILABLE');
  const sameIntent = Number(intent.provider_config_id) === Number(config.id)
    && String(intent.patient_uid).toLowerCase() === String(subject.patientUid).toLowerCase()
    && Number(intent.invoice_id || 0) === Number(subject.invoiceId || 0)
    && Number(intent.payment_link_id || 0) === Number(subject.paymentLinkId || 0)
    && toPaise(intent.amount) === toPaise(orderAmount)
    && String(intent.currency).toUpperCase() === 'INR'
    && String(intent.created_by || '').toLowerCase() === requestActorUid
    && Number(intent.webhook_credential_version || 1)
      === Number(config.webhook_credential_version || 1);
  if (!sameIntent) {
    throw AppError.conflict(
      'Idempotency key is already bound to a different payment order intent',
      'PAYMENT_GATEWAY_ORDER_INTENT_MISMATCH',
    );
  }
  if (intent.provider_order_id) return toGatewayOrderCheckout(intent, config);
  if (!['created', 'attempted'].includes(String(intent.status))) {
    throw AppError.conflict(
      `Payment gateway order intent cannot be recovered from ${intent.status}`,
      'PAYMENT_GATEWAY_ORDER_NOT_RECOVERABLE',
    );
  }

  const adapter = resolveAdapter(config.provider);
  const providerArgs = {
    keyId: config.key_id,
    keySecret: decryptedKeySecret(config),
    amountPaise: toPaise(intent.amount),
    currency: String(intent.currency),
    receipt: String(intent.receipt),
    notes: {
      tenant_id: tenant,
      ...(intent.invoice_id ? { invoice_id: String(intent.invoice_id) } : {}),
      ...(intent.payment_link_id ? { payment_link_id: String(intent.payment_link_id) } : {}),
    },
  };
  let providerOrder = null;
  try {
    if (intent.inserted !== true && typeof adapter.findOrderByReceipt === 'function') {
      providerOrder = await adapter.findOrderByReceipt(providerArgs);
    }
    if (!providerOrder) providerOrder = await adapter.createOrder(providerArgs);
  } catch (err) {
    await prisma.$executeRawUnsafe(
      `UPDATE payment_gateway_orders
          SET failure_code = 'provider_order_create_uncertain',
              failure_reason = $1, updated_at = NOW()
        WHERE id = $2::int AND tenant_id = $3::uuid AND provider_order_id IS NULL`,
      String(err?.code || 'upstream_error').slice(0, 500), Number(intent.id), tenant,
    ).catch(() => {});
    throw err;
  }

  const orderMismatches = providerOrderEvidenceMismatches(intent, providerOrder);
  if (orderMismatches.length) {
    await prisma.$executeRawUnsafe(
      `UPDATE payment_gateway_orders
          SET status = 'failed', failure_code = 'provider_order_evidence_mismatch',
              failure_reason = $1, updated_at = NOW()
        WHERE id = $2::int AND tenant_id = $3::uuid AND provider_order_id IS NULL`,
      `Provider order response mismatch: ${orderMismatches.join(', ')}`.slice(0, 500),
      Number(intent.id), tenant,
    );
    throw new AppError(
      'Payment gateway returned an order that did not match the persisted intent',
      502,
      'PAYMENT_GATEWAY_ORDER_EVIDENCE_MISMATCH',
      { fields: orderMismatches },
    );
  }

  const boundRows = await prisma.$queryRawUnsafe(
    `UPDATE payment_gateway_orders
        SET provider_order_id = $1,
            failure_code = NULL, failure_reason = NULL,
            metadata = metadata || jsonb_build_object('order_create_state', 'provider_bound'),
            updated_at = NOW()
      WHERE id = $2::int AND tenant_id = $3::uuid
        AND provider_order_id IS NULL AND status IN ('created', 'attempted')
      RETURNING *`,
    String(providerOrder.providerOrderId), Number(intent.id), tenant,
  );
  const order = boundRows[0] || (await prisma.$queryRawUnsafe(
    `SELECT * FROM payment_gateway_orders
      WHERE id = $1::int AND tenant_id = $2::uuid LIMIT 1`,
    Number(intent.id), tenant,
  ))[0];
  if (!order || String(order.provider_order_id) !== String(providerOrder.providerOrderId)) {
    throw AppError.conflict(
      'Payment gateway order was concurrently bound to different provider evidence',
      'PAYMENT_GATEWAY_ORDER_BINDING_CONFLICT',
    );
  }
  return toGatewayOrderCheckout(order, config);
}

function providerOrderEvidenceMismatches(intent, evidence) {
  const mismatches = [];
  const providerOrderId = String(evidence?.providerOrderId || '').trim();
  if (!isExactProviderIdentifier(intent.provider, 'order', providerOrderId)) {
    mismatches.push('order_id');
  }
  if (!Number.isInteger(Number(evidence?.amountPaise))
      || Number(evidence.amountPaise) !== toPaise(intent.amount)) mismatches.push('amount');
  if (String(evidence?.currency || '').trim().toUpperCase()
      !== String(intent.currency || '').trim().toUpperCase()) mismatches.push('currency');
  if (String(evidence?.receipt || '') !== String(intent.receipt || '')) mismatches.push('receipt');
  if (String(evidence?.status || '').trim().toLowerCase() !== 'created') mismatches.push('status');
  return mismatches;
}

function toGatewayOrderCheckout(order, config) {
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
  billing_payment_id, captured_at, reconciled_at, reconciliation_note, reconciled_by,
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
  const resolvedBy = typeof resolved_by === 'string' ? resolved_by.trim() : '';
  if (!resolvedBy) {
    throw AppError.forbidden(
      'An authenticated operator is required to resolve gateway order reconciliation',
      'PAYMENT_GATEWAY_RECONCILIATION_ACTOR_REQUIRED',
    );
  }
  const actorRows = await prisma.$queryRawUnsafe(
    `SELECT uid
       FROM users
      WHERE tenant_id = $1::uuid AND uid = $2::uuid
      LIMIT 1`,
    tenant, resolvedBy,
  );
  if (!actorRows.length) {
    throw AppError.forbidden(
      'The reconciliation actor must belong to this tenant',
      'PAYMENT_GATEWAY_RECONCILIATION_ACTOR_INVALID',
    );
  }
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE payment_gateway_orders
        SET reconciled_at = NOW(),
            reconciliation_note = $1,
            reconciled_by = $2::uuid,
            updated_at = NOW()
      WHERE id = $3::int AND tenant_id = $4::uuid
        AND status = 'requires_reconciliation'
        AND reconciled_at IS NULL
      RETURNING ${ORDER_VIEW_COLUMNS}`,
    trimmedNote.slice(0, 500), resolvedBy, Number(id), tenant,
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
    resolved_by: resolvedBy,
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
 * opaque token selects exactly one config row (and thereby the tenant +
 * webhook credentials). Disabled/rotated credentials are accepted by the
 * route only after signature verification AND exact binding to an existing
 * nonterminal order/refund. This keeps inbound settlement evidence available
 * after an operator disables outbound calls without reopening outbound use.
 */
export async function resolveWebhookConfigByToken(webhookToken) {
  if (typeof webhookToken !== 'string' || !WEBHOOK_TOKEN_RE.test(webhookToken)) return null;
  // Cross-tenant by design (mirrors /pay's token-only lookup): the token is
  // the routing key and the tenant is derived FROM the row.
  const rows = await prisma.$queryRawUnsafe(
    `SELECT * FROM payment_gateway_provider_configs
      WHERE metadata->>'webhook_token' = $1
      LIMIT 1`,
    String(webhookToken),
  );
  return rows[0] || null;
}

export function decryptedWebhookSecret(config) {
  return config?.webhook_secret_ciphertext ? decryptField(config.webhook_secret_ciphertext) : null;
}

export function decryptedWebhookSecrets(config) {
  const currentVersion = Number(config?.webhook_credential_version || 1);
  const credentials = [];
  if (typeof config?.webhook_secret_ciphertext === 'string'
      && config.webhook_secret_ciphertext.length > 0) {
    credentials.push({
      secret: decryptField(config.webhook_secret_ciphertext),
      current: true,
      version: currentVersion,
      retiredAt: null,
    });
  }
  const retired = Array.isArray(config?.metadata?.webhook_secret_versions)
    ? config.metadata.webhook_secret_versions
    : [];
  for (const entry of retired) {
    const version = Number(entry?.version);
    if (!Number.isInteger(version) || version <= 0 || version >= currentVersion
        || typeof entry?.ciphertext !== 'string' || !entry.ciphertext
        || typeof entry?.retired_at !== 'string') continue;
    const retiredAt = new Date(entry.retired_at);
    if (Number.isNaN(retiredAt.getTime())) continue;
    credentials.push({
      secret: decryptField(entry.ciphertext),
      current: false,
      version,
      retiredAt,
    });
  }
  return credentials;
}

/**
 * A delivery authenticated by a disabled config or an old rotated secret is
 * settlement-only. It must name an exact nonterminal intent owned by the same
 * config row; token+signature alone never grants an unbounded callback path.
 */
export async function hasBoundNonterminalWebhookIntent({ config, payload, credential }) {
  const tenant = requireTenantId(config?.tenant_id);
  const retiredVersion = credential?.current === false
    ? Number(credential.version)
    : null;
  if (credential?.current === false
      && (!Number.isInteger(retiredVersion) || retiredVersion <= 0)) return false;
  const refund = payload?.payload?.refund?.entity || null;
  if (refund) {
    const providerRefundId = String(refund.id || '').trim();
    const providerPaymentId = String(refund.payment_id || '').trim();
    const billingRefundId = Number(refund.notes?.billing_refund_id);
    if (!providerRefundId
        && (!providerPaymentId || !Number.isInteger(billingRefundId) || billingRefundId <= 0)) {
      return false;
    }
    const rows = await prisma.$queryRawUnsafe(
      `SELECT r.id
         FROM payment_gateway_refunds r
         JOIN payment_gateway_orders o
           ON o.id = r.gateway_order_id AND o.tenant_id = r.tenant_id
        WHERE r.tenant_id = $1::uuid
          AND r.provider = $2 AND r.environment = $3
          AND o.provider_config_id = $4::int
          AND r.status IN ('initiated', 'pending', 'requires_reconciliation')
          AND ($8::int IS NULL OR r.webhook_credential_version = $8::int)
          AND ($9::timestamptz IS NULL OR r.created_at <= $9::timestamptz)
          AND (
            ($5::text <> '' AND r.provider_refund_id = $5)
            OR (
              $6::text <> '' AND $7::int > 0
              AND r.provider_payment_id = $6
              AND r.billing_refund_id = $7::int
            )
          )
        LIMIT 1`,
      tenant, config.provider, config.environment, Number(config.id),
      providerRefundId, providerPaymentId,
      Number.isInteger(billingRefundId) && billingRefundId > 0 ? billingRefundId : 0,
      retiredVersion,
      credential?.retiredAt instanceof Date ? credential.retiredAt.toISOString() : null,
    );
    return rows.length > 0;
  }

  const payment = payload?.payload?.payment?.entity || {};
  const order = payload?.payload?.order?.entity || {};
  const providerOrderId = String(payment.order_id || order.id || '').trim();
  if (!providerOrderId) return false;
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id
       FROM payment_gateway_orders
      WHERE tenant_id = $1::uuid
        AND provider = $2 AND environment = $3
        AND provider_config_id = $4::int
        AND provider_order_id = $5
        AND status IN ('created', 'attempted')
        AND ($6::int IS NULL OR webhook_credential_version = $6::int)
        AND ($7::timestamptz IS NULL OR created_at <= $7::timestamptz)
      LIMIT 1`,
    tenant, config.provider, config.environment, Number(config.id), providerOrderId,
    retiredVersion,
    credential?.retiredAt instanceof Date ? credential.retiredAt.toISOString() : null,
  );
  return rows.length > 0;
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
  const updated = await prisma.$executeRawUnsafe(
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
  if (Number(updated) !== 1) {
    throw new AppError(
      'Payment gateway webhook status could not be persisted',
      503,
      'PAYMENT_GATEWAY_WEBHOOK_STATUS_UNAVAILABLE',
    );
  }
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

const TERMINAL_CAPTURE_RECONCILIATION_CODES = new Set([
  'BAD_REQUEST',
  'DUPLICATE_PAYMENT_REFERENCE',
  'PAYMENT_GATEWAY_CAPTURE_EVIDENCE_MISMATCH',
]);

async function parkCaptureForReconciliation({
  tenant, config, providerOrderId, providerPaymentId, error: captureError,
}) {
  const orderRows = await prisma.$queryRawUnsafe(
    `SELECT id, status FROM payment_gateway_orders
      WHERE tenant_id = $1::uuid AND provider = $2 AND environment = $3
        AND provider_config_id = $4::int AND provider_order_id = $5
      LIMIT 1`,
    tenant, config.provider, config.environment, Number(config.id), String(providerOrderId),
  );
  if (!orderRows.length || orderRows[0].status === 'paid') return null;
  await setOrderRequiresReconciliation({
    tenantId: tenant,
    orderId: orderRows[0].id,
    providerPaymentId,
    reason: `${captureError.code || 'BOOKING_FAILED'}: ${captureError.message}`,
  });
  logger.error('payment gateway capture requires manual reconciliation', {
    gateway_order_id: Number(orderRows[0].id),
    code: captureError.code,
    error: captureError.message,
  });
  return {
    outcome: 'requires_reconciliation',
    orderId: Number(orderRows[0].id),
    reason: captureError.code || captureError.message,
  };
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
  const providerAmountPaise = Number(paymentEntity.amount);
  const method = normalizeOrderMethod(paymentEntity.method);
  const mode = paymentModeForMethod(paymentEntity.method);

  const wiring = await resolveLedgerWiring(tenant);
  let result;
  try {
    result = await setTenantTx(tenant, async (tx) => {
      const orderRows = await tx.$queryRawUnsafe(
        `SELECT * FROM payment_gateway_orders
          WHERE tenant_id = $1::uuid AND provider = $2 AND environment = $3
            AND provider_config_id = $4::int AND provider_order_id = $5
          FOR UPDATE`,
        tenant, config.provider, config.environment, Number(config.id), String(providerOrderId),
      );
      if (!orderRows.length) {
        throw AppError.notFound(
          'No gateway order matches this capture event',
          'PAYMENT_GATEWAY_ORDER_NOT_FOUND',
        );
      }
      const order = orderRows[0];
      const evidenceMismatches = [];
      if (!isExactProviderIdentifier(config.provider, 'payment', providerPaymentId)) {
        evidenceMismatches.push('payment_id');
      }
      if (!Number.isInteger(providerAmountPaise)
          || providerAmountPaise <= 0
          || providerAmountPaise !== toPaise(order.amount)) {
        evidenceMismatches.push('amount');
      }
      if (typeof paymentEntity.currency !== 'string'
          || paymentEntity.currency.trim().toUpperCase()
            !== String(order.currency || '').trim().toUpperCase()) {
        evidenceMismatches.push('currency');
      }
      if (evidenceMismatches.length) {
        throw AppError.badRequest(
          `Captured payment evidence does not match the order: ${evidenceMismatches.join(', ')}`,
          'PAYMENT_GATEWAY_CAPTURE_EVIDENCE_MISMATCH',
        );
      }
      if (order.status === 'paid') {
        if (String(order.provider_payment_id) !== String(providerPaymentId)) {
          throw AppError.conflict(
            'Capture replay payment id does not match the booked payment',
            'PAYMENT_GATEWAY_CAPTURE_REPLAY_MISMATCH',
          );
        }
        let payment = null;
        if (wiring.postCommit) {
          const paymentRows = await tx.$queryRawUnsafe(
            `SELECT * FROM billing_payments
              WHERE id = $1::int AND tenant_id = $2::uuid
              LIMIT 1`,
            Number(order.billing_payment_id), tenant,
          );
          if (!paymentRows.length) {
            throw new AppError(
              'Booked gateway payment evidence is unavailable for ledger retry',
              503,
              'PAYMENT_GATEWAY_CAPTURE_LEDGER_EVIDENCE_UNAVAILABLE',
            );
          }
          payment = paymentRows[0];
        }
        // Replay (or a second event for the already-booked capture).
        return {
          outcome: 'replay',
          orderId: Number(order.id),
          billingPaymentId: order.billing_payment_id != null ? Number(order.billing_payment_id) : null,
          payment,
        };
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
    if (err instanceof AppError && TERMINAL_CAPTURE_RECONCILIATION_CODES.has(err.code)) {
      // The provider captured money we could not book (voided invoice,
      // amount drift, or a durable reference collision). Park only this
      // explicit terminal allowlist. Ledger/config/DB AppErrors must escape so
      // the webhook route returns non-2xx and the provider retries.
      const parked = await parkCaptureForReconciliation({
        tenant, config, providerOrderId, providerPaymentId, error: err,
      });
      if (parked) return parked;
    }
    throw err;
  }

  if ((result.outcome === 'captured' || result.outcome === 'replay')
      && wiring.postCommit) {
    try {
      await postPaymentEntry({ payment: result.payment, tenantId: tenant });
    } catch (ledgerErr) {
      if (ledgerErr instanceof AppError && ledgerErr.code === 'LEDGER_DUPLICATE') {
        return result;
      }
      logger.error('Ledger PAYMENT post (gateway capture) failed — provider retry required', {
        payment_id: result.billingPaymentId, error: ledgerErr.message,
      });
      throw ledgerErr;
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
      WHERE tenant_id = $3::uuid AND provider = $4 AND environment = $5
        AND provider_config_id = $6::int AND provider_order_id = $7
        AND status IN ('created', 'attempted')
      RETURNING id`,
    entity.error_code ? String(entity.error_code).slice(0, 80) : null,
    entity.error_description ? String(entity.error_description).slice(0, 500) : null,
    tenant, config.provider, config.environment, Number(config.id), String(entity.order_id),
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
      WHERE tenant_id = $2::uuid AND provider = $3 AND environment = $4
        AND provider_config_id = $5::int AND provider_order_id = $6
        AND status = 'created'`,
    normalizeOrderMethod(entity.method),
    tenant, config.provider, config.environment, Number(config.id), String(entity.order_id),
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

const REFUND_VIEW_COLUMNS = `
  id, provider, environment, gateway_order_id, billing_refund_id,
  provider_payment_id, provider_refund_id, amount, currency, status, reason,
  initiated_by, initiated_at, processed_at, failed_at, failure_code,
  failure_reason, reconciled_at, reconciliation_note, reconciled_by,
  created_at, updated_at`;

export async function listReconciliationGatewayRefunds({
  tenantId, include_resolved = false, limit = 50, offset = 0,
} = {}) {
  const tenant = requireTenantId(tenantId);
  const safeLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 50, 200));
  const safeOffset = Math.max(0, Number.parseInt(offset, 10) || 0);
  const rows = await prisma.$queryRawUnsafe(
    `SELECT ${REFUND_VIEW_COLUMNS}
       FROM payment_gateway_refunds
      WHERE tenant_id = $1::uuid AND status = 'requires_reconciliation'
        AND ($2::boolean OR reconciled_at IS NULL)
      ORDER BY initiated_at ASC, id ASC
      LIMIT $3::int OFFSET $4::int`,
    tenant, include_resolved === true, safeLimit, safeOffset,
  );
  return {
    refunds: rows.map((row) => toGatewayRefundResult(row, false)),
    limit: safeLimit,
    offset: safeOffset,
  };
}

export async function resolveGatewayRefundReconciliation({
  tenantId, id, note, resolved_by,
}) {
  const tenant = requireTenantId(tenantId);
  const trimmedNote = String(note || '').trim();
  if (trimmedNote.length < 10 || trimmedNote.length > 500) {
    throw AppError.badRequest(
      'A reconciliation note of 10-500 chars describing the manual resolution is required',
      'PAYMENT_GATEWAY_REFUND_RECONCILIATION_NOTE_REQUIRED',
    );
  }
  if (typeof resolved_by !== 'string' || !resolved_by.trim()) {
    throw AppError.forbidden(
      'An authenticated operator is required to resolve gateway refund reconciliation',
      'PAYMENT_GATEWAY_REFUND_RECONCILIATION_ACTOR_REQUIRED',
    );
  }
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE payment_gateway_refunds
        SET reconciled_at = NOW(), reconciliation_note = $1,
            reconciled_by = $2::uuid, updated_at = NOW()
      WHERE id = $3::int AND tenant_id = $4::uuid
        AND status = 'requires_reconciliation' AND reconciled_at IS NULL
      RETURNING ${REFUND_VIEW_COLUMNS}`,
    trimmedNote, String(resolved_by), Number(id), tenant,
  );
  if (!rows.length) {
    const existing = await prisma.$queryRawUnsafe(
      `SELECT id, status, reconciled_at FROM payment_gateway_refunds
        WHERE id = $1::int AND tenant_id = $2::uuid LIMIT 1`,
      Number(id), tenant,
    );
    if (!existing.length) throw AppError.notFound('Payment gateway refund not found');
    throw AppError.conflict(
      existing[0].reconciled_at
        ? 'This gateway refund was already reconciled'
        : 'Gateway refund is not awaiting reconciliation',
      'PAYMENT_GATEWAY_REFUND_NOT_RECONCILABLE',
    );
  }
  logger.info('payment gateway refund manually reconciled', {
    gateway_refund_id: Number(rows[0].id),
    resolved_by: resolved_by ? String(resolved_by) : null,
  });
  return toGatewayRefundResult(rows[0], false);
}

const PROVIDER_REFUND_STATUSES = new Set(['pending', 'processed', 'failed']);

function refundEvidenceMismatches(intent, evidence, { expectedStatus = null } = {}) {
  const mismatches = [];
  const providerRefundId = String(evidence?.providerRefundId || '').trim();
  if (!isExactProviderIdentifier(intent.provider, 'refund', providerRefundId)
      || (intent.provider_refund_id && String(intent.provider_refund_id) !== providerRefundId)) {
    mismatches.push('refund_id');
  }
  if (!isExactProviderIdentifier(intent.provider, 'payment', evidence?.providerPaymentId)
      || String(evidence?.providerPaymentId || '') !== String(intent.provider_payment_id)) {
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
  if ((expectedStatus && status !== expectedStatus)
      || (!expectedStatus && !PROVIDER_REFUND_STATUSES.has(status))) {
    mismatches.push('status');
  }
  if (evidence?.billingRefundId !== undefined
      && Number(evidence.billingRefundId) !== Number(intent.billing_refund_id)) {
    mismatches.push('billing_refund_id');
  }
  return mismatches;
}

async function reopenRefundReconciliationForExactProviderEvidence({
  tenant, gatewayRefund, providerRefundId,
}) {
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE payment_gateway_refunds
        SET metadata = jsonb_set(
              COALESCE(metadata, '{}'::jsonb),
              '{provider_evidence_superseded_reconciliations}',
              (
                CASE
                  WHEN jsonb_typeof(metadata->'provider_evidence_superseded_reconciliations') = 'array'
                    THEN metadata->'provider_evidence_superseded_reconciliations'
                  ELSE '[]'::jsonb
                END
              ) || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
                'reconciled_at', reconciled_at,
                'reconciliation_note', reconciliation_note,
                'reconciled_by', reconciled_by,
                'provider_refund_id', $1::text,
                'superseded_by', 'exact_provider_processed_evidence'
              ))),
              true
            ),
            reconciled_at = NULL, reconciliation_note = NULL,
            reconciled_by = NULL, updated_at = NOW()
      WHERE id = $2::int AND tenant_id = $3::uuid
        AND status = 'requires_reconciliation' AND reconciled_at IS NOT NULL
      RETURNING id`,
    String(providerRefundId), Number(gatewayRefund.id), tenant,
  );
  if (rows.length) {
    logger.info('payment gateway refund reconciliation superseded by exact provider evidence', {
      gateway_refund_id: Number(gatewayRefund.id),
    });
  }
}

async function findGatewayRefundForWebhook({ tenant, config, entity }) {
  const providerRefundId = entity.id || null;
  const providerPaymentId = entity.payment_id || null;
  const billingRefundId = Number(entity.notes?.billing_refund_id);
  let rows = await prisma.$queryRawUnsafe(
    `SELECT refunds.*
       FROM payment_gateway_refunds AS refunds
       JOIN payment_gateway_orders AS orders
         ON orders.id = refunds.gateway_order_id
        AND orders.tenant_id = refunds.tenant_id
      WHERE refunds.tenant_id = $1::uuid
        AND refunds.provider = $2 AND refunds.environment = $3
        AND orders.provider_config_id = $4::int
        AND refunds.provider_refund_id = $5
      LIMIT 1`,
    tenant, config.provider, config.environment, Number(config.id), String(providerRefundId),
  );
  if (!rows.length && providerPaymentId
      && Number.isInteger(billingRefundId) && billingRefundId > 0) {
    // The callback can beat phase 3 after the irreversible provider call.
    // Payment id plus our billing-refund note is the exact committed intent;
    // payment id alone is ambiguous when one capture has partial refunds.
    rows = await prisma.$queryRawUnsafe(
      `SELECT refunds.*
         FROM payment_gateway_refunds AS refunds
         JOIN payment_gateway_orders AS orders
           ON orders.id = refunds.gateway_order_id
          AND orders.tenant_id = refunds.tenant_id
        WHERE refunds.tenant_id = $1::uuid
          AND refunds.provider = $2 AND refunds.environment = $3
          AND orders.provider_config_id = $4::int
          AND refunds.provider_payment_id = $5
          AND refunds.billing_refund_id = $6::int
          AND refunds.status IN ('initiated', 'pending', 'requires_reconciliation')
        ORDER BY refunds.id DESC
        LIMIT 1`,
      tenant, config.provider, config.environment, Number(config.id),
      String(providerPaymentId), billingRefundId,
    );
  }
  return {
    gatewayRefund: rows[0] || null,
    evidence: {
      providerRefundId,
      providerPaymentId,
      amountPaise: entity.amount,
      currency: entity.currency,
      status: entity.status,
      billingRefundId,
    },
  };
}

async function parkRefundEvidenceMismatch({ tenant, gatewayRefund, evidence, mismatches }) {
  const providerRefundId = String(evidence.providerRefundId || '').trim();
  const safeProviderRefundId = providerRefundId && providerRefundId.length <= 120
    ? providerRefundId
    : null;
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
    safeProviderRefundId, refundEvidenceMismatchReason(mismatches),
    Number(gatewayRefund.id), tenant,
  );
  return {
    outcome: 'requires_reconciliation',
    gatewayRefundId: Number(gatewayRefund.id),
    reason: refundEvidenceMismatchReason(mismatches),
  };
}

function refundEvidenceMismatchReason(mismatches) {
  return `Provider refund evidence mismatch: ${mismatches.join(', ')}`.slice(0, 500);
}

async function claimGatewayPayoutRailTx(tx, {
  tenant, billingRefundId, gatewayRefundId,
}) {
  const claimed = await tx.$executeRawUnsafe(
    `UPDATE billing_refunds AS refund
        SET payout_rail = 'gateway',
            payout_rail_claimed_at = COALESCE(payout_rail_claimed_at, NOW()),
            gateway_refund_id = $1::int,
            updated_at = NOW()
      WHERE refund.id = $2::int AND refund.tenant_id = $3::uuid
        AND refund.approval_status = 'APPROVED'
        AND (
          refund.payout_rail IS NULL
          OR (
            refund.payout_rail = 'gateway'
            AND (
              refund.gateway_refund_id IS NULL
              OR refund.gateway_refund_id = $1::int
              OR EXISTS (
                SELECT 1
                  FROM payment_gateway_refunds AS prior
                 WHERE prior.id = refund.gateway_refund_id
                   AND prior.tenant_id = refund.tenant_id
                   AND prior.status = 'failed'
              )
            )
          )
        )
      `,
    Number(gatewayRefundId), Number(billingRefundId), tenant,
  );
  if (Number(claimed) !== 1) {
    throw AppError.conflict(
      'The approved refund payout is already owned by another execution rail',
      'PAYMENT_GATEWAY_REFUND_PAYOUT_RAIL_CONFLICT',
    );
  }
}

/**
 * Initiate the provider refund for an APPROVED billing_refunds row whose
 * invoice was gateway-collected. Execution/evidence only — the approval
 * authority and the ledger REFUND_PAID posting stay with billingV2
 * (markGatewayRefundPaid, driven by exact refund.processed evidence).
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
              mode, approval_status, payout_rail, gateway_refund_id
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
    if (refund.payout_rail === 'manual') {
      throw AppError.conflict(
        'This approved refund is already claimed for manual payout',
        'PAYMENT_GATEWAY_REFUND_PAYOUT_RAIL_CONFLICT',
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
      await claimGatewayPayoutRailTx(tx, {
        tenant,
        billingRefundId: refund.id,
        gatewayRefundId: existing.id,
      });
      return { row: existing, replay: true, callProvider: false };
    }

    const orderRows = await tx.$queryRawUnsafe(
      `SELECT o.id, o.provider, o.environment, o.provider_config_id,
              o.provider_payment_id,
              o.amount, o.invoice_id, o.patient_uid::text, o.billing_payment_id,
              bp.invoice_id AS payment_invoice_id,
              bp.patient_uid::text AS payment_patient_uid, bp.mode AS payment_mode,
              pc.provider AS config_provider, pc.environment AS config_environment,
              pc.key_id, pc.key_secret_ciphertext,
              pc.webhook_credential_version
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
      await claimGatewayPayoutRailTx(tx, {
        tenant,
        billingRefundId: refund.id,
        gatewayRefundId: existing.id,
      });
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
          reason, initiated_by, webhook_credential_version)
       VALUES ($1::uuid, $2, $3, $4::int, $5::int, $6, $7, $8::numeric, 'INR',
               'initiated', $9, $10::uuid, $11::int)
       RETURNING *`,
      tenant, order.provider, order.environment, Number(order.id), Number(refund.id),
      String(order.provider_payment_id), newProviderIdempotencyKey, refundAmount,
      refund.reason ? String(refund.reason).slice(0, 500) : null,
      initiated_by ? String(initiated_by) : null,
      Number(order.webhook_credential_version || 1),
    );
    await claimGatewayPayoutRailTx(tx, {
      tenant,
      billingRefundId: refund.id,
      gatewayRefundId: rows[0].id,
    });
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
      receipt: gatewayRefundReceipt(intent.row, intent.order),
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

  if (providerRefund.status === 'processed') {
    try {
      const processed = await handleRefundProcessedEvent({
        tenantId: tenant,
        config: {
          id: Number(intent.order.provider_config_id),
          provider: intent.order.provider,
          environment: intent.order.environment,
        },
        payload: {
          payload: {
            refund: {
              entity: {
                id: providerRefund.providerRefundId,
                payment_id: providerRefund.providerPaymentId,
                amount: providerRefund.amountPaise,
                currency: providerRefund.currency,
                status: 'processed',
                notes: { billing_refund_id: String(intent.row.billing_refund_id) },
              },
            },
          },
        },
      });
      if (!['refund_processed', 'replay', 'requires_reconciliation'].includes(processed.outcome)) {
        throw new AppError(
          'Processed provider refund could not be correlated to its durable intent',
          502,
          'PAYMENT_GATEWAY_REFUND_CORRELATION_FAILED',
        );
      }
    } catch (err) {
      const parkedRows = await prisma.$queryRawUnsafe(
        `UPDATE payment_gateway_refunds
            SET provider_refund_id = COALESCE(provider_refund_id, $1),
                status = 'requires_reconciliation',
                failure_code = 'billing_refund_finalize_failed',
                failure_reason = $2, updated_at = NOW()
          WHERE id = $3::int AND tenant_id = $4::uuid
            AND status IN ('initiated', 'pending', 'requires_reconciliation')
          RETURNING *`,
        String(providerRefund.providerRefundId),
        `Provider refund processed but billing finalization failed: ${err?.code || 'internal_error'}`.slice(0, 500),
        Number(intent.row.id), tenant,
      );
      if (parkedRows.length) return toGatewayRefundResult(parkedRows[0], intent.replay);
      throw err;
    }
    const processedRows = await prisma.$queryRawUnsafe(
      `SELECT * FROM payment_gateway_refunds
        WHERE id = $1::int AND tenant_id = $2::uuid LIMIT 1`,
      Number(intent.row.id), tenant,
    );
    if (!processedRows.length) throw AppError.notFound('Gateway refund intent not found');
    return toGatewayRefundResult(processedRows[0], intent.replay);
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

function gatewayRefundReceipt(row, order = {}) {
  const identity = JSON.stringify([
    String(row.tenant_id),
    String(order.patient_uid || ''),
    'payment_gateway_refund',
    `billing_refund:${Number(row.billing_refund_id)}`,
    `gateway_order:${Number(row.gateway_order_id)}`,
    String(row.provider_idempotency_key),
  ]);
  return `pgr-${sha256Hex(identity).slice(0, 32)}`;
}

/**
 * Exact refund.processed provider evidence → mark the execution leg processed and drive
 * markGatewayRefundPaid (billingV2 authority; posts REFUND_PAID per ledger wiring)
 * with reference = provider_refund_id. Idempotent under redelivery: an
 * already-PAID billing refund is accepted as done, and an already-processed
 * execution row short-circuits to replay.
 */
export async function handleRefundProcessedEvent({ tenantId, config, payload }) {
  const tenant = requireTenantId(tenantId);
  const entity = payload?.payload?.refund?.entity || {};
  const providerRefundId = entity.id || null;
  if (!providerRefundId) return { outcome: 'ignored', reason: 'missing refund entity id' };
  const { gatewayRefund, evidence } = await findGatewayRefundForWebhook({
    tenant, config, entity,
  });
  if (!gatewayRefund) {
    return { outcome: 'ignored', reason: 'no matching gateway refund row' };
  }
  if (gatewayRefund.status === 'processed') {
    return { outcome: 'replay', gatewayRefundId: Number(gatewayRefund.id) };
  }

  const evidenceMismatches = refundEvidenceMismatches(
    gatewayRefund, evidence, { expectedStatus: 'processed' },
  );
  if (evidenceMismatches.length) {
    return parkRefundEvidenceMismatch({
      tenant, gatewayRefund, evidence, mismatches: evidenceMismatches,
    });
  }

  if (gatewayRefund.reconciled_at) {
    await reopenRefundReconciliationForExactProviderEvidence({
      tenant, gatewayRefund, providerRefundId,
    });
  }

  // Authority first: flip the billing refund APPROVED → PAID (its own
  // setTenantTx; idempotent via the status guard) with the provider refund id
  // as the payout reference. A crash between this and the execution-row
  // update self-heals on redelivery via the already-PAID acceptance below.
  if (gatewayRefund.billing_refund_id != null) {
    try {
      await markGatewayRefundPaid(Number(gatewayRefund.billing_refund_id), {
        tenantId: tenant,
        gateway_refund_id: Number(gatewayRefund.id),
        provider_refund_id: String(providerRefundId),
      });
    } catch (err) {
      const billingRows = await prisma.$queryRawUnsafe(
          `SELECT approval_status, payout_rail, gateway_refund_id, reference
             FROM billing_refunds
            WHERE id = $1::int AND tenant_id = $2::uuid LIMIT 1`,
          Number(gatewayRefund.billing_refund_id), tenant,
        );
      const billingRefund = billingRows[0] || null;
      const exactAlreadyPaid = err instanceof AppError && err.statusCode === 404
        && billingRefund?.approval_status === 'PAID'
        && billingRefund?.payout_rail === 'gateway'
        && Number(billingRefund?.gateway_refund_id) === Number(gatewayRefund.id)
        && String(billingRefund?.reference || '') === String(providerRefundId);
      if (!exactAlreadyPaid) {
        if (billingRefund?.approval_status === 'PAID'
            || err?.code === 'BILLING_REFUND_PAYOUT_RAIL_CONFLICT'
            || err?.code === 'BILLING_REFUND_GATEWAY_EXECUTION_CONFLICT') {
          await prisma.$executeRawUnsafe(
            `UPDATE payment_gateway_refunds
                SET status = 'requires_reconciliation',
                    failure_code = 'payout_rail_conflict',
                    failure_reason = $1, updated_at = NOW()
              WHERE id = $2::int AND tenant_id = $3::uuid
                AND status IN ('initiated', 'pending', 'requires_reconciliation')`,
            'Provider processed this refund but a different payout execution owns the billing refund',
            Number(gatewayRefund.id), tenant,
          );
          return {
            outcome: 'requires_reconciliation',
            gatewayRefundId: Number(gatewayRefund.id),
            billingRefundId: Number(gatewayRefund.billing_refund_id),
            reason: 'payout_rail_conflict',
          };
        }
        throw err;
      }
    }
  }

  const updated = await prisma.$queryRawUnsafe(
    `UPDATE payment_gateway_refunds
        SET status = 'processed',
            provider_refund_id = COALESCE(provider_refund_id, $1),
            processed_at = NOW(), updated_at = NOW()
      WHERE id = $2::int AND tenant_id = $3::uuid
        AND status IN ('initiated', 'pending', 'requires_reconciliation')
        AND (
          billing_refund_id IS NULL
          OR EXISTS (
            SELECT 1 FROM billing_refunds AS authority
             WHERE authority.id = payment_gateway_refunds.billing_refund_id
               AND authority.tenant_id = payment_gateway_refunds.tenant_id
               AND authority.payout_rail = 'gateway'
               AND authority.gateway_refund_id = payment_gateway_refunds.id
               AND authority.approval_status = 'PAID'
          )
        )
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
  const { gatewayRefund, evidence } = await findGatewayRefundForWebhook({
    tenant, config, entity,
  });
  if (!gatewayRefund) {
    return { outcome: 'ignored', reason: 'no matching in-flight gateway refund' };
  }
  if (gatewayRefund.reconciled_at) {
    return { outcome: 'replay', gatewayRefundId: Number(gatewayRefund.id) };
  }
  if (gatewayRefund.status === 'failed') {
    return { outcome: 'replay', gatewayRefundId: Number(gatewayRefund.id) };
  }
  const evidenceMismatches = refundEvidenceMismatches(
    gatewayRefund, evidence, { expectedStatus: 'failed' },
  );
  if (evidenceMismatches.length) {
    return parkRefundEvidenceMismatch({
      tenant, gatewayRefund, evidence, mismatches: evidenceMismatches,
    });
  }
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE payment_gateway_refunds
        SET status = 'failed', provider_refund_id = COALESCE(provider_refund_id, $1::varchar),
            failed_at = NOW(), failure_code = $2, failure_reason = $3, updated_at = NOW()
      WHERE id = $4::int AND tenant_id = $5::uuid
        AND status IN ('initiated', 'pending', 'requires_reconciliation')
      RETURNING id`,
    String(entity.id),
    entity.error_code ? String(entity.error_code).slice(0, 80) : null,
    entity.error_description ? String(entity.error_description).slice(0, 500) : 'provider reported refund failure',
    Number(gatewayRefund.id), tenant,
  );
  return rows.length
    ? { outcome: 'refund_failed_recorded', gatewayRefundId: Number(rows[0].id) }
    : { outcome: 'replay', gatewayRefundId: Number(gatewayRefund.id) };
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
