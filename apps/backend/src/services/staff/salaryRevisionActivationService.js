import crypto from 'node:crypto';
import { setTenant } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { recordSalaryRevisionActivatedTx } from './salaryRevisionActivationEventService.js';

const MAX_ATTEMPTS = 3;
const LEASE_SECONDS = 300;
const BASELINE_FIELDS = [
  'basic_salary',
  'hra_pct',
  'da_pct',
  'special_allowance',
  'transport_allowance',
  'medical_allowance',
  'tds_monthly',
  'pf_employee_pct',
];
const CHANGE_FIELDS = new Set([
  'hra_pct',
  'da_pct',
  'special_allowance',
  'transport_allowance',
  'medical_allowance',
  'tds_monthly',
]);
const GROSS_CHANGE_FIELDS = new Set([
  'hra_pct',
  'da_pct',
  'special_allowance',
  'transport_allowance',
  'medical_allowance',
]);

function iso(value, dateOnly = false) {
  if (value == null) return null;
  const result = new Date(value).toISOString();
  return dateOnly ? result.slice(0, 10) : result;
}

function money(value) {
  return value == null ? null : Number(value).toFixed(2);
}

function canonicalBaseline(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return {
    ...Object.fromEntries(BASELINE_FIELDS.map(field => [
      field,
      Number(value[field] ?? 0).toFixed(2),
    ])),
    esi_applicable: Boolean(value.esi_applicable),
  };
}

function canonicalChanges(value) {
  if (value == null) return null;
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  return Object.fromEntries(Object.keys(parsed).sort().map(field => [
    field,
    Number(parsed[field]).toFixed(2),
  ]));
}

function sha256(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function termsManifest(revision) {
  return sha256({
    tenant_id: revision.tenant_id,
    revision_number: revision.revision_number,
    staff_uid: revision.staff_uid,
    revision_type: revision.revision_type,
    salary_baseline: canonicalBaseline(revision.salary_baseline),
    current_basic: money(revision.current_basic),
    proposed_basic: money(revision.proposed_basic),
    current_gross: money(revision.current_gross),
    proposed_gross: money(revision.proposed_gross),
    increment_amount: money(revision.increment_amount),
    increment_pct: money(revision.increment_pct),
    bonus_amount: money(revision.bonus_amount),
    bonus_reason: revision.bonus_reason ?? null,
    other_changes: canonicalChanges(revision.other_changes),
    effective_from: iso(revision.effective_from, true),
    reason: revision.reason,
    proposed_by: revision.proposed_by,
    proposed_at: iso(revision.proposed_at),
  });
}

function hrSignature(revision) {
  return sha256({
    terms_manifest_sha256: revision.terms_manifest_sha256,
    hr_signed_by: revision.hr_signed_by,
    hr_signed_at: iso(revision.hr_signed_at),
    hr_signer_role: revision.hr_signer_role,
    hr_authority_checked_at: iso(revision.hr_authority_checked_at),
    hr_authority_source: revision.hr_authority_source,
    hr_comment: revision.hr_comment ?? null,
  });
}

function adminSignature(revision) {
  return sha256({
    tenant_id: revision.tenant_id,
    revision_number: revision.revision_number,
    staff_uid: revision.staff_uid,
    revision_type: revision.revision_type,
    salary_baseline: canonicalBaseline(revision.salary_baseline),
    current_basic: money(revision.current_basic),
    proposed_basic: money(revision.proposed_basic),
    current_gross: money(revision.current_gross),
    proposed_gross: money(revision.proposed_gross),
    increment_amount: money(revision.increment_amount),
    increment_pct: money(revision.increment_pct),
    bonus_amount: money(revision.bonus_amount),
    bonus_reason: revision.bonus_reason ?? null,
    other_changes: canonicalChanges(revision.other_changes),
    effective_from: iso(revision.effective_from, true),
    reason: revision.reason,
    proposed_by: revision.proposed_by,
    proposed_at: iso(revision.proposed_at),
    hr_signed_by: revision.hr_signed_by,
    hr_signed_at: iso(revision.hr_signed_at),
    hr_signer_role: revision.hr_signer_role,
    hr_authority_checked_at: iso(revision.hr_authority_checked_at),
    hr_authority_source: revision.hr_authority_source,
    hr_comment: revision.hr_comment ?? null,
    admin_signed_by: revision.admin_signed_by,
    admin_signed_at: iso(revision.admin_signed_at),
    admin_signer_role: revision.admin_signer_role,
    admin_authority_checked_at: iso(revision.admin_authority_checked_at),
    admin_authority_source: revision.admin_authority_source,
    admin_comment: revision.admin_comment ?? null,
    terms_manifest_sha256: revision.terms_manifest_sha256,
    hr_signature_sha256: revision.hr_signature_sha256,
  });
}

function baselineMatches(salary, baseline) {
  return baseline && BASELINE_FIELDS.every(field => (
    Number.isFinite(Number(baseline[field]))
    && Math.abs(Number(salary[field] ?? 0) - Number(baseline[field])) < 0.005
  )) && typeof baseline.esi_applicable === 'boolean'
    && Boolean(salary.esi_applicable) === baseline.esi_applicable;
}

function gross(salary) {
  const basic = Number(salary.basic_salary);
  return Math.round((
    basic
    + basic * Number(salary.hra_pct ?? 0) / 100
    + basic * Number(salary.da_pct ?? 0) / 100
    + Number(salary.special_allowance ?? 0)
    + Number(salary.transport_allowance ?? 0)
    + Number(salary.medical_allowance ?? 0)
  ) * 100) / 100;
}

function validShape(revision, changes) {
  const fields = Object.keys(changes);
  if (revision.revision_type === 'increment') {
    return revision.proposed_basic != null
      && Number(revision.proposed_basic) > Number(revision.current_basic)
      && Number(revision.increment_amount) > 0
      && Number(revision.increment_pct) > 0
      && Math.abs(Number(revision.proposed_basic) - Number(revision.current_basic)
        - Number(revision.increment_amount)) < 0.005
      && revision.bonus_amount == null
      && revision.bonus_reason == null
      && fields.length === 0;
  }
  if (revision.revision_type === 'bonus') {
    return revision.proposed_basic == null
      && revision.increment_amount == null
      && revision.increment_pct == null
      && Number(revision.bonus_amount) > 0
      && typeof revision.bonus_reason === 'string'
      && revision.bonus_reason.trim().length > 0
      && fields.length === 0;
  }
  if (revision.revision_type === 'deduction_change') {
    return revision.proposed_basic == null
      && revision.increment_amount == null
      && revision.increment_pct == null
      && revision.bonus_amount == null
      && revision.bonus_reason == null
      && fields.length === 1
      && fields[0] === 'tds_monthly';
  }
  return revision.revision_type === 'component_change'
    && revision.proposed_basic == null
    && revision.increment_amount == null
    && revision.increment_pct == null
    && revision.bonus_amount == null
    && revision.bonus_reason == null
    && fields.length > 0
    && fields.every(field => GROSS_CHANGE_FIELDS.has(field));
}

async function applyClaim(claim) {
  return setTenant(claim.tenant_id, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `SELECT activation.id AS activation_id, activation.attempt_count,
              activation.expected_admin_signature_sha256,
              revision.*, clock_timestamp() AS worker_now,
              CURRENT_DATE AS worker_date
       FROM salary_revision_activation_jobs activation
       JOIN salary_revisions revision
         ON revision.tenant_id = activation.tenant_id
        AND revision.id = activation.revision_id
       JOIN tenants tenant
         ON tenant.id = activation.tenant_id
        AND LOWER(COALESCE(tenant.status, '')) = 'active'
        WHERE activation.id = $1::bigint
          AND activation.tenant_id = $2::uuid
          AND activation.claim_token = $3::uuid
          AND activation.attempt_count = $4::int
          AND activation.status = 'processing'
          AND activation.lease_expires_at > clock_timestamp()
          AND revision.tenant_reconciliation_required = false
        FOR UPDATE OF activation, revision
        FOR SHARE OF tenant`,
      claim.id,
      claim.tenant_id,
      claim.claim_token,
      Number(claim.attempt_count),
    );
    const revision = rows[0];
    if (!revision) return { outcome: 'stale_claim' };
    if (revision.status !== 'approved'
        || iso(revision.worker_date, true) < iso(revision.effective_from, true)) {
      throw new Error('Salary revision activation is not due and approved');
    }
    if (revision.expected_admin_signature_sha256 !== revision.admin_signature_sha256
        || revision.signature_hash !== revision.admin_signature_sha256
        || termsManifest(revision) !== revision.terms_manifest_sha256
        || hrSignature(revision) !== revision.hr_signature_sha256
        || adminSignature(revision) !== revision.admin_signature_sha256
        || revision.hr_signer_role !== 'HR_STAFF'
        || !['ADMIN', 'SUPER_ADMIN'].includes(revision.admin_signer_role)
        || revision.hr_authority_source !== 'users_active_row'
        || revision.admin_authority_source !== 'users_active_row'
        || iso(revision.hr_authority_checked_at) !== iso(revision.hr_signed_at)
        || iso(revision.admin_authority_checked_at) !== iso(revision.admin_signed_at)
        || revision.hr_signed_by === revision.admin_signed_by) {
      throw new Error('Salary revision activation signature evidence is invalid');
    }
    const salaries = await tx.$queryRawUnsafe(
      `SELECT salary.basic_salary, salary.hra_pct, salary.da_pct,
              salary.special_allowance, salary.transport_allowance,
              salary.medical_allowance, salary.tds_monthly,
              salary.pf_employee_pct, salary.esi_applicable
         FROM staff_salary salary
         JOIN users staff_owner
           ON staff_owner.tenant_id = salary.tenant_id
          AND staff_owner.uid = salary.staff_uid
        WHERE salary.tenant_id = $1::uuid
          AND salary.staff_uid = $2::uuid
          AND salary.is_active = true
          AND staff_owner.is_active = true
          AND COALESCE(staff_owner.is_deleted, false) = false
          AND staff_owner.deleted_at IS NULL
          AND staff_owner.merged_into_uid IS NULL
          AND LOWER(COALESCE(staff_owner.status, 'active')) = 'active'
        FOR UPDATE OF salary FOR SHARE OF staff_owner`,
      claim.tenant_id,
      revision.staff_uid,
    );
    const salary = salaries[0];
    if (!salary || !baselineMatches(salary, revision.salary_baseline)) {
      throw new Error('Frozen staff salary baseline changed before activation');
    }
    const changes = revision.other_changes == null
      ? {}
      : (typeof revision.other_changes === 'string'
        ? JSON.parse(revision.other_changes) : revision.other_changes);
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)
        || Object.entries(changes).some(([field, value]) => (
          !CHANGE_FIELDS.has(field)
          || !Number.isFinite(Number(value))
          || Number(value) < 0
        ))
        || !validShape(revision, changes)) {
      throw new Error('Salary revision activation financial shape is invalid');
    }
    const expectedGross = gross({
      ...salary,
      ...changes,
      basic_salary: revision.proposed_basic ?? salary.basic_salary,
    });
    if (Math.abs(Number(revision.current_gross) - gross(salary)) >= 0.005
        || Math.abs(Number(revision.proposed_gross) - expectedGross) >= 0.005) {
      throw new Error('Salary revision activation gross evidence is invalid');
    }
    const assignments = [];
    const values = [];
    let index = 1;
    if (revision.proposed_basic != null) {
      assignments.push(`basic_salary = $${index++}`);
      values.push(revision.proposed_basic);
    }
    for (const [field, value] of Object.entries(changes)) {
      assignments.push(`${field} = $${index++}`);
      values.push(value);
    }
    if (assignments.length > 0) {
      assignments.push('updated_at = clock_timestamp()');
      values.push(revision.staff_uid, claim.tenant_id);
      const updated = await tx.$executeRawUnsafe(
        `UPDATE staff_salary
            SET ${assignments.join(', ')}
          WHERE staff_uid = $${index}::uuid
            AND tenant_id = $${index + 1}::uuid
            AND is_active = true`,
        ...values,
      );
      if (updated !== 1) throw new Error('Salary activation update lost its tenant fence');
    }
    if (revision.revision_type === 'bonus') {
      await tx.$queryRawUnsafe(
        `INSERT INTO salary_revision_payables (
           tenant_id, revision_id, staff_uid, payable_type, amount, status
         ) VALUES ($1::uuid, $2::int, $3::uuid, 'bonus', $4::numeric, 'pending')
         ON CONFLICT (tenant_id, revision_id) DO NOTHING
         RETURNING id`,
        claim.tenant_id,
        revision.id,
        revision.staff_uid,
        revision.bonus_amount,
      );
      const payable = await tx.$queryRawUnsafe(
        `SELECT id FROM salary_revision_payables
          WHERE tenant_id = $1::uuid AND revision_id = $2::int
            AND staff_uid = $3::uuid AND payable_type = 'bonus'
            AND amount = $4::numeric AND status = 'pending'
          FOR UPDATE`,
        claim.tenant_id,
        revision.id,
        revision.staff_uid,
        revision.bonus_amount,
      );
      if (payable.length !== 1) throw new Error('Bonus payable activation is inconsistent');
    }
    const applied = await tx.$queryRawUnsafe(
      `UPDATE salary_revisions
          SET status = 'applied', applied_at = $3::timestamptz,
              updated_at = $3::timestamptz
        WHERE tenant_id = $1::uuid AND id = $2::int
          AND tenant_reconciliation_required = false AND status = 'approved'
        RETURNING id`,
      claim.tenant_id,
      revision.id,
      revision.worker_now,
    );
    if (applied.length !== 1) throw new Error('Salary revision activation transition was lost');
    if (['increment', 'component_change'].includes(revision.revision_type)
        && Number(revision.proposed_gross) > Number(revision.current_gross)
        && iso(revision.effective_from, true) < iso(revision.worker_date, true)) {
      await tx.$queryRawUnsafe(
        `INSERT INTO salary_revision_arrears_work_items (
           tenant_id, revision_id, staff_uid, effective_on, activated_at, status
         ) VALUES ($1::uuid, $2::int, $3::uuid, $4::date, $5::timestamptz, 'pending')
         ON CONFLICT (tenant_id, revision_id) DO NOTHING
         RETURNING id`,
        claim.tenant_id,
        revision.id,
        revision.staff_uid,
        revision.effective_from,
        revision.worker_now,
      );
      const arrearsWork = await tx.$queryRawUnsafe(
        `SELECT id
           FROM salary_revision_arrears_work_items
          WHERE tenant_id = $1::uuid AND revision_id = $2::int
            AND staff_uid = $3::uuid AND effective_on = $4::date
            AND activated_at = $5::timestamptz AND status = 'pending'
          FOR UPDATE`,
        claim.tenant_id,
        revision.id,
        revision.staff_uid,
        revision.effective_from,
        revision.worker_now,
      );
      if (arrearsWork.length !== 1) {
        throw new Error('Salary revision arrears work identity is inconsistent');
      }
    }
    await tx.$executeRawUnsafe(
      `UPDATE annual_review_reminders reminder
          SET status = 'completed', revision_id = $2::int
        WHERE reminder.tenant_id = $1::uuid
          AND reminder.staff_uid = $3::uuid
          AND reminder.review_year = EXTRACT(YEAR FROM $4::date)::int
          AND reminder.status IN ('pending', 'initiated')
          AND reminder.tenant_reconciliation_required = false
          AND (reminder.revision_id IS NULL OR reminder.revision_id = $2::int)`,
      claim.tenant_id,
      revision.id,
      revision.staff_uid,
      revision.effective_from,
    );
    const finalized = await tx.$queryRawUnsafe(
      `UPDATE salary_revision_activation_jobs
          SET status = 'applied', claim_token = NULL, claimed_at = NULL,
              lease_expires_at = NULL, last_error = NULL,
              outcome = jsonb_build_object('code', 'applied', 'revision_id', $5::int),
              applied_at = $6::timestamptz, finalized_at = $6::timestamptz,
              updated_at = $6::timestamptz
        WHERE id = $1::bigint AND tenant_id = $2::uuid
          AND claim_token = $3::uuid AND attempt_count = $4::int
          AND status = 'processing'
        RETURNING id`,
      claim.id,
      claim.tenant_id,
      claim.claim_token,
      Number(claim.attempt_count),
      revision.id,
      revision.worker_now,
    );
    if (finalized.length !== 1) throw new Error('Salary revision activation lease was lost');
    await recordSalaryRevisionActivatedTx(tx, {
      tenantId: claim.tenant_id,
      revisionId: revision.id,
      staffUid: revision.staff_uid,
      sourceType: 'activation_worker',
      sourceId: claim.id,
      effectiveOn: revision.effective_from,
      appliedAt: revision.worker_now,
      termsManifestSha256: revision.terms_manifest_sha256,
      hrSignatureSha256: revision.hr_signature_sha256,
      adminSignatureSha256: revision.admin_signature_sha256,
    });
    return { outcome: 'applied', revisionId: Number(revision.id) };
  });
}

async function failClaim(claim, failure) {
  const terminal = Number(claim.attempt_count) >= MAX_ATTEMPTS;
  const delaySeconds = Math.min(300, 5 * (2 ** Number(claim.attempt_count)));
  return setTenant(claim.tenant_id, tx => tx.$queryRawUnsafe(
    `UPDATE salary_revision_activation_jobs
        SET status = CASE WHEN $5::boolean THEN 'reconciliation_required' ELSE 'queued' END,
            next_attempt_at = clock_timestamp() + ($6::int * INTERVAL '1 second'),
            claim_token = NULL, claimed_at = NULL, lease_expires_at = NULL,
            last_error = $4,
            outcome = CASE WHEN $5::boolean
              THEN jsonb_build_object(
                'code', 'salary_revision_activation_failed',
                'attempt_count', attempt_count,
                'message', $4::text
              ) ELSE outcome END,
            finalized_at = CASE WHEN $5::boolean THEN clock_timestamp() ELSE NULL END,
            updated_at = clock_timestamp()
      WHERE id = $1::bigint AND tenant_id = $2::uuid
        AND claim_token = $3::uuid AND attempt_count = $7::int
        AND status = 'processing'
      RETURNING id, status`,
    claim.id,
    claim.tenant_id,
    claim.claim_token,
    String(failure?.message || failure).slice(0, 2000),
    terminal,
    delaySeconds,
    Number(claim.attempt_count),
  ));
}

export async function processDueSalaryRevisionActivations({ tenantId, limit = 25 } = {}) {
  const boundedLimit = Math.max(1, Math.min(Number(limit) || 25, 100));
  const claims = await setTenant(tenantId, async (tx) => {
    const activeTenants = await tx.$queryRawUnsafe(
      `SELECT id FROM tenants
        WHERE id = $1::uuid AND LOWER(COALESCE(status, '')) = 'active'
        FOR SHARE`,
      tenantId,
    );
    if (activeTenants.length !== 1) return [];
    return tx.$queryRawUnsafe(
      `WITH expired AS (
       UPDATE salary_revision_activation_jobs
          SET status = CASE WHEN attempt_count >= $2::int
                       THEN 'reconciliation_required' ELSE 'queued' END,
              next_attempt_at = clock_timestamp(), claim_token = NULL,
              claimed_at = NULL, lease_expires_at = NULL,
              last_error = 'Activation worker lease expired',
              outcome = CASE WHEN attempt_count >= $2::int
                THEN jsonb_build_object(
                  'code', 'salary_revision_activation_lease_exhausted',
                  'attempt_count', attempt_count
                ) ELSE outcome END,
              finalized_at = CASE WHEN attempt_count >= $2::int
                             THEN clock_timestamp() ELSE NULL END,
              updated_at = clock_timestamp()
        WHERE tenant_id = $3::uuid AND status = 'processing'
          AND lease_expires_at <= clock_timestamp()
        RETURNING id
     ), candidates AS (
       SELECT activation.id
         FROM salary_revision_activation_jobs activation
         JOIN salary_revisions revision
           ON revision.tenant_id = activation.tenant_id
          AND revision.id = activation.revision_id
        WHERE activation.tenant_id = $3::uuid
          AND activation.status = 'queued'
          AND activation.next_attempt_at <= clock_timestamp()
          AND activation.attempt_count < $2::int
          AND CURRENT_DATE >= activation.effective_on
          AND revision.status = 'approved'
          AND revision.tenant_reconciliation_required = false
        ORDER BY activation.next_attempt_at, activation.id
        FOR UPDATE OF activation SKIP LOCKED
        LIMIT $1::int
     )
     UPDATE salary_revision_activation_jobs activation
        SET status = 'processing', attempt_count = attempt_count + 1,
            claim_token = gen_random_uuid(), claimed_at = clock_timestamp(),
            lease_expires_at = clock_timestamp() + ($4::int * INTERVAL '1 second'),
            updated_at = clock_timestamp()
       FROM candidates
      WHERE activation.id = candidates.id
      RETURNING activation.id, activation.tenant_id, activation.revision_id,
                activation.claim_token, activation.attempt_count`,
      boundedLimit,
      MAX_ATTEMPTS,
      tenantId,
      LEASE_SECONDS,
    );
  });
  const outcomes = [];
  for (const claim of claims) {
    try {
      outcomes.push(await applyClaim(claim));
    } catch (failure) {
      logger.warn(`Salary revision activation ${claim.id} failed: ${failure.message}`);
      await failClaim(claim, failure);
      outcomes.push({ outcome: 'failed', revisionId: Number(claim.revision_id) });
    }
  }
  return outcomes;
}

export default { processDueSalaryRevisionActivations };
