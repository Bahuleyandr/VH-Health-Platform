// src/services/portal/patientPortalService.js
//
// Sprint 10 — patient self-service surface. Exposes the read-side of
// billing + lab + the secure messaging inbox, all scoped to the
// authenticated patient via patient_uid in the JWT.
//
// Bill payment is delegated to the existing Sprint-4 paymentLinkService
// — the patient route lets a patient mint their own UPI link for an
// invoice they actually own.

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import * as paymentLinkService from '../billing/paymentLinkService.js';
import { sendPushNotification } from '../../utils/notifications/sendPushNotification.js';

// Fetch active FCM tokens for a patient. Returns [] when the patient
// has no registered devices — caller should treat the missing notif
// as best-effort, not a hard error.
async function fcmTokensForPatient(patient_uid) {
  if (!patient_uid) return [];
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT fcm_token FROM user_devices
        WHERE user_uid = $1::uuid
          AND fcm_token IS NOT NULL
          AND fcm_token <> ''`,
      String(patient_uid),
    );
    return rows.map((r) => r.fcm_token);
  } catch (err) {
    logger.warn('fcmTokensForPatient failed', { error: err.message });
    return [];
  }
}

// ── Bills ────────────────────────────────────────────────────────────

export async function listMyBills({ tenantId, patient_uid, status }) {
  if (!patient_uid) throw AppError.badRequest('patient_uid is required');
  const params = [tenantId, String(patient_uid)];
  let where = `tenant_id = $1::uuid AND patient_uid = $2::uuid`;
  if (status) {
    params.push(status);
    where += ` AND status = $${params.length}`;
  }
  return prisma.$queryRawUnsafe(
    `SELECT id, invoice_number, issued_at, created_at, invoice_type, status,
            subtotal, cgst_amount, sgst_amount, igst_amount,
            discount_amount, total_amount, amount_paid, amount_due
       FROM billing_invoices
      WHERE ${where}
      ORDER BY COALESCE(issued_at, created_at) DESC, id DESC
      LIMIT 200`,
    ...params,
  );
}

export async function getMyBill({ tenantId, patient_uid, id }) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, invoice_number, issued_at, created_at, invoice_type, status,
            subtotal, cgst_amount, sgst_amount, igst_amount,
            discount_amount, discount_reason, total_amount, amount_paid,
            amount_due, patient_uid, patient_state, hospital_state, tenant_id
       FROM billing_invoices
      WHERE id = $1::int AND tenant_id = $2::uuid AND patient_uid = $3::uuid`,
    Number(id), tenantId, String(patient_uid),
  );
  if (!rows.length) throw AppError.notFound('Bill not found');
  const items = await prisma.$queryRawUnsafe(
    `SELECT id, service_code, description, quantity, unit_price, gst_rate,
            line_subtotal, cgst_amount, sgst_amount, igst_amount, line_total,
            hsn_sac
       FROM billing_invoice_items
      WHERE invoice_id = $1::int
      ORDER BY id`,
    rows[0].id,
  );
  const payments = await prisma.$queryRawUnsafe(
    `SELECT id, amount, mode, reference, collected_at, reversed
       FROM billing_payments
      WHERE invoice_id = $1::int
      ORDER BY collected_at DESC`,
    rows[0].id,
  );
  return { invoice: rows[0], items, payments };
}

/**
 * Patient-initiated UPI payment link. We re-use Sprint 4 service but
 * lock the patient to their own invoice/uid; we never accept a body
 * patient_uid.
 */
export async function createSelfPaymentLink({
  tenantId, patient_uid, invoice_id,
}) {
  if (!invoice_id) throw AppError.badRequest('invoice_id is required');
  // Verify ownership before minting a link.
  const own = await prisma.$queryRawUnsafe(
    `SELECT id, amount_due FROM billing_invoices
      WHERE id = $1::int AND tenant_id = $2::uuid AND patient_uid = $3::uuid`,
    Number(invoice_id), tenantId, String(patient_uid),
  );
  if (!own.length) throw AppError.notFound('Bill not found or not yours');
  if (Number(own[0].amount_due) <= 0) {
    throw AppError.badRequest('Bill is already settled');
  }
  return paymentLinkService.createPaymentLink({
    tenantId,
    invoice_id: Number(invoice_id),
    patient_uid: String(patient_uid),
    amount: own[0].amount_due,
    created_by: patient_uid,
    notes: 'Patient self-initiated UPI link',
  });
}

// ── Lab results ──────────────────────────────────────────────────────
// Patients only see results that have been signed off (NABH 5.6
// principle — un-signed values can change).

// ── Patient-side invoice PDF (download bill) ─────────────────────────
//
// /portal/bills/:id renders the invoice + line items + payments to
// JSON, but the patient app's "Download bill" CTA needed a binary PDF
// for offline retention, employer reimbursement, and TPA dispute
// paperwork. Generates on every request (invoices are small, line
// counts bounded, payment history may have flipped after settlement).
// Finding 2026-05-10-tpa-insurance-claim-patient-final-bill-download-missing.
export async function generateMyInvoicePdfBuffer({ tenantId, patient_uid, id }) {
  if (!patient_uid) throw AppError.badRequest('patient_uid is required');
  const invoiceId = Number(id);
  if (!Number.isInteger(invoiceId) || invoiceId <= 0) {
    throw AppError.badRequest('invoice id must be a positive integer');
  }
  // IDOR: confirm the invoice belongs to this patient before
  // generating any binary. We never trust id alone.
  const owner = await prisma.$queryRawUnsafe(
    `SELECT id FROM billing_invoices
      WHERE id = $1::int AND tenant_id = $2::uuid AND patient_uid = $3::uuid`,
    invoiceId, tenantId, String(patient_uid),
  );
  if (!owner.length) throw AppError.notFound('Bill not found');

  const { generateInvoicePDF } = await import('../documents/clinicalPdfGenerator.js');
  return generateInvoicePDF(invoiceId);
}

// ── B-6 — patient-side discharge PDF ─────────────────────────────────

// tenantId reserved for future tenant scoping; currently unscoped per the in-flight finding.
export async function getMyDischargePdfUrl({ tenantId: _tenantId, patient_uid, admission_id }) {
  if (!patient_uid) throw AppError.badRequest('patient_uid is required');
  const id = Number(admission_id);
  if (!Number.isInteger(id) || id <= 0) {
    throw AppError.badRequest('admission_id must be a positive integer');
  }
  // IDOR: confirm the admission belongs to this patient before ever
  // touching the PDF generator. We never trust admission_id alone.
  const adRows = await prisma.$queryRawUnsafe(
    `SELECT id FROM admissions
      WHERE id = $1::int AND patient_uid = $2::uuid`,
    id, String(patient_uid),
  );
  if (!adRows.length) throw AppError.notFound('Admission not found');

  const { getOrGenerateDischargePdfUrl } = await import('../documents/clinicalPdfGenerator.js');
  return getOrGenerateDischargePdfUrl(id);
}

// ── Discharge summary read surface for patients ──────────────────────
//
// `discharge_summaries` (Sprint 11, structured template-driven path)
// previously had zero patient-facing HTTP route — the row existed in
// the DB but the patient app could not retrieve it. These exports add
// list + detail reads scoped to the authenticated patient's own
// patient_uid; we never trust admission_id or summary_id alone.
//
// Only signed/delivered summaries are visible to patients — drafts and
// ready_for_signoff are clinician-only WIP.

const PATIENT_VISIBLE_DISCHARGE_STATUSES = ['signed', 'delivered'];

export async function listMyDischargeSummaries({ tenantId, patient_uid, limit = 50 }) {
  if (!patient_uid) throw AppError.badRequest('patient_uid is required');
  return prisma.$queryRawUnsafe(
    `SELECT id, admission_id, primary_diagnosis,
            patient_name_snapshot, hospital_number,
            admitted_at, discharged_at, ward_at_discharge,
            status, signed_by_name, signed_at,
            delivered_at, delivery_method, created_at
       FROM discharge_summaries
      WHERE tenant_id = $1::uuid
        AND patient_uid = $2::uuid
        AND status = ANY($3::text[])
      ORDER BY COALESCE(signed_at, created_at) DESC, id DESC
      LIMIT $4::int`,
    tenantId, String(patient_uid),
    PATIENT_VISIBLE_DISCHARGE_STATUSES, Number(limit),
  );
}

async function fetchDischargeSummaryWithSections({ tenantId, patient_uid, where, ...params }) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, admission_id, patient_uid,
            patient_name_snapshot, age_years_snapshot, sex_snapshot,
            hospital_number, admitted_at, discharged_at,
            ward_at_discharge, primary_diagnosis, secondary_diagnoses,
            icd10_codes, procedures_performed,
            status, signed_by_name, signed_by_reg, signed_at,
            delivered_at, delivery_method, created_at, updated_at
       FROM discharge_summaries
      WHERE ${where}
        AND tenant_id = $1::uuid
        AND patient_uid = $2::uuid
        AND status = ANY($3::text[])
      LIMIT 1`,
    tenantId, String(patient_uid),
    PATIENT_VISIBLE_DISCHARGE_STATUSES,
    ...params.values,
  );
  if (!rows.length) {
    throw AppError.notFound('Discharge summary not found');
  }
  const summary = rows[0];
  const sections = await prisma.$queryRawUnsafe(
    `SELECT section_key, section_title, display_order, body
       FROM discharge_summary_sections
      WHERE discharge_summary_id = $1::int
      ORDER BY display_order, id`,
    summary.id,
  );
  return { ...summary, sections };
}

export async function getMyDischargeSummary({ tenantId, patient_uid, id }) {
  const summaryId = Number(id);
  if (!Number.isInteger(summaryId) || summaryId <= 0) {
    throw AppError.badRequest('Discharge summary id must be a positive integer');
  }
  return fetchDischargeSummaryWithSections({
    tenantId,
    patient_uid,
    where: 'id = $4::int',
    values: [summaryId],
  });
}

export async function getMyDischargeSummaryByAdmission({
  tenantId, patient_uid, admission_id,
}) {
  const adId = Number(admission_id);
  if (!Number.isInteger(adId) || adId <= 0) {
    throw AppError.badRequest('admission_id must be a positive integer');
  }
  // Multiple discharge_summaries rows can exist for a single admission
  // (e.g. amended summary after a coding correction). The latest
  // signed one is the legal copy the patient should see.
  return fetchDischargeSummaryWithSections({
    tenantId,
    patient_uid,
    where: `id = (
      SELECT id FROM discharge_summaries
       WHERE admission_id = $4::int
         AND tenant_id = $1::uuid
         AND patient_uid = $2::uuid
         AND status = ANY($3::text[])
       ORDER BY COALESCE(signed_at, created_at) DESC, id DESC
       LIMIT 1
    )`,
    values: [adId],
  });
}

// ── B-5 — patient-app TPA breakdown ──────────────────────────────────
//
// Patient self-service view of TPA claim status. The Sprint 5 TPA
// workflow (migration 153) lives in `tpa_claims`, distinct from the
// legacy billing-driven `insurance_claims`. See the table-split note
// in apps/backend/CLAUDE.md. Read-only — claim creation stays on the
// staff path (claimsService).

export async function listMyClaims({ tenantId, patient_uid, status = null }) {
  if (!patient_uid) throw AppError.badRequest('patient_uid is required');
  const params = [tenantId, String(patient_uid)];
  let where = 'tenant_id = $1::uuid AND patient_uid = $2::uuid';
  if (status) {
    params.push(status);
    where += ` AND status = $${params.length}`;
  }
  return prisma.$queryRawUnsafe(
    `SELECT id, claim_number, claim_type, total_billed, claimed_amount,
            approved_amount, paid_amount, non_payable_amount,
            patient_copay, status, submitted_at, paid_at,
            invoice_id, admission_id, denial_reason, tpa_reference_id
       FROM tpa_claims
      WHERE ${where}
      ORDER BY created_at DESC, id DESC
      LIMIT 100`,
    ...params,
  );
}

export async function getMyClaim({ tenantId, patient_uid, id }) {
  const claimRows = await prisma.$queryRawUnsafe(
    `SELECT c.id, c.claim_number, c.patient_uid, c.invoice_id,
            c.policy_id, c.preauth_id, c.admission_id,
            c.claim_type, c.total_billed, c.claimed_amount,
            c.approved_amount, c.paid_amount,
            c.non_payable_amount, c.patient_copay,
            c.status, c.submitted_at, c.paid_at,
            c.denial_reason, c.tpa_reference_id,
            c.created_at, c.updated_at,
            p.policy_number, p.policyholder_name, p.policy_type
       FROM tpa_claims c
       LEFT JOIN insurance_policies p ON p.id = c.policy_id
      WHERE c.id = $1::int
        AND c.tenant_id = $2::uuid
        AND c.patient_uid = $3::uuid`,
    Number(id), tenantId, String(patient_uid),
  );
  if (!claimRows.length) throw AppError.notFound('Claim not found');
  const claim = claimRows[0];

  // Linked invoice line totals per category (when invoice is linked).
  // The patient_responsibility is the gap between hospital_billed and
  // what the TPA approved, plus any pre-disclosed non_payable amount.
  let invoiceLines = [];
  let invoiceTotal = 0;
  if (claim.invoice_id) {
    const lines = await prisma.$queryRawUnsafe(
      `SELECT category, SUM(line_total)::numeric AS total
         FROM billing_invoice_items
        WHERE invoice_id = $1::int
        GROUP BY category
        ORDER BY category`,
      Number(claim.invoice_id),
    );
    invoiceLines = lines;
    invoiceTotal = lines.reduce((sum, l) => sum + Number(l.total || 0), 0);
  }

  const totalBilled = Number(claim.total_billed || 0);
  const claimedAmount = Number(claim.claimed_amount || 0);
  const approvedAmount = Number(claim.approved_amount || 0);
  const paidAmount = Number(claim.paid_amount || 0);
  const nonPayable = Number(claim.non_payable_amount || 0);
  const patientCopay = Number(claim.patient_copay || 0);
  const patientResponsibility = Math.max(
    0,
    nonPayable + patientCopay + Math.max(0, claimedAmount - approvedAmount)
  );

  return {
    claim,
    invoice_breakdown: {
      invoice_id: claim.invoice_id,
      lines: invoiceLines,
      total: invoiceTotal,
    },
    summary: {
      hospital_billed: totalBilled,
      tpa_claimed: claimedAmount,
      tpa_approved: approvedAmount,
      tpa_paid: paidAmount,
      patient_responsibility: patientResponsibility,
      currency: 'INR',
    },
  };
}

export async function listMyLabResults({ tenantId, patient_uid, limit = 100 }) {
  // `lab_results` has `performed_at` and `received_at` — never an
  // `observation_datetime` column. The earlier query 500ed on every
  // patient-portal lab-results load. Use `performed_at` as the canonical
  // observation timestamp and fall back to `received_at` when the
  // analyzer didn't report one (legacy HL7 paths). Exposed as
  // `observation_datetime` for backwards compatibility with the Flutter
  // patient app's lab_results_screen. See finding
  // 2026-05-10-lab-walk-in-patient-lab-results-portal-500.
  return prisma.$queryRawUnsafe(
    `SELECT id, test_code, test_name,
            COALESCE(performed_at, received_at) AS observation_datetime,
            value_text, value_numeric, unit, reference_range,
            abnormal_flag, signed_off_at
       FROM lab_results
      WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid
        AND signed_off_at IS NOT NULL
      ORDER BY COALESCE(performed_at, received_at) DESC NULLS LAST, id DESC
      LIMIT $3::int`,
    tenantId, String(patient_uid), Number(limit),
  );
}

export async function getMyLabResult({ tenantId, patient_uid, id }) {
  // Expose the `observation_datetime` alias alongside the row so the
  // Flutter app's detail screen and the list screen see the same field
  // — match the alias from listMyLabResults above.
  const rows = await prisma.$queryRawUnsafe(
    `SELECT *, COALESCE(performed_at, received_at) AS observation_datetime
       FROM lab_results
      WHERE id = $1::int AND tenant_id = $2::uuid AND patient_uid = $3::uuid
        AND signed_off_at IS NOT NULL`,
    Number(id), tenantId, String(patient_uid),
  );
  if (!rows.length) throw AppError.notFound('Lab result not found');
  return rows[0];
}

// ── Secure messaging (patient ↔ staff) ──────────────────────────────

export async function listMyThreads({ tenantId, patient_uid, status, limit = 50 }) {
  const params = [tenantId, String(patient_uid)];
  let where = `tenant_id = $1::uuid AND patient_uid = $2::uuid`;
  if (status) {
    params.push(status);
    where += ` AND status = $${params.length}`;
  }
  params.push(Number(limit));
  return prisma.$queryRawUnsafe(
    `SELECT id, subject, category, status, priority,
            last_message_at, last_message_by, patient_unread_count,
            assigned_staff_uid, created_at
       FROM patient_message_threads
      WHERE ${where}
      ORDER BY last_message_at DESC NULLS LAST
      LIMIT $${params.length}::int`,
    ...params,
  );
}

export async function getThread({ tenantId, patient_uid, thread_id, viewer_kind }) {
  // Staff can fetch any thread in their tenant; patient only their own.
  const params = [Number(thread_id), tenantId];
  let where = `id = $1::int AND tenant_id = $2::uuid`;
  if (viewer_kind === 'patient') {
    if (!patient_uid) throw AppError.badRequest('patient_uid is required');
    params.push(String(patient_uid));
    where += ` AND patient_uid = $${params.length}::uuid`;
  }
  const threadRows = await prisma.$queryRawUnsafe(
    `SELECT * FROM patient_message_threads WHERE ${where}`,
    ...params,
  );
  if (!threadRows.length) throw AppError.notFound('Thread not found');

  const messages = await prisma.$queryRawUnsafe(
    `SELECT * FROM patient_messages WHERE thread_id = $1::int ORDER BY created_at`,
    threadRows[0].id,
  );
  return { thread: threadRows[0], messages };
}

export async function startThread({
  tenantId, patient_uid, subject, category = 'general',
  body, attachments,
  related_invoice_id, related_lab_result_id, related_appointment_id,
}) {
  if (!patient_uid) throw AppError.badRequest('patient_uid is required');
  if (!subject) throw AppError.badRequest('subject is required');
  if (!body) throw AppError.badRequest('body is required');

  const tRows = await prisma.$queryRawUnsafe(
    `INSERT INTO patient_message_threads
       (patient_uid, subject, category,
        related_invoice_id, related_lab_result_id, related_appointment_id,
        status, last_message_at, last_message_by, staff_unread_count,
        created_by, tenant_id)
     VALUES ($1::uuid, $2, $3,
             $4::int, $5::int, $6::int,
             'awaiting_staff', NOW(), 'patient', 1,
             $1::uuid, $7::uuid)
     RETURNING *`,
    String(patient_uid), String(subject), category,
    related_invoice_id ? Number(related_invoice_id) : null,
    related_lab_result_id ? Number(related_lab_result_id) : null,
    related_appointment_id ? Number(related_appointment_id) : null,
    tenantId,
  );

  await prisma.$executeRawUnsafe(
    `INSERT INTO patient_messages
       (thread_id, sender_kind, sender_uid, body, attachments, tenant_id)
     VALUES ($1::int, 'patient', $2::uuid, $3, $4::jsonb, $5::uuid)`,
    tRows[0].id, String(patient_uid), String(body),
    JSON.stringify(attachments || []),
    tenantId,
  );

  return tRows[0];
}

/**
 * Append a message to an existing thread. sender_kind drives the
 * unread-counter and last-message bookkeeping.
 */
export async function appendMessage({
  tenantId, thread_id, sender_kind, sender_uid, sender_name,
  body, attachments, patient_uid,
}) {
  if (!thread_id) throw AppError.badRequest('thread_id is required');
  if (!body) throw AppError.badRequest('body is required');
  if (!['patient', 'staff', 'system'].includes(sender_kind)) {
    throw AppError.badRequest('sender_kind must be patient | staff | system');
  }

  // Verify access for patient senders.
  const owner = await prisma.$queryRawUnsafe(
    `SELECT id, patient_uid FROM patient_message_threads
      WHERE id = $1::int AND tenant_id = $2::uuid`,
    Number(thread_id), tenantId,
  );
  if (!owner.length) throw AppError.notFound('Thread not found');
  if (sender_kind === 'patient' && String(owner[0].patient_uid) !== String(patient_uid)) {
    throw AppError.forbidden('Not your thread');
  }

  const msgRows = await prisma.$queryRawUnsafe(
    `INSERT INTO patient_messages
       (thread_id, sender_kind, sender_uid, sender_name, body, attachments, tenant_id)
     VALUES ($1::int, $2, $3::uuid, $4, $5, $6::jsonb, $7::uuid)
     RETURNING *`,
    Number(thread_id), sender_kind,
    sender_uid ? String(sender_uid) : null,
    sender_name || null, String(body),
    JSON.stringify(attachments || []),
    tenantId,
  );

  // Update thread bookkeeping. If patient wrote, staff has unread; if
  // staff wrote, patient has unread. Either way last_message_*
  // updates and status flips to "awaiting_<other>".
  if (sender_kind === 'patient') {
    await prisma.$executeRawUnsafe(
      `UPDATE patient_message_threads
          SET last_message_at = NOW(), last_message_by = 'patient',
              staff_unread_count = staff_unread_count + 1,
              status = CASE WHEN status = 'closed' THEN status ELSE 'awaiting_staff' END,
              updated_at = NOW()
        WHERE id = $1::int`,
      Number(thread_id),
    );
  } else if (sender_kind === 'staff') {
    await prisma.$executeRawUnsafe(
      `UPDATE patient_message_threads
          SET last_message_at = NOW(), last_message_by = 'staff',
              patient_unread_count = patient_unread_count + 1,
              status = CASE WHEN status = 'closed' THEN status ELSE 'awaiting_patient' END,
              updated_at = NOW()
        WHERE id = $1::int`,
      Number(thread_id),
    );
    // Push notify the patient (best-effort, never blocks the reply).
    Promise.resolve()
      .then(async () => {
        const patientUid = owner[0].patient_uid;
        const tokens = await fcmTokensForPatient(patientUid);
        if (!tokens.length) return;
        // Fetch the thread subject to give the notification context
        // beyond "New message" — patients triage from the lock screen.
        const t = await prisma.$queryRawUnsafe(
          `SELECT subject FROM patient_message_threads WHERE id = $1::int`,
          Number(thread_id),
        );
        const subject = t[0]?.subject || 'New message';
        const preview = String(body).slice(0, 120);
        return sendPushNotification({
          tokens,
          title: subject,
          body: sender_name ? `${sender_name}: ${preview}` : preview,
          userId: String(patientUid),
          data: {
            type: 'patient_message',
            thread_id: String(thread_id),
            deep_link: `/portal/messages/${thread_id}`,
          },
        });
      })
      .catch((err) => {
        logger.warn('patient message push failed', {
          error: err.message,
          thread_id,
        });
      });
  } else {
    await prisma.$executeRawUnsafe(
      `UPDATE patient_message_threads
          SET last_message_at = NOW(), last_message_by = 'system', updated_at = NOW()
        WHERE id = $1::int`,
      Number(thread_id),
    );
  }
  return msgRows[0];
}

export async function markThreadRead({
  tenantId, thread_id, reader_kind, patient_uid,
}) {
  if (!['patient', 'staff'].includes(reader_kind)) {
    throw AppError.badRequest('reader_kind must be patient | staff');
  }
  // Verify ownership for patients.
  if (reader_kind === 'patient') {
    const own = await prisma.$queryRawUnsafe(
      `SELECT 1 FROM patient_message_threads
        WHERE id = $1::int AND tenant_id = $2::uuid AND patient_uid = $3::uuid`,
      Number(thread_id), tenantId, String(patient_uid),
    );
    if (!own.length) throw AppError.notFound('Thread not found');
  }
  if (reader_kind === 'patient') {
    await prisma.$executeRawUnsafe(
      `UPDATE patient_messages
          SET read_by_patient_at = COALESCE(read_by_patient_at, NOW())
        WHERE thread_id = $1::int`,
      Number(thread_id),
    );
    await prisma.$executeRawUnsafe(
      `UPDATE patient_message_threads SET patient_unread_count = 0, updated_at = NOW()
        WHERE id = $1::int`,
      Number(thread_id),
    );
  } else {
    await prisma.$executeRawUnsafe(
      `UPDATE patient_messages
          SET read_by_staff_at = COALESCE(read_by_staff_at, NOW())
        WHERE thread_id = $1::int`,
      Number(thread_id),
    );
    await prisma.$executeRawUnsafe(
      `UPDATE patient_message_threads SET staff_unread_count = 0, updated_at = NOW()
        WHERE id = $1::int`,
      Number(thread_id),
    );
  }
  return { ok: true };
}

// ── Staff inbox view ────────────────────────────────────────────────

export async function listStaffInbox({
  tenantId, status, priority, assigned_staff_uid, limit = 100,
}) {
  const params = [tenantId];
  const conds = [`tenant_id = $1::uuid`];
  if (status) { params.push(status); conds.push(`status = $${params.length}`); }
  if (priority) { params.push(priority); conds.push(`priority = $${params.length}`); }
  if (assigned_staff_uid) {
    params.push(String(assigned_staff_uid));
    conds.push(`assigned_staff_uid = $${params.length}::uuid`);
  }
  params.push(Number(limit));
  return prisma.$queryRawUnsafe(
    `SELECT id, patient_uid, subject, category, status, priority,
            last_message_at, last_message_by, staff_unread_count,
            assigned_staff_uid, created_at
       FROM patient_message_threads
      WHERE ${conds.join(' AND ')}
      ORDER BY priority = 'urgent' DESC, last_message_at DESC NULLS LAST
      LIMIT $${params.length}::int`,
    ...params,
  );
}

export async function assignThread({
  tenantId, thread_id, assigned_staff_uid,
}) {
  await prisma.$executeRawUnsafe(
    `UPDATE patient_message_threads
        SET assigned_staff_uid = $1::uuid, updated_at = NOW()
      WHERE id = $2::int AND tenant_id = $3::uuid`,
    assigned_staff_uid ? String(assigned_staff_uid) : null,
    Number(thread_id), tenantId,
  );
  return { ok: true };
}

export async function setThreadStatus({
  tenantId, thread_id, status, priority,
}) {
  const sets = [];
  const params = [];
  if (status) { params.push(status); sets.push(`status = $${params.length}`); }
  if (priority) { params.push(priority); sets.push(`priority = $${params.length}`); }
  if (!sets.length) return { ok: true };
  params.push(Number(thread_id));
  params.push(tenantId);
  await prisma.$executeRawUnsafe(
    `UPDATE patient_message_threads SET ${sets.join(', ')}, updated_at = NOW()
      WHERE id = $${params.length - 1}::int AND tenant_id = $${params.length}::uuid`,
    ...params,
  );
  return { ok: true };
}
