import crypto from 'node:crypto';
import { setTenant } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { normalizeRole } from '../../utils/roles.js';
import { getStaffVisibilityRoles } from '../../config/rolePolicyGraph.js';
import {
  findSalaryRevisionCommandReplayTx,
  finaliseSalaryRevisionCommandTx,
} from './salaryRevisionCommandService.js';
import { recordSalaryRevisionActivatedTx } from './salaryRevisionActivationEventService.js';

const DEFAULT_LEASE_SECONDS = 300;
const DEFAULT_MAX_ATTEMPTS = 3;
const VALID_TARGET_TYPES = new Set(['all', 'department', 'role', 'designation']);
const SALARY_BASELINE_FIELDS = [
  'basic_salary',
  'hra_pct',
  'da_pct',
  'special_allowance',
  'transport_allowance',
  'medical_allowance',
  'tds_monthly',
  'pf_employee_pct',
];

export class BulkSalaryRevisionError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'BulkSalaryRevisionError';
    this.statusCode = statusCode;
  }
}

function requireUuid(value, label) {
  if (!value) throw new BulkSalaryRevisionError(`${label} is required`, 401);
  return value;
}

function requireJobId(value) {
  const jobId = Number(value);
  if (!Number.isInteger(jobId) || jobId <= 0) {
    throw new BulkSalaryRevisionError('Invalid bulk revision job id');
  }
  return jobId;
}

function money(value) {
  return Math.round(Number(value) * 100) / 100;
}

function sameMoney(left, right) {
  return Math.abs(Number(left) - Number(right)) < 0.005;
}

function canonicalSalaryBaseline(salary) {
  if (!salary || typeof salary !== 'object' || Array.isArray(salary)) return null;
  return {
    ...Object.fromEntries(SALARY_BASELINE_FIELDS.map(field => [
      field,
      Number(salary[field] ?? 0).toFixed(2),
    ])),
    esi_applicable: Boolean(salary.esi_applicable),
  };
}

function salaryBaselineMatches(salary, baseline) {
  if (!baseline || typeof baseline !== 'object' || Array.isArray(baseline)) return false;
  return SALARY_BASELINE_FIELDS.every(field => (
    Number.isFinite(Number(baseline[field]))
    && sameMoney(salary[field] ?? 0, baseline[field])
  )) && typeof baseline.esi_applicable === 'boolean'
    && Boolean(salary.esi_applicable) === baseline.esi_applicable;
}

function grossFromSalary(salary) {
  const basic = Number(salary.basic_salary);
  return money(
    basic
      + basic * Number(salary.hra_pct ?? 0) / 100
      + basic * Number(salary.da_pct ?? 0) / 100
      + Number(salary.special_allowance ?? 0)
      + Number(salary.transport_allowance ?? 0)
      + Number(salary.medical_allowance ?? 0),
  );
}

function iso(value, dateOnly = false) {
  if (value == null) return null;
  const text = new Date(value).toISOString();
  return dateOnly ? text.slice(0, 10) : text;
}

function sha256Json(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function jobTermsManifest(job) {
  return sha256Json({
    tenant_id: job.tenant_id,
    id: Number(job.job_id ?? job.id),
    description: job.description,
    revision_type: job.revision_type,
    target_type: job.target_type,
    target_value: job.target_value ?? null,
    increment_type: job.increment_type ?? null,
    increment_value: job.increment_value == null
      ? null
      : Number(job.increment_value).toFixed(2),
    bonus_amount: job.bonus_amount == null ? null : Number(job.bonus_amount).toFixed(2),
    effective_from: iso(job.effective_from, true),
    created_by: job.created_by,
    created_by_role: job.created_by_role,
    creator_authority_checked_at: iso(job.creator_authority_checked_at),
    creator_authority_source: job.creator_authority_source,
    created_at: iso(job.created_at),
    staff_count: Number(job.staff_count),
    cohort_manifest_sha256: job.cohort_manifest_sha256,
  });
}

function hrSignature(job, hrUid, signedAt) {
  return sha256Json({
    terms_manifest_sha256: job.terms_manifest_sha256,
    hr_signed_by: hrUid,
    hr_signed_at: iso(signedAt),
    hr_signer_role: job.hr_signer_role ?? 'HR_STAFF',
    hr_authority_checked_at: iso(job.hr_authority_checked_at ?? signedAt),
    hr_authority_source: job.hr_authority_source ?? 'users_active_row',
  });
}

function adminSignature(job, adminUid, signedAt) {
  return sha256Json({
    terms_manifest_sha256: job.terms_manifest_sha256,
    hr_signature_sha256: job.hr_signature_sha256,
    approved_by: adminUid,
    approved_at: iso(signedAt),
    admin_signer_role: job.admin_signer_role,
    admin_authority_checked_at: iso(job.admin_authority_checked_at ?? signedAt),
    admin_authority_source: job.admin_authority_source ?? 'users_active_row',
  });
}

function revisionTermsManifest(revision) {
  return sha256Json({
    tenant_id: revision.tenant_id,
    revision_number: revision.revision_number,
    staff_uid: revision.staff_uid,
    revision_type: revision.revision_type,
    salary_baseline: canonicalSalaryBaseline(revision.salary_baseline),
    current_basic: revision.current_basic == null
      ? null : Number(revision.current_basic).toFixed(2),
    proposed_basic: revision.proposed_basic == null
      ? null : Number(revision.proposed_basic).toFixed(2),
    current_gross: revision.current_gross == null
      ? null : Number(revision.current_gross).toFixed(2),
    proposed_gross: revision.proposed_gross == null
      ? null : Number(revision.proposed_gross).toFixed(2),
    increment_amount: revision.increment_amount == null
      ? null : Number(revision.increment_amount).toFixed(2),
    increment_pct: revision.increment_pct == null
      ? null : Number(revision.increment_pct).toFixed(2),
    bonus_amount: revision.bonus_amount == null
      ? null : Number(revision.bonus_amount).toFixed(2),
    bonus_reason: revision.bonus_reason ?? null,
    other_changes: null,
    effective_from: iso(revision.effective_from, true),
    reason: revision.reason,
    proposed_by: revision.proposed_by,
    proposed_at: iso(revision.proposed_at),
  });
}

function revisionHrSignature(revision) {
  return sha256Json({
    terms_manifest_sha256: revision.terms_manifest_sha256,
    hr_signed_by: revision.hr_signed_by,
    hr_signed_at: iso(revision.hr_signed_at),
    hr_signer_role: revision.hr_signer_role,
    hr_authority_checked_at: iso(revision.hr_authority_checked_at),
    hr_authority_source: revision.hr_authority_source,
    hr_comment: null,
  });
}

function revisionAdminSignature(revision) {
  return sha256Json({
    tenant_id: revision.tenant_id,
    revision_number: revision.revision_number,
    staff_uid: revision.staff_uid,
    revision_type: revision.revision_type,
    salary_baseline: canonicalSalaryBaseline(revision.salary_baseline),
    current_basic: revision.current_basic == null
      ? null : Number(revision.current_basic).toFixed(2),
    proposed_basic: revision.proposed_basic == null
      ? null : Number(revision.proposed_basic).toFixed(2),
    current_gross: revision.current_gross == null
      ? null : Number(revision.current_gross).toFixed(2),
    proposed_gross: revision.proposed_gross == null
      ? null : Number(revision.proposed_gross).toFixed(2),
    increment_amount: revision.increment_amount == null
      ? null : Number(revision.increment_amount).toFixed(2),
    increment_pct: revision.increment_pct == null
      ? null : Number(revision.increment_pct).toFixed(2),
    bonus_amount: revision.bonus_amount == null
      ? null : Number(revision.bonus_amount).toFixed(2),
    bonus_reason: revision.bonus_reason ?? null,
    other_changes: null,
    effective_from: iso(revision.effective_from, true),
    reason: revision.reason,
    proposed_by: revision.proposed_by,
    proposed_at: iso(revision.proposed_at),
    hr_signed_by: revision.hr_signed_by,
    hr_signed_at: iso(revision.hr_signed_at),
    hr_signer_role: revision.hr_signer_role,
    hr_authority_checked_at: iso(revision.hr_authority_checked_at),
    hr_authority_source: revision.hr_authority_source,
    hr_comment: null,
    admin_signed_by: revision.admin_signed_by,
    admin_signed_at: iso(revision.admin_signed_at),
    admin_signer_role: revision.admin_signer_role,
    admin_authority_checked_at: iso(revision.admin_authority_checked_at),
    admin_authority_source: revision.admin_authority_source,
    admin_comment: null,
    terms_manifest_sha256: revision.terms_manifest_sha256,
    hr_signature_sha256: revision.hr_signature_sha256,
  });
}

async function assertDatabaseRole(tx, tenantId, actorUid, allowedRoles) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT role
       FROM users
      WHERE tenant_id = $1::uuid
        AND uid = $2::uuid
        AND is_active = true
        AND COALESCE(is_deleted, false) = false
        AND deleted_at IS NULL
        AND merged_into_uid IS NULL
        AND LOWER(COALESCE(status, 'active')) = 'active'
      FOR SHARE`,
    tenantId,
    actorUid,
  );
  const role = normalizeRole(rows[0]?.role);
  if (!allowedRoles.includes(role)) {
    throw new BulkSalaryRevisionError('Signer role is not authorized', 403);
  }
  return role;
}

function cohortManifest(items) {
  const canonical = items
    .map(item => `${item.staff_uid}:${normalizeRole(item.staff_role_at_freeze)}:${JSON.stringify(canonicalSalaryBaseline(
      item.salary_baseline,
    ))}:${money(item.salary_before).toFixed(2)}`)
    .sort()
    .join('\n');
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

async function assertCohortManifestTx(tx, tenantId, jobId, expectedManifest) {
  const items = await tx.$queryRawUnsafe(
    `SELECT staff_uid, staff_role_at_freeze, salary_before, salary_baseline
       FROM bulk_revision_job_items
      WHERE tenant_id = $1::uuid AND job_id = $2::int
      ORDER BY staff_uid`,
    tenantId,
    jobId,
  );
  if (!expectedManifest || cohortManifest(items) !== expectedManifest) {
    throw new BulkSalaryRevisionError('Bulk revision cohort manifest changed', 409);
  }
  return items.length;
}

function canCreateBulkRevisionForTarget(creatorRole, targetRole) {
  const actor = normalizeRole(creatorRole);
  const target = normalizeRole(targetRole);
  if (!actor || !target || target === 'PATIENT') return false;
  if (target === 'SUPER_ADMIN') return actor === 'SUPER_ADMIN';
  if (target === 'ADMIN') return actor === 'SUPER_ADMIN';
  return getStaffVisibilityRoles(actor).includes(target);
}

function targetClause(targetType) {
  if (targetType === 'department') return 'AND ss.department = $3';
  if (targetType === 'role') return 'AND u.role = $3';
  if (targetType === 'designation') return 'AND ss.designation = $3';
  return '';
}

export async function createBulkSalaryRevisionJob({ tenantId, actorUid, input, command }) {
  requireUuid(tenantId, 'tenantId');
  requireUuid(actorUid, 'actorUid');
  const {
    description,
    revision_type: revisionType,
    target_type: targetType,
    target_value: targetValue,
    increment_type: incrementType,
    increment_value: incrementValue,
    bonus_amount: bonusAmount,
    effective_from: effectiveFrom,
  } = input;
  if (!description || !revisionType || !targetType || !effectiveFrom) {
    throw new BulkSalaryRevisionError(
      'description,revision_type,target_type,effective_from required',
    );
  }
  if (!VALID_TARGET_TYPES.has(targetType)) {
    throw new BulkSalaryRevisionError('target_type must be all, department, role, or designation');
  }
  if (targetType !== 'all' && !targetValue) {
    throw new BulkSalaryRevisionError('target_value is required for the selected target_type');
  }
  if (!['increment', 'bonus'].includes(revisionType)) {
    throw new BulkSalaryRevisionError('revision_type must be increment or bonus');
  }
  if (
    revisionType === 'increment'
    && (
      !['fixed', 'percentage'].includes(incrementType)
      || !Number.isFinite(Number(incrementValue))
      || Number(incrementValue) <= 0
    )
  ) {
    throw new BulkSalaryRevisionError(
      'A positive increment_value and fixed or percentage increment_type are required',
    );
  }
  if (
    revisionType === 'bonus'
    && (!Number.isFinite(Number(bonusAmount)) || Number(bonusAmount) <= 0)
  ) {
    throw new BulkSalaryRevisionError('A positive bonus_amount is required');
  }
  const effectiveDate = new Date(effectiveFrom);
  if (Number.isNaN(effectiveDate.getTime())) {
    throw new BulkSalaryRevisionError('effective_from must be a valid date');
  }
  if (revisionType === 'increment' && effectiveDate.getUTCDate() !== 1) {
    throw new BulkSalaryRevisionError(
      'Bulk increment revisions require a first-of-month effective_from',
    );
  }

  return setTenant(tenantId, async (tx) => {
    const creatorRole = await assertDatabaseRole(
      tx,
      tenantId,
      actorUid,
      ['HR_STAFF', 'ADMIN', 'SUPER_ADMIN'],
    );
    const creatorAuthorityAt = (await tx.$queryRawUnsafe(
      'SELECT clock_timestamp() AS authority_checked_at',
    ))[0].authority_checked_at;
    const replay = await findSalaryRevisionCommandReplayTx(tx, tenantId, command);
    if (replay) return replay.responseData;
    const job = await tx.bulk_revision_jobs.create({
      data: {
        tenant_id: tenantId,
        description,
        revision_type: revisionType,
        target_type: targetType,
        target_value: targetValue,
        increment_type: incrementType,
        increment_value: incrementValue,
        bonus_amount: bonusAmount,
        effective_from: effectiveDate,
        staff_count: 0,
        processed_count: 0,
        failed_count: 0,
        status: 'building',
        created_by: actorUid,
        created_by_role: creatorRole,
        creator_authority_checked_at: creatorAuthorityAt,
        creator_authority_source: 'users_active_row',
      },
      select: {
        id: true,
        description: true,
        revision_type: true,
        target_type: true,
        target_value: true,
        increment_type: true,
        increment_value: true,
        bonus_amount: true,
        effective_from: true,
        staff_count: true,
        status: true,
        created_by: true,
        created_by_role: true,
        creator_authority_checked_at: true,
        creator_authority_source: true,
        created_at: true,
      },
    });
    const params = [tenantId, job.id];
    if (targetType !== 'all') params.push(targetValue);
    const items = await tx.$queryRawUnsafe(
      `INSERT INTO bulk_revision_job_items (
         tenant_id, job_id, staff_uid, staff_role_at_freeze,
         salary_before, salary_baseline
       )
       SELECT $1::uuid, $2::int, u.uid, UPPER(u.role), ss.basic_salary,
              jsonb_build_object(
                'basic_salary', to_char(ss.basic_salary, 'FM999999999990.00'),
                'hra_pct', to_char(COALESCE(ss.hra_pct, 0), 'FM999999999990.00'),
                'da_pct', to_char(COALESCE(ss.da_pct, 0), 'FM999999999990.00'),
                'special_allowance', to_char(COALESCE(ss.special_allowance, 0), 'FM999999999990.00'),
                'transport_allowance', to_char(COALESCE(ss.transport_allowance, 0), 'FM999999999990.00'),
                'medical_allowance', to_char(COALESCE(ss.medical_allowance, 0), 'FM999999999990.00'),
                'tds_monthly', to_char(COALESCE(ss.tds_monthly, 0), 'FM999999999990.00'),
                'pf_employee_pct', to_char(COALESCE(ss.pf_employee_pct, 0), 'FM999999999990.00'),
                'esi_applicable', COALESCE(ss.esi_applicable, false)
              )
         FROM users u
         JOIN staff_salary ss
           ON ss.staff_uid = u.uid
          AND ss.tenant_id = u.tenant_id
        WHERE u.tenant_id = $1::uuid
          AND u.is_active = true
          AND COALESCE(u.is_deleted, false) = false
          AND u.deleted_at IS NULL
          AND u.merged_into_uid IS NULL
          AND LOWER(COALESCE(u.status, 'active')) = 'active'
          AND ss.is_active = true
          ${targetClause(targetType)}
       ON CONFLICT (tenant_id, job_id, staff_uid) DO NOTHING
       RETURNING id, staff_uid, staff_role_at_freeze, salary_before, salary_baseline`,
      ...params,
    );
    if (items.length === 0) {
      throw new BulkSalaryRevisionError(
        `No active staff found for ${targetType}=${targetValue ?? 'all'}`,
      );
    }
    const unauthorizedTargets = items.filter(
      item => !canCreateBulkRevisionForTarget(creatorRole, item.staff_role_at_freeze),
    );
    if (unauthorizedTargets.length > 0) {
      throw new BulkSalaryRevisionError(
        'Bulk revision cohort contains staff outside the creator payroll authority scope',
        403,
      );
    }
    if (
      revisionType === 'increment'
      && items.some(item => !Number.isFinite(Number(item.salary_before))
        || Number(item.salary_before) <= 0)
    ) {
      throw new BulkSalaryRevisionError(
        'Every increment target must have a positive active salary baseline',
        409,
      );
    }
    await tx.$executeRawUnsafe(
      `UPDATE bulk_revision_job_items
          SET next_attempt_at = CASE
                WHEN $3::date > CURRENT_DATE THEN $3::date::timestamptz
                ELSE clock_timestamp()
              END,
              updated_at = clock_timestamp()
        WHERE tenant_id = $1::uuid
          AND job_id = $2::int`,
      tenantId,
      job.id,
      effectiveFrom,
    );
    const manifest = cohortManifest(items);
    const termsManifest = jobTermsManifest({
      ...job,
      tenant_id: tenantId,
      staff_count: items.length,
      cohort_manifest_sha256: manifest,
    });
    const saved = await tx.bulk_revision_jobs.update({
      where: { id: job.id },
      data: {
        staff_count: items.length,
        cohort_manifest_sha256: manifest,
        terms_manifest_sha256: termsManifest,
        status: 'draft',
        updated_at: new Date(),
      },
      select: {
        id: true,
        description: true,
        revision_type: true,
        target_type: true,
        target_value: true,
        increment_type: true,
        increment_value: true,
        bonus_amount: true,
        effective_from: true,
        staff_count: true,
        cohort_manifest_sha256: true,
        terms_manifest_sha256: true,
        status: true,
        created_by: true,
        created_by_role: true,
        creator_authority_checked_at: true,
        creator_authority_source: true,
        created_at: true,
      },
    });
    const committed = await finaliseSalaryRevisionCommandTx(tx, {
      tenantId,
      command,
      responseData: saved,
      message: `Bulk revision draft created. Will affect ${saved.staff_count} staff.`,
    });
    return committed.responseData;
  });
}

export async function hrSignBulkSalaryRevisionJob({ tenantId, jobId, hrUid, command }) {
  const id = requireJobId(jobId);
  requireUuid(hrUid, 'hrUid');
  return setTenant(tenantId, async (tx) => {
    const hrSignerRole = await assertDatabaseRole(tx, tenantId, hrUid, ['HR_STAFF']);
    const replay = await findSalaryRevisionCommandReplayTx(tx, tenantId, command);
    if (replay) return replay.responseData;
    const jobs = await tx.$queryRawUnsafe(
      `SELECT tenant_id, id, description, revision_type, target_type, target_value,
              increment_type, increment_value, bonus_amount, effective_from,
              created_by, created_by_role, creator_authority_checked_at,
              creator_authority_source, created_at, status, hr_signed_by, staff_count,
              cohort_manifest_sha256, terms_manifest_sha256,
              clock_timestamp() AS command_at
         FROM bulk_revision_jobs
        WHERE tenant_id = $1::uuid AND id = $2::int
        FOR UPDATE`,
      tenantId,
      id,
    );
    const job = jobs[0];
    if (!job) throw new BulkSalaryRevisionError('Bulk revision job not found', 404);
    if (job.status !== 'draft') {
      throw new BulkSalaryRevisionError('Bulk revision job is not awaiting HR signature', 409);
    }
    if (!job.terms_manifest_sha256
        || jobTermsManifest(job) !== job.terms_manifest_sha256) {
      throw new BulkSalaryRevisionError('Bulk revision terms manifest changed', 409);
    }
    const itemCount = await assertCohortManifestTx(
      tx,
      tenantId,
      id,
      job.cohort_manifest_sha256,
    );
    if (itemCount !== Number(job.staff_count)) {
      throw new BulkSalaryRevisionError('Bulk revision cohort count changed', 409);
    }
    const signedAt = job.command_at;
    const signature = hrSignature(job, hrUid, signedAt);
    const signed = await tx.$queryRawUnsafe(
      `UPDATE bulk_revision_jobs
          SET status = 'pending_admin',
              hr_signed_by = $3::uuid,
              hr_signed_at = $4::timestamptz,
              hr_signature_sha256 = $5,
              hr_signer_role = $6,
              hr_authority_checked_at = $4::timestamptz,
              hr_authority_source = 'users_active_row',
              updated_at = $4::timestamptz
        WHERE tenant_id = $1::uuid
          AND id = $2::int
          AND status = 'draft'
        RETURNING id, status, hr_signed_by, hr_signed_at,
                  hr_signature_sha256, staff_count`,
      tenantId,
      id,
      hrUid,
      signedAt,
      signature,
      hrSignerRole,
    );
    if (signed.length !== 1) {
      throw new BulkSalaryRevisionError('Bulk revision HR signature transition was lost', 409);
    }
    const committed = await finaliseSalaryRevisionCommandTx(tx, {
      tenantId,
      command,
      responseData: signed[0],
      message: 'Bulk revision HR signature applied — awaiting Admin countersign',
    });
    return committed.responseData;
  });
}

export async function approveBulkSalaryRevisionJob({ tenantId, jobId, adminUid, command }) {
  const id = requireJobId(jobId);
  requireUuid(adminUid, 'adminUid');
  return setTenant(tenantId, async (tx) => {
    const adminSignerRole = await assertDatabaseRole(
      tx, tenantId, adminUid, ['ADMIN', 'SUPER_ADMIN'],
    );
    const replay = await findSalaryRevisionCommandReplayTx(tx, tenantId, command);
    if (replay) return replay.responseData;
    const jobs = await tx.$queryRawUnsafe(
      `SELECT tenant_id, id, description, revision_type, target_type, target_value,
              increment_type, increment_value, bonus_amount, effective_from,
              created_by, created_by_role, creator_authority_checked_at,
              creator_authority_source, created_at, status, hr_signed_by, hr_signed_at,
              hr_signature_sha256, hr_signer_role, hr_authority_checked_at,
              hr_authority_source, staff_count, cohort_manifest_sha256,
              terms_manifest_sha256, clock_timestamp() AS command_at
         FROM bulk_revision_jobs
        WHERE tenant_id = $1::uuid AND id = $2::int
        FOR UPDATE`,
      tenantId,
      id,
    );
    const job = jobs[0];
    if (!job) throw new BulkSalaryRevisionError('Bulk revision job not found', 404);
    if (job.status !== 'pending_admin' || !job.hr_signed_by) {
      throw new BulkSalaryRevisionError('Bulk revision job is not awaiting Admin approval', 409);
    }
    if (job.hr_signed_by === adminUid) {
      throw new BulkSalaryRevisionError('HR and Admin signers must be different people', 403);
    }
    if (!job.terms_manifest_sha256
        || jobTermsManifest(job) !== job.terms_manifest_sha256
        || !job.hr_signature_sha256
        || job.hr_signer_role !== 'HR_STAFF'
        || job.hr_authority_source !== 'users_active_row'
        || iso(job.hr_authority_checked_at) !== iso(job.hr_signed_at)
        || hrSignature(job, job.hr_signed_by, job.hr_signed_at) !== job.hr_signature_sha256) {
      throw new BulkSalaryRevisionError('Bulk revision signed terms changed', 409);
    }
    const itemCount = await assertCohortManifestTx(
      tx,
      tenantId,
      id,
      job.cohort_manifest_sha256,
    );
    if (itemCount !== Number(job.staff_count)) {
      throw new BulkSalaryRevisionError('Bulk revision cohort count changed', 409);
    }
    const approvedAt = job.command_at;
    const signature = adminSignature({
      ...job,
      admin_signer_role: adminSignerRole,
      admin_authority_checked_at: approvedAt,
      admin_authority_source: 'users_active_row',
    }, adminUid, approvedAt);
    const approved = await tx.$queryRawUnsafe(
      `UPDATE bulk_revision_jobs
          SET status = 'queued',
              approved_by = $3::uuid,
              approved_at = $4::timestamptz,
              admin_signature_sha256 = $5,
              admin_signer_role = $6,
              admin_authority_checked_at = $4::timestamptz,
              admin_authority_source = 'users_active_row',
              updated_at = $4::timestamptz
        WHERE tenant_id = $1::uuid
          AND id = $2::int
          AND status = 'pending_admin'
          AND hr_signed_by IS NOT NULL
          AND hr_signed_by IS DISTINCT FROM $3::uuid
        RETURNING id, status, staff_count, hr_signed_by, approved_by, approved_at,
                  admin_signature_sha256`,
      tenantId,
      id,
      adminUid,
      approvedAt,
      signature,
      adminSignerRole,
    );
    if (approved.length !== 1) {
      throw new BulkSalaryRevisionError('Bulk revision approval transition was lost', 409);
    }
    const committed = await finaliseSalaryRevisionCommandTx(tx, {
      tenantId,
      command,
      responseData: approved[0],
      message: 'Bulk revision approved and queued for durable processing',
    });
    return committed.responseData;
  });
}

export async function reapExpiredBulkRevisionLeases({
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  tenantId = null,
} = {}) {
  return setTenant(tenantId, async (tx) => tx.$queryRawUnsafe(
    `UPDATE bulk_revision_job_items item
        SET status = CASE
              WHEN item.attempt_count >= $1::int
                THEN 'reconciliation_required'
              ELSE 'pending'
            END,
            next_attempt_at = clock_timestamp(),
            claim_token = NULL,
            claimed_at = NULL,
            lease_expires_at = NULL,
            last_error = 'Worker lease expired before atomic staff completion',
            outcome = CASE
              WHEN item.attempt_count >= $1::int
                THEN jsonb_build_object(
                  'code', 'bulk_revision_lease_exhausted',
                  'attempt_count', item.attempt_count
                )
              ELSE item.outcome
            END,
            finalized_at = CASE
              WHEN item.attempt_count >= $1::int THEN clock_timestamp()
              ELSE NULL
            END,
            updated_at = clock_timestamp()
      WHERE (
          (
            item.status = 'processing'
            AND item.lease_expires_at <= clock_timestamp()
          )
          OR (
            item.status = 'pending'
            AND item.attempt_count >= $1::int
          )
        )
        AND ($2::uuid IS NULL OR item.tenant_id = $2::uuid)
      RETURNING item.id, item.tenant_id, item.job_id, item.status`,
    maxAttempts,
    tenantId,
  ), { superAdmin: tenantId == null });
}

export async function claimBulkRevisionItems({
  limit = 25,
  leaseSeconds = DEFAULT_LEASE_SECONDS,
  jobId = null,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  tenantId = null,
  skipReap = false,
} = {}) {
  if (!skipReap) await reapExpiredBulkRevisionLeases({ maxAttempts, tenantId });
  const boundedLimit = Math.max(1, Math.min(Number(limit) || 25, 100));
  const requestedJobId = jobId == null ? null : requireJobId(jobId);
  return setTenant(tenantId, async (tx) => {
    if (tenantId != null) {
      const activeTenants = await tx.$queryRawUnsafe(
        `SELECT id FROM tenants
          WHERE id = $1::uuid AND LOWER(COALESCE(status, '')) = 'active'
          FOR SHARE`,
        tenantId,
      );
      if (activeTenants.length !== 1) return [];
    }
    const claimed = await tx.$queryRawUnsafe(
      `WITH candidates AS (
         SELECT item.id
           FROM bulk_revision_job_items item
           JOIN bulk_revision_jobs job
             ON job.tenant_id = item.tenant_id
            AND job.id = item.job_id
           JOIN tenants tenant
             ON tenant.id = job.tenant_id
            AND LOWER(COALESCE(tenant.status, '')) = 'active'
          WHERE item.status = 'pending'
            AND item.next_attempt_at <= clock_timestamp()
            AND item.attempt_count < $4::int
            AND job.status IN ('queued', 'processing')
            AND CURRENT_DATE >= job.effective_from
            AND ($3::int IS NULL OR item.job_id = $3::int)
            AND ($5::uuid IS NULL OR item.tenant_id = $5::uuid)
          ORDER BY item.next_attempt_at, item.id
          FOR UPDATE OF item SKIP LOCKED
          LIMIT $1::int
       )
       UPDATE bulk_revision_job_items item
          SET status = 'processing',
              attempt_count = item.attempt_count + 1,
              claim_token = gen_random_uuid(),
              claimed_at = clock_timestamp(),
              lease_expires_at = clock_timestamp() + ($2::int * INTERVAL '1 second'),
              last_error = NULL,
              updated_at = clock_timestamp()
         FROM candidates
        WHERE item.id = candidates.id
        RETURNING item.id, item.tenant_id, item.job_id, item.staff_uid,
                  item.claim_token, item.attempt_count, item.lease_expires_at`,
      boundedLimit,
      leaseSeconds,
      requestedJobId,
      maxAttempts,
      tenantId,
    );
    if (claimed.length > 0) {
      await tx.$executeRawUnsafe(
        `UPDATE bulk_revision_jobs job
            SET status = 'processing', updated_at = clock_timestamp()
          WHERE (job.tenant_id, job.id) IN (
            SELECT DISTINCT item.tenant_id, item.job_id
              FROM bulk_revision_job_items item
             WHERE item.id = ANY($1::bigint[])
          )
            AND job.status = 'queued'`,
        claimed.map(item => item.id),
      );
    }
    return claimed;
  }, { superAdmin: tenantId == null });
}

async function markClaimFailure(claim, failure, { maxAttempts }) {
  const terminal = Number(claim.attempt_count) >= maxAttempts;
  const retrySeconds = Math.min(300, 2 ** Number(claim.attempt_count) * 5);
  return setTenant(claim.tenant_id, async (tx) => tx.$queryRawUnsafe(
    `UPDATE bulk_revision_job_items item
        SET status = CASE WHEN $6::boolean THEN 'reconciliation_required' ELSE 'pending' END,
            next_attempt_at = clock_timestamp() + ($5::int * INTERVAL '1 second'),
            claim_token = NULL,
            claimed_at = NULL,
            lease_expires_at = NULL,
            last_error = $4,
            outcome = CASE
              WHEN $6::boolean THEN jsonb_build_object(
                'code', 'bulk_revision_staff_failed',
                'message', $4::text,
                'attempt_count', item.attempt_count
              )
              ELSE item.outcome
            END,
            finalized_at = CASE WHEN $6::boolean THEN clock_timestamp() ELSE NULL END,
            updated_at = clock_timestamp()
      WHERE item.id = $1::bigint
        AND item.tenant_id = $2::uuid
        AND item.claim_token = $3::uuid
        AND item.attempt_count = $7::int
        AND item.status = 'processing'
      RETURNING item.id, item.status`,
    claim.id,
    claim.tenant_id,
    claim.claim_token,
    String(failure?.message || failure || 'Unknown bulk revision failure').slice(0, 2000),
    retrySeconds,
    terminal,
    Number(claim.attempt_count),
  ));
}

export async function reconcileBulkRevisionJob({ tenantId, jobId }) {
  const id = requireJobId(jobId);
  return setTenant(tenantId, async (tx) => {
    const jobs = await tx.$queryRawUnsafe(
      `SELECT id, staff_count, status
         FROM bulk_revision_jobs
        WHERE tenant_id = $1::uuid AND id = $2::int
        FOR UPDATE`,
      tenantId,
      id,
    );
    if (!jobs[0]) return null;
    const counts = (await tx.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS total_count,
              COUNT(*) FILTER (WHERE status = 'applied')::int AS applied_count,
              COUNT(*) FILTER (WHERE status = 'reconciliation_required')::int AS failed_count,
              COUNT(*) FILTER (WHERE status IN ('pending', 'processing'))::int AS open_count
         FROM bulk_revision_job_items
        WHERE tenant_id = $1::uuid AND job_id = $2::int`,
      tenantId,
      id,
    ))[0];
    const staffCount = Number(jobs[0].staff_count || 0);
    const totalCount = Number(counts.total_count || 0);
    const appliedCount = Number(counts.applied_count || 0);
    const failedCount = Number(counts.failed_count || 0);
    const openCount = Number(counts.open_count || 0);
    let status = jobs[0].status;
    if (staffCount > 0 && totalCount === staffCount && appliedCount === staffCount) {
      status = 'completed';
    } else if (openCount === 0 && (failedCount > 0 || totalCount !== staffCount)) {
      status = 'reconciliation_required';
    } else if (status !== 'queued') {
      status = 'processing';
    }
    const updated = await tx.$queryRawUnsafe(
      `UPDATE bulk_revision_jobs
          SET status = $3,
              processed_count = $4::int,
              failed_count = $5::int,
              completed_at = CASE WHEN $3 = 'completed' THEN clock_timestamp() ELSE NULL END,
              last_processed_at = clock_timestamp(),
              updated_at = clock_timestamp()
        WHERE tenant_id = $1::uuid AND id = $2::int
        RETURNING id, status, staff_count, processed_count, failed_count, completed_at`,
      tenantId,
      id,
      status,
      appliedCount,
      failedCount,
    );
    return updated[0];
  });
}

export async function processClaimedBulkRevisionItem(claim, {
  now = new Date(),
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
} = {}) {
  try {
    const result = await setTenant(claim.tenant_id, async (tx) => {
      const rows = await tx.$queryRawUnsafe(
        `SELECT item.id, item.staff_uid, item.staff_role_at_freeze,
                item.salary_before, item.salary_baseline,
                item.attempt_count, job.tenant_id, job.id AS job_id,
                job.description, job.revision_type, job.target_type,
                job.target_value, job.increment_type, job.increment_value,
                job.bonus_amount, job.effective_from, job.created_by,
                job.created_by_role, job.creator_authority_checked_at,
                job.creator_authority_source,
                job.created_at, job.hr_signed_by, job.hr_signed_at,
                job.hr_signature_sha256, job.hr_signer_role,
                job.hr_authority_checked_at, job.hr_authority_source,
                job.approved_by, job.approved_at, job.admin_signature_sha256,
                job.admin_signer_role, job.admin_authority_checked_at,
                job.admin_authority_source, job.status AS job_status,
                job.staff_count, job.cohort_manifest_sha256,
                job.terms_manifest_sha256,
                 clock_timestamp() AS worker_now, CURRENT_DATE AS worker_date
           FROM bulk_revision_job_items item
           JOIN bulk_revision_jobs job
             ON job.tenant_id = item.tenant_id
            AND job.id = item.job_id
           JOIN tenants tenant
             ON tenant.id = job.tenant_id
            AND LOWER(COALESCE(tenant.status, '')) = 'active'
          WHERE item.id = $1::bigint
            AND item.tenant_id = $2::uuid
            AND item.claim_token = $3::uuid
            AND item.attempt_count = $4::int
            AND item.status = 'processing'
             AND item.lease_expires_at > clock_timestamp()
           FOR UPDATE OF item, job
           FOR SHARE OF tenant`,
        claim.id,
        claim.tenant_id,
        claim.claim_token,
        Number(claim.attempt_count),
      );
      const item = rows[0];
      if (!item) return { outcome: 'stale_claim' };
      const workerNow = item.worker_now;
      if (iso(item.worker_date, true) < iso(item.effective_from, true)) {
        throw new Error('Bulk revision was claimed before its effective date');
      }
      if (item.job_status !== 'processing' || !item.hr_signed_by || !item.approved_by) {
        throw new Error('Bulk revision job is not durably approved');
      }
      if (item.hr_signed_by === item.approved_by) {
        throw new Error('Bulk revision job violates signer separation');
      }
      if (!item.terms_manifest_sha256
          || jobTermsManifest(item) !== item.terms_manifest_sha256
          || !item.hr_signature_sha256
          || item.hr_signer_role !== 'HR_STAFF'
          || item.hr_authority_source !== 'users_active_row'
          || iso(item.hr_authority_checked_at) !== iso(item.hr_signed_at)
          || hrSignature(item, item.hr_signed_by, item.hr_signed_at)
            !== item.hr_signature_sha256
          || !item.admin_signature_sha256
          || !['ADMIN', 'SUPER_ADMIN'].includes(item.admin_signer_role)
          || item.admin_authority_source !== 'users_active_row'
          || iso(item.admin_authority_checked_at) !== iso(item.approved_at)
          || adminSignature(item, item.approved_by, item.approved_at)
            !== item.admin_signature_sha256) {
        throw new Error('Bulk revision signed terms changed after approval');
      }
      const itemCount = await assertCohortManifestTx(
        tx,
        claim.tenant_id,
        item.job_id,
        item.cohort_manifest_sha256,
      );
      if (itemCount !== Number(item.staff_count)) {
        throw new Error('Bulk revision cohort count changed after approval');
      }
      const salaries = await tx.$queryRawUnsafe(
        `SELECT salary.basic_salary, salary.hra_pct, salary.da_pct,
                salary.special_allowance, salary.transport_allowance,
                salary.medical_allowance, salary.tds_monthly,
                salary.pf_employee_pct, salary.esi_applicable,
                UPPER(staff_owner.role) AS current_staff_role
           FROM staff_salary salary
           JOIN users staff_owner
             ON staff_owner.uid = salary.staff_uid
            AND staff_owner.tenant_id = salary.tenant_id
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
        item.staff_uid,
      );
      const salary = salaries[0];
      if (!salary || !sameMoney(salary.basic_salary, item.salary_before)
          || !salaryBaselineMatches(salary, item.salary_baseline)
          || normalizeRole(salary.current_staff_role) !== normalizeRole(item.staff_role_at_freeze)
          || !canCreateBulkRevisionForTarget(item.created_by_role, salary.current_staff_role)) {
        throw new Error('Frozen staff salary baseline changed before bulk revision');
      }
      let proposedBasic = Number(item.salary_before);
      if (item.revision_type === 'increment') {
        proposedBasic = item.increment_type === 'percentage'
          ? proposedBasic * (1 + Number(item.increment_value) / 100)
          : proposedBasic + Number(item.increment_value);
      }
      proposedBasic = money(proposedBasic);
      const currentGross = grossFromSalary(salary);
      const proposedGross = grossFromSalary({ ...salary, basic_salary: proposedBasic });
      const incrementAmount = item.revision_type === 'increment'
        ? money(proposedBasic - Number(item.salary_before))
        : null;
      const incrementPct = item.revision_type === 'increment'
        ? money(incrementAmount / Number(item.salary_before) * 100)
        : null;
      const revisionNumber = (await tx.$queryRawUnsafe(
        `SELECT 'REV-' || TO_CHAR($1::timestamptz, 'YYYY') || '-'
              || LPAD(nextval('revision_number_seq')::TEXT, 4, '0') AS revision_number`,
        workerNow,
      ))[0].revision_number;
      const revisionEvidence = {
        tenant_id: claim.tenant_id,
        revision_number: revisionNumber,
        staff_uid: item.staff_uid,
        revision_type: item.revision_type,
        salary_baseline: item.salary_baseline,
        current_basic: item.salary_before,
        proposed_basic: item.revision_type === 'increment' ? proposedBasic : null,
        current_gross: currentGross,
        proposed_gross: proposedGross,
        increment_amount: incrementAmount,
        increment_pct: incrementPct,
        bonus_amount: item.revision_type === 'bonus' ? item.bonus_amount : null,
        bonus_reason: item.revision_type === 'bonus' ? item.description : null,
        effective_from: item.effective_from,
        reason: item.description,
        proposed_by: item.created_by,
        proposed_at: item.created_at,
        hr_signed_by: item.hr_signed_by,
        hr_signed_at: item.hr_signed_at,
        hr_signer_role: item.hr_signer_role,
        hr_authority_checked_at: item.hr_authority_checked_at,
        hr_authority_source: item.hr_authority_source,
        admin_signed_by: item.approved_by,
        admin_signed_at: item.approved_at,
        admin_signer_role: item.admin_signer_role,
        admin_authority_checked_at: item.admin_authority_checked_at,
        admin_authority_source: item.admin_authority_source,
      };
      revisionEvidence.terms_manifest_sha256 = revisionTermsManifest(revisionEvidence);
      revisionEvidence.hr_signature_sha256 = revisionHrSignature(revisionEvidence);
      revisionEvidence.admin_signature_sha256 = revisionAdminSignature(revisionEvidence);
      const revision = await tx.salary_revisions.create({
        data: {
          tenant_id: claim.tenant_id,
          tenant_reconciliation_required: false,
          tenant_reconciliation_evidence: {},
          staff_uid: item.staff_uid,
          revision_number: revisionNumber,
          revision_type: item.revision_type,
          current_basic: item.salary_before,
          proposed_basic: revisionEvidence.proposed_basic,
          current_gross: currentGross,
          proposed_gross: proposedGross,
          salary_baseline: item.salary_baseline,
          increment_amount: incrementAmount,
          increment_pct: incrementPct,
          bonus_amount: revisionEvidence.bonus_amount,
          bonus_reason: revisionEvidence.bonus_reason,
          effective_from: new Date(item.effective_from),
          reason: item.description,
          proposed_by: item.created_by,
          proposed_at: item.created_at,
          status: 'applied',
          hr_signed_by: item.hr_signed_by,
          hr_signed_at: item.hr_signed_at,
          hr_signer_role: item.hr_signer_role,
          hr_authority_checked_at: item.hr_authority_checked_at,
          hr_authority_source: item.hr_authority_source,
          admin_signed_by: item.approved_by,
          admin_signed_at: item.approved_at,
          admin_signer_role: item.admin_signer_role,
          admin_authority_checked_at: item.admin_authority_checked_at,
          admin_authority_source: item.admin_authority_source,
          terms_manifest_sha256: revisionEvidence.terms_manifest_sha256,
          hr_signature_sha256: revisionEvidence.hr_signature_sha256,
          admin_signature_sha256: revisionEvidence.admin_signature_sha256,
          applied_at: workerNow,
          signature_hash: revisionEvidence.admin_signature_sha256,
        },
        select: { id: true },
      });
      if (item.revision_type === 'bonus') {
        const payable = await tx.$queryRawUnsafe(
          `INSERT INTO salary_revision_payables (
             tenant_id, revision_id, staff_uid, payable_type, amount, status
           )
           VALUES ($1::uuid, $2::int, $3::uuid, 'bonus', $4::numeric, 'pending')
           RETURNING id`,
          claim.tenant_id,
          revision.id,
          item.staff_uid,
          item.bonus_amount,
        );
        if (payable.length !== 1) throw new Error('Bulk bonus payable could not be recorded');
      }
      if (item.revision_type === 'increment') {
        const updatedSalary = await tx.$queryRawUnsafe(
          `UPDATE staff_salary
              SET basic_salary = $3::numeric, updated_at = $4::timestamptz
            WHERE tenant_id = $1::uuid
               AND staff_uid = $2::uuid
               AND basic_salary = $5::numeric
               AND is_active = true
            RETURNING staff_uid`,
          claim.tenant_id,
          item.staff_uid,
          proposedBasic,
          workerNow,
          item.salary_before,
        );
        if (updatedSalary.length !== 1) {
          throw new Error('Tenant-bound staff salary update lost its frozen baseline');
        }
        if (iso(item.effective_from, true) < iso(item.worker_date, true)) {
          await tx.$queryRawUnsafe(
            `INSERT INTO salary_revision_arrears_work_items (
               tenant_id, revision_id, staff_uid, effective_on, activated_at, status
             ) VALUES ($1::uuid, $2::int, $3::uuid, $4::date, $5::timestamptz, 'pending')
             ON CONFLICT (tenant_id, revision_id) DO NOTHING
             RETURNING id`,
            claim.tenant_id,
            revision.id,
            item.staff_uid,
            item.effective_from,
            workerNow,
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
            item.staff_uid,
            item.effective_from,
            workerNow,
          );
          if (arrearsWork.length !== 1) {
            throw new Error('Bulk salary revision arrears work identity is inconsistent');
          }
        }
      }
      await tx.$executeRawUnsafe(
        `UPDATE annual_review_reminders reminder
            SET status = 'completed', revision_id = $3::int
          WHERE reminder.tenant_id = $1::uuid
            AND reminder.staff_uid = $2::uuid
            AND reminder.review_year = EXTRACT(YEAR FROM $4::date)::int
            AND reminder.status IN ('pending', 'initiated')
            AND reminder.tenant_reconciliation_required = false
            AND (reminder.revision_id IS NULL OR reminder.revision_id = $3::int)`,
        claim.tenant_id,
        item.staff_uid,
        revision.id,
        item.effective_from,
      );
      const finalized = await tx.$queryRawUnsafe(
        `UPDATE bulk_revision_job_items item
            SET status = 'applied',
                revision_id = $5::int,
                salary_after = $6::numeric,
                claim_token = NULL,
                claimed_at = NULL,
                lease_expires_at = NULL,
                last_error = NULL,
                outcome = jsonb_build_object(
                  'code', 'applied',
                  'revision_id', $5::int,
                  'salary_before', item.salary_before,
                  'salary_after', $6::numeric
                ),
                applied_at = $7::timestamptz,
                finalized_at = $7::timestamptz,
                updated_at = $7::timestamptz
          WHERE item.id = $1::bigint
            AND item.tenant_id = $2::uuid
            AND item.claim_token = $3::uuid
            AND item.attempt_count = $4::int
            AND item.status = 'processing'
          RETURNING item.id, item.revision_id, item.status`,
        claim.id,
        claim.tenant_id,
        claim.claim_token,
        Number(claim.attempt_count),
        revision.id,
        proposedBasic,
        workerNow,
      );
      if (finalized.length !== 1) throw new Error('Bulk revision item lease was lost');
      await recordSalaryRevisionActivatedTx(tx, {
        tenantId: claim.tenant_id,
        revisionId: revision.id,
        staffUid: item.staff_uid,
        sourceType: 'bulk_revision_worker',
        sourceId: claim.id,
        effectiveOn: item.effective_from,
        appliedAt: workerNow,
        termsManifestSha256: revisionEvidence.terms_manifest_sha256,
        hrSignatureSha256: revisionEvidence.hr_signature_sha256,
        adminSignatureSha256: revisionEvidence.admin_signature_sha256,
      });
      return { outcome: 'applied', item: finalized[0] };
    });
    await reconcileBulkRevisionJob({
      tenantId: claim.tenant_id,
      jobId: claim.job_id,
    });
    return result;
  } catch (failure) {
    logger.warn(`Bulk salary revision item ${claim.id} failed: ${failure.message}`);
    await markClaimFailure(claim, failure, { now, maxAttempts });
    await reconcileBulkRevisionJob({
      tenantId: claim.tenant_id,
      jobId: claim.job_id,
    });
    return { outcome: 'failed', error: failure.message };
  }
}

export async function processBulkSalaryRevisionJobs({
  limit = 25,
  now = new Date(),
  leaseSeconds = DEFAULT_LEASE_SECONDS,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  jobId = null,
  tenantId = null,
} = {}) {
  const reaped = await reapExpiredBulkRevisionLeases({ maxAttempts, tenantId });
  const reapedTerminalJobs = [
    ...new Map(
      reaped
        .filter(item => item.status === 'reconciliation_required')
        .map(item => [`${item.tenant_id}:${item.job_id}`, item]),
    ).values(),
  ];
  for (const item of reapedTerminalJobs) {
    await reconcileBulkRevisionJob({
      tenantId: item.tenant_id,
      jobId: item.job_id,
    });
  }
  const claimed = await claimBulkRevisionItems({
    limit,
    now,
    leaseSeconds,
    maxAttempts,
    jobId,
    tenantId,
    skipReap: true,
  });
  const outcomes = [];
  for (const claim of claimed) {
    outcomes.push(await processClaimedBulkRevisionItem(claim, { now, maxAttempts }));
  }
  if (claimed.length === 0 && jobId != null && tenantId != null) {
    await reconcileBulkRevisionJob({
      tenantId,
      jobId,
    });
  } else if (claimed.length === 0 && jobId != null) {
    const jobRows = await setTenant(null, async (tx) => tx.$queryRawUnsafe(
      `SELECT tenant_id FROM bulk_revision_jobs WHERE id = $1::int`,
      requireJobId(jobId),
    ), { superAdmin: true });
    if (jobRows.length === 1) {
      await reconcileBulkRevisionJob({
        tenantId: jobRows[0].tenant_id,
        jobId,
      });
    }
  }
  return { claimed: claimed.length, reaped: reaped.length, outcomes };
}
