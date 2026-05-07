// src/services/insurance/pmjayService.js
//
// Sprint 16 — AB-PMJAY + state-scheme workflow. Different shape from
// the private-TPA flow in claimsService.js: HBP fixed-rate packages,
// beneficiary verification, and a unified preauth+claim case row.

import prisma from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';

function fiscalYearOf(d = new Date()) {
  const m = d.getMonth() + 1;
  const y = d.getFullYear();
  const start = m >= 4 ? y : y - 1;
  return `${String(start).slice(2)}-${String(start + 1).slice(2)}`;
}

async function nextCaseNumber(tenantId) {
  const fy = fiscalYearOf();
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO pmjay_case_counter (tenant_id, fiscal_year, next_value)
     VALUES ($1::uuid, $2, 1)
     ON CONFLICT (tenant_id, fiscal_year)
     DO UPDATE SET next_value = pmjay_case_counter.next_value + 1
     RETURNING next_value`,
    String(tenantId), fy,
  );
  return `PMJAY-${fy.replace('-', '')}-${String(rows[0].next_value).padStart(5, '0')}`;
}

// ── Packages (rate card) ────────────────────────────────────────────

export async function listPackages({ scheme_code, specialty_group, q, limit = 200 } = {}) {
  const params = [];
  const conds = ['active = true'];
  if (scheme_code) { params.push(scheme_code); conds.push(`scheme_code = $${params.length}`); }
  if (specialty_group) { params.push(specialty_group); conds.push(`specialty_group = $${params.length}`); }
  if (q) {
    params.push(`%${q}%`);
    conds.push(`(procedure_name ILIKE $${params.length} OR package_code ILIKE $${params.length})`);
  }
  params.push(Number(limit));
  return prisma.$queryRawUnsafe(
    `SELECT id, scheme_code, package_code, procedure_name, specialty_group,
            package_rate, los_days, inclusions, exclusions, bundling_allowed
       FROM pmjay_packages
      WHERE ${conds.join(' AND ')}
      ORDER BY scheme_code, specialty_group, procedure_name
      LIMIT $${params.length}::int`,
    ...params,
  );
}

// ── Beneficiaries ───────────────────────────────────────────────────

export async function upsertBeneficiary({
  tenantId, patient_uid, scheme_code, beneficiary_id, family_id,
  card_number, policyholder_name, age_eligible = true, state_code,
  card_url, policy_year, notes,
}) {
  if (!patient_uid) throw AppError.badRequest('patient_uid is required');
  if (!scheme_code) throw AppError.badRequest('scheme_code is required');
  if (!beneficiary_id) throw AppError.badRequest('beneficiary_id is required');

  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO pmjay_beneficiaries
       (patient_uid, scheme_code, beneficiary_id, family_id, card_number,
        policyholder_name, age_eligible, state_code, card_url,
        policy_year, notes, tenant_id)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::uuid)
     ON CONFLICT (tenant_id, scheme_code, beneficiary_id)
     DO UPDATE SET
       patient_uid = EXCLUDED.patient_uid,
       family_id = EXCLUDED.family_id,
       card_number = EXCLUDED.card_number,
       policyholder_name = EXCLUDED.policyholder_name,
       age_eligible = EXCLUDED.age_eligible,
       state_code = EXCLUDED.state_code,
       card_url = EXCLUDED.card_url,
       policy_year = EXCLUDED.policy_year,
       notes = EXCLUDED.notes,
       updated_at = NOW()
     RETURNING *`,
    String(patient_uid), String(scheme_code), String(beneficiary_id),
    family_id || null, card_number || null, policyholder_name || null,
    !!age_eligible, state_code || null, card_url || null,
    policy_year || null, notes || null, tenantId,
  );
  return rows[0];
}

export async function listBeneficiariesForPatient({ tenantId, patient_uid }) {
  return prisma.$queryRawUnsafe(
    `SELECT * FROM pmjay_beneficiaries
      WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid
      ORDER BY created_at DESC`,
    tenantId, String(patient_uid),
  );
}

export async function verifyBeneficiary({
  tenantId, id, verified_by, verification_method,
}) {
  const allowed = ['otp', 'aadhaar_biometric', 'card_match', 'manual'];
  if (!allowed.includes(verification_method)) {
    throw AppError.badRequest(`verification_method must be one of: ${allowed.join(', ')}`);
  }
  await prisma.$executeRawUnsafe(
    `UPDATE pmjay_beneficiaries
        SET verified_at = NOW(), verified_by = $1::uuid,
            verification_method = $2, updated_at = NOW()
      WHERE id = $3::int AND tenant_id = $4::uuid`,
    verified_by ? String(verified_by) : null,
    verification_method,
    Number(id), tenantId,
  );
  const rows = await prisma.$queryRawUnsafe(
    `SELECT * FROM pmjay_beneficiaries WHERE id = $1::int AND tenant_id = $2::uuid`,
    Number(id), tenantId,
  );
  if (!rows.length) throw AppError.notFound('Beneficiary not found');
  return rows[0];
}

// ── Cases (preauth + claim merged) ──────────────────────────────────

async function loadPackage(tenantId, package_id) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, scheme_code, package_code, procedure_name, package_rate
       FROM pmjay_packages
      WHERE id = $1::int AND (tenant_id = $2::uuid OR tenant_id IS NULL)`,
    Number(package_id), tenantId,
  );
  if (!rows.length) throw AppError.notFound('Package not found');
  return rows[0];
}

export async function createCase({
  tenantId, beneficiary_id, patient_uid, admission_id, package_id,
  primary_diagnosis, icd10_codes, treating_doctor_uid, treating_doctor_name,
  expected_admission_date, notes, created_by,
}) {
  if (!beneficiary_id) throw AppError.badRequest('beneficiary_id is required');
  if (!patient_uid) throw AppError.badRequest('patient_uid is required');
  if (!package_id) throw AppError.badRequest('package_id is required');
  if (!primary_diagnosis) throw AppError.badRequest('primary_diagnosis is required');

  // Package rate locked at case creation.
  const pkg = await loadPackage(tenantId, package_id);
  // Confirm beneficiary belongs to this patient + tenant + verified.
  const benRows = await prisma.$queryRawUnsafe(
    `SELECT id, verified_at FROM pmjay_beneficiaries
      WHERE id = $1::int AND tenant_id = $2::uuid AND patient_uid = $3::uuid`,
    Number(beneficiary_id), tenantId, String(patient_uid),
  );
  if (!benRows.length) {
    throw AppError.badRequest('Beneficiary not linked to this patient');
  }
  if (!benRows[0].verified_at) {
    throw AppError.badRequest('Beneficiary must be verified (OTP / biometric) before creating a case');
  }

  const caseNumber = await nextCaseNumber(tenantId);
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO pmjay_cases
       (case_number, beneficiary_id, patient_uid, admission_id, package_id,
        primary_diagnosis, icd10_codes, treating_doctor_uid, treating_doctor_name,
        expected_admission_date, locked_package_rate, notes,
        created_by, tenant_id)
     VALUES ($1, $2::int, $3::uuid, $4::int, $5::int,
             $6, $7::text[], $8::uuid, $9, $10::date, $11::numeric,
             $12, $13::uuid, $14::uuid)
     RETURNING *`,
    caseNumber, Number(beneficiary_id), String(patient_uid),
    admission_id ? Number(admission_id) : null, Number(package_id),
    String(primary_diagnosis), icd10_codes || null,
    treating_doctor_uid ? String(treating_doctor_uid) : null,
    treating_doctor_name || null,
    expected_admission_date || null,
    Number(pkg.package_rate),
    notes || null,
    created_by ? String(created_by) : null, tenantId,
  );
  return rows[0];
}

export async function getCase({ tenantId, id }) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT c.*, p.package_code, p.procedure_name, p.scheme_code AS pkg_scheme,
            b.beneficiary_id AS beneficiary_external_id, b.family_id,
            b.policyholder_name, b.policy_year
       FROM pmjay_cases c
       JOIN pmjay_packages p ON p.id = c.package_id
       JOIN pmjay_beneficiaries b ON b.id = c.beneficiary_id
      WHERE c.id = $1::int AND c.tenant_id = $2::uuid`,
    Number(id), tenantId,
  );
  if (!rows.length) throw AppError.notFound('Case not found');
  return rows[0];
}

const STATUS_TRANSITIONS = {
  preauth_draft: ['preauth_submitted', 'cancelled'],
  preauth_submitted: ['preauth_approved', 'preauth_queried', 'preauth_denied', 'cancelled'],
  preauth_queried: ['preauth_submitted', 'preauth_denied', 'cancelled'],
  preauth_approved: ['admission_in_progress', 'cancelled'],
  preauth_denied: ['cancelled'],
  admission_in_progress: ['discharge_pending', 'cancelled'],
  discharge_pending: ['claim_submitted', 'cancelled'],
  claim_submitted: ['claim_approved', 'claim_queried', 'claim_denied'],
  claim_queried: ['claim_submitted', 'claim_denied'],
  claim_approved: ['claim_paid', 'claim_denied'],
  claim_paid: ['claim_closed'],
  claim_denied: ['claim_closed'],
  claim_closed: [],
  cancelled: [],
};

export async function transition({
  tenantId, id, status, scheme_reference_id, query_text, denial_reason,
  approved_amount, paid_amount, payment_reference,
}) {
  const current = await getCase({ tenantId, id });
  const allowed = STATUS_TRANSITIONS[current.status] ?? [];
  if (!allowed.includes(status)) {
    throw AppError.invalidTransition(current.status, status, allowed);
  }

  // Compose the SET clause based on which transition we're doing.
  const sets = ['status = $1', 'updated_at = NOW()'];
  const params = [status];
  function set(col, value) {
    if (value === undefined || value === null) return;
    params.push(value);
    sets.push(`${col} = $${params.length}`);
  }
  set('scheme_reference_id', scheme_reference_id || null);
  set('query_text', query_text || null);
  set('denial_reason', denial_reason || null);
  set('approved_amount', approved_amount ? Number(approved_amount) : null);

  // Bookkeeping per status.
  if (status === 'preauth_submitted' && !current.preauth_submitted_at) {
    sets.push('preauth_submitted_at = NOW()');
  }
  if (status === 'claim_submitted' && !current.claim_submitted_at) {
    sets.push('claim_submitted_at = NOW()');
  }
  if (status === 'claim_paid') {
    if (paid_amount != null) {
      params.push(Number(paid_amount));
      sets.push(`paid_amount = $${params.length}`);
    }
    if (payment_reference) {
      params.push(payment_reference);
      sets.push(`payment_reference = $${params.length}`);
    }
    sets.push('paid_at = NOW()');
  }

  params.push(Number(id), tenantId);
  await prisma.$executeRawUnsafe(
    `UPDATE pmjay_cases SET ${sets.join(', ')}
      WHERE id = $${params.length - 1}::int AND tenant_id = $${params.length}::uuid`,
    ...params,
  );

  // Update beneficiary cumulative on payment.
  if (status === 'claim_paid' && paid_amount != null) {
    await prisma.$executeRawUnsafe(
      `UPDATE pmjay_beneficiaries
          SET cumulative_used = cumulative_used + $1::numeric, updated_at = NOW()
        WHERE id = $2::int`,
      Number(paid_amount), Number(current.beneficiary_id),
    );
  }
  return getCase({ tenantId, id });
}

export async function listCases({ tenantId, status, scheme_code, limit = 100 }) {
  const params = [tenantId];
  const conds = ['c.tenant_id = $1::uuid'];
  if (status) { params.push(status); conds.push(`c.status = $${params.length}`); }
  if (scheme_code) { params.push(scheme_code); conds.push(`p.scheme_code = $${params.length}`); }
  params.push(Number(limit));
  return prisma.$queryRawUnsafe(
    `SELECT c.id, c.case_number, c.patient_uid, c.primary_diagnosis,
            c.locked_package_rate, c.approved_amount, c.paid_amount,
            c.status, c.preauth_submitted_at, c.claim_submitted_at,
            p.scheme_code, p.package_code, p.procedure_name
       FROM pmjay_cases c
       JOIN pmjay_packages p ON p.id = c.package_id
      WHERE ${conds.join(' AND ')}
      ORDER BY c.created_at DESC
      LIMIT $${params.length}::int`,
    ...params,
  );
}
