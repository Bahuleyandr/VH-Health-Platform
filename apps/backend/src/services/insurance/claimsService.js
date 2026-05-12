// src/services/insurance/claimsService.js
//
// Sprint 5 — Insurance / TPA workflow.
//
// Pre-auth → enhancement → final claim → settlement, end-to-end. Keeps
// payer/TPA master tables (migration 119) as the source of truth and
// adds the per-encounter rows under it. Uses billing_invoices for the
// final-bill linkage so the cashier and the insurance coordinator
// stay in sync.

import prisma from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';

// ── helpers ──────────────────────────────────────────────────────────

function fiscalYearOf(d = new Date()) {
  // Indian FY: Apr 1 → Mar 31. FY24-25 covers Apr 2024 – Mar 2025.
  const m = d.getMonth() + 1;
  const y = d.getFullYear();
  const start = m >= 4 ? y : y - 1;
  return `${String(start).slice(2)}-${String(start + 1).slice(2)}`;
}

async function nextSeq(tableCounter, prefix, tenantId) {
  // Atomic increment per (tenant, fiscal_year).
  const fy = fiscalYearOf();
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO ${tableCounter} (tenant_id, fiscal_year, next_value)
     VALUES ($1::uuid, $2, 1)
     ON CONFLICT (tenant_id, fiscal_year)
     DO UPDATE SET next_value = ${tableCounter}.next_value + 1
     RETURNING next_value`,
    String(tenantId), fy,
  );
  const seq = rows[0].next_value;
  return `${prefix}-${fy.replace('-', '')}-${String(seq).padStart(5, '0')}`;
}

// ── Insurance policy CRUD ────────────────────────────────────────────

export async function upsertPolicy({
  tenantId, patient_uid, payer_id, tpa_id, policy_number, member_id,
  policyholder_name, relation_to_patient, policy_type, corporate_employer,
  sum_insured, valid_from, valid_to, card_url, notes, created_by,
}) {
  if (!patient_uid) throw AppError.badRequest('patient_uid is required');
  if (!policy_number) throw AppError.badRequest('policy_number is required');

  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO insurance_policies
       (patient_uid, payer_id, tpa_id, policy_number, member_id,
        policyholder_name, relation_to_patient, policy_type,
        corporate_employer, sum_insured, valid_from, valid_to,
        card_url, notes, created_by, tenant_id)
     VALUES ($1::uuid, $2::int, $3::int, $4, $5, $6, $7, $8, $9,
             $10::numeric, $11::date, $12::date, $13, $14, $15::uuid, $16::uuid)
     RETURNING *`,
    String(patient_uid),
    payer_id ? Number(payer_id) : null,
    tpa_id ? Number(tpa_id) : null,
    String(policy_number),
    member_id || null, policyholder_name || null,
    relation_to_patient || null, policy_type || null,
    corporate_employer || null,
    sum_insured ? Number(sum_insured) : null,
    valid_from || null, valid_to || null,
    card_url || null, notes || null,
    created_by ? String(created_by) : null, tenantId,
  );
  return rows[0];
}

export async function listPoliciesForPatient({ tenantId, patient_uid }) {
  return prisma.$queryRawUnsafe(
    `SELECT p.*, pa.display_name AS payer_name, t.display_name AS tpa_name
       FROM insurance_policies p
       LEFT JOIN payers pa ON pa.id = p.payer_id
       LEFT JOIN tpas t ON t.id = p.tpa_id
      WHERE p.tenant_id = $1::uuid AND p.patient_uid = $2::uuid
      ORDER BY p.created_at DESC`,
    tenantId, String(patient_uid),
  );
}

// ── Pre-authorization ────────────────────────────────────────────────

export async function createPreauth({
  tenantId, policy_id, patient_uid, admission_id,
  request_type = 'planned', parent_preauth_id,
  primary_diagnosis, icd10_codes, proposed_procedure, procedure_codes,
  treating_doctor_uid, treating_doctor_name,
  expected_admission_date, expected_los_days,
  expected_cost, cost_breakdown, notes, created_by,
}) {
  if (!policy_id) throw AppError.badRequest('policy_id is required');
  if (!patient_uid) throw AppError.badRequest('patient_uid is required');
  if (!primary_diagnosis) throw AppError.badRequest('primary_diagnosis is required');
  if (!expected_cost || Number(expected_cost) <= 0) {
    throw AppError.badRequest('expected_cost must be > 0');
  }

  const preauth_number = await nextSeq('insurance_preauth_counter', 'PA', tenantId);

  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO insurance_preauth
       (policy_id, patient_uid, admission_id, preauth_number,
        request_type, parent_preauth_id,
        primary_diagnosis, icd10_codes, proposed_procedure, procedure_codes,
        treating_doctor_uid, treating_doctor_name,
        expected_admission_date, expected_los_days,
        expected_cost, cost_breakdown, notes, created_by, tenant_id)
     VALUES ($1::int, $2::uuid, $3::int, $4,
             $5, $6::int,
             $7, $8::text[], $9, $10::text[],
             $11::uuid, $12,
             $13::date, $14::int,
             $15::numeric, $16::jsonb, $17, $18::uuid, $19::uuid)
     RETURNING *`,
    Number(policy_id), String(patient_uid),
    admission_id ? Number(admission_id) : null,
    preauth_number, request_type,
    parent_preauth_id ? Number(parent_preauth_id) : null,
    primary_diagnosis,
    icd10_codes || null,
    proposed_procedure || null,
    procedure_codes || null,
    treating_doctor_uid ? String(treating_doctor_uid) : null,
    treating_doctor_name || null,
    expected_admission_date || null,
    expected_los_days ? Number(expected_los_days) : null,
    Number(expected_cost),
    JSON.stringify(cost_breakdown || {}),
    notes || null,
    created_by ? String(created_by) : null, tenantId,
  );
  return rows[0];
}

/**
 * Sum sanctioned_amount across the parent + every approved /
 * partially_approved child for an admission's preauth chain. This is
 * the cumulative TPA cap the cashier should bill against — the original
 * preauth alone is stale once an enhancement is approved. Mirrors the
 * approved-states set used in the chart-path GET handler.
 *
 * Strategy: when called with a child preauth, walk up to the parent
 * once and then aggregate. Stable for chains of any depth because
 * enhancements are always direct children of the original preauth
 * (request_type='enhancement', parent_preauth_id=original.id) —
 * grandchildren are not part of the workflow.
 *
 * Returns numeric values (Number, not Decimal) because the consumers
 * (cashier UI, billing alerts) compare them with computed totals.
 */
export async function chainTotalsFor({ tenantId, preauthId }) {
  const rootRows = await prisma.$queryRawUnsafe(
    `WITH RECURSIVE root AS (
       SELECT id, parent_preauth_id
         FROM insurance_preauth
        WHERE id = $1::int AND tenant_id = $2::uuid
       UNION ALL
       SELECT p.id, p.parent_preauth_id
         FROM insurance_preauth p
         JOIN root r ON r.parent_preauth_id = p.id
     )
     SELECT id FROM root WHERE parent_preauth_id IS NULL LIMIT 1`,
    Number(preauthId), tenantId,
  );
  if (!rootRows.length) {
    return {
      root_preauth_id: null,
      cumulative_approved: 0,
      cumulative_requested: 0,
      chain_length: 0,
    };
  }
  const rootId = rootRows[0].id;
  const totals = await prisma.$queryRawUnsafe(
    `SELECT
        $1::int AS root_id,
        SUM(CASE WHEN status IN ('approved','partially_approved')
                 THEN COALESCE(sanctioned_amount, 0) ELSE 0 END)::numeric AS approved_total,
        SUM(CASE WHEN status NOT IN ('cancelled','lapsed','denied')
                 THEN COALESCE(expected_cost, 0) ELSE 0 END)::numeric AS requested_total,
        COUNT(*)::int AS chain_length
       FROM insurance_preauth
      WHERE tenant_id = $2::uuid
        AND (id = $1::int OR parent_preauth_id = $1::int)`,
    rootId, tenantId,
  );
  const t = totals[0] || {};
  return {
    root_preauth_id: rootId,
    cumulative_approved: Number(t.approved_total ?? 0),
    cumulative_requested: Number(t.requested_total ?? 0),
    chain_length: Number(t.chain_length ?? 0),
  };
}

export async function getPreauth({ tenantId, id }) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT * FROM insurance_preauth WHERE id = $1::int AND tenant_id = $2::uuid`,
    Number(id), tenantId,
  );
  if (!rows.length) throw AppError.notFound('Pre-auth not found');
  // Project cumulative totals across the parent + enhancement chain so
  // every consumer of /api/v1/insurance/preauth/:id (admin TPA desk,
  // chart panel, billing screens) sees the live cap, not the row's
  // own sanctioned amount. See finding
  // 2026-05-10-tpa-insurance-claim-billing-cumulative-approval-not-projected.
  const totals = await chainTotalsFor({ tenantId, preauthId: rows[0].id });
  return { ...rows[0], ...totals };
}

export async function submitPreauth({
  tenantId, id, submitted_by, submission_channel = 'portal', tpa_reference_id,
}) {
  const pre = await getPreauth({ tenantId, id });
  if (pre.status !== 'draft') {
    throw AppError.badRequest(`Pre-auth in ${pre.status} cannot be submitted`);
  }
  await prisma.$executeRawUnsafe(
    `UPDATE insurance_preauth
        SET status = 'submitted', submitted_at = NOW(),
            submitted_by = $1::uuid, submission_channel = $2,
            tpa_reference_id = COALESCE($3, tpa_reference_id),
            updated_at = NOW()
      WHERE id = $4::int`,
    submitted_by ? String(submitted_by) : null,
    submission_channel,
    tpa_reference_id || null,
    pre.id,
  );
  return getPreauth({ tenantId, id });
}

export async function recordPreauthResponse({
  tenantId, preauth_id, response_type, sanctioned_amount, validity_until,
  conditions, query_text, denial_reason, raw_response,
  decided_by_tpa_user, decided_at, recorded_by,
}) {
  const pre = await getPreauth({ tenantId, id: preauth_id });
  if (!['submitted', 'queried', 'approved', 'partially_approved'].includes(pre.status)) {
    throw AppError.badRequest(`Cannot record response on ${pre.status} pre-auth`);
  }

  // Insert response row (timeline).
  const respRows = await prisma.$queryRawUnsafe(
    `INSERT INTO insurance_preauth_responses
       (preauth_id, response_type, sanctioned_amount, validity_until,
        conditions, query_text, denial_reason, raw_response,
        decided_by_tpa_user, decided_at, recorded_by)
     VALUES ($1::int, $2, $3::numeric, $4::timestamptz, $5, $6, $7,
             $8::jsonb, $9, $10::timestamptz, $11::uuid)
     RETURNING *`,
    Number(preauth_id), response_type,
    sanctioned_amount ? Number(sanctioned_amount) : null,
    validity_until || null,
    conditions || null, query_text || null, denial_reason || null,
    JSON.stringify(raw_response || {}),
    decided_by_tpa_user || null,
    decided_at || new Date().toISOString(),
    recorded_by ? String(recorded_by) : null,
  );

  // Project response onto pre-auth row.
  const newStatus = ({
    approved: 'approved',
    partially_approved: 'partially_approved',
    denied: 'denied',
    queried: 'queried',
    enhancement_request: 'queried',
  })[response_type] || pre.status;

  await prisma.$executeRawUnsafe(
    `UPDATE insurance_preauth
        SET status = $1,
            sanctioned_amount = COALESCE($2::numeric, sanctioned_amount),
            sanctioned_at = CASE WHEN $1 IN ('approved','partially_approved') THEN NOW() ELSE sanctioned_at END,
            validity_until = COALESCE($3::timestamptz, validity_until),
            query_text = CASE WHEN $1 = 'queried' THEN $4 ELSE query_text END,
            denial_reason = CASE WHEN $1 = 'denied' THEN $5 ELSE denial_reason END,
            updated_at = NOW()
      WHERE id = $6::int`,
    newStatus,
    sanctioned_amount ? Number(sanctioned_amount) : null,
    validity_until || null,
    query_text || null,
    denial_reason || null,
    Number(preauth_id),
  );

  return { response: respRows[0], preauth: await getPreauth({ tenantId, id: preauth_id }) };
}

export async function listPendingPreauths({ tenantId, limit = 100 }) {
  return prisma.$queryRawUnsafe(
    `SELECT pa.id, pa.preauth_number, pa.patient_uid, pa.primary_diagnosis,
            pa.expected_cost, pa.sanctioned_amount, pa.status,
            pa.submitted_at, pa.created_at,
            p.policy_number, py.display_name AS payer_name, t.display_name AS tpa_name
       FROM insurance_preauth pa
       JOIN insurance_policies p ON p.id = pa.policy_id
       LEFT JOIN payers py ON py.id = p.payer_id
       LEFT JOIN tpas t ON t.id = p.tpa_id
      WHERE pa.tenant_id = $1::uuid
        AND pa.status IN ('draft','submitted','queried')
      ORDER BY pa.created_at DESC
      LIMIT $2::int`,
    tenantId, Number(limit),
  );
}

// ── Final claim ──────────────────────────────────────────────────────

export async function createClaim({
  tenantId, policy_id, preauth_id, invoice_id, patient_uid, admission_id,
  claim_type = 'cashless', total_billed, patient_copay = 0,
  non_payable_amount = 0, claimed_amount, notes, created_by,
}) {
  if (!policy_id) throw AppError.badRequest('policy_id is required');
  if (!patient_uid) throw AppError.badRequest('patient_uid is required');
  if (!total_billed || Number(total_billed) <= 0) {
    throw AppError.badRequest('total_billed must be > 0');
  }
  const claimAmt = Number(claimed_amount ?? (Number(total_billed) - Number(patient_copay) - Number(non_payable_amount)));
  if (claimAmt <= 0) throw AppError.badRequest('claimed_amount must be > 0');

  const claim_number = await nextSeq('tpa_claim_counter', 'CL', tenantId);

  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO tpa_claims
       (claim_number, policy_id, preauth_id, invoice_id, patient_uid,
        admission_id, claim_type, total_billed, patient_copay,
        non_payable_amount, claimed_amount, notes, created_by, tenant_id)
     VALUES ($1, $2::int, $3::int, $4::int, $5::uuid, $6::int, $7,
             $8::numeric, $9::numeric, $10::numeric, $11::numeric,
             $12, $13::uuid, $14::uuid)
     RETURNING *`,
    claim_number, Number(policy_id),
    preauth_id ? Number(preauth_id) : null,
    invoice_id ? Number(invoice_id) : null,
    String(patient_uid),
    admission_id ? Number(admission_id) : null,
    claim_type, Number(total_billed), Number(patient_copay),
    Number(non_payable_amount), claimAmt,
    notes || null,
    created_by ? String(created_by) : null, tenantId,
  );
  return rows[0];
}

export async function getClaim({ tenantId, id }) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT * FROM tpa_claims WHERE id = $1::int AND tenant_id = $2::uuid`,
    Number(id), tenantId,
  );
  if (!rows.length) throw AppError.notFound('Claim not found');
  return rows[0];
}

export async function submitClaim({
  tenantId, id, submitted_by, submission_channel = 'portal', tpa_reference_id,
}) {
  const cl = await getClaim({ tenantId, id });
  if (cl.status !== 'prepared') {
    throw AppError.badRequest(`Claim in ${cl.status} cannot be submitted`);
  }
  await prisma.$executeRawUnsafe(
    `UPDATE tpa_claims
        SET status = 'submitted', submitted_at = NOW(),
            submitted_by = $1::uuid, submission_channel = $2,
            tpa_reference_id = COALESCE($3, tpa_reference_id),
            updated_at = NOW()
      WHERE id = $4::int`,
    submitted_by ? String(submitted_by) : null,
    submission_channel,
    tpa_reference_id || null,
    cl.id,
  );
  return getClaim({ tenantId, id });
}

export async function recordClaimDecision({
  tenantId, id, decision, approved_amount, denial_reason, recorded_by,
}) {
  const cl = await getClaim({ tenantId, id });
  if (!['submitted', 'queried', 'approved', 'partially_approved'].includes(cl.status)) {
    throw AppError.badRequest(`Cannot record decision on ${cl.status} claim`);
  }
  const allowed = ['approved', 'partially_approved', 'queried', 'denied'];
  if (!allowed.includes(decision)) throw AppError.badRequest('Invalid decision');

  await prisma.$executeRawUnsafe(
    `UPDATE tpa_claims
        SET status = $1,
            approved_amount = COALESCE($2::numeric, approved_amount),
            denial_reason = CASE WHEN $1 = 'denied' THEN $3 ELSE denial_reason END,
            updated_at = NOW()
      WHERE id = $4::int`,
    decision,
    approved_amount ? Number(approved_amount) : null,
    denial_reason || null,
    cl.id,
  );

  // Drop a correspondence row for the audit trail.
  await prisma.$executeRawUnsafe(
    `INSERT INTO tpa_claim_correspondence
       (claim_id, direction, channel, subject, body, recorded_by)
     VALUES ($1::int, 'inbound', 'portal',
             $2, $3, $4::uuid)`,
    cl.id,
    `Decision: ${decision}`,
    [
      `Decision: ${decision}`,
      approved_amount ? `Approved: ${approved_amount}` : null,
      denial_reason ? `Reason: ${denial_reason}` : null,
    ].filter(Boolean).join('\n'),
    recorded_by ? String(recorded_by) : null,
  );

  return getClaim({ tenantId, id });
}

export async function recordClaimPayment({
  tenantId, id, paid_amount, payment_reference, paid_at, recorded_by,
}) {
  const cl = await getClaim({ tenantId, id });
  if (!['approved', 'partially_approved', 'submitted'].includes(cl.status)) {
    throw AppError.badRequest(`Cannot record payment on ${cl.status} claim`);
  }
  const paidNum = Number(paid_amount);
  if (!paid_amount || paidNum <= 0) {
    throw AppError.badRequest('paid_amount must be > 0');
  }
  // Insurers must not pay more than the hospital claimed. The
  // non_payable component (room upgrade delta, pharmacy over-cap,
  // attendant charges, etc.) is patient liability and must never be
  // silently absorbed into the TPA settlement — that would zero out
  // the patient share at discharge. See finding
  // 2026-05-09-tpa-insurance-claim-billing-tpa-overpay-no-validation.
  const claimedNum = Number(cl.claimed_amount || 0);
  if (claimedNum > 0 && paidNum > claimedNum) {
    throw AppError.badRequest(
      `paid_amount ${paidNum} exceeds claimed_amount ${claimedNum}; ` +
      `record an enhancement preauth or split the payment instead.`,
      'PAYMENT_EXCEEDS_CLAIM',
      { claimed_amount: claimedNum, paid_amount: paidNum }
    );
  }
  await prisma.$executeRawUnsafe(
    `UPDATE tpa_claims
        SET status = 'paid', paid_amount = $1::numeric,
            payment_reference = $2, paid_at = COALESCE($3::timestamptz, NOW()),
            updated_at = NOW()
      WHERE id = $4::int`,
    Number(paid_amount), payment_reference || null,
    paid_at || null, cl.id,
  );

  await prisma.$executeRawUnsafe(
    `INSERT INTO tpa_claim_correspondence
       (claim_id, direction, channel, subject, body, recorded_by)
     VALUES ($1::int, 'inbound', 'portal',
             $2, $3, $4::uuid)`,
    cl.id,
    `Settlement received`,
    `Paid amount: ${paid_amount}\nRef: ${payment_reference || '—'}`,
    recorded_by ? String(recorded_by) : null,
  );

  return getClaim({ tenantId, id });
}

export async function listClaims({
  tenantId, status, patient_uid, claim_type, aging_bucket, limit = 100,
}) {
  const params = [tenantId];
  const where = [`tenant_id = $1::uuid`];
  if (status) { params.push(status); where.push(`status = $${params.length}`); }
  if (patient_uid) {
    params.push(String(patient_uid));
    where.push(`patient_uid = $${params.length}::uuid`);
  }
  if (claim_type) { params.push(claim_type); where.push(`claim_type = $${params.length}`); }
  if (aging_bucket) { params.push(aging_bucket); where.push(`aging_bucket = $${params.length}`); }
  params.push(Number(limit));
  return prisma.$queryRawUnsafe(
    `SELECT * FROM tpa_claims_aging
      WHERE ${where.join(' AND ')}
      ORDER BY days_since_submit DESC NULLS LAST
      LIMIT $${params.length}::int`,
    ...params,
  );
}

// ── Documents + correspondence ───────────────────────────────────────

export async function attachDocument({
  claim_id, preauth_id, doc_type, file_name, file_url,
  file_size_bytes, mime_type, uploaded_by, notes,
}) {
  if (!claim_id && !preauth_id) {
    throw AppError.badRequest('claim_id or preauth_id is required');
  }
  if (!doc_type) throw AppError.badRequest('doc_type is required');
  if (!file_url) throw AppError.badRequest('file_url is required');

  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO tpa_claim_documents
       (claim_id, preauth_id, doc_type, file_name, file_url,
        file_size_bytes, mime_type, uploaded_by, notes)
     VALUES ($1::int, $2::int, $3, $4, $5,
             $6::bigint, $7, $8::uuid, $9)
     RETURNING *`,
    claim_id ? Number(claim_id) : null,
    preauth_id ? Number(preauth_id) : null,
    doc_type, file_name || 'document', file_url,
    file_size_bytes ? Number(file_size_bytes) : null,
    mime_type || null,
    uploaded_by ? String(uploaded_by) : null,
    notes || null,
  );
  return rows[0];
}

export async function logCorrespondence({
  claim_id, preauth_id, direction, channel, subject, body,
  attachments, recorded_by,
}) {
  if (!claim_id && !preauth_id) {
    throw AppError.badRequest('claim_id or preauth_id is required');
  }
  if (!['inbound', 'outbound'].includes(direction)) {
    throw AppError.badRequest('direction must be inbound or outbound');
  }
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO tpa_claim_correspondence
       (claim_id, preauth_id, direction, channel, subject, body,
        attachments, recorded_by)
     VALUES ($1::int, $2::int, $3, $4, $5, $6, $7::jsonb, $8::uuid)
     RETURNING *`,
    claim_id ? Number(claim_id) : null,
    preauth_id ? Number(preauth_id) : null,
    direction, channel || 'email', subject || null, body || null,
    JSON.stringify(attachments || []),
    recorded_by ? String(recorded_by) : null,
  );
  return rows[0];
}

export async function getClaimBundle({ tenantId, id }) {
  const claim = await getClaim({ tenantId, id });
  const docs = await prisma.$queryRawUnsafe(
    `SELECT * FROM tpa_claim_documents WHERE claim_id = $1::int ORDER BY uploaded_at DESC`,
    claim.id,
  );
  const corr = await prisma.$queryRawUnsafe(
    `SELECT * FROM tpa_claim_correspondence WHERE claim_id = $1::int ORDER BY recorded_at DESC`,
    claim.id,
  );
  return { claim, documents: docs, correspondence: corr };
}
