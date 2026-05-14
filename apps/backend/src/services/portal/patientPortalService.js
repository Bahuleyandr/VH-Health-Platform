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
  let invoiceStatusClause = '';
  let pharmacyStatusClause = '';
  if (status) {
    params.push(status);
    invoiceStatusClause = ` AND status = $${params.length}`;
    // pharmacy_orders tracks settlement on `payment_status`, not
    // `status` — match the same filter value against it (case-
    // insensitive: invoice statuses are upper-case, pharmacy
    // payment_status is lower-case) so ?status=pending narrows both.
    pharmacyStatusClause = ` AND LOWER(po.payment_status) = LOWER($${params.length})`;
  }
  // A DISPENSED pharmacy order with payment_status=pending and no
  // billing_invoices row never surfaced on the patient's Bills tab —
  // the patient could see the payable charge nowhere and could not
  // self-serve payment or claim a receipt for TPA paperwork. UNION the
  // unsettled, un-invoiced pharmacy-order charges into the list so they
  // show alongside formal invoices; `source` discriminates the two so
  // the patient app can branch on tap. Finding
  // 2026-05-10-walk-in-opd-patient-bills-empty-despite-pending-pharmacy-charge.
  return prisma.$queryRawUnsafe(
    `SELECT id, invoice_number, issued_at, created_at, invoice_type, status,
            subtotal, cgst_amount, sgst_amount, igst_amount,
            discount_amount, total_amount, amount_paid, amount_due,
            'invoice' AS source
       FROM billing_invoices
      WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid${invoiceStatusClause}
      UNION ALL
     SELECT po.id, po.order_number AS invoice_number,
            po.ordered_at::timestamptz AS issued_at,
            po.created_at::timestamptz AS created_at,
            'pharmacy_order' AS invoice_type,
            po.payment_status AS status,
            po.total_amount AS subtotal,
            0::numeric AS cgst_amount, 0::numeric AS sgst_amount,
            0::numeric AS igst_amount, 0::numeric AS discount_amount,
            po.total_amount,
            0::numeric AS amount_paid,
            po.total_amount AS amount_due,
            'pharmacy_order' AS source
       FROM pharmacy_orders po
       JOIN users u ON u.id = po.patient_id
      WHERE u.uid = $2::uuid
        AND po.total_amount > 0
        AND LOWER(po.payment_status) NOT IN ('paid', 'waived', 'cancelled')
        AND UPPER(po.status) <> 'CANCELLED'
        AND NOT EXISTS (
          SELECT 1 FROM billing_invoice_items bii
           WHERE bii.source_ref_type = 'pharmacy_order'
             AND bii.source_ref_id = po.id
        )${pharmacyStatusClause}
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
  // Wave-5 batch-3 — include the TPA-decision columns so the patient
  // app's bill detail can banner non-payable lines as they're flagged.
  // Migration 216 added the four columns; null defaults are surfaced
  // as 'pending' on the client. Finding:
  //   2026-05-09-tpa-insurance-claim-discharge-nonpayable-not-disclosed-proactively
  const items = await prisma.$queryRawUnsafe(
    `SELECT id, service_code, description, quantity, unit_price, gst_rate,
            line_subtotal, cgst_amount, sgst_amount, igst_amount, line_total,
            hsn_sac,
            source_ref_type, source_ref_id,
            tpa_decision, tpa_non_payable_reason, tpa_decided_at
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
  // Wave-5 batch-2 — Insurance / TPA breakdown. Surface the linked
  // tpa_claims row and any per-line decisions from tpa_claim_line_decisions
  // (migration 211, separately-numbered) so cashless patients see IRDAI-
  // required itemised non-payable explanations. Cash-payer invoices
  // return null tpa_breakdown.
  // Finding 2026-05-09-tpa-insurance-claim-patient-bill-no-disallowance-breakdown.
  const tpaBreakdown = await resolveBillTpaBreakdown({ invoice_id: rows[0].id });

  // Wave-5 batch-3 — non-payable preview rollup from the billing_invoice_items
  // columns added in migration 216 (`tpa_decision`, `tpa_non_payable_reason`).
  // Complements the tpa_breakdown above: tpa_breakdown is the FINAL insurer-
  // verdict view (post-TPA reply); non_payable_preview is the running
  // prediction from the auto-itemizer (proactive disclosure as items
  // accumulate, before TPA responds).
  // Finding: 2026-05-09-tpa-insurance-claim-discharge-nonpayable-not-disclosed-proactively.
  let nonPayableTotal = 0;
  let nonPayableLineCount = 0;
  const nonPayableReasons = {};
  for (const it of items) {
    if (it.tpa_decision === 'non_payable' || it.tpa_decision === 'partial') {
      nonPayableTotal += Number(it.line_total || 0);
      nonPayableLineCount += 1;
      const reason = it.tpa_non_payable_reason || 'other';
      nonPayableReasons[reason] = (nonPayableReasons[reason] || 0) + Number(it.line_total || 0);
    }
  }
  const non_payable_preview = {
    total: Math.round(nonPayableTotal * 100) / 100,
    line_count: nonPayableLineCount,
    reasons: nonPayableReasons,
  };

  return { invoice: rows[0], items, payments, tpa_breakdown: tpaBreakdown, non_payable_preview };
}

// Plain-language explanations for tpa_claim_line_decisions.reason_code.
// The DB CHECK constraint enforces this set; the app maps each code to a
// patient-friendly label so the bill never surfaces a raw insurer code.
const TPA_REASON_LABELS = {
  room_upgrade: 'Room upgrade beyond policy entitlement',
  over_cap_pharmacy: 'Pharmacy charges above policy cap',
  over_cap_consumables: 'Consumables above policy cap',
  non_listed: 'Item not covered by the policy',
  partial_approval: 'Partial approval — balance is patient share',
  co_pay: 'Policy co-pay portion',
  sub_limit: 'Sub-limit reached for this category',
  pre_existing_waiting: 'Pre-existing condition still under waiting period',
  other: 'Other — see notes',
};

async function resolveBillTpaBreakdown({ invoice_id }) {
  // tpa_claims.invoice_id is the FK — at most one claim per invoice in
  // the cashless workflow. Reimbursement claims may not link an invoice
  // at all (filed after discharge). We tolerate the empty case.
  let claimRows = [];
  try {
    claimRows = await prisma.$queryRawUnsafe(
      `SELECT id, claim_number, claim_type, total_billed, claimed_amount,
              approved_amount, paid_amount, non_payable_amount,
              patient_copay, status, denial_reason
         FROM tpa_claims
        WHERE invoice_id = $1::int
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
      Number(invoice_id),
    );
  } catch (err) {
    // Under-migrated tenants: tpa_claims table missing → not a TPA bill.
    if (err?.meta?.code !== '42P01') throw err;
    return null;
  }
  if (!claimRows.length) return null;
  const claim = claimRows[0];

  let decisions = [];
  try {
    decisions = await prisma.$queryRawUnsafe(
      `SELECT d.id, d.invoice_item_id, d.reason_code, d.reason_text,
              d.approved_amount, d.non_payable_amount, d.recorded_at,
              i.description AS item_description, i.line_total AS item_line_total
         FROM tpa_claim_line_decisions d
         JOIN billing_invoice_items i ON i.id = d.invoice_item_id
        WHERE d.claim_id = $1::int
        ORDER BY i.id`,
      Number(claim.id),
    );
  } catch (err) {
    // Migration 211 not yet applied on this tenant — return claim totals
    // only. The patient still sees the aggregate non_payable_amount.
    if (err?.meta?.code !== '42P01') throw err;
  }

  // Surface the latest insurer correspondence (if any) so the patient
  // sees the same plain-language note the staff received from the TPA.
  let latestInsurerMessage = null;
  try {
    const corrRows = await prisma.$queryRawUnsafe(
      `SELECT subject, body, recorded_at
         FROM tpa_claim_correspondence
        WHERE claim_id = $1::int AND direction = 'inbound'
        ORDER BY recorded_at DESC, id DESC
        LIMIT 1`,
      Number(claim.id),
    );
    if (corrRows.length) latestInsurerMessage = corrRows[0];
  } catch (err) {
    if (err?.meta?.code !== '42P01') throw err;
  }

  return {
    claim,
    line_decisions: decisions.map((d) => ({
      ...d,
      reason_label: TPA_REASON_LABELS[d.reason_code] || TPA_REASON_LABELS.other,
    })),
    latest_insurer_message: latestInsurerMessage,
    summary: {
      hospital_billed: Number(claim.total_billed || 0),
      tpa_approved: Number(claim.approved_amount || 0),
      tpa_paid: Number(claim.paid_amount || 0),
      non_payable: Number(claim.non_payable_amount || 0),
      patient_copay: Number(claim.patient_copay || 0),
      currency: 'INR',
    },
  };
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

// ── Clinical notes read surface for patients ─────────────────────────
//
// /api/v1/emr/notes is gated by CLINICAL_STAFF_ROLES, so PATIENT
// requests come back 403. Patients still need to read their own
// progress notes — the "completed follow-up with no new Rx" case
// is the most common: the doctor's plan is in clinical_notes and
// the patient app has nowhere to surface it. These exports add a
// patient-scoped read surface that mirrors what the staff timeline
// would show, filtered to the authenticated patient_uid and
// restricted to note types the patient should see.
//
// We hide nursing assessments (those are internal handover artifacts)
// and unsigned drafts (patients should never see un-finalised notes).
// Doctor-authored progress / discharge / SOAP / procedure notes pass.

const PATIENT_VISIBLE_NOTE_TYPES = [
  'progress',
  'soap',
  'discharge',
  'procedure',
  'consultation',
  'follow_up',
  'follow-up',
];

export async function listMyClinicalNotes({ patient_uid, limit = 100, note_type = null }) {
  if (!patient_uid) throw AppError.badRequest('patient_uid is required');
  const types = note_type
    ? [String(note_type).toLowerCase()]
    : PATIENT_VISIBLE_NOTE_TYPES;
  return prisma.$queryRawUnsafe(
    `SELECT id, patient_uid, encounter_id, author_uid, author_role,
            note_type, title, content, version, is_addendum,
            is_signed, signed_at, parent_note_id,
            created_at, updated_at
       FROM clinical_notes
      WHERE patient_uid = $1::uuid
        AND is_signed = TRUE
        AND lower(note_type) = ANY($2::text[])
      ORDER BY created_at DESC, id DESC
      LIMIT $3::int`,
    String(patient_uid), types, Number(limit),
  );
}

export async function getMyClinicalNote({ patient_uid, id }) {
  const noteId = Number(id);
  if (!Number.isInteger(noteId) || noteId <= 0) {
    throw AppError.badRequest('clinical note id must be a positive integer');
  }
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, patient_uid, encounter_id, author_uid, author_role,
            note_type, title, content, version, is_addendum,
            is_signed, signed_at, parent_note_id,
            created_at, updated_at
       FROM clinical_notes
      WHERE id = $1::int
        AND patient_uid = $2::uuid
        AND is_signed = TRUE
        AND lower(note_type) = ANY($3::text[])`,
    noteId, String(patient_uid), PATIENT_VISIBLE_NOTE_TYPES,
  );
  if (!rows.length) throw AppError.notFound('Clinical note not found');
  return rows[0];
}

export async function listMyClinicalNotesForAppointment({ patient_uid, appointment_id }) {
  if (!patient_uid) throw AppError.badRequest('patient_uid is required');
  const apptId = Number(appointment_id);
  if (!Number.isInteger(apptId) || apptId <= 0) {
    throw AppError.badRequest('appointment_id must be a positive integer');
  }
  // clinical_notes has no direct appointment_id FK — the link lives
  // in content->>'appointment_id' when the doctor's note-writer
  // attaches it. Fall back to a 24h time window around the
  // appointment for legacy notes that don't carry the attribute.
  const apptRows = await prisma.$queryRawUnsafe(
    `SELECT a.id, a.created_at, a.appointment_date, a.appointment_time,
            COALESCE(u.uid, a.uid) AS patient_uid
       FROM appointments a
       LEFT JOIN users u ON u.id = a.patient_id
      WHERE a.id = $1::int`,
    apptId,
  );
  if (!apptRows.length) throw AppError.notFound('Appointment not found');
  const appt = apptRows[0];
  if (String(appt.patient_uid) !== String(patient_uid)) {
    throw AppError.notFound('Appointment not found');
  }
  return prisma.$queryRawUnsafe(
    `SELECT id, patient_uid, encounter_id, author_uid, author_role,
            note_type, title, content, version, is_addendum,
            is_signed, signed_at, parent_note_id,
            created_at, updated_at
       FROM clinical_notes
      WHERE patient_uid = $1::uuid
        AND is_signed = TRUE
        AND lower(note_type) = ANY($2::text[])
        AND (
          (content ? 'appointment_id'
           AND (content->>'appointment_id')::int = $3::int)
          OR
          (NOT (content ? 'appointment_id')
           AND created_at >= $4::timestamptz - INTERVAL '24 hours'
           AND created_at <= $4::timestamptz + INTERVAL '7 days')
        )
      ORDER BY created_at ASC, id ASC`,
    String(patient_uid),
    PATIENT_VISIBLE_NOTE_TYPES,
    apptId,
    appt.created_at,
  );
}

// ── Patient-side Rx PDF (download prescription) ──────────────────────
//
// e_prescriptions.pdf_key is stamped at create-time by
// ePrescriptionController.generatePrescriptionPDF, but the upload to
// R2 is best-effort and silently swallows R2 outages — leaving pdf_key
// null forever for that row. Patients hitting "Download" on a
// prescription with pdf_key null currently get a 404 from the staff
// downloadPrescriptionPDF endpoint. This service:
//   - Verifies the prescription belongs to the authenticated patient
//   - Returns the existing signed URL if pdf_key is set
//   - Otherwise regenerates the PDF, uploads, stamps pdf_key, returns
// Finding 2026-05-10-pediatric-opd-patient-weight-based-rx-pdf-missing.
export async function getOrGenerateMyPrescriptionPdfUrl({ patient_uid, prescription_id }) {
  if (!patient_uid) throw AppError.badRequest('patient_uid is required');
  const id = Number(prescription_id);
  if (!Number.isInteger(id) || id <= 0) {
    throw AppError.badRequest('prescription id must be a positive integer');
  }

  // IDOR: patient_uid join. Prescriptions created via legacy paths
  // may have patient_uid null but patient_id set; fall back to a
  // uid→id lookup so those still resolve.
  const rows = await prisma.$queryRawUnsafe(
    `SELECT ep.id, ep.pdf_key, ep.patient_id, ep.patient_uid,
            ep.prescription_number
       FROM e_prescriptions ep
      WHERE ep.id = $1::int
        AND (
          ep.patient_uid = $2::uuid
          OR ep.patient_id = (SELECT id FROM users WHERE uid = $2::uuid LIMIT 1)
        )`,
    id, String(patient_uid),
  );
  if (!rows.length) throw AppError.notFound('Prescription not found');
  const rx = rows[0];

  const { uploadFileToR2, getSignedFileUrl } = await import('../../utils/r2Storage.js');

  if (rx.pdf_key) {
    try {
      const url = await getSignedFileUrl(rx.pdf_key, 3600);
      return { key: rx.pdf_key, url, generated: false };
    } catch (e) {
      logger.warn(`Persisted Rx PDF key resolved but signed URL failed: ${e.message}; regenerating`);
    }
  }

  // Lazy regeneration. We reach into the controller's
  // generatePrescriptionPDF helper rather than duplicating layout.
  // The helper is a pure renderer over (prescription, patient,
  // doctor) — no res handle required.
  const { generatePrescriptionPDFBuffer } = await import('../prescription/prescriptionPdfHelper.js');
  const detail = await prisma.$queryRawUnsafe(
    `SELECT ep.id, ep.appointment_id, ep.patient_id, ep.doctor_id,
            ep.prescription_number, ep.diagnosis, ep.clinical_notes,
            ep.medications, ep.vitals, ep.follow_up_date,
            ep.follow_up_notes, ep.created_at,
            p.name AS patient_name, p.phone AS patient_phone,
            p.gender AS patient_gender, p.birthday AS patient_birthday,
            d.name AS doctor_name, doc.specialty AS doctor_specialization
       FROM e_prescriptions ep
       LEFT JOIN users p ON p.id = ep.patient_id
       LEFT JOIN users d ON d.id = ep.doctor_id
       LEFT JOIN doctors doc ON doc.user_id = ep.doctor_id
      WHERE ep.id = $1::int`,
    id,
  );
  if (!detail.length) throw AppError.notFound('Prescription detail not found');
  const row = detail[0];

  const buffer = await generatePrescriptionPDFBuffer(
    {
      id: row.id,
      prescription_number: row.prescription_number,
      diagnosis: row.diagnosis,
      clinical_notes: row.clinical_notes,
      medications: row.medications,
      vitals: row.vitals,
      follow_up_date: row.follow_up_date,
      follow_up_notes: row.follow_up_notes,
      created_at: row.created_at,
    },
    {
      name: row.patient_name,
      phone: row.patient_phone,
      gender: row.patient_gender,
      birthday: row.patient_birthday,
    },
    {
      name: row.doctor_name,
      specialization: row.doctor_specialization,
    },
  );

  const key = `prescriptions/pdf/${row.prescription_number || `rx-${row.id}-${Date.now()}`}.pdf`;
  await uploadFileToR2(buffer, key, 'application/pdf');
  await prisma.$executeRawUnsafe(
    `UPDATE e_prescriptions SET pdf_key = $1, updated_at = NOW() WHERE id = $2::int`,
    key, id,
  );
  const url = await getSignedFileUrl(key, 3600);
  return { key, url, generated: true };
}

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
            delivered_at, delivery_method, summary_language,
            created_at, updated_at
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
  // `body_translations` carries the language-tagged section bodies
  // (e.g. {"ta": "..."}) so a Tamil-speaking patient's app can render
  // the discharge instructions in their own language. Migration 231.
  const sections = await prisma.$queryRawUnsafe(
    `SELECT section_key, section_title, display_order, body, body_translations
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

  // Surface the recorded TPA correspondence so the patient can see WHY
  // an amount was disallowed in plain language rather than just an
  // unexplained INR delta. `tpa_claim_correspondence` is the canonical
  // log of insurer queries / approvals / settlement notes — pull the
  // most-recent inbound row (the insurer's reply) plus a chronological
  // tail so a settled cashless claim shows the full audit trail.
  // Finding 2026-05-10-tpa-insurance-claim-patient-claim-breakdown-500.
  let correspondence = [];
  try {
    correspondence = await prisma.$queryRawUnsafe(
      `SELECT id, direction, channel, subject, body, recorded_at
         FROM tpa_claim_correspondence
        WHERE claim_id = $1::int
        ORDER BY recorded_at ASC, id ASC`,
      Number(id),
    );
  } catch (corrErr) {
    // Under-migrated tenants (rare): table missing → empty array.
    if (corrErr?.meta?.code !== '42P01') throw corrErr;
  }

  const latestInbound = [...correspondence]
    .reverse()
    .find((row) => row.direction === 'inbound');

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
    correspondence,
    latest_insurer_message: latestInbound
      ? {
          subject: latestInbound.subject,
          body: latestInbound.body,
          recorded_at: latestInbound.recorded_at,
        }
      : null,
  };
}

// ── Lab orders (investigations) ─────────────────────────────────────
//
// `lab_results` rows arrive from the analyzer with per-analyte values
// (haemoglobin, WBC, etc.) and the patient sees those on
// /portal/lab-results. The lab **order** that produced them lives in
// `investigations` and carries the patient-actionable fields:
// collection_location, fasting_required, fasting_instructions,
// collection_deadline_at (migration 203). Without surfacing these the
// patient is sent home with no idea where to give the sample or
// whether to fast.
// Finding 2026-05-09-walk-in-opd-patient-lab-order-no-collection-instructions
// + 2026-05-10-walk-in-opd-patient-lab-order-missing-instructions.

export async function listMyLabOrders({ patient_uid, status = null, limit = 100 }) {
  if (!patient_uid) throw AppError.badRequest('patient_uid is required');
  // Resolve the patient's int id once — legacy rows on `investigations`
  // (created before patient_uid backfill) only carry patient_id.
  const userRows = await prisma.$queryRawUnsafe(
    `SELECT id FROM users WHERE uid = $1::uuid LIMIT 1`,
    String(patient_uid),
  );
  const patientId = userRows[0]?.id ?? null;

  const params = [String(patient_uid)];
  let where = `(i.patient_uid = $1::uuid`;
  if (patientId != null) {
    params.push(patientId);
    where += ` OR i.patient_id = $${params.length}::int`;
  }
  where += `)`;
  if (status) {
    params.push(String(status).toUpperCase());
    where += ` AND UPPER(i.status) = $${params.length}`;
  }
  params.push(Number(limit));
  return prisma.$queryRawUnsafe(
    `SELECT i.id, i.test_name, i.test_code, i.test_type, i.investigation_type,
            i.status, i.priority,
            i.requested_at, i.scheduled_date, i.time_slot,
            i.collected_at, i.completed_at,
            i.collection_location, i.collection_deadline_at,
            i.fasting_required, i.fasting_instructions,
            i.notes, i.result_summary, i.conclusion,
            i.result_uploaded_at, i.file_key,
            u.name AS doctor_name, doc.specialty AS doctor_specialty
       FROM investigations i
       LEFT JOIN users u ON u.id = i.doctor_id
       LEFT JOIN doctors doc ON doc.user_id = i.doctor_id
      WHERE ${where}
      ORDER BY
        CASE WHEN UPPER(i.status) IN ('REQUESTED','PENDING','SCHEDULED','SAMPLE_COLLECTED','PROCESSING') THEN 0 ELSE 1 END,
        i.requested_at DESC NULLS LAST, i.id DESC
      LIMIT $${params.length}::int`,
    ...params,
  );
}

export async function getMyLabOrder({ patient_uid, id }) {
  if (!patient_uid) throw AppError.badRequest('patient_uid is required');
  const invId = Number(id);
  if (!Number.isInteger(invId) || invId <= 0) {
    throw AppError.badRequest('lab order id must be a positive integer');
  }
  const userRows = await prisma.$queryRawUnsafe(
    `SELECT id FROM users WHERE uid = $1::uuid LIMIT 1`,
    String(patient_uid),
  );
  const patientId = userRows[0]?.id ?? null;
  const rows = await prisma.$queryRawUnsafe(
    `SELECT i.id, i.test_name, i.test_code, i.test_type, i.investigation_type,
            i.status, i.priority,
            i.requested_at, i.scheduled_date, i.time_slot,
            i.collected_at, i.completed_at,
            i.collection_location, i.collection_deadline_at,
            i.fasting_required, i.fasting_instructions,
            i.notes, i.result_summary, i.conclusion, i.interpretation,
            i.results, i.structured_results,
            i.result_uploaded_at, i.file_key,
            u.name AS doctor_name, doc.specialty AS doctor_specialty
       FROM investigations i
       LEFT JOIN users u ON u.id = i.doctor_id
       LEFT JOIN doctors doc ON doc.user_id = i.doctor_id
      WHERE i.id = $1::int
        AND (i.patient_uid = $2::uuid OR i.patient_id = $3::int)`,
    invId, String(patient_uid), patientId,
  );
  if (!rows.length) throw AppError.notFound('Lab order not found');
  return rows[0];
}

// Generate a lab report PDF for a completed investigation. Patient is
// IDOR-scoped on patient_uid (or fallback patient_id) before the binary
// is generated. Delegates to clinicalPdfGenerator.generateLabReportPDF
// for the actual layout. Finding
// 2026-05-10-lab-walk-in-patient-no-report-pdf-download.
export async function generateMyLabOrderPdfBuffer({ patient_uid, id }) {
  if (!patient_uid) throw AppError.badRequest('patient_uid is required');
  const invId = Number(id);
  if (!Number.isInteger(invId) || invId <= 0) {
    throw AppError.badRequest('lab order id must be a positive integer');
  }
  const userRows = await prisma.$queryRawUnsafe(
    `SELECT id FROM users WHERE uid = $1::uuid LIMIT 1`,
    String(patient_uid),
  );
  const patientId = userRows[0]?.id ?? null;
  const ownRows = await prisma.$queryRawUnsafe(
    `SELECT id FROM investigations
      WHERE id = $1::int
        AND (patient_uid = $2::uuid OR patient_id = $3::int)`,
    invId, String(patient_uid), patientId,
  );
  if (!ownRows.length) throw AppError.notFound('Lab order not found');

  const { generateLabReportPDF } = await import('../documents/clinicalPdfGenerator.js');
  return generateLabReportPDF(invId);
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
