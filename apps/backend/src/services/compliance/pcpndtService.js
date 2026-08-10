// src/services/compliance/pcpndtService.js
//
// Sprint 18 — PCPNDT Act Form F + USG register + monthly submission
// rollup. The Act criminalises sex-determination disclosure; this
// module enforces the structured capture an inspector expects.

import prisma from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { boundedInteger } from '../../utils/pagination.js';

async function assertPatientInTenant(tenantId, patientUid) {
  if (!patientUid) return;
  const rows = await prisma.$queryRawUnsafe(
    `SELECT uid FROM users
      WHERE tenant_id = $1::uuid
        AND uid = $2::uuid
        AND role = 'PATIENT'
      LIMIT 1`,
    String(tenantId),
    String(patientUid),
  );
  if (!rows.length) throw AppError.notFound('Patient not found');
}

async function nextSerial(tenantId) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO pcpndt_serial_counter (tenant_id, next_value)
     VALUES ($1::uuid, 1)
     ON CONFLICT (tenant_id)
     DO UPDATE SET next_value = pcpndt_serial_counter.next_value + 1
     RETURNING next_value`,
    String(tenantId),
  );
  return rows[0].next_value;
}

// ── Machines ────────────────────────────────────────────────────────

export async function listMachines({ tenantId, includeInactive = false }) {
  const params = [tenantId];
  let where = `tenant_id = $1::uuid`;
  if (!includeInactive) where += ` AND status = 'active'`;
  return prisma.$queryRawUnsafe(
    `SELECT id, machine_code, manufacturer, model, serial_number,
            pcpndt_registration_no, registered_at, registration_valid_to,
            location, status, notes
       FROM pcpndt_usg_machines
      WHERE ${where}
      ORDER BY status, machine_code`,
    ...params,
  );
}

export async function upsertMachine({
  tenantId, machine_code, manufacturer, model, serial_number,
  pcpndt_registration_no, registered_at, registration_valid_to,
  location, status = 'active', notes,
}) {
  if (!machine_code) throw AppError.badRequest('machine_code is required');
  if (!manufacturer || !model || !serial_number) {
    throw AppError.badRequest('manufacturer + model + serial_number required');
  }
  if (!pcpndt_registration_no) {
    throw AppError.badRequest('pcpndt_registration_no is required by the Act');
  }
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO pcpndt_usg_machines
       (machine_code, manufacturer, model, serial_number,
        pcpndt_registration_no, registered_at, registration_valid_to,
        location, status, notes, tenant_id)
     VALUES ($1, $2, $3, $4, $5, $6::date, $7::date, $8, $9, $10, $11::uuid)
     ON CONFLICT (tenant_id, machine_code)
     DO UPDATE SET
       manufacturer = EXCLUDED.manufacturer,
       model = EXCLUDED.model,
       serial_number = EXCLUDED.serial_number,
       pcpndt_registration_no = EXCLUDED.pcpndt_registration_no,
       registered_at = EXCLUDED.registered_at,
       registration_valid_to = EXCLUDED.registration_valid_to,
       location = EXCLUDED.location,
       status = EXCLUDED.status,
       notes = EXCLUDED.notes,
       updated_at = NOW()
     RETURNING *`,
    String(machine_code), String(manufacturer), String(model),
    String(serial_number), String(pcpndt_registration_no),
    registered_at || null, registration_valid_to || null,
    location || null, status, notes || null, tenantId,
  );
  return rows[0];
}

// ── Sonologists ────────────────────────────────────────────────────

export async function listSonologists({ tenantId, includeInactive = false }) {
  const params = [tenantId];
  let where = `tenant_id = $1::uuid`;
  if (!includeInactive) where += ` AND active = true`;
  return prisma.$queryRawUnsafe(
    `SELECT id, staff_uid, name, qualification, medical_council_reg,
            pcpndt_training_cert_no, pcpndt_training_date,
            undertaking_signed_at, active
       FROM pcpndt_sonologists
      WHERE ${where}
      ORDER BY name`,
    ...params,
  );
}

export async function upsertSonologist({
  tenantId, id, staff_uid, name, qualification, medical_council_reg,
  pcpndt_training_cert_no, pcpndt_training_date, undertaking_signed_at,
  active = true,
}) {
  if (!name) throw AppError.badRequest('name is required');
  if (!medical_council_reg) {
    throw AppError.badRequest('medical_council_reg is required for PCPNDT compliance');
  }
  if (!undertaking_signed_at) {
    throw AppError.badRequest(
      'undertaking_signed_at is required — sonologist must sign Form 8 before being on the roster',
    );
  }
  if (id) {
    const rows = await prisma.$queryRawUnsafe(
      `UPDATE pcpndt_sonologists SET
         staff_uid = $1::uuid, name = $2, qualification = $3,
         medical_council_reg = $4, pcpndt_training_cert_no = $5,
         pcpndt_training_date = $6::date, undertaking_signed_at = $7::date,
         active = $8, updated_at = NOW()
       WHERE id = $9::int AND tenant_id = $10::uuid
       RETURNING *`,
      staff_uid ? String(staff_uid) : null,
      String(name), qualification || null, String(medical_council_reg),
      pcpndt_training_cert_no || null, pcpndt_training_date || null,
      undertaking_signed_at, !!active,
      Number(id), tenantId,
    );
    if (!rows.length) throw AppError.notFound('Sonologist not found');
    return rows[0];
  }
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO pcpndt_sonologists
       (staff_uid, name, qualification, medical_council_reg,
        pcpndt_training_cert_no, pcpndt_training_date,
        undertaking_signed_at, active, tenant_id)
     VALUES ($1::uuid, $2, $3, $4, $5, $6::date, $7::date, $8, $9::uuid)
     RETURNING *`,
    staff_uid ? String(staff_uid) : null,
    String(name), qualification || null, String(medical_council_reg),
    pcpndt_training_cert_no || null, pcpndt_training_date || null,
    undertaking_signed_at, !!active, tenantId,
  );
  return rows[0];
}

// ── Form F entry ────────────────────────────────────────────────────

export async function createFormF({
  tenantId, patient_uid, patient_name, patient_age, husband_or_father_name,
  full_address, contact_number,
  gravida = 1, parity = 0, abortions = 0, living_children = 0,
  living_children_sex, lmp_date, gestational_age_weeks,
  indication, indication_category,
  referred_by_doctor_name, referred_by_reg_no,
  procedure_kind = 'usg', machine_id, sonologist_id, procedure_findings,
  sex_determination_disclosed = false, consent_taken = true,
  test_date, created_by,
}) {
  // Required by the Act.
  if (!patient_name) throw AppError.badRequest('patient_name is required');
  if (patient_age == null) throw AppError.badRequest('patient_age is required');
  if (!husband_or_father_name) {
    throw AppError.badRequest('husband_or_father_name is required by Form F');
  }
  if (!full_address) throw AppError.badRequest('full_address is required');
  if (!indication) throw AppError.badRequest('indication is required');
  if (!machine_id) throw AppError.badRequest('machine_id is required');
  if (!sonologist_id) throw AppError.badRequest('sonologist_id is required');
  if (!consent_taken) {
    throw AppError.badRequest('Consent must be taken before USG can be performed');
  }
  // The form's most legally-loaded field — must be explicitly false.
  if (sex_determination_disclosed) {
    throw AppError.badRequest(
      'sex_determination_disclosed must be false. The Act prohibits disclosure of sex.',
    );
  }
  await assertPatientInTenant(tenantId, patient_uid);

  // Verify the machine + sonologist are active and belong to this tenant.
  const m = await prisma.$queryRawUnsafe(
    `SELECT id, status FROM pcpndt_usg_machines
      WHERE id = $1::int AND tenant_id = $2::uuid`,
    Number(machine_id), tenantId,
  );
  if (!m.length) throw AppError.notFound('Machine not registered');
  if (m[0].status !== 'active') {
    throw AppError.badRequest(`Machine is ${m[0].status}, cannot perform tests`);
  }
  const s = await prisma.$queryRawUnsafe(
    `SELECT id, active, undertaking_signed_at FROM pcpndt_sonologists
      WHERE id = $1::int AND tenant_id = $2::uuid`,
    Number(sonologist_id), tenantId,
  );
  if (!s.length) throw AppError.notFound('Sonologist not on the roster');
  if (!s[0].active) throw AppError.badRequest('Sonologist is inactive');
  if (!s[0].undertaking_signed_at) {
    throw AppError.badRequest('Sonologist has not signed the PCPNDT undertaking');
  }

  const serial = await nextSerial(tenantId);
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO pcpndt_form_f
       (serial_no, test_date, patient_uid, patient_name, patient_age,
        husband_or_father_name, full_address, contact_number,
        gravida, parity, abortions, living_children, living_children_sex,
        lmp_date, gestational_age_weeks,
        indication, indication_category,
        referred_by_doctor_name, referred_by_reg_no,
        procedure_kind, machine_id, sonologist_id, procedure_findings,
        sex_determination_disclosed, consent_taken, consent_signed_at,
        status, created_by, tenant_id)
     VALUES ($1::int, $2::date, $3::uuid, $4, $5::int, $6, $7, $8,
             $9::int, $10::int, $11::int, $12::int, $13,
             $14::date, $15::numeric,
             $16, $17,
             $18, $19,
             $20, $21::int, $22::int, $23,
             $24, $25, NOW(),
             'completed', $26::uuid, $27::uuid)
     RETURNING *`,
    serial, test_date || new Date().toISOString().split('T')[0],
    patient_uid ? String(patient_uid) : null,
    String(patient_name), Number(patient_age),
    String(husband_or_father_name), String(full_address),
    contact_number || null,
    Number(gravida), Number(parity), Number(abortions),
    Number(living_children), living_children_sex || null,
    lmp_date || null, gestational_age_weeks ?? null,
    String(indication), indication_category || null,
    referred_by_doctor_name || null, referred_by_reg_no || null,
    procedure_kind, Number(machine_id), Number(sonologist_id),
    procedure_findings || null,
    false, true,    // sex_determination_disclosed=false, consent_taken=true
    created_by ? String(created_by) : null, tenantId,
  );
  return rows[0];
}

export async function getFormF({ tenantId, id }) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT f.*,
            m.machine_code, m.manufacturer AS machine_manufacturer,
            m.model AS machine_model, m.pcpndt_registration_no,
            s.name AS sonologist_name, s.medical_council_reg AS sonologist_reg
       FROM pcpndt_form_f f
       LEFT JOIN pcpndt_usg_machines m
         ON m.id = f.machine_id AND m.tenant_id = f.tenant_id
       LEFT JOIN pcpndt_sonologists s
         ON s.id = f.sonologist_id AND s.tenant_id = f.tenant_id
      WHERE f.id = $1::int AND f.tenant_id = $2::uuid`,
    Number(id), tenantId,
  );
  if (!rows.length) throw AppError.notFound('Form F not found');
  return rows[0];
}

export async function listFormF({
  tenantId, from, to, sonologist_id, status, limit = 200,
}) {
  const params = [tenantId];
  const conds = [`f.tenant_id = $1::uuid`];
  if (from) { params.push(from); conds.push(`f.test_date >= $${params.length}::date`); }
  if (to) { params.push(to); conds.push(`f.test_date <= $${params.length}::date`); }
  if (sonologist_id) {
    params.push(Number(sonologist_id));
    conds.push(`f.sonologist_id = $${params.length}::int`);
  }
  if (status) {
    params.push(status);
    conds.push(`f.status = $${params.length}`);
  }
  params.push(boundedInteger(limit, { fallback: 200, min: 1, max: 500 }));
  return prisma.$queryRawUnsafe(
    `SELECT f.id, f.serial_no, f.test_date, f.patient_name, f.patient_age,
            f.gravida, f.parity, f.indication_category, f.status,
            f.submitted_at,
            m.machine_code, s.name AS sonologist_name
       FROM pcpndt_form_f f
       LEFT JOIN pcpndt_usg_machines m
         ON m.id = f.machine_id AND m.tenant_id = f.tenant_id
       LEFT JOIN pcpndt_sonologists s
         ON s.id = f.sonologist_id AND s.tenant_id = f.tenant_id
      WHERE ${conds.join(' AND ')}
      ORDER BY f.test_date DESC, f.serial_no DESC
      LIMIT $${params.length}::int`,
    ...params,
  );
}

// ── Monthly submission batch ────────────────────────────────────────

export async function generateMonthlySubmission({
  tenantId, period_year, period_month, generated_by,
}) {
  if (!period_year || !period_month) {
    throw AppError.badRequest('period_year + period_month required');
  }
  // Find all completed-but-not-submitted forms in the month.
  const periodStart = `${period_year}-${String(period_month).padStart(2, '0')}-01`;
  const next = period_month === 12
    ? `${Number(period_year) + 1}-01-01`
    : `${period_year}-${String(period_month + 1).padStart(2, '0')}-01`;
  const formsToSubmit = await prisma.$queryRawUnsafe(
    `SELECT id FROM pcpndt_form_f
      WHERE tenant_id = $1::uuid
        AND status = 'completed'
        AND test_date >= $2::date AND test_date < $3::date
        AND submitted_at IS NULL`,
    tenantId, periodStart, next,
  );
  const total = formsToSubmit.length;

  const submission = await prisma.$queryRawUnsafe(
    `INSERT INTO pcpndt_submissions
       (period_year, period_month, generated_by, total_forms, tenant_id)
     VALUES ($1::int, $2::int, $3::uuid, $4::int, $5::uuid)
     ON CONFLICT (tenant_id, period_year, period_month)
     DO UPDATE SET total_forms = EXCLUDED.total_forms,
                   generated_at = NOW(),
                   generated_by = EXCLUDED.generated_by
     RETURNING *`,
    Number(period_year), Number(period_month),
    generated_by ? String(generated_by) : null,
    total, tenantId,
  );

  if (formsToSubmit.length) {
    const ids = formsToSubmit.map((r) => r.id);
    await prisma.$executeRawUnsafe(
      `UPDATE pcpndt_form_f
          SET submitted_at = NOW(),
              submission_batch_id = $1::int,
              status = 'submitted_to_authority',
              updated_at = NOW()
        WHERE tenant_id = $3::uuid
          AND id = ANY($2::int[])`,
      submission[0].id, ids, tenantId,
    );
  }
  return { ...submission[0], forms_count: total };
}

export async function listSubmissions({ tenantId, limit = 24 }) {
  return prisma.$queryRawUnsafe(
    `SELECT * FROM pcpndt_submissions
      WHERE tenant_id = $1::uuid
      ORDER BY period_year DESC, period_month DESC
      LIMIT $2::int`,
    tenantId, boundedInteger(limit, { fallback: 24, min: 1, max: 200 }),
  );
}

export async function acknowledgeSubmission({
  tenantId, id, authority_reference, notes,
}) {
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE pcpndt_submissions
        SET submitted_to_authority_at = NOW(),
            authority_reference = $1,
            notes = COALESCE($2, notes)
      WHERE id = $3::int AND tenant_id = $4::uuid
      RETURNING *`,
    authority_reference || null, notes || null,
    Number(id), tenantId,
  );
  if (!rows.length) throw AppError.notFound('Submission batch not found');
  return rows[0];
}
