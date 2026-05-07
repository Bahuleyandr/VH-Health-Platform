// src/services/discharge/dischargeService.js
//
// Sprint 11 — discharge summary builder. The doctor picks a template
// (or auto-pick by specialty), the system materialises a draft with
// every section row pre-populated from the template's `default_body`
// when set, then the doctor edits + signs. Status walk:
//   draft → ready_for_signoff → signed → delivered

import prisma from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';

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
  hospital_number, admitted_at, discharged_at, ward_at_discharge,
  primary_diagnosis, secondary_diagnoses, icd10_codes, procedures_performed,
  template_code, specialty, created_by,
}) {
  if (!patient_uid) throw AppError.badRequest('patient_uid is required');
  const template = await pickTemplate({ tenantId, template_code, specialty });

  const headerRows = await prisma.$queryRawUnsafe(
    `INSERT INTO discharge_summaries
       (admission_id, patient_uid, patient_name_snapshot, age_years_snapshot,
        sex_snapshot, hospital_number, admitted_at, discharged_at,
        ward_at_discharge, primary_diagnosis, secondary_diagnoses,
        icd10_codes, procedures_performed, status, created_by, tenant_id)
     VALUES ($1::int, $2::uuid, $3, $4::int, $5, $6, $7::timestamptz,
             $8::timestamptz, $9, $10, $11::text[], $12::text[], $13::text[],
             'draft', $14::uuid, $15::uuid)
     RETURNING *`,
    admission_id ? Number(admission_id) : null,
    String(patient_uid),
    patient_name || null,
    age_years ? Number(age_years) : null,
    sex || null,
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
      RETURNING id`,
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
  return getOne({ tenantId, id });
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
