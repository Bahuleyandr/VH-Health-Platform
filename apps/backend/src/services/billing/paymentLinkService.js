// src/services/billing/paymentLinkService.js
//
// Sprint 4 — UPI / payment-gateway link creation, distribution, and
// reconciliation. WhatsApp and email distribute through their own
// providers; SMS has no gateway, so it queues a notification-outbox intent
// and the link is NOT stamped as sent over that channel.

import { randomBytes } from 'node:crypto';
import prisma, { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { queuePatientSms } from '../../utils/notifications/smsOutbox.js';
import { sendEmail } from '../../utils/notifications/sendEmailNotification.js';
import { sendWhatsApp } from '../../utils/notifications/sendWhatsAppNotification.js';
import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { getTenantSettings } from '../tenant/tenantSettingsService.js';
import { collectPayment, deriveInvoicePaymentStateFromLedgerTx } from './billingV2Service.js';
import { postPaymentEntry } from './ledger/ledgerPostings.js';
import { resolveLedgerWiring } from './ledger/ledgerAuthoritativeMode.js';

const DEFAULT_EXPIRY_HOURS = 48;
const DEFAULT_TENANT_ID = '00000000-0000-4000-8000-000000000001';
const DEFAULT_PAYMENT_LINK_CHANNELS = ['whatsapp'];
const TELECONSULT_PAYMENT_LINK_NOTES_PREFIX = 'Teleconsult post-consult payment';

export const PAYMENT_LINK_CHANNELS = new Set(['sms', 'whatsapp', 'email']);

function generateToken() {
  return randomBytes(24).toString('base64url');
}

function normalizeTenantId(tenantId) {
  return tenantId ? String(tenantId) : DEFAULT_TENANT_ID;
}

export function normalizePaymentLinkChannels(channels, fallback = DEFAULT_PAYMENT_LINK_CHANNELS) {
  const raw = Array.isArray(channels)
    ? channels
    : (channels ? [channels] : []);
  const normalized = [];
  for (const channel of raw) {
    const value = String(channel || '').trim().toLowerCase();
    if (PAYMENT_LINK_CHANNELS.has(value) && !normalized.includes(value)) {
      normalized.push(value);
    }
  }
  if (normalized.length) return normalized;
  return Array.isArray(fallback) ? [...fallback] : DEFAULT_PAYMENT_LINK_CHANNELS;
}

export function resolveTeleconsultPaymentLinkConfig(settings = {}) {
  const raw = settings?.teleconsultPayments;
  if (!raw || typeof raw !== 'object' || raw.enabled !== true) {
    return {
      enabled: false,
      channels: DEFAULT_PAYMENT_LINK_CHANNELS,
      expiresInHours: DEFAULT_EXPIRY_HOURS,
    };
  }
  const expiresInHours = Number(raw.expiresInHours ?? raw.expires_in_hours ?? DEFAULT_EXPIRY_HOURS);
  return {
    enabled: true,
    channels: normalizePaymentLinkChannels(raw.channels),
    expiresInHours: Number.isFinite(expiresInHours) && expiresInHours > 0
      ? expiresInHours
      : DEFAULT_EXPIRY_HOURS,
  };
}

async function assertPatientInTenant(patientUid, tenantId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT uid
       FROM users
      WHERE uid = $1::uuid
        AND tenant_id = $2::uuid
      LIMIT 1`,
    String(patientUid),
    normalizeTenantId(tenantId),
  );
  if (!rows.length) throw AppError.notFound('Patient not found');
}

async function resolvePaymentLinkSubject({ tenantId, invoice_id, patient_uid }) {
  if (invoice_id) {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, patient_uid
         FROM billing_invoices
        WHERE id = $1::int
          AND tenant_id = $2::uuid
        LIMIT 1`,
      Number(invoice_id),
      normalizeTenantId(tenantId),
    );
    if (!rows.length) throw AppError.notFound('Invoice not found');
    if (patient_uid && String(patient_uid).toLowerCase() !== String(rows[0].patient_uid).toLowerCase()) {
      throw AppError.forbidden(
        'Payment link patient_uid must match the invoice patient',
        'PAYMENT_LINK_PATIENT_MISMATCH',
      );
    }
    return { invoiceId: Number(invoice_id), patientUid: rows[0].patient_uid };
  }

  if (!patient_uid) throw AppError.badRequest('patient_uid is required');
  await assertPatientInTenant(patient_uid, tenantId);
  return { invoiceId: null, patientUid: String(patient_uid) };
}

async function getTeleconsultPaymentContext({ tenantId, teleconsultationId }) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT tc.id,
            tc.appointment_id,
            COALESCE(tc.patient_uid, ap.uid) AS patient_uid,
            tc.status,
            tc.actual_end,
            COALESCE(tp.phone, ap.phone, a.phone) AS patient_phone,
            COALESCE(tp.email, ap.email) AS patient_email
       FROM teleconsultations tc
       LEFT JOIN appointments a
              ON a.id = tc.appointment_id
             AND a.tenant_id = tc.tenant_id
       LEFT JOIN users tp
              ON tp.uid = tc.patient_uid
             AND tp.tenant_id = tc.tenant_id
       LEFT JOIN users ap
              ON ap.id = a.patient_id
             AND ap.tenant_id = tc.tenant_id
      WHERE tc.id = $1::int
        AND tc.tenant_id = $2::uuid
      LIMIT 1`,
    Number(teleconsultationId),
    normalizeTenantId(tenantId),
  );
  return rows[0] || null;
}

async function findTeleconsultLinkedInvoice({ tenantId, teleconsultation, invoiceId = null }) {
  const params = [
    normalizeTenantId(tenantId),
    Number(teleconsultation.id),
    teleconsultation.appointment_id != null ? Number(teleconsultation.appointment_id) : null,
    String(teleconsultation.patient_uid),
  ];
  const invoiceSql = invoiceId ? ` AND bi.id = $${params.push(Number(invoiceId))}::int` : '';
  const rows = await prisma.$queryRawUnsafe(
    `SELECT bi.id,
            bi.invoice_number,
            bi.patient_uid,
            bi.patient_phone,
            bi.amount_due,
            bi.status,
            bi.tenant_id
       FROM billing_invoices bi
       JOIN billing_invoice_items bii
         ON bii.invoice_id = bi.id
        AND bii.tenant_id = bi.tenant_id
      WHERE bi.tenant_id = $1::uuid
        AND bi.patient_uid = $4::uuid
        ${invoiceSql}
        AND (
          (bii.source_ref_type = 'teleconsultation' AND bii.source_ref_id = $2::int)
          OR (
            $3::int IS NOT NULL
            AND bii.source_ref_type = 'appointment'
            AND bii.source_ref_id = $3::int
          )
        )
      ORDER BY CASE
                 WHEN bi.status IN ('ISSUED', 'PARTIAL') THEN 0
                 WHEN bi.status = 'DRAFT' THEN 1
                 ELSE 2
               END,
               bi.created_at DESC,
               bi.id DESC
      LIMIT 1`,
    ...params,
  );
  return rows[0] || null;
}

async function findReusablePaymentLinkForInvoice({ tenantId, invoiceId, amount }) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT *
       FROM billing_payment_links
      WHERE tenant_id = $1::uuid
        AND invoice_id = $2::int
        AND amount = $3::numeric
        AND status IN ('created', 'sent')
        AND (expires_at IS NULL OR expires_at > NOW())
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    normalizeTenantId(tenantId),
    Number(invoiceId),
    Number(amount),
  );
  return rows[0] || null;
}

/**
 * Build a UPI Intent deep link per the NPCI URI spec.
 * https://www.npci.org.in/PDF/npci/upi/circular/UPI%20Linking%20Specs.pdf
 *
 * Format: upi://pay?pa=<vpa>&pn=<name>&am=<amount>&cu=INR&tn=<note>&tr=<ref>
 */
export function buildUpiDeepLink({ vpa, name, amount, note, transactionRef }) {
  if (!vpa || !name || !amount) return null;
  const params = new URLSearchParams();
  params.set('pa', vpa);
  params.set('pn', name);
  params.set('am', String(Number(amount).toFixed(2)));
  params.set('cu', 'INR');
  if (note) params.set('tn', note);
  if (transactionRef) params.set('tr', transactionRef);
  // UPI parsers are picky about + vs %20 in tn; we do safe encoding.
  return `upi://pay?${params.toString()}`;
}

export async function createPaymentLink({
  tenantId, invoice_id, patient_uid, amount, currency = 'INR',
  provider = 'upi_intent', expires_in_hours, notes, created_by,
}) {
  if (!amount || Number(amount) <= 0) throw AppError.badRequest('amount must be > 0');
  const tenant = normalizeTenantId(tenantId);
  if (!invoice_id && !patient_uid) throw AppError.badRequest('patient_uid is required');

  const vpa = process.env.HOSPITAL_UPI_VPA;
  const payeeName = process.env.HOSPITAL_UPI_PAYEE_NAME || process.env.HOSPITAL_NAME;

  if (provider === 'upi_intent' && (!vpa || !payeeName)) {
    throw AppError.badRequest(
      'UPI VPA + payee name required (set HOSPITAL_UPI_VPA + HOSPITAL_UPI_PAYEE_NAME or HOSPITAL_NAME env)',
    );
  }

  const subject = await resolvePaymentLinkSubject({ tenantId: tenant, invoice_id, patient_uid });

  const token = generateToken();
  const transactionRef = `VH-${subject.invoiceId || 'AD'}-${token.slice(0, 10)}`;
  const deepLink = provider === 'upi_intent'
    ? buildUpiDeepLink({
        vpa, name: payeeName, amount, transactionRef,
        note: subject.invoiceId ? `Invoice ${subject.invoiceId}` : 'Hospital bill',
      })
    : null;

  const expiresAt = new Date();
  expiresAt.setHours(expiresAt.getHours() + (Number(expires_in_hours) || DEFAULT_EXPIRY_HOURS));

  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO billing_payment_links
       (link_token, invoice_id, patient_uid, amount, currency,
        upi_payee_vpa, upi_payee_name, upi_transaction_ref, upi_deep_link,
        provider, expires_at, notes, created_by, tenant_id)
     VALUES ($1, $2, $3::uuid, $4::numeric, $5, $6, $7, $8, $9,
             $10, $11::timestamptz, $12, $13::uuid, $14::uuid)
     RETURNING *`,
    token,
    subject.invoiceId,
    String(subject.patientUid), Number(amount), currency,
    vpa || null, payeeName || null, transactionRef, deepLink,
    provider, expiresAt.toISOString(), notes || null,
    created_by ? String(created_by) : null, tenant,
  );
  return rows[0];
}

export async function getPaymentLink({ tenantId, link_token }) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT * FROM billing_payment_links
      WHERE link_token = $1 AND tenant_id = $2::uuid`,
    String(link_token), tenantId,
  );
  if (!rows.length) throw AppError.notFound('Payment link not found');
  return rows[0];
}

/**
 * Send the link to the patient via SMS, WhatsApp, and/or email.
 * Records send timestamps on the link row.
 */
export async function sendPaymentLink({
  tenantId, link_token, channels = ['whatsapp'],
  patient_phone, patient_email,
}) {
  const link = await getPaymentLink({ tenantId, link_token });
  if (link.status === 'paid' || link.status === 'cancelled') {
    throw AppError.badRequest(`Link is ${link.status}, cannot resend`);
  }

  const baseUrl = process.env.HOSPITAL_PAY_BASE_URL || 'https://api.vhhealth.app/pay';
  const shareUrl = `${baseUrl}/${link.link_token}`;

  // Build a short message body. Localise via the hospital's preferred
  // language eventually; for MVP we keep it bilingual English+Hindi.
  const amountStr = `₹${Number(link.amount).toFixed(2)}`;
  const messageBody = [
    `Your hospital bill of ${amountStr} is ready.`,
    `Pay via UPI / card / wallet here: ${shareUrl}`,
    '',
    `बिल ₹${Number(link.amount).toFixed(2)} का तैयार है। भुगतान करें: ${shareUrl}`,
  ].join('\n');

  const updates = {};
  const requestedChannels = normalizePaymentLinkChannels(channels);
  // SMS has no configured gateway. Queue the durable intent on the
  // notification outbox and deliberately do NOT stamp sent_via_sms_at —
  // that column is a delivery claim, and nothing was delivered
  // (audit 2026-08-09 finding F7).
  if (requestedChannels.includes('sms') && patient_phone) {
    await queuePatientSms({
      tenantId,
      recipientId: link.patient_uid || null,
      recipientPhone: patient_phone,
      title: `Hospital bill — ${amountStr}`,
      // Never persist the link token in outbox payload metadata — it is a
      // bearer credential. It stays inside the message body only.
      body: messageBody,
      data: {
        type: 'billing_payment_link',
        payment_link_id: String(link.id),
        invoice_id: link.invoice_id === null || link.invoice_id === undefined
          ? null
          : String(link.invoice_id),
      },
      sourceEventKey: `billing-payment-link:${link.id}`,
      templateVersion: 'sms.billing_payment_link.v1',
      context: 'billing-payment-link',
    });
  }
  if (requestedChannels.includes('whatsapp') && patient_phone) {
    try {
      await sendWhatsApp({ to: patient_phone, body: messageBody });
      updates.sent_via_whatsapp_at = 'NOW()';
    } catch (e) {
      // Never log link_token — it is a bearer credential for the payment link.
      logger.warn('paymentLink WA send failed', { error: e.message, link_id: link.id });
    }
  }
  if (requestedChannels.includes('email') && patient_email) {
    try {
      await sendEmail({
        to: patient_email,
        subject: `Hospital bill — ${amountStr}`,
        html: `<p>Your bill of <strong>${amountStr}</strong> is ready.</p><p><a href="${shareUrl}">Pay now</a></p>`,
        text: messageBody,
      });
      updates.sent_via_email_at = 'NOW()';
    } catch (e) {
      logger.warn('paymentLink email send failed', { error: e.message, link_id: link.id });
    }
  }

  // Update sent-timestamps + status. Avoid SQL injection by setting
  // each column separately rather than building dynamic SQL with NOW().
  if (updates.sent_via_whatsapp_at) {
    await prisma.$executeRawUnsafe(
      `UPDATE billing_payment_links SET sent_via_whatsapp_at = NOW(),
              status = CASE WHEN status = 'created' THEN 'sent' ELSE status END,
              updated_at = NOW()
        WHERE id = $1::int`,
      link.id,
    );
  }
  // No sent_via_sms_at branch on purpose: the SMS channel has no gateway, so
  // there is never a send to stamp. Re-add it together with the provider
  // integration behind smsService.sendSMS.
  if (updates.sent_via_email_at) {
    await prisma.$executeRawUnsafe(
      `UPDATE billing_payment_links SET sent_via_email_at = NOW(),
              status = CASE WHEN status = 'created' THEN 'sent' ELSE status END,
              updated_at = NOW()
        WHERE id = $1::int`,
      link.id,
    );
  }
  return getPaymentLink({ tenantId, link_token: link.link_token });
}

export async function createTeleconsultPostConsultPaymentLink({
  tenantId, teleconsultation_id, invoice_id, created_by, channels,
  patient_phone, patient_email,
}) {
  const tenant = requireTenantId(normalizeTenantId(tenantId));
  if (!teleconsultation_id) {
    throw AppError.badRequest('teleconsultation_id is required');
  }

  const settings = await getTenantSettings(tenant);
  const config = resolveTeleconsultPaymentLinkConfig(settings);
  const teleconsultationId = Number(teleconsultation_id);
  if (!Number.isInteger(teleconsultationId) || teleconsultationId <= 0) {
    throw AppError.badRequest('teleconsultation_id must be a positive integer');
  }

  const teleconsultation = await getTeleconsultPaymentContext({ tenantId: tenant, teleconsultationId });
  if (!teleconsultation) throw AppError.notFound('Teleconsultation not found');

  const baseResult = {
    teleconsultation_id: teleconsultationId,
    appointment_id: teleconsultation.appointment_id != null ? Number(teleconsultation.appointment_id) : null,
    patient_uid: teleconsultation.patient_uid || null,
    invoice_id: invoice_id ? Number(invoice_id) : null,
    configured: config.enabled,
  };

  if (!config.enabled) {
    return { ...baseResult, status: 'skipped', reason: 'tenant_not_configured' };
  }
  if (String(teleconsultation.status || '').toLowerCase() !== 'completed') {
    return { ...baseResult, status: 'skipped', reason: 'teleconsultation_not_completed' };
  }
  if (!teleconsultation.patient_uid) {
    return { ...baseResult, status: 'skipped', reason: 'patient_not_resolved' };
  }

  const invoice = await findTeleconsultLinkedInvoice({
    tenantId: tenant,
    teleconsultation,
    invoiceId: invoice_id,
  });
  if (!invoice) {
    return { ...baseResult, status: 'skipped', reason: 'invoice_not_linked' };
  }

  const amountDue = Number(invoice.amount_due || 0);
  if (['PAID', 'VOID'].includes(String(invoice.status || '').toUpperCase()) || amountDue <= 0) {
    return {
      ...baseResult,
      invoice_id: Number(invoice.id),
      status: 'skipped',
      reason: 'invoice_not_payable',
    };
  }

  const requestedChannels = normalizePaymentLinkChannels(channels, config.channels);
  let link = await findReusablePaymentLinkForInvoice({
    tenantId: tenant,
    invoiceId: invoice.id,
    amount: amountDue,
  });
  const reused = Boolean(link);
  if (!link) {
    link = await createPaymentLink({
      tenantId: tenant,
      invoice_id: invoice.id,
      patient_uid: invoice.patient_uid,
      amount: amountDue,
      expires_in_hours: config.expiresInHours,
      notes: `${TELECONSULT_PAYMENT_LINK_NOTES_PREFIX}: consult ${teleconsultationId}` +
        (teleconsultation.appointment_id ? ` / appointment ${teleconsultation.appointment_id}` : ''),
      created_by,
    });
  }

  const sentLink = await sendPaymentLink({
    tenantId: tenant,
    link_token: link.link_token,
    channels: requestedChannels,
    patient_phone: patient_phone || invoice.patient_phone || teleconsultation.patient_phone || null,
    patient_email: patient_email || teleconsultation.patient_email || null,
  });

  return {
    ...baseResult,
    invoice_id: Number(invoice.id),
    payment_link_id: Number(sentLink.id),
    link: sentLink,
    status: reused ? 'reused' : 'created',
    sent: sentLink.status === 'sent',
    channels: requestedChannels,
    reused,
  };
}

/**
 * Manual reconciliation: cashier confirms the UPI/online payment
 * landed (verified in their bank app or gateway dashboard) and marks
 * the link paid. This creates the matching billing_payments row so
 * the invoice's amount_paid / amount_due / status update through
 * the same path as cash.
 */
export async function markPaymentLinkPaid({
  tenantId, link_token, paid_via, paid_reference, performed_by,
}) {
  // Convert paid_via to billing_payments mode. UPI / Card / etc.
  const modeMap = {
    upi: 'UPI', card: 'CARD', netbanking: 'NETBANKING',
    wallet: 'WALLET', other: 'UPI',
  };
  const mode = modeMap[(paid_via || 'upi').toLowerCase()] || 'UPI';

  // One atomic transaction for the whole reconcile: lock the link row FOR
  // UPDATE (so a double webhook / double-click can't both pass the
  // already-paid check), create the payment via collectPayment ON THE SAME tx
  // (no nested setTenantTx), then flip the link to paid. The payment INSERT is
  // additionally backstopped by migration 317's unique (tenant_id, reference,
  // mode) index, so even two links re-presenting the same gateway reference
  // collapse to one payment row.
  const wiring = await resolveLedgerWiring(requireTenantId(tenantId));
  const payment = await setTenantTx(requireTenantId(tenantId), async (tx) => {
    const linkRows = await tx.$queryRawUnsafe(
      `SELECT id, invoice_id, patient_uid, amount, upi_transaction_ref, status
         FROM billing_payment_links
        WHERE link_token = $1 AND tenant_id = $2::uuid
        FOR UPDATE`,
      String(link_token), normalizeTenantId(tenantId),
    );
    if (!linkRows.length) throw AppError.notFound('Payment link not found');
    const link = linkRows[0];
    if (link.status === 'paid') throw AppError.badRequest('Already paid');
    if (link.status === 'cancelled' || link.status === 'expired') {
      throw AppError.badRequest(`Link is ${link.status}`);
    }

    const createdPayment = await collectPayment({
      tenantId,
      invoice_id: link.invoice_id,
      patient_uid: link.patient_uid,
      amount: link.amount,
      mode,
      reference: paid_reference || link.upi_transaction_ref,
      collected_by: performed_by,
      notes: `Payment link ${link_token}`,
    }, { tx });

    await tx.$executeRawUnsafe(
      `UPDATE billing_payment_links
          SET status = 'paid', paid_at = NOW(),
              paid_via = $1, paid_reference = $2,
              linked_payment_id = $3::int, updated_at = NOW()
        WHERE id = $4::int`,
      paid_via || 'upi', paid_reference || null, createdPayment.id, link.id,
    );
    // Phase 4 enforce: collectPayment(tx) skips its own post (caller-owned tx);
    // post the PAYMENT here INSIDE the link tx so a ledger failure rolls back.
    if (wiring.sameTx) {
      await postPaymentEntry({ payment: createdPayment, tenantId: requireTenantId(tenantId), tx });
      // Phase 4-3: derive the invoice cache columns from the ledger.
      if (createdPayment.invoice_id) await deriveInvoicePaymentStateFromLedgerTx(tx, createdPayment.invoice_id);
    }
    return createdPayment;
  });

  // Shadow: collectPayment(tx) skipped its inline post, so post here post-commit
  // best-effort after the link tx commits — keeps the live payment-link path
  // unbreakable by the ledger. Off: skip.
  if (wiring.postCommit) {
    try {
      await postPaymentEntry({ payment, tenantId: requireTenantId(tenantId) });
    } catch (ledgerErr) {
      logger.error('Ledger PAYMENT post (payment-link) failed (non-blocking)', { payment_id: payment?.id, error: ledgerErr.message });
    }
  }

  return { link: await getPaymentLink({ tenantId, link_token }), payment };
}

export async function cancelPaymentLink({ tenantId, link_token, reason }) {
  const link = await getPaymentLink({ tenantId, link_token });
  if (link.status === 'paid') throw AppError.badRequest('Cannot cancel a paid link');
  await prisma.$executeRawUnsafe(
    `UPDATE billing_payment_links
        SET status = 'cancelled', cancelled_at = NOW(),
            notes = COALESCE(notes, '') || $1,
            updated_at = NOW()
      WHERE id = $2::int`,
    reason ? `\n[cancelled] ${reason}` : '\n[cancelled]', link.id,
  );
  return getPaymentLink({ tenantId, link_token });
}

/**
 * Cron-friendly: mark any created/sent links past their expires_at
 * as 'expired'. Idempotent.
 */
export async function expireStaleLinks() {
  const result = await prisma.$executeRawUnsafe(
    `UPDATE billing_payment_links
        SET status = 'expired', updated_at = NOW()
      WHERE status IN ('created', 'sent')
        AND expires_at < NOW()`,
  );
  return { expired: result };
}

export async function listPaymentLinks({ tenantId, patient_uid, status, invoice_id, limit = 100 }) {
  const params = [tenantId];
  const where = [`tenant_id = $1::uuid`];
  if (patient_uid) { params.push(String(patient_uid)); where.push(`patient_uid = $${params.length}::uuid`); }
  if (status) { params.push(status); where.push(`status = $${params.length}`); }
  if (invoice_id) { params.push(Number(invoice_id)); where.push(`invoice_id = $${params.length}::int`); }
  params.push(Number(limit));
  return prisma.$queryRawUnsafe(
    `SELECT id, link_token, invoice_id, patient_uid, amount, currency,
            upi_deep_link, provider, status, expires_at, paid_at, paid_via,
            sent_via_whatsapp_at, sent_via_sms_at, sent_via_email_at,
            created_at
       FROM billing_payment_links
      WHERE ${where.join(' AND ')}
      ORDER BY created_at DESC
      LIMIT $${params.length}::int`,
    ...params,
  );
}
