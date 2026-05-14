// src/services/discharge/dischargeService.js
//
// Sprint 11 — discharge summary builder. The doctor picks a template
// (or auto-pick by specialty), the system materialises a draft with
// every section row pre-populated from the template's `default_body`
// when set, then the doctor edits + signs. Status walk:
//   draft → ready_for_signoff → signed → delivered

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';

// Section keys we recognise as "discharge medications" for the
// materialise-to-e_prescriptions handoff. Templates use slightly
// different naming conventions across specialties; match all of them
// case-insensitively. Anything matching here triggers a synthesised
// e_prescriptions row on sign so the patient app's Rx tab finds it.
const DISCHARGE_MED_SECTION_KEYS = new Set([
  'discharge_medications',
  'medications_on_discharge',
  'takeaway_medications',
  'take_home_medications',
  'discharge_meds',
]);

// ── Templates ───────────────────────────────────────────────────────

export async function listTemplates({ tenantId, specialty }) {
  const params = [tenantId];
  const where = [`tenant_id = $1::uuid`, `active = true`];
  if (specialty) {
    params.push(specialty);
    where.push(`(specialty = $${params.length} OR specialty IS NULL)`);
  }
  return prisma.$queryRawUnsafe(
    `SELECT id, code, display_name, specialty, sections, active
       FROM discharge_summary_templates
      WHERE ${where.join(' AND ')}
      ORDER BY specialty NULLS LAST, display_name`,
    ...params,
  );
}

async function pickTemplate({ tenantId, template_code, specialty }) {
  if (template_code) {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT * FROM discharge_summary_templates
        WHERE tenant_id = $1::uuid AND code = $2 AND active = true`,
      tenantId, template_code,
    );
    if (rows.length) return rows[0];
  }
  if (specialty) {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT * FROM discharge_summary_templates
        WHERE tenant_id = $1::uuid AND specialty = $2 AND active = true
        ORDER BY id LIMIT 1`,
      tenantId, specialty,
    );
    if (rows.length) return rows[0];
  }
  // Fallback to general medicine.
  const rows = await prisma.$queryRawUnsafe(
    `SELECT * FROM discharge_summary_templates
      WHERE tenant_id = $1::uuid AND specialty = 'general_medicine' AND active = true
      ORDER BY id LIMIT 1`,
    tenantId,
  );
  if (!rows.length) {
    throw AppError.badRequest(
      'No discharge summary template available. Configure one in admin first.',
    );
  }
  return rows[0];
}

// ── Discharge summary CRUD ──────────────────────────────────────────

export async function createDraft({
  tenantId, admission_id, patient_uid,
  patient_name, age_years, sex,
  patient_name_snapshot, age_years_snapshot, sex_snapshot,
  hospital_number, admitted_at, discharged_at, ward_at_discharge,
  primary_diagnosis, secondary_diagnoses, icd10_codes, procedures_performed,
  template_code, specialty, created_by,
}) {
  if (!patient_uid) throw AppError.badRequest('patient_uid is required');
  const template = await pickTemplate({ tenantId, template_code, specialty });

  // Accept both naming styles: callers may send the bare field
  // (`patient_name`) or the explicit snapshot column name
  // (`patient_name_snapshot`). Whichever is present wins; if neither
  // is supplied, the INSERT's COALESCE backfills from the users row.
  // A discharge summary is a medico-legal document — patient name,
  // age, and sex are mandatory header fields and must never be NULL.
  // Finding:
  //   2026-05-09-inpatient-admission-discharge-summary-patient-fields-dropped
  const headerRows = await prisma.$queryRawUnsafe(
    `INSERT INTO discharge_summaries
       (admission_id, patient_uid, patient_name_snapshot, age_years_snapshot,
        sex_snapshot, hospital_number, admitted_at, discharged_at,
        ward_at_discharge, primary_diagnosis, secondary_diagnoses,
        icd10_codes, procedures_performed, status, created_by, tenant_id)
     VALUES ($1::int, $2::uuid,
             COALESCE($3, (SELECT u.name FROM users u WHERE u.uid = $2::uuid LIMIT 1)),
             COALESCE($4::int,
               (SELECT (EXTRACT(YEAR FROM AGE(u.birthday)))::int
                  FROM users u WHERE u.uid = $2::uuid AND u.birthday IS NOT NULL LIMIT 1)),
             COALESCE($5, (SELECT u.gender FROM users u WHERE u.uid = $2::uuid LIMIT 1)),
             $6, $7::timestamptz,
             $8::timestamptz, $9, $10, $11::text[], $12::text[], $13::text[],
             'draft', $14::uuid, $15::uuid)
     RETURNING *`,
    admission_id ? Number(admission_id) : null,
    String(patient_uid),
    patient_name_snapshot ?? patient_name ?? null,
    (age_years_snapshot ?? age_years) != null
      ? Number(age_years_snapshot ?? age_years)
      : null,
    sex_snapshot ?? sex ?? null,
    hospital_number || null,
    admitted_at || null,
    discharged_at || null,
    ward_at_discharge || null,
    primary_diagnosis || null,
    secondary_diagnoses || null,
    icd10_codes || null,
    procedures_performed || null,
    created_by ? String(created_by) : null,
    tenantId,
  );
  const summary = headerRows[0];

  // Materialise sections from the template.
  const sections = Array.isArray(template.sections) ? template.sections : [];
  for (const s of sections) {
    if (!s?.section_key || !s?.section_title) continue;
    await prisma.$executeRawUnsafe(
      `INSERT INTO discharge_summary_sections
         (discharge_summary_id, section_key, section_title, display_order, body)
       VALUES ($1::int, $2, $3, $4::int, $5)`,
      summary.id,
      String(s.section_key),
      String(s.section_title),
      Number(s.display_order ?? 0),
      s.default_body ? String(s.default_body) : null,
    );
  }

  return getOne({ tenantId, id: summary.id });
}

export async function getOne({ tenantId, id }) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT * FROM discharge_summaries WHERE id = $1::int AND tenant_id = $2::uuid`,
    Number(id), tenantId,
  );
  if (!rows.length) throw AppError.notFound('Discharge summary not found');
  const sections = await prisma.$queryRawUnsafe(
    `SELECT id, section_key, section_title, display_order, body, edited_by, edited_at
       FROM discharge_summary_sections
      WHERE discharge_summary_id = $1::int
      ORDER BY display_order, id`,
    rows[0].id,
  );
  return { ...rows[0], sections };
}

export async function updateSection({
  tenantId, id, section_key, body, edited_by,
}) {
  // Verify ownership before edit (prevents cross-tenant tampering).
  const owner = await prisma.$queryRawUnsafe(
    `SELECT id, status FROM discharge_summaries
      WHERE id = $1::int AND tenant_id = $2::uuid`,
    Number(id), tenantId,
  );
  if (!owner.length) throw AppError.notFound('Discharge summary not found');
  if (owner[0].status === 'signed' || owner[0].status === 'delivered') {
    throw AppError.badRequest(
      `Discharge summary is ${owner[0].status} — sections cannot be edited.`,
    );
  }
  const result = await prisma.$executeRawUnsafe(
    `UPDATE discharge_summary_sections
        SET body = $1, edited_by = $2::uuid, edited_at = NOW()
      WHERE discharge_summary_id = $3::int AND section_key = $4`,
    body || null,
    edited_by ? String(edited_by) : null,
    Number(id), String(section_key),
  );
  if (Number(result) === 0) {
    throw AppError.notFound(`Section ${section_key} not found on this summary`);
  }
  // Bump parent updated_at to track edit recency.
  await prisma.$executeRawUnsafe(
    `UPDATE discharge_summaries SET updated_at = NOW() WHERE id = $1::int`,
    Number(id),
  );
  return getOne({ tenantId, id });
}

export async function markReadyForSignoff({ tenantId, id }) {
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE discharge_summaries
        SET status = 'ready_for_signoff', updated_at = NOW()
      WHERE id = $1::int AND tenant_id = $2::uuid AND status = 'draft'
      RETURNING id`,
    Number(id), tenantId,
  );
  if (!rows.length) {
    throw AppError.badRequest(
      'Discharge summary not in draft state (cannot mark ready)',
    );
  }
  return getOne({ tenantId, id });
}

export async function sign({
  tenantId, id, signed_by, signed_by_name, signed_by_reg,
}) {
  if (!signed_by_name) {
    throw AppError.badRequest('signed_by_name is required');
  }
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE discharge_summaries
        SET status = 'signed', signed_by = $1::uuid,
            signed_by_name = $2, signed_by_reg = $3, signed_at = NOW(),
            updated_at = NOW()
      WHERE id = $4::int AND tenant_id = $5::uuid
        AND status IN ('draft', 'ready_for_signoff')
      RETURNING id, admission_id, patient_uid, signed_at`,
    signed_by ? String(signed_by) : null,
    String(signed_by_name),
    signed_by_reg || null,
    Number(id), tenantId,
  );
  if (!rows.length) {
    throw AppError.badRequest(
      'Discharge summary already signed or in an invalid state for signing',
    );
  }

  const signed = rows[0];

  // Denormalise summary_signed_at onto the admission row so the
  // patient-side discharge-PDF gate (clinicalPdfGenerator
  // .getOrGenerateDischargePdfUrl) and the cascade-readiness check
  // can both read it without re-joining discharge_summaries. The
  // dischargeSummaryGenerator (clinical_notes path) does the same;
  // until this point the discharge_summaries path silently skipped
  // it and the patient PDF endpoint returned 409 forever. Finding:
  // 2026-05-09-tpa-insurance-claim-patient-discharge-pdf-blocked.
  if (signed.admission_id) {
    try {
      await prisma.$executeRawUnsafe(
        `UPDATE admissions
            SET summary_signed_at = $1, updated_at = NOW()
          WHERE id = $2::int`,
        signed.signed_at, Number(signed.admission_id),
      );
    } catch (e) {
      logger.warn(
        `dischargeService.sign: failed to stamp summary_signed_at on admission ${signed.admission_id}: ${e.message}`,
      );
    }
  }

  // Materialise discharge medications as an e_prescriptions row so the
  // patient app's Rx tab surfaces them. Best-effort: signing must not
  // fail if no medication section is configured or the section body is
  // empty. Finding 2026-05-09-surgical-day-care-patient-discharge-meds-
  // not-in-e_prescriptions.
  await materialiseDischargeMedsAsPrescription({
    discharge_summary_id: Number(id),
    patient_uid: signed.patient_uid,
    doctor_uid: signed_by || null,
  });

  return getOne({ tenantId, id });
}

/**
 * Create an e_prescriptions row from the discharge summary's medication
 * section(s) so the patient app's Rx list surfaces discharge meds.
 *
 * Section bodies are free text — we don't try to parse them into
 * structured `medications` JSON (that would require NLP and may
 * misrepresent dosing for a clinical artifact). Instead we store the
 * full body as `clinical_notes` and one synthetic medication entry
 * pointing at the discharge summary, so the Rx tab card renders
 * something sensible and a deep-link can route the patient to the
 * actual discharge summary view (see Group A patient portal route).
 *
 * Idempotent — if a prescription was already created from this
 * discharge summary, we skip. Best-effort: any failure is logged and
 * swallowed.
 */
async function materialiseDischargeMedsAsPrescription({
  discharge_summary_id, patient_uid, doctor_uid,
}) {
  if (!patient_uid) return;
  try {
    const sections = await prisma.$queryRawUnsafe(
      `SELECT section_key, section_title, body
         FROM discharge_summary_sections
        WHERE discharge_summary_id = $1::int
          AND body IS NOT NULL AND length(trim(body)) > 0`,
      Number(discharge_summary_id),
    );
    const medSection = sections.find((s) =>
      DISCHARGE_MED_SECTION_KEYS.has(String(s.section_key || '').toLowerCase()),
    );
    if (!medSection) return;

    // Idempotency probe: a prescription whose clinical_notes references
    // this discharge_summary_id means we've already materialised it.
    const marker = `[discharge_summary_id=${discharge_summary_id}]`;
    const existing = await prisma.$queryRawUnsafe(
      `SELECT id FROM e_prescriptions
        WHERE patient_uid = $1::uuid
          AND clinical_notes LIKE $2
        LIMIT 1`,
      String(patient_uid), `%${marker}%`,
    );
    if (existing.length) return;

    // Resolve int ids — getMyPrescriptions filters by patient_id (int).
    // doctor_id is best-effort: discharge can be signed by a name-only
    // user with no DB row.
    const [patientRow, doctorRow] = await Promise.all([
      prisma.$queryRawUnsafe(
        `SELECT id FROM users WHERE uid = $1::uuid LIMIT 1`,
        String(patient_uid),
      ),
      doctor_uid
        ? prisma.$queryRawUnsafe(
            `SELECT id FROM users WHERE uid = $1::uuid LIMIT 1`,
            String(doctor_uid),
          )
        : Promise.resolve([]),
    ]);
    const patientId = patientRow[0]?.id ?? null;
    const doctorId = doctorRow[0]?.id ?? null;
    if (!patientId) {
      logger.warn(
        `materialiseDischargeMedsAsPrescription: no users row for patient_uid=${patient_uid}`,
      );
      return;
    }

    // The section body is unstructured free text (one med per line in
    // typical templates). Surface it verbatim as a single "medication"
    // entry so the Rx tab card renders the body, and the patient can
    // tap through to the discharge summary view for the full schedule.
    const sectionBody = String(medSection.body || '').trim();
    const lines = sectionBody
      .split(/\r?\n/)
      .map((l) => l.replace(/^[\s•\-*]+/, '').trim())
      .filter((l) => l.length > 0);
    const medications = lines.length
      ? lines.map((line) => ({
          name: line,
          instructions: 'See discharge summary for full schedule',
          source: 'discharge_summary',
        }))
      : [{
          name: medSection.section_title || 'Discharge medications',
          instructions: sectionBody,
          source: 'discharge_summary',
        }];

    const clinicalNotesText =
      `Discharge medications from discharge summary. ${marker}\n\n${sectionBody}`;

    await prisma.$executeRawUnsafe(
      `INSERT INTO e_prescriptions
         (appointment_id, patient_id, doctor_id, patient_uid, doctor_uid,
          diagnosis, clinical_notes, medications, status)
       VALUES (NULL, $1::int, $2, $3::uuid, $4,
               NULL, $5, $6::jsonb, 'active')`,
      patientId,
      doctorId,
      String(patient_uid),
      doctor_uid ? String(doctor_uid) : null,
      clinicalNotesText,
      JSON.stringify(medications),
    );
  } catch (e) {
    logger.warn(
      `materialiseDischargeMedsAsPrescription failed for discharge_summary_id=${discharge_summary_id}: ${e.message}`,
    );
  }
}

export async function markDelivered({
  tenantId, id, delivery_method,
}) {
  const allowed = ['printed', 'email', 'whatsapp', 'abdm'];
  if (!allowed.includes(delivery_method)) {
    throw AppError.badRequest(
      `delivery_method must be one of: ${allowed.join(', ')}`,
    );
  }
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE discharge_summaries
        SET status = 'delivered', delivered_at = NOW(),
            delivery_method = $1, updated_at = NOW()
      WHERE id = $2::int AND tenant_id = $3::uuid AND status = 'signed'
      RETURNING id`,
    delivery_method, Number(id), tenantId,
  );
  if (!rows.length) {
    throw AppError.badRequest(
      'Discharge summary must be signed before it can be marked delivered',
    );
  }
  return getOne({ tenantId, id });
}

export async function listForPatient({ tenantId, patient_uid, limit = 50 }) {
  return prisma.$queryRawUnsafe(
    `SELECT id, admission_id, primary_diagnosis, status, signed_at,
            delivered_at, delivery_method, created_at
       FROM discharge_summaries
      WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid
      ORDER BY created_at DESC
      LIMIT $3::int`,
    tenantId, String(patient_uid), Number(limit),
  );
}

export async function listPending({ tenantId, limit = 100 }) {
  return prisma.$queryRawUnsafe(
    `SELECT id, patient_uid, patient_name_snapshot, primary_diagnosis,
            admitted_at, discharged_at, status, created_at, updated_at
       FROM discharge_summaries
      WHERE tenant_id = $1::uuid AND status IN ('draft', 'ready_for_signoff')
      ORDER BY updated_at DESC
      LIMIT $2::int`,
    tenantId, Number(limit),
  );
}
