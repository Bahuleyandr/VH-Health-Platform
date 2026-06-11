// src/services/billing/paymentLinkService.js
//
// Sprint 4 — UPI / payment-gateway link creation, distribution, and
// reconciliation. Uses the existing sendWhatsApp / sendEmail
// notification infrastructure for distribution.

import { randomBytes } from 'node:crypto';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { sendEmail } from '../../utils/notifications/sendEmailNotification.js';
import { sendWhatsApp } from '../../utils/notifications/sendWhatsAppNotification.js';
import { AppError } from '../../utils/AppError.js';
import { collectPayment } from './billingV2Service.js';

const DEFAULT_EXPIRY_HOURS = 48;
const DEFAULT_TENANT_ID = '00000000-0000-4000-8000-000000000001';

function generateToken() {
  return randomBytes(24).toString('base64url');
}

function normalizeTenantId(tenantId) {
  return tenantId ? String(tenantId) : DEFAULT_TENANT_ID;
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
  const subject = await resolvePaymentLinkSubject({ tenantId: tenant, invoice_id, patient_uid });

  const vpa = process.env.HOSPITAL_UPI_VPA;
  const payeeName = process.env.HOSPITAL_UPI_PAYEE_NAME || process.env.HOSPITAL_NAME;

  if (provider === 'upi_intent' && (!vpa || !payeeName)) {
    throw AppError.badRequest(
      'UPI VPA + payee name required (set HOSPITAL_UPI_VPA + HOSPITAL_UPI_PAYEE_NAME or HOSPITAL_NAME env)',
    );
  }

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
 * Send the link to the patient via WhatsApp + (optionally) email.
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
  if (channels.includes('whatsapp') && patient_phone) {
    try {
      await sendWhatsApp({ to: patient_phone, body: messageBody });
      updates.sent_via_whatsapp_at = 'NOW()';
    } catch (e) {
      logger.warn('paymentLink WA send failed', { error: e.message, link_token });
    }
  }
  if (channels.includes('email') && patient_email) {
    try {
      await sendEmail({
        to: patient_email,
        subject: `Hospital bill — ${amountStr}`,
        html: `<p>Your bill of <strong>${amountStr}</strong> is ready.</p><p><a href="${shareUrl}">Pay now</a></p>`,
        text: messageBody,
      });
      updates.sent_via_email_at = 'NOW()';
    } catch (e) {
      logger.warn('paymentLink email send failed', { error: e.message, link_token });
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
  const link = await getPaymentLink({ tenantId, link_token });
  if (link.status === 'paid') throw AppError.badRequest('Already paid');
  if (link.status === 'cancelled' || link.status === 'expired') {
    throw AppError.badRequest(`Link is ${link.status}`);
  }

  // Convert paid_via to billing_payments mode. UPI / Card / etc.
  const modeMap = {
    upi: 'UPI', card: 'CARD', netbanking: 'NETBANKING',
    wallet: 'WALLET', other: 'UPI',
  };
  const mode = modeMap[(paid_via || 'upi').toLowerCase()] || 'UPI';

  // Create the payment row through the existing service so the parent
  // invoice's totals update consistently.
  const payment = await collectPayment({
    tenantId,
    invoice_id: link.invoice_id,
    patient_uid: link.patient_uid,
    amount: link.amount,
    mode,
    reference: paid_reference || link.upi_transaction_ref,
    collected_by: performed_by,
    notes: `Payment link ${link.link_token}`,
  });

  await prisma.$executeRawUnsafe(
    `UPDATE billing_payment_links
        SET status = 'paid', paid_at = NOW(),
            paid_via = $1, paid_reference = $2,
            linked_payment_id = $3::int, updated_at = NOW()
      WHERE id = $4::int`,
    paid_via || 'upi', paid_reference || null, payment.id, link.id,
  );

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
