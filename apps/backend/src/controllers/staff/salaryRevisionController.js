// src/controllers/staff/salaryRevisionController.js
import crypto from 'crypto';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import { setTenant } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import {
  SalaryRevisionCommandError,
  salaryRevisionCommandFromRequest,
  findSalaryRevisionCommandReplayTx,
  finaliseSalaryRevisionCommandTx,
} from '../../services/staff/salaryRevisionCommandService.js';
import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';
import { success, error } from '../../utils/responseHelper.js';
import { normalizeRole } from '../../utils/roles.js';
import {
  SalaryRevisionReconciliationError,
  attestPayrollReconciliation,
  listPayrollReconciliationWorklist,
  resolvePayrollReconciliation,
} from '../../services/staff/salaryRevisionReconciliationService.js';
import { recordSalaryRevisionActivatedTx } from '../../services/staff/salaryRevisionActivationEventService.js';

const SALARY_CHANGE_FIELDS = new Set([
  'hra_pct',
  'da_pct',
  'special_allowance',
  'transport_allowance',
  'medical_allowance',
  'tds_monthly',
]);
const GROSS_COMPONENT_FIELDS = new Set([
  'hra_pct',
  'da_pct',
  'special_allowance',
  'transport_allowance',
  'medical_allowance',
]);
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

function canonicalGross(salary) {
  const basic = Number(salary.basic_salary);
  const gross = basic
    + (basic * Number(salary.hra_pct ?? 0) / 100)
    + (basic * Number(salary.da_pct ?? 0) / 100)
    + Number(salary.special_allowance ?? 0)
    + Number(salary.transport_allowance ?? 0)
    + Number(salary.medical_allowance ?? 0);
  return Math.round(gross * 100) / 100;
}

function roundMoney(value) {
  return Math.round(Number(value) * 100) / 100;
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
    && Math.abs(Number(salary[field] ?? 0) - Number(baseline[field])) < 0.005
  )) && typeof baseline.esi_applicable === 'boolean'
    && Boolean(salary.esi_applicable) === baseline.esi_applicable;
}

function revisionFinancialShapeValid(revision, changes) {
  const fields = Object.keys(changes);
  if (revision.revision_type === 'increment') {
    return revision.proposed_basic != null
      && Number(revision.proposed_basic) > Number(revision.current_basic)
      && revision.increment_amount != null
      && revision.increment_pct != null
      && Math.abs(
        Number(revision.proposed_basic)
        - Number(revision.current_basic)
        - Number(revision.increment_amount)
      ) < 0.005
      && Number(revision.increment_amount) > 0
      && Number(revision.increment_pct) > 0
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
  if (revision.revision_type === 'component_change') {
    return revision.proposed_basic == null
      && revision.increment_amount == null
      && revision.increment_pct == null
      && revision.bonus_amount == null
      && revision.bonus_reason == null
      && fields.length > 0
      && fields.every(field => GROSS_COMPONENT_FIELDS.has(field));
  }
  return false;
}

function canonicalOtherChanges(value) {
  if (value == null) return null;
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  return Object.fromEntries(Object.keys(parsed).sort().map(field => [
    field,
    Number(parsed[field]).toFixed(2),
  ]));
}

function canonicalDate(value, dateOnly = false) {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  const iso = date.toISOString();
  return dateOnly ? iso.slice(0, 10) : iso;
}

function canonicalMoney(value) {
  return value == null ? null : Number(value).toFixed(2);
}

async function activeDatabaseRole(tx, tenantId, actorUid) {
  if (!actorUid) return false;
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
  return normalizeRole(rows[0]?.role) || null;
}

async function hasActiveDatabaseRole(tx, tenantId, actorUid, allowedRoles) {
  return allowedRoles.includes(await activeDatabaseRole(tx, tenantId, actorUid));
}

function computeRevisionHash(revision) {
  const payload = {
    tenant_id: revision.tenant_id,
    revision_number: revision.revision_number,
    staff_uid: revision.staff_uid,
    revision_type: revision.revision_type,
    salary_baseline: canonicalSalaryBaseline(revision.salary_baseline),
    current_basic: canonicalMoney(revision.current_basic),
    proposed_basic: canonicalMoney(revision.proposed_basic),
    current_gross: canonicalMoney(revision.current_gross),
    proposed_gross: canonicalMoney(revision.proposed_gross),
    increment_amount: canonicalMoney(revision.increment_amount),
    increment_pct: canonicalMoney(revision.increment_pct),
    bonus_amount: canonicalMoney(revision.bonus_amount),
    bonus_reason: revision.bonus_reason ?? null,
    other_changes: canonicalOtherChanges(revision.other_changes),
    effective_from: canonicalDate(revision.effective_from, true),
    reason: revision.reason,
    proposed_by: revision.proposed_by,
    proposed_at: canonicalDate(revision.proposed_at),
    hr_signed_by: revision.hr_signed_by,
    hr_signed_at: canonicalDate(revision.hr_signed_at),
    hr_signer_role: revision.hr_signer_role ?? null,
    hr_authority_checked_at: canonicalDate(revision.hr_authority_checked_at),
    hr_authority_source: revision.hr_authority_source ?? null,
    hr_comment: revision.hr_comment ?? null,
    admin_signed_by: revision.admin_signed_by,
    admin_signed_at: canonicalDate(revision.admin_signed_at),
    admin_signer_role: revision.admin_signer_role ?? null,
    admin_authority_checked_at: canonicalDate(revision.admin_authority_checked_at),
    admin_authority_source: revision.admin_authority_source ?? null,
    admin_comment: revision.admin_comment ?? null,
    terms_manifest_sha256: revision.terms_manifest_sha256 ?? null,
    hr_signature_sha256: revision.hr_signature_sha256 ?? null,
  };
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function computeRevisionTermsManifest(revision) {
  return crypto.createHash('sha256').update(JSON.stringify({
    tenant_id: revision.tenant_id,
    revision_number: revision.revision_number,
    staff_uid: revision.staff_uid,
    revision_type: revision.revision_type,
    salary_baseline: canonicalSalaryBaseline(revision.salary_baseline),
    current_basic: canonicalMoney(revision.current_basic),
    proposed_basic: canonicalMoney(revision.proposed_basic),
    current_gross: canonicalMoney(revision.current_gross),
    proposed_gross: canonicalMoney(revision.proposed_gross),
    increment_amount: canonicalMoney(revision.increment_amount),
    increment_pct: canonicalMoney(revision.increment_pct),
    bonus_amount: canonicalMoney(revision.bonus_amount),
    bonus_reason: revision.bonus_reason ?? null,
    other_changes: canonicalOtherChanges(revision.other_changes),
    effective_from: canonicalDate(revision.effective_from, true),
    reason: revision.reason,
    proposed_by: revision.proposed_by,
    proposed_at: canonicalDate(revision.proposed_at),
  })).digest('hex');
}

function computeRevisionHrSignature(revision) {
  return crypto.createHash('sha256').update(JSON.stringify({
    terms_manifest_sha256: revision.terms_manifest_sha256,
    hr_signed_by: revision.hr_signed_by,
    hr_signed_at: canonicalDate(revision.hr_signed_at),
    hr_signer_role: revision.hr_signer_role,
    hr_authority_checked_at: canonicalDate(revision.hr_authority_checked_at),
    hr_authority_source: revision.hr_authority_source,
    hr_comment: revision.hr_comment ?? null,
  })).digest('hex');
}

function computeRevisionRejectionEvidence(revision) {
  return crypto.createHash('sha256').update(JSON.stringify({
    tenant_id: revision.tenant_id,
    revision_number: revision.revision_number,
    terms_manifest_sha256: revision.terms_manifest_sha256,
    rejected_by: revision.rejected_by,
    rejected_at: canonicalDate(revision.rejected_at),
    rejected_actor_role: revision.rejected_actor_role,
    rejected_authority_checked_at: canonicalDate(revision.rejected_authority_checked_at),
    rejected_authority_source: revision.rejected_authority_source,
    rejection_reason: revision.rejection_reason,
  })).digest('hex');
}

// ─── HR: Propose increment or bonus ──────────────────────────────────────────
export const proposeRevision = async (req, res) => {
  try {
    const proposerUid = req.user?.uid;
    const tenantId = resolveTenantOrThrow(req);
    const {
      staff_uid, revision_type, proposed_basic, increment_amount, increment_pct,
      bonus_amount, bonus_reason, other_changes, effective_from, reason,
    } = req.body;

    if (!staff_uid || !revision_type || !reason || !effective_from) {
      return error(res, 'staff_uid, revision_type, effective_from, and reason are required', HTTP_STATUS.BAD_REQUEST);
    }

    const validTypes = ['increment', 'bonus', 'deduction_change', 'component_change'];
    if (!validTypes.includes(revision_type)) {
      return error(res, `revision_type must be one of: ${validTypes.join(', ')}`, HTTP_STATUS.BAD_REQUEST);
    }
    const numericInputs = [proposed_basic, increment_amount, increment_pct, bonus_amount]
      .filter(value => value != null);
    if (numericInputs.some(value => !Number.isFinite(Number(value)) || Number(value) <= 0)) {
      return error(res, 'Revision amounts and percentages must be positive finite numbers', HTTP_STATUS.BAD_REQUEST);
    }
    if (revision_type === 'increment' && proposed_basic == null) {
      return error(res, 'proposed_basic is required for an increment revision', HTTP_STATUS.BAD_REQUEST);
    }
    if (revision_type === 'bonus' && (
      bonus_amount == null
      || typeof bonus_reason !== 'string'
      || !bonus_reason.trim()
    )) {
      return error(
        res,
        'bonus_amount and a non-empty bonus_reason are required for a bonus revision',
        HTTP_STATUS.BAD_REQUEST,
      );
    }
    if (revision_type === 'increment' && increment_amount != null && increment_pct != null) {
      return error(
        res,
        'Provide at most one of increment_amount or increment_pct',
        HTTP_STATUS.BAD_REQUEST,
      );
    }
    const incompatibleByType = {
      increment: bonus_amount != null || bonus_reason != null || other_changes != null,
      bonus: proposed_basic != null || increment_amount != null
        || increment_pct != null || other_changes != null,
      deduction_change: proposed_basic != null || increment_amount != null
        || increment_pct != null || bonus_amount != null || bonus_reason != null,
      component_change: proposed_basic != null || increment_amount != null
        || increment_pct != null || bonus_amount != null || bonus_reason != null,
    };
    if (incompatibleByType[revision_type]) {
      return error(
        res,
        `${revision_type} includes fields owned by another revision type`,
        HTTP_STATUS.BAD_REQUEST,
      );
    }
    if (
      other_changes != null
      && (
        typeof other_changes !== 'object'
        || Array.isArray(other_changes)
        || Object.keys(other_changes).length === 0
      )
    ) {
      return error(res, 'other_changes must be a non-empty object', HTTP_STATUS.BAD_REQUEST);
    }
    const validatedOtherChanges = {};
    for (const [field, value] of Object.entries(other_changes || {})) {
      if (!SALARY_CHANGE_FIELDS.has(field)) {
        return error(res, `Unsupported salary component: ${field}`, HTTP_STATUS.BAD_REQUEST);
      }
      if (!Number.isFinite(Number(value)) || Number(value) < 0) {
        return error(res, `${field} must be a non-negative finite number`, HTTP_STATUS.BAD_REQUEST);
      }
      validatedOtherChanges[field] = Number(value);
    }
    if (
      revision_type === 'component_change'
      && (
        !Object.keys(validatedOtherChanges).some(field => GROSS_COMPONENT_FIELDS.has(field))
        || Object.keys(validatedOtherChanges).some(field => !GROSS_COMPONENT_FIELDS.has(field))
      )
    ) {
      return error(res, 'component_change requires at least one gross salary component', HTTP_STATUS.BAD_REQUEST);
    }
    if (
      revision_type === 'deduction_change'
      && (
        Object.keys(validatedOtherChanges).length !== 1
        || validatedOtherChanges.tds_monthly == null
      )
    ) {
      return error(res, 'deduction_change currently requires only tds_monthly', HTTP_STATUS.BAD_REQUEST);
    }
    const effectiveDate = new Date(effective_from);
    if (Number.isNaN(effectiveDate.getTime())) {
      return error(res, 'effective_from must be a valid date', HTTP_STATUS.BAD_REQUEST);
    }
    if (['increment', 'component_change'].includes(revision_type)
        && effectiveDate.getUTCDate() !== 1) {
      return error(
        res,
        'increment and component_change revisions require a first-of-month effective_from',
        HTTP_STATUS.BAD_REQUEST,
      );
    }
    const command = salaryRevisionCommandFromRequest(
      req,
      'revision_propose',
      `${staff_uid}:${revision_type}`,
    );

    const proposed = await setTenant(tenantId, async (tx) => {
      const replay = await findSalaryRevisionCommandReplayTx(tx, tenantId, command);
      if (replay) return { outcome: 'proposed', revision: replay.responseData, message: replay.message };
      if (!await hasActiveDatabaseRole(
        tx,
        tenantId,
        proposerUid,
        ['HR_STAFF', 'ADMIN', 'SUPER_ADMIN'],
      )) {
        return { outcome: 'role_forbidden' };
      }
      const staff = await tx.$queryRawUnsafe(
        `SELECT uid
           FROM users
          WHERE uid = $1::uuid
            AND tenant_id = $2::uuid
            AND is_active = true
            AND COALESCE(is_deleted, false) = false
            AND deleted_at IS NULL
            AND merged_into_uid IS NULL
            AND LOWER(COALESCE(status, 'active')) = 'active'
          FOR SHARE`,
        staff_uid,
        tenantId,
      );
      if (staff.length !== 1) return { outcome: 'staff_not_found' };
      const salaries = await tx.$queryRawUnsafe(
        `SELECT id, staff_uid, basic_salary, hra_pct, da_pct,
                special_allowance, transport_allowance, medical_allowance,
                tds_monthly, pf_employee_pct, esi_applicable
           FROM staff_salary
          WHERE staff_uid = $1::uuid
            AND tenant_id = $2::uuid
            AND is_active = true
          FOR UPDATE`,
        staff_uid,
        tenantId,
      );
      if (salaries.length !== 1) return { outcome: 'salary_not_found' };
      const currentSalary = salaries[0];
      const salaryBaseline = canonicalSalaryBaseline(currentSalary);
      const proposedBasic = proposed_basic == null ? null : roundMoney(proposed_basic);
      if (
        revision_type === 'increment'
        && proposedBasic <= Number(currentSalary.basic_salary)
      ) {
        return { outcome: 'invalid_increment' };
      }
      let canonicalIncrementAmount = null;
      let canonicalIncrementPct = null;
      if (revision_type === 'increment') {
        canonicalIncrementAmount = roundMoney(
          proposedBasic - Number(currentSalary.basic_salary),
        );
        if (Number(currentSalary.basic_salary) > 0) {
          canonicalIncrementPct = roundMoney(
            canonicalIncrementAmount / Number(currentSalary.basic_salary) * 100,
          );
        }
        if (
          (increment_amount != null
            && Math.abs(Number(increment_amount) - canonicalIncrementAmount) >= 0.005)
          || (increment_pct != null
            && (
              canonicalIncrementPct == null
              || Math.abs(Number(increment_pct) - canonicalIncrementPct) >= 0.005
            ))
        ) {
          return { outcome: 'increment_evidence_mismatch' };
        }
      }
      const currentGross = canonicalGross(currentSalary);
      const proposedSalary = {
        ...currentSalary,
        ...validatedOtherChanges,
        basic_salary: proposedBasic == null
          ? currentSalary.basic_salary
          : proposedBasic,
      };
      const proposedGross = canonicalGross(proposedSalary);
      const result = await tx.$queryRawUnsafe(`
        INSERT INTO salary_revisions (
          staff_uid, revision_type, current_basic, proposed_basic,
          increment_amount, increment_pct,
          bonus_amount, bonus_reason, other_changes,
          effective_from, reason, proposed_by,
          current_gross, proposed_gross, salary_baseline, tenant_id,
          tenant_reconciliation_required, tenant_reconciliation_evidence
        ) VALUES (
          $1::uuid, $2, $3, $4, $5, $6, $7, $8, $9::jsonb,
          $10::date, $11, $12::uuid, $13, $14, $15::jsonb, $16::uuid,
          false, '{}'::jsonb
        )
        RETURNING id, staff_uid, revision_type, current_basic, proposed_basic,
                  status, reason, created_at, revision_number
      `,
        staff_uid,
        revision_type,
        currentSalary.basic_salary,
        proposedBasic,
        canonicalIncrementAmount,
        canonicalIncrementPct,
        bonus_amount ?? null,
        bonus_reason ?? null,
        Object.keys(validatedOtherChanges).length > 0
          ? JSON.stringify(validatedOtherChanges)
          : null,
        effective_from,
        reason,
        proposerUid,
        currentGross,
        proposedGross,
        JSON.stringify(salaryBaseline),
        tenantId,
      );
      const message = `${revision_type} proposal ${result[0].revision_number} submitted — awaiting HR signature`;
      const committed = await finaliseSalaryRevisionCommandTx(tx, {
        tenantId,
        command,
        responseData: result[0],
        message,
      });
      return { outcome: 'proposed', revision: committed.responseData, message: committed.message };
    });
    if (proposed.outcome === 'role_forbidden') {
      return error(res, 'Active HR or Admin authority is required', HTTP_STATUS.FORBIDDEN);
    }
    if (proposed.outcome === 'staff_not_found') {
      return error(res, 'Active staff member not found', HTTP_STATUS.NOT_FOUND);
    }
    if (proposed.outcome === 'salary_not_found') {
      return error(res, 'Active tenant-bound staff salary row is required', HTTP_STATUS.CONFLICT);
    }
    if (proposed.outcome === 'invalid_increment') {
      return error(res, 'proposed_basic must exceed the locked current salary', HTTP_STATUS.BAD_REQUEST);
    }
    if (proposed.outcome === 'increment_evidence_mismatch') {
      return error(
        res,
        'Increment amount or percentage conflicts with the locked salary baseline',
        HTTP_STATUS.BAD_REQUEST,
      );
    }
    success(
      res,
      proposed.revision,
      proposed.message,
    );
  } catch (err) {
    logger.error('Propose Revision Error:', err);
    error(
      res,
      err instanceof SalaryRevisionCommandError ? err.message : 'Failed to propose revision',
      err instanceof SalaryRevisionCommandError
        ? err.statusCode
        : HTTP_STATUS.INTERNAL_SERVER_ERROR,
    );
  }
};

// ─── HR: Sign revision (first countersign) ───────────────────────────────────
export const hrSignRevision = async (req, res) => {
  try {
    const { id } = req.params;
    const hrUid = req.user?.uid;
    const tenantId = resolveTenantOrThrow(req);
    const { comment } = req.body;
    const command = salaryRevisionCommandFromRequest(req, 'revision_hr_sign', id);

    const signed = await setTenant(tenantId, async (tx) => {
      const replay = await findSalaryRevisionCommandReplayTx(tx, tenantId, command);
      if (replay) return { outcome: 'signed', revision: replay.responseData, message: replay.message };
      const hrSignerRole = await activeDatabaseRole(tx, tenantId, hrUid);
      if (hrSignerRole !== 'HR_STAFF') {
        return { outcome: 'role_forbidden' };
      }
      const revisions = await tx.$queryRawUnsafe(`
        SELECT sr.id, sr.tenant_id, sr.revision_number, sr.staff_uid,
               sr.revision_type, sr.salary_baseline, sr.current_basic,
               sr.proposed_basic, sr.current_gross, sr.proposed_gross,
               sr.increment_amount, sr.increment_pct, sr.bonus_amount,
               sr.bonus_reason, sr.other_changes, sr.effective_from, sr.reason,
               sr.proposed_by, sr.proposed_at, sr.status,
               clock_timestamp() AS signed_at
          FROM salary_revisions sr
          JOIN users staff_owner
            ON staff_owner.uid = sr.staff_uid
           AND staff_owner.tenant_id = sr.tenant_id
           AND staff_owner.is_active = true
           AND COALESCE(staff_owner.is_deleted, false) = false
           AND staff_owner.deleted_at IS NULL
           AND staff_owner.merged_into_uid IS NULL
           AND LOWER(COALESCE(staff_owner.status, 'active')) = 'active'
         WHERE sr.id = $1::int
           AND sr.tenant_id = $2::uuid
           AND sr.tenant_reconciliation_required = false
         FOR UPDATE OF sr FOR SHARE OF staff_owner
      `, id, tenantId);
      if (revisions.length === 0) return { outcome: 'not_found' };
      const revision = revisions[0];
      if (revision.status !== 'pending_hr') return { outcome: 'wrong_state' };
      const signedAt = revision.signed_at;
      const termsManifest = computeRevisionTermsManifest(revision);
      const hrSignature = computeRevisionHrSignature({
        ...revision,
        terms_manifest_sha256: termsManifest,
        hr_signed_by: hrUid,
        hr_signed_at: signedAt,
        hr_signer_role: hrSignerRole,
        hr_authority_checked_at: signedAt,
        hr_authority_source: 'users_active_row',
        hr_comment: comment ?? null,
      });
      const result = await tx.$queryRawUnsafe(`
        UPDATE salary_revisions
           SET hr_signed_by=$1::uuid, hr_signed_at=$5::timestamptz, hr_comment=$2,
               hr_signer_role=$6, hr_authority_checked_at=$5::timestamptz,
               hr_authority_source='users_active_row',
               terms_manifest_sha256=$7, hr_signature_sha256=$8,
               status='pending_admin', updated_at=$5::timestamptz
         WHERE id=$3::int
           AND tenant_id=$4::uuid
           AND tenant_reconciliation_required = false
           AND status = 'pending_hr'
         RETURNING id, staff_uid, revision_type, current_basic, proposed_basic,
                   status, reason, created_at
      `,
        hrUid, comment ?? null, id, tenantId, signedAt, hrSignerRole,
        termsManifest, hrSignature,
      );
      if (result.length !== 1) return { outcome: 'transition_lost' };
      const message = 'HR signature applied — awaiting Admin countersign';
      const committed = await finaliseSalaryRevisionCommandTx(tx, {
        tenantId, command, responseData: result[0], message,
      });
      return { outcome: 'signed', revision: committed.responseData, message: committed.message };
    });
    if (signed.outcome === 'role_forbidden') {
      return error(res, 'Active HR_STAFF authority is required', HTTP_STATUS.FORBIDDEN);
    }
    if (signed.outcome === 'not_found') {
      return error(res, 'Revision not found', HTTP_STATUS.NOT_FOUND);
    }
    if (signed.outcome === 'wrong_state') {
      return error(res, 'Revision is not awaiting HR signature', HTTP_STATUS.BAD_REQUEST);
    }
    if (signed.outcome !== 'signed') throw new Error('Salary revision HR signature transition lost');
    success(res, signed.revision, signed.message);
  } catch (err) {
    logger.error('HR Sign Revision Error:', err);
    error(
      res,
      err instanceof SalaryRevisionCommandError ? err.message : 'Failed to sign revision',
      err instanceof SalaryRevisionCommandError
        ? err.statusCode
        : HTTP_STATUS.INTERNAL_SERVER_ERROR,
    );
  }
};

// ─── Admin: Countersign revision (second/final sign) ────────────────────────
export const adminSignRevision = async (req, res) => {
  try {
    const { id } = req.params;
    const adminUid = req.user?.uid;
    const tenantId = resolveTenantOrThrow(req);
    const { comment } = req.body;
    const command = salaryRevisionCommandFromRequest(req, 'revision_admin_sign', id);

    const signed = await setTenant(tenantId, async (tx) => {
      const replay = await findSalaryRevisionCommandReplayTx(tx, tenantId, command);
      if (replay) return { outcome: 'signed', revision: replay.responseData, message: replay.message };
      const adminSignerRole = await activeDatabaseRole(tx, tenantId, adminUid);
      if (!['ADMIN', 'SUPER_ADMIN'].includes(adminSignerRole)) {
        return { outcome: 'role_forbidden' };
      }
      const revisions = await tx.$queryRawUnsafe(`
        SELECT sr.id, sr.tenant_id, sr.revision_number, sr.staff_uid,
               sr.revision_type, sr.salary_baseline, sr.current_basic,
               sr.proposed_basic, sr.current_gross, sr.proposed_gross,
               sr.increment_amount, sr.increment_pct, sr.bonus_amount,
               sr.bonus_reason, sr.other_changes, sr.effective_from, sr.reason,
               sr.proposed_by, sr.proposed_at, sr.hr_signed_by, sr.hr_signed_at,
               sr.hr_signer_role, sr.hr_authority_checked_at,
               sr.hr_authority_source, sr.hr_comment,
               sr.terms_manifest_sha256, sr.hr_signature_sha256,
               sr.admin_signed_by, sr.admin_signed_at,
               sr.admin_comment, sr.status, clock_timestamp() AS command_at
          FROM salary_revisions sr
          JOIN users staff_owner
            ON staff_owner.uid = sr.staff_uid
           AND staff_owner.tenant_id = sr.tenant_id
           AND staff_owner.is_active = true
           AND COALESCE(staff_owner.is_deleted, false) = false
           AND staff_owner.deleted_at IS NULL
           AND staff_owner.merged_into_uid IS NULL
           AND LOWER(COALESCE(staff_owner.status, 'active')) = 'active'
         WHERE sr.id = $1::int
           AND sr.tenant_id = $2::uuid
           AND sr.tenant_reconciliation_required = false
         FOR UPDATE OF sr FOR SHARE OF staff_owner
      `, id, tenantId);
      if (revisions.length === 0) return { outcome: 'not_found' };
      const revision = revisions[0];
      if (revision.status !== 'pending_admin') return { outcome: 'wrong_state' };
      if (revision.hr_signed_by === adminUid) return { outcome: 'same_signer' };
      if (revision.hr_signer_role !== 'HR_STAFF'
          || revision.hr_authority_source !== 'users_active_row'
          || canonicalDate(revision.hr_authority_checked_at)
            !== canonicalDate(revision.hr_signed_at)) {
        return { outcome: 'hr_authority_invalid' };
      }
      if (!revision.terms_manifest_sha256 || !revision.hr_signature_sha256
          || computeRevisionTermsManifest(revision) !== revision.terms_manifest_sha256
          || computeRevisionHrSignature(revision) !== revision.hr_signature_sha256) {
        return { outcome: 'hr_signature_invalid' };
      }
      const adminSignedAt = revision.command_at;
      const hash = computeRevisionHash({
        ...revision,
        admin_signed_by: adminUid,
        admin_signed_at: adminSignedAt,
        admin_signer_role: adminSignerRole,
        admin_authority_checked_at: adminSignedAt,
        admin_authority_source: 'users_active_row',
        admin_comment: comment ?? null,
      });
      const result = await tx.$queryRawUnsafe(`
        UPDATE salary_revisions
           SET admin_signed_by=$1::uuid, admin_signed_at=$2::timestamptz,
               admin_comment=$3, status='approved',
               -- One bind, two differently-typed targets: signature_hash is
               -- VARCHAR(64) and migration 754's admin_signature_sha256 is
               -- CHAR(64). An untyped $4 gets a type deduced from each target
               -- in turn and Postgres refuses to plan the statement
               -- (42P08, "character varying versus character"), so every
               -- admin countersign 500s. Pin the bind to text once and let the
               -- assignment cast land it in both columns.
               signature_hash=$4::text,
               admin_signature_sha256=$4::text,
               admin_signer_role=$7, admin_authority_checked_at=$2::timestamptz,
               admin_authority_source='users_active_row',
               updated_at=NOW()
         WHERE id=$5::int
           AND tenant_id=$6::uuid
           AND tenant_reconciliation_required = false
           AND status = 'pending_admin'
           AND hr_signed_by IS DISTINCT FROM $1::uuid
         RETURNING id, staff_uid, revision_type, current_basic, proposed_basic,
                   status, reason, created_at
      `, adminUid, adminSignedAt, comment ?? null, hash, id, tenantId, adminSignerRole);
      if (result.length !== 1) return { outcome: 'transition_lost' };
      await tx.$queryRawUnsafe(
        `INSERT INTO salary_revision_activation_jobs (
           tenant_id, revision_id, effective_on,
           expected_admin_signature_sha256, status, next_attempt_at
         ) VALUES (
           $1::uuid, $2::int, $3::date, $4, 'queued',
           CASE WHEN $3::date > CURRENT_DATE
             THEN $3::date::timestamptz ELSE clock_timestamp() END
         )
         ON CONFLICT (tenant_id, revision_id) DO NOTHING
         RETURNING id`,
        tenantId,
        Number(id),
        revision.effective_from,
        hash,
      );
      const activation = await tx.$queryRawUnsafe(
        `SELECT id
           FROM salary_revision_activation_jobs
          WHERE tenant_id = $1::uuid AND revision_id = $2::int
            AND expected_admin_signature_sha256 = $3
            AND status = 'queued'
          FOR UPDATE`,
        tenantId,
        Number(id),
        hash,
      );
      if (activation.length !== 1) return { outcome: 'transition_lost' };
      const message = 'Admin countersign complete — revision approved';
      const committed = await finaliseSalaryRevisionCommandTx(tx, {
        tenantId, command, responseData: result[0], message,
      });
      return { outcome: 'signed', revision: committed.responseData, message: committed.message };
    });
    if (signed.outcome === 'role_forbidden') {
      return error(res, 'Active Admin authority is required', HTTP_STATUS.FORBIDDEN);
    }
    if (signed.outcome === 'not_found') {
      return error(res, 'Revision not found', HTTP_STATUS.NOT_FOUND);
    }
    if (signed.outcome === 'wrong_state') {
      return error(res, 'Revision must be HR-signed before Admin countersign', HTTP_STATUS.BAD_REQUEST);
    }
    if (signed.outcome === 'same_signer') {
      return error(res, 'HR signer and Admin signer cannot be the same person', HTTP_STATUS.FORBIDDEN);
    }
    if (signed.outcome === 'hr_authority_invalid') {
      return error(res, 'The recorded HR authority-at-signature evidence is invalid', HTTP_STATUS.CONFLICT);
    }
    if (signed.outcome === 'hr_signature_invalid') {
      return error(res, 'The frozen HR-signed revision terms are invalid', HTTP_STATUS.CONFLICT);
    }
    if (signed.outcome !== 'signed') throw new Error('Salary revision Admin signature transition lost');
    success(res, signed.revision, signed.message);
  } catch (err) {
    logger.error('Admin Sign Revision Error:', err);
    error(
      res,
      err instanceof SalaryRevisionCommandError ? err.message : 'Failed to countersign revision',
      err instanceof SalaryRevisionCommandError
        ? err.statusCode
        : HTTP_STATUS.INTERNAL_SERVER_ERROR,
    );
  }
};

// ─── Admin: Apply approved revision to staff_salary ─────────────────────────
export const applyRevision = async (req, res) => {
  try {
    const { id } = req.params;
    const adminUid = req.user?.uid;
    const tenantId = resolveTenantOrThrow(req);
    const command = salaryRevisionCommandFromRequest(req, 'revision_apply', id);
    const applied = await setTenant(tenantId, async (tx) => {
      const replay = await findSalaryRevisionCommandReplayTx(tx, tenantId, command);
      if (replay) return { outcome: 'applied', responseData: replay.responseData, message: replay.message };
      const activeTenants = await tx.$queryRawUnsafe(
        `SELECT id FROM tenants
          WHERE id = $1::uuid AND LOWER(COALESCE(status, '')) = 'active'
          FOR SHARE`,
        tenantId,
      );
      if (activeTenants.length !== 1) return { outcome: 'tenant_inactive' };
      if (!await hasActiveDatabaseRole(tx, tenantId, adminUid, ['ADMIN', 'SUPER_ADMIN'])) {
        return { outcome: 'role_forbidden' };
      }
      const activationRows = await tx.$queryRawUnsafe(
        `SELECT id, status, expected_admin_signature_sha256
           FROM salary_revision_activation_jobs
          WHERE tenant_id = $1::uuid AND revision_id = $2::int
          FOR UPDATE`,
        tenantId,
        Number(id),
      );
      if (activationRows.length !== 1) return { outcome: 'activation_missing' };
      if (activationRows[0].status === 'processing') {
        return { outcome: 'activation_in_progress' };
      }
      if (activationRows[0].status !== 'queued') return { outcome: 'not_approved' };
      const rev = await tx.$queryRawUnsafe(`
        SELECT sr.id, sr.tenant_id, sr.revision_number, sr.staff_uid,
               sr.revision_type, sr.salary_baseline, sr.current_basic,
               sr.proposed_basic, sr.current_gross, sr.proposed_gross,
               sr.increment_amount, sr.increment_pct, sr.bonus_amount,
               sr.bonus_reason, sr.other_changes, sr.effective_from, sr.reason,
               sr.proposed_by, sr.proposed_at, sr.hr_signed_by, sr.hr_signed_at,
               sr.hr_signer_role, sr.hr_authority_checked_at,
               sr.hr_authority_source, sr.hr_comment,
               sr.admin_signed_by, sr.admin_signed_at, sr.admin_signer_role,
               sr.admin_authority_checked_at, sr.admin_authority_source,
               sr.admin_comment, sr.terms_manifest_sha256,
               sr.hr_signature_sha256, sr.admin_signature_sha256,
               sr.signature_hash, sr.status, CURRENT_DATE AS db_current_date
          FROM salary_revisions sr
          JOIN users staff_owner
            ON staff_owner.uid = sr.staff_uid
           AND staff_owner.tenant_id = sr.tenant_id
           AND staff_owner.is_active = true
           AND COALESCE(staff_owner.is_deleted, false) = false
           AND staff_owner.deleted_at IS NULL
           AND staff_owner.merged_into_uid IS NULL
           AND LOWER(COALESCE(staff_owner.status, 'active')) = 'active'
         WHERE sr.id = $1::int
           AND sr.tenant_id = $2::uuid
           AND sr.tenant_reconciliation_required = false
         FOR UPDATE OF sr FOR SHARE OF staff_owner
      `, id, tenantId);
      if (rev.length === 0) return { outcome: 'not_found' };
      if (rev[0].status !== 'approved') return { outcome: 'not_approved' };

      const r = rev[0];
      if (r.hr_signed_by === r.admin_signed_by) return { outcome: 'same_signer' };
      if (!r.signature_hash || !r.admin_signature_sha256
          || activationRows[0].expected_admin_signature_sha256
            !== r.admin_signature_sha256
          || r.signature_hash !== r.admin_signature_sha256
          || computeRevisionTermsManifest(r) !== r.terms_manifest_sha256
          || computeRevisionHrSignature(r) !== r.hr_signature_sha256
          || computeRevisionHash(r) !== r.signature_hash) {
        return { outcome: 'signature_invalid' };
      }
      if (r.hr_signer_role !== 'HR_STAFF'
          || r.hr_authority_source !== 'users_active_row'
          || canonicalDate(r.hr_authority_checked_at) !== canonicalDate(r.hr_signed_at)) {
        return { outcome: 'hr_authority_invalid' };
      }
      if (!['ADMIN', 'SUPER_ADMIN'].includes(r.admin_signer_role)
          || r.admin_authority_source !== 'users_active_row'
          || canonicalDate(r.admin_authority_checked_at) !== canonicalDate(r.admin_signed_at)) {
        return { outcome: 'admin_authority_invalid' };
      }
      if (canonicalDate(r.db_current_date, true) < canonicalDate(r.effective_from, true)) {
        const responseData = {
          revision_id: String(id),
          staff_uid: r.staff_uid,
          status: 'scheduled',
          effective_from: canonicalDate(r.effective_from, true),
        };
        const message = 'Revision approved and scheduled for its effective date';
        const committed = await finaliseSalaryRevisionCommandTx(tx, {
          tenantId, command, responseData, message,
        });
        return {
          outcome: 'scheduled',
          responseData: committed.responseData,
          message: committed.message,
        };
      }
      const salaries = await tx.$queryRawUnsafe(
        `SELECT basic_salary, hra_pct, da_pct, special_allowance,
                transport_allowance, medical_allowance, tds_monthly,
                pf_employee_pct, esi_applicable
           FROM staff_salary
          WHERE tenant_id = $1::uuid
            AND staff_uid = $2::uuid
            AND is_active = true
          FOR UPDATE`,
        tenantId,
        r.staff_uid,
      );
      if (salaries.length !== 1) return { outcome: 'staff_salary_inactive' };
      const currentSalary = salaries[0];
      if (!salaryBaselineMatches(currentSalary, r.salary_baseline)) {
        return { outcome: 'salary_baseline_changed' };
      }
      let changes = {};
      try {
        changes = r.other_changes == null
          ? {}
          : (typeof r.other_changes === 'string' ? JSON.parse(r.other_changes) : r.other_changes);
      } catch (_) {
        return { outcome: 'financial_evidence_invalid' };
      }
      if (
        !changes
        || typeof changes !== 'object'
        || Array.isArray(changes)
        || Object.entries(changes).some(([field, value]) => (
          !SALARY_CHANGE_FIELDS.has(field)
          || !Number.isFinite(Number(value))
          || Number(value) < 0
        ))
      ) {
        return { outcome: 'financial_evidence_invalid' };
      }
      if (!revisionFinancialShapeValid(r, changes)) {
        return { outcome: 'financial_evidence_invalid' };
      }
      const expectedProposedGross = canonicalGross({
        ...currentSalary,
        ...changes,
        basic_salary: r.proposed_basic ?? currentSalary.basic_salary,
      });
      if (
        r.current_gross == null
        || r.proposed_gross == null
        || Math.abs(Number(r.current_gross) - canonicalGross(currentSalary)) >= 0.005
        || Math.abs(Number(r.proposed_gross) - expectedProposedGross) >= 0.005
      ) {
        return { outcome: 'financial_evidence_invalid' };
      }
      const updates = [];
      const vals = [];
      let idx = 1;

      if (r.proposed_basic != null) {
        updates.push(`basic_salary = $${idx++}`);
        vals.push(r.proposed_basic);
      }

      for (const [field, value] of Object.entries(changes)) {
        updates.push(`${field} = $${idx++}`);
        vals.push(value);
      }

      if (updates.length > 0) {
        updates.push('updated_at = NOW()');
        vals.push(r.staff_uid, tenantId);
        const updatedSalary = await tx.$executeRawUnsafe(
          `UPDATE staff_salary
              SET ${updates.join(', ')}
            WHERE staff_uid = $${idx}::uuid
              AND tenant_id = $${idx + 1}::uuid
              AND is_active = true`,
          ...vals,
        );
        if (updatedSalary !== 1) throw new Error('Tenant-bound staff salary row not found');
      }

      if (r.revision_type === 'bonus') {
        if (!Number.isFinite(Number(r.bonus_amount)) || Number(r.bonus_amount) <= 0) {
          return { outcome: 'financial_evidence_invalid' };
        }
        const payable = await tx.$queryRawUnsafe(
          `INSERT INTO salary_revision_payables (
             tenant_id, revision_id, staff_uid, payable_type, amount, status
           )
           VALUES ($1::uuid, $2::int, $3::uuid, 'bonus', $4::numeric, 'pending')
           RETURNING id`,
          tenantId,
          Number(r.id),
          r.staff_uid,
          r.bonus_amount,
        );
        if (payable.length !== 1) throw new Error('Bonus payable could not be recorded');
      }

      const markedApplied = await tx.$queryRawUnsafe(`
        UPDATE salary_revisions
           SET status='applied', applied_at=NOW(), updated_at=NOW()
         WHERE id=$1::int
           AND tenant_id=$2::uuid
           AND tenant_reconciliation_required = false
           AND status='approved'
         RETURNING id, applied_at
      `, id, tenantId);
      if (markedApplied.length !== 1) throw new Error('Salary revision apply transition lost its tenant fence');

      if (['increment', 'component_change'].includes(r.revision_type)
          && Number(r.proposed_gross) > Number(r.current_gross)
          && canonicalDate(r.effective_from, true) < canonicalDate(r.db_current_date, true)) {
        await tx.$queryRawUnsafe(
          `INSERT INTO salary_revision_arrears_work_items (
             tenant_id, revision_id, staff_uid, effective_on, activated_at, status
           ) VALUES ($1::uuid, $2::int, $3::uuid, $4::date, $5::timestamptz, 'pending')
           ON CONFLICT (tenant_id, revision_id) DO NOTHING
           RETURNING id`,
          tenantId,
          Number(id),
          r.staff_uid,
          r.effective_from,
          markedApplied[0].applied_at,
        );
        const arrearsWork = await tx.$queryRawUnsafe(
          `SELECT id
             FROM salary_revision_arrears_work_items
            WHERE tenant_id = $1::uuid AND revision_id = $2::int
              AND staff_uid = $3::uuid AND effective_on = $4::date
              AND activated_at = $5::timestamptz AND status = 'pending'
            FOR UPDATE`,
          tenantId,
          Number(id),
          r.staff_uid,
          r.effective_from,
          markedApplied[0].applied_at,
        );
        if (arrearsWork.length !== 1) {
          throw new Error('Salary revision arrears work identity is inconsistent');
        }
      }

      const activationApplied = await tx.$queryRawUnsafe(
        `UPDATE salary_revision_activation_jobs
            SET status = 'applied', claim_token = NULL, claimed_at = NULL,
                lease_expires_at = NULL, last_error = NULL,
                outcome = jsonb_build_object('code', 'applied', 'revision_id', $2::int),
                applied_at = clock_timestamp(), finalized_at = clock_timestamp(),
                updated_at = clock_timestamp()
          WHERE tenant_id = $1::uuid AND revision_id = $2::int
            AND expected_admin_signature_sha256 = $3
            AND status = 'queued'
          RETURNING id`,
        tenantId,
        Number(id),
        r.admin_signature_sha256,
      );
      if (activationApplied.length !== 1) {
        throw new Error('Salary revision activation evidence was not finalized');
      }

      await tx.$executeRawUnsafe(`
        UPDATE annual_review_reminders reminder
           SET status='completed', revision_id=$1::int
         WHERE reminder.staff_uid=$2::uuid
           AND reminder.tenant_id=$4::uuid
           AND reminder.tenant_reconciliation_required = false
           AND reminder.review_year=EXTRACT(YEAR FROM $3::date)::int
           AND reminder.status IN ('pending','initiated')
           AND (reminder.revision_id IS NULL OR reminder.revision_id = $1::int)
           AND EXISTS (
             SELECT 1 FROM users staff_owner
              WHERE staff_owner.uid = reminder.staff_uid
                AND staff_owner.tenant_id = $4::uuid
           )
      `, id, r.staff_uid, r.effective_from, tenantId);

      await recordSalaryRevisionActivatedTx(tx, {
        tenantId,
        revisionId: Number(id),
        staffUid: r.staff_uid,
        sourceType: 'manual_apply',
        sourceId: activationApplied[0].id,
        effectiveOn: r.effective_from,
        appliedAt: markedApplied[0].applied_at,
        termsManifestSha256: r.terms_manifest_sha256,
        hrSignatureSha256: r.hr_signature_sha256,
        adminSignatureSha256: r.admin_signature_sha256,
      });

      const responseData = { revision_id: String(id), staff_uid: r.staff_uid };
      const message = 'Revision applied to staff salary';
      const committed = await finaliseSalaryRevisionCommandTx(tx, {
        tenantId, command, responseData, message,
      });
      return {
        outcome: 'applied',
        responseData: committed.responseData,
        message: committed.message,
      };
    });

    if (applied.outcome === 'not_found') return error(res, 'Revision not found', HTTP_STATUS.NOT_FOUND);
    if (applied.outcome === 'role_forbidden') {
      return error(res, 'Active Admin authority is required', HTTP_STATUS.FORBIDDEN);
    }
    if (applied.outcome === 'tenant_inactive') {
      return error(res, 'Tenant is not active; revision activation is parked', HTTP_STATUS.CONFLICT);
    }
    if (applied.outcome === 'not_approved') {
      return error(res, 'Revision must be approved by both HR and Admin before applying', HTTP_STATUS.FORBIDDEN);
    }
    if (applied.outcome === 'activation_missing') {
      return error(res, 'Revision activation evidence is missing', HTTP_STATUS.CONFLICT);
    }
    if (applied.outcome === 'activation_in_progress') {
      return error(res, 'Revision activation is already being processed', HTTP_STATUS.CONFLICT);
    }
    if (applied.outcome === 'same_signer') {
      return error(res, 'HR signer and Admin signer cannot be the same person', HTTP_STATUS.FORBIDDEN);
    }
    if (applied.outcome === 'signature_invalid') {
      return error(res, 'Revision approval signature is invalid', HTTP_STATUS.CONFLICT);
    }
    if (applied.outcome === 'hr_authority_invalid') {
      return error(res, 'The recorded HR authority-at-signature evidence is invalid', HTTP_STATUS.CONFLICT);
    }
    if (applied.outcome === 'admin_authority_invalid') {
      return error(res, 'The recorded Admin authority-at-signature evidence is invalid', HTTP_STATUS.CONFLICT);
    }
    if (applied.outcome === 'staff_salary_inactive') {
      return error(res, 'Active tenant-bound staff salary row is required', HTTP_STATUS.CONFLICT);
    }
    if (applied.outcome === 'salary_baseline_changed') {
      return error(res, 'Staff salary changed after this revision was proposed', HTTP_STATUS.CONFLICT);
    }
    if (applied.outcome === 'financial_evidence_invalid') {
      return error(res, 'Revision financial evidence is incomplete or inconsistent', HTTP_STATUS.CONFLICT);
    }

    success(res, applied.responseData, applied.message);
  } catch (err) {
    logger.error('Apply Revision Error:', err);
    error(
      res,
      err instanceof SalaryRevisionCommandError ? err.message : 'Failed to apply revision',
      err instanceof SalaryRevisionCommandError
        ? err.statusCode
        : HTTP_STATUS.INTERNAL_SERVER_ERROR,
    );
  }
};

// ─── Reject revision ─────────────────────────────────────────────────────────
export const rejectRevision = async (req, res) => {
  try {
    const { id } = req.params;
    const rejecterUid = req.user?.uid;
    const tenantId = resolveTenantOrThrow(req);
    const { reason } = req.body;
    const canonicalReason = typeof reason === 'string' ? reason.trim() : '';
    if (!canonicalReason || canonicalReason.length > 2000) {
      return error(
        res,
        'A non-empty rejection reason of at most 2000 characters is required',
        HTTP_STATUS.BAD_REQUEST,
      );
    }
    const command = salaryRevisionCommandFromRequest(req, 'revision_reject', id);

    const rejected = await setTenant(tenantId, async (tx) => {
      const replay = await findSalaryRevisionCommandReplayTx(tx, tenantId, command);
      if (replay) return { outcome: 'rejected', revision: replay.responseData, message: replay.message };
      const rejecterRole = await activeDatabaseRole(tx, tenantId, rejecterUid);
      if (!['HR_STAFF', 'ADMIN', 'SUPER_ADMIN'].includes(rejecterRole)) {
        return { outcome: 'role_forbidden' };
      }
      const revisions = await tx.$queryRawUnsafe(`
        SELECT sr.id, sr.tenant_id, sr.revision_number, sr.staff_uid,
               sr.revision_type, sr.salary_baseline, sr.current_basic,
               sr.proposed_basic, sr.current_gross, sr.proposed_gross,
               sr.increment_amount, sr.increment_pct, sr.bonus_amount,
               sr.bonus_reason, sr.other_changes, sr.effective_from, sr.reason,
               sr.proposed_by, sr.proposed_at, sr.status,
               sr.terms_manifest_sha256, sr.hr_signature_sha256,
               clock_timestamp() AS command_at
          FROM salary_revisions sr
          JOIN users staff_owner
            ON staff_owner.uid = sr.staff_uid
           AND staff_owner.tenant_id = sr.tenant_id
           AND staff_owner.is_active = true
           AND COALESCE(staff_owner.is_deleted, false) = false
           AND staff_owner.deleted_at IS NULL
           AND staff_owner.merged_into_uid IS NULL
           AND LOWER(COALESCE(staff_owner.status, 'active')) = 'active'
         WHERE sr.id = $1::int
           AND sr.tenant_id = $2::uuid
           AND sr.tenant_reconciliation_required = false
           AND sr.status IN ('pending_hr','pending_admin')
         FOR UPDATE OF sr FOR SHARE OF staff_owner
      `, id, tenantId);
      if (revisions.length !== 1) return { outcome: 'not_found' };
      const revision = revisions[0];
      const termsManifest = computeRevisionTermsManifest(revision);
      if (revision.terms_manifest_sha256
          && revision.terms_manifest_sha256 !== termsManifest) {
        return { outcome: 'terms_invalid' };
      }
      const rejectedAt = revision.command_at;
      const rejectionEvidence = computeRevisionRejectionEvidence({
        ...revision,
        terms_manifest_sha256: termsManifest,
        rejected_by: rejecterUid,
        rejected_at: rejectedAt,
        rejected_actor_role: rejecterRole,
        rejected_authority_checked_at: rejectedAt,
        rejected_authority_source: 'users_active_row',
        rejection_reason: canonicalReason,
      });
      const result = await tx.$queryRawUnsafe(`
        UPDATE salary_revisions
           SET status='rejected', rejected_by=$1::uuid, rejected_at=$5::timestamptz,
               rejection_reason=$2, rejected_actor_role=$6,
               rejected_authority_checked_at=$5::timestamptz,
               rejected_authority_source='users_active_row',
               terms_manifest_sha256=$7, rejection_evidence_sha256=$8,
               updated_at=$5::timestamptz
         WHERE id=$3::int
           AND tenant_id=$4::uuid
           AND tenant_reconciliation_required = false
           AND status IN ('pending_hr','pending_admin')
           AND EXISTS (
             SELECT 1 FROM users staff_owner
              WHERE staff_owner.uid = salary_revisions.staff_uid
                AND staff_owner.tenant_id = salary_revisions.tenant_id
                AND staff_owner.is_active = true
                AND COALESCE(staff_owner.is_deleted, false) = false
                AND staff_owner.deleted_at IS NULL
                AND staff_owner.merged_into_uid IS NULL
                AND LOWER(COALESCE(staff_owner.status, 'active')) = 'active'
           )
         RETURNING id, staff_uid, revision_type, current_basic, proposed_basic,
                   status, reason, created_at
      `, rejecterUid, canonicalReason, id, tenantId, rejectedAt, rejecterRole,
        termsManifest, rejectionEvidence);
      if (result.length !== 1) return { outcome: 'not_found' };
      const message = 'Revision rejected';
      const committed = await finaliseSalaryRevisionCommandTx(tx, {
        tenantId, command, responseData: result[0], message,
      });
      return { outcome: 'rejected', revision: committed.responseData, message: committed.message };
    });

    if (rejected.outcome === 'role_forbidden') {
      return error(res, 'Active HR or Admin authority is required', HTTP_STATUS.FORBIDDEN);
    }
    if (rejected.outcome === 'not_found') {
      return error(res, 'Revision not found or already processed', HTTP_STATUS.NOT_FOUND);
    }
    if (rejected.outcome === 'terms_invalid') {
      return error(res, 'Revision terms changed before rejection', HTTP_STATUS.CONFLICT);
    }
    success(res, rejected.revision, rejected.message);
  } catch (err) {
    logger.error('Reject Revision Error:', err);
    error(
      res,
      err instanceof SalaryRevisionCommandError ? err.message : 'Failed to reject revision',
      err instanceof SalaryRevisionCommandError
        ? err.statusCode
        : HTTP_STATUS.INTERNAL_SERVER_ERROR,
    );
  }
};

export const getBonusPayableReconciliationWorklist = async (req, res) => {
  try {
    const tenantId = resolveTenantOrThrow(req);
    const rows = await setTenant(tenantId, (tx) => tx.$queryRawUnsafe(
      `SELECT payable.id::text AS id, payable.revision_id, payable.staff_uid,
              payable.amount, payable.status, payable.reconciliation_reason,
              payable.reconciliation_evidence, payable.reconciliation_decision,
              payable.reconciliation_hr_by, payable.reconciliation_hr_at,
              payable.reconciliation_hr_evidence, revision.revision_number,
              revision.applied_at, staff_owner.name AS staff_name
         FROM salary_revision_payables payable
         JOIN salary_revisions revision
           ON revision.tenant_id = payable.tenant_id
          AND revision.id = payable.revision_id
          AND revision.staff_uid = payable.staff_uid
         JOIN users staff_owner
           ON staff_owner.tenant_id = payable.tenant_id
          AND staff_owner.uid = payable.staff_uid
        WHERE payable.tenant_id = $1::uuid
          AND payable.status = 'reconciliation_required'
        ORDER BY payable.created_at, payable.id`,
      tenantId,
    ));
    success(res, rows, 'Bonus payable reconciliation worklist fetched');
  } catch (err) {
    logger.error('Bonus Payable Reconciliation Worklist Error:', err);
    error(res, 'Failed to fetch bonus payable reconciliation worklist', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

function validateReconciliationAttestation(body) {
  const decision = body?.decision;
  const evidence = body?.evidence;
  if (!['confirmed_unpaid', 'confirmed_settled'].includes(decision)) return null;
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)
      || Object.keys(evidence).length === 0) return null;
  return { decision, evidence };
}

function canonicalEvidence(value) {
  if (Array.isArray(value)) return value.map(canonicalEvidence);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map(key => [key, canonicalEvidence(value[key])]),
    );
  }
  return value;
}

function reconciliationEvidenceHash(payload) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(canonicalEvidence(payload)))
    .digest('hex');
}

export const hrAttestBonusPayableReconciliation = async (req, res) => {
  try {
    const tenantId = resolveTenantOrThrow(req);
    const hrUid = req.user?.uid;
    const attestation = validateReconciliationAttestation(req.body);
    if (!attestation) {
      return error(
        res,
        'decision and non-empty evidence are required for bonus reconciliation',
        HTTP_STATUS.BAD_REQUEST,
      );
    }
    const command = salaryRevisionCommandFromRequest(
      req,
      'bonus_payable_hr_attest',
      req.params.id,
    );
    const outcome = await setTenant(tenantId, async (tx) => {
      const hrActorRole = await activeDatabaseRole(tx, tenantId, hrUid);
      if (hrActorRole !== 'HR_STAFF') {
        return { outcome: 'role_forbidden' };
      }
      const replay = await findSalaryRevisionCommandReplayTx(tx, tenantId, command);
      if (replay) return { outcome: 'attested', data: replay.responseData, message: replay.message };
      const rows = await tx.$queryRawUnsafe(
        `SELECT payable.id, payable.revision_id, payable.staff_uid,
                payable.payable_type, payable.amount,
                payable.reconciliation_reason,
                clock_timestamp() AS command_at
           FROM salary_revision_payables payable
           JOIN salary_revisions revision
             ON revision.tenant_id = payable.tenant_id
            AND revision.id = payable.revision_id
            AND revision.staff_uid = payable.staff_uid
            AND revision.revision_type = 'bonus'
            AND revision.status = 'applied'
            AND revision.tenant_reconciliation_required = false
          WHERE payable.tenant_id = $1::uuid
            AND payable.id = $2::bigint
            AND payable.status = 'reconciliation_required'
            AND payable.reconciliation_hr_by IS NULL
          FOR UPDATE OF payable`,
        tenantId,
        req.params.id,
      );
      if (!rows[0]) return { outcome: 'not_found' };
      const signedAt = rows[0].command_at;
      const evidenceHash = reconciliationEvidenceHash({
        tenant_id: tenantId,
        payable_id: String(req.params.id),
        revision_id: Number(rows[0].revision_id),
        staff_uid: rows[0].staff_uid,
        payable_type: rows[0].payable_type,
        amount: canonicalMoney(rows[0].amount),
        reconciliation_reason: rows[0].reconciliation_reason,
        decision: attestation.decision,
        evidence: attestation.evidence,
        hr_actor_uid: hrUid,
        hr_actor_role: hrActorRole,
        hr_authority_source: 'users_active_row',
        hr_authority_checked_at: canonicalDate(signedAt),
        hr_signed_at: canonicalDate(signedAt),
        request_body_sha256: command.requestBodySha256,
      });
      const attested = await tx.$queryRawUnsafe(
        `UPDATE salary_revision_payables
            SET reconciliation_decision = $3,
                reconciliation_hr_by = $4::uuid,
                reconciliation_hr_at = $5::timestamptz,
                reconciliation_hr_evidence = $6::jsonb,
                reconciliation_hr_evidence_sha256 = $7,
                reconciliation_hr_request_sha256 = $8::char(64),
                reconciliation_hr_actor_role = $9,
                reconciliation_hr_authority_checked_at = $5::timestamptz,
                reconciliation_hr_authority_source = 'users_active_row',
                updated_at = clock_timestamp()
          WHERE tenant_id = $1::uuid AND id = $2::bigint
            AND status = 'reconciliation_required'
            AND reconciliation_hr_by IS NULL
          RETURNING id::text AS id, revision_id, staff_uid, amount, status,
                    reconciliation_decision, reconciliation_hr_by,
                    reconciliation_hr_at, reconciliation_hr_evidence,
                    reconciliation_hr_evidence_sha256,
                    reconciliation_hr_request_sha256,
                    reconciliation_hr_actor_role,
                    reconciliation_hr_authority_checked_at,
                    reconciliation_hr_authority_source`,
        tenantId,
        req.params.id,
        attestation.decision,
        hrUid,
        signedAt,
        JSON.stringify(attestation.evidence),
        evidenceHash,
        command.requestBodySha256,
        hrActorRole,
      );
      if (!attested[0]) return { outcome: 'transition_lost' };
      const message = 'HR reconciliation attestation recorded — awaiting Admin countersign';
      const committed = await finaliseSalaryRevisionCommandTx(tx, {
        tenantId, command, responseData: attested[0], message,
      });
      return { outcome: 'attested', data: committed.responseData, message: committed.message };
    });
    if (outcome.outcome === 'role_forbidden') {
      return error(res, 'Active HR_STAFF authority is required', HTTP_STATUS.FORBIDDEN);
    }
    if (outcome.outcome === 'not_found') {
      return error(res, 'Unresolved bonus payable not found', HTTP_STATUS.NOT_FOUND);
    }
    if (outcome.outcome !== 'attested') throw new Error('Bonus reconciliation HR transition lost');
    success(res, outcome.data, outcome.message);
  } catch (err) {
    logger.error('Bonus Payable HR Reconciliation Error:', err);
    error(
      res,
      err instanceof SalaryRevisionCommandError ? err.message : 'Failed to attest bonus reconciliation',
      err instanceof SalaryRevisionCommandError ? err.statusCode : HTTP_STATUS.INTERNAL_SERVER_ERROR,
    );
  }
};

export const adminResolveBonusPayableReconciliation = async (req, res) => {
  try {
    const tenantId = resolveTenantOrThrow(req);
    const adminUid = req.user?.uid;
    const attestation = validateReconciliationAttestation(req.body);
    if (!attestation) {
      return error(
        res,
        'decision and non-empty evidence are required for bonus reconciliation',
        HTTP_STATUS.BAD_REQUEST,
      );
    }
    const command = salaryRevisionCommandFromRequest(
      req,
      'bonus_payable_admin_resolve',
      req.params.id,
    );
    const outcome = await setTenant(tenantId, async (tx) => {
      const adminActorRole = await activeDatabaseRole(tx, tenantId, adminUid);
      if (!['ADMIN', 'SUPER_ADMIN'].includes(adminActorRole)) {
        return { outcome: 'role_forbidden' };
      }
      const replay = await findSalaryRevisionCommandReplayTx(tx, tenantId, command);
      if (replay) return { outcome: 'resolved', data: replay.responseData, message: replay.message };
      const rows = await tx.$queryRawUnsafe(
        `SELECT payable.id, payable.revision_id, payable.staff_uid,
                payable.payable_type, payable.amount,
                payable.reconciliation_reason, payable.reconciliation_decision,
                payable.reconciliation_hr_by, payable.reconciliation_hr_at,
                payable.reconciliation_hr_evidence,
                payable.reconciliation_hr_evidence_sha256,
                payable.reconciliation_hr_request_sha256,
                payable.reconciliation_hr_actor_role,
                payable.reconciliation_hr_authority_checked_at,
                payable.reconciliation_hr_authority_source,
                clock_timestamp() AS command_at
           FROM salary_revision_payables payable
           JOIN salary_revisions revision
             ON revision.tenant_id = payable.tenant_id
            AND revision.id = payable.revision_id
            AND revision.staff_uid = payable.staff_uid
            AND revision.revision_type = 'bonus'
            AND revision.status = 'applied'
            AND revision.tenant_reconciliation_required = false
          WHERE payable.tenant_id = $1::uuid
            AND payable.id = $2::bigint
            AND payable.status = 'reconciliation_required'
            AND payable.reconciliation_hr_by IS NOT NULL
            AND payable.reconciliation_admin_by IS NULL
          FOR UPDATE OF payable`,
        tenantId,
        req.params.id,
      );
      const payable = rows[0];
      if (!payable) return { outcome: 'not_found' };
      if (payable.reconciliation_hr_by === adminUid) return { outcome: 'same_signer' };
      if (payable.reconciliation_decision !== attestation.decision) {
        return { outcome: 'decision_mismatch' };
      }
      const expectedHrHash = reconciliationEvidenceHash({
        tenant_id: tenantId,
        payable_id: String(req.params.id),
        revision_id: Number(payable.revision_id),
        staff_uid: payable.staff_uid,
        payable_type: payable.payable_type,
        amount: canonicalMoney(payable.amount),
        reconciliation_reason: payable.reconciliation_reason,
        decision: payable.reconciliation_decision,
        evidence: payable.reconciliation_hr_evidence,
        hr_actor_uid: payable.reconciliation_hr_by,
        hr_actor_role: payable.reconciliation_hr_actor_role,
        hr_authority_source: payable.reconciliation_hr_authority_source,
        hr_authority_checked_at: canonicalDate(
          payable.reconciliation_hr_authority_checked_at,
        ),
        hr_signed_at: canonicalDate(payable.reconciliation_hr_at),
        request_body_sha256: payable.reconciliation_hr_request_sha256,
      });
      if (!payable.reconciliation_hr_evidence_sha256
          || expectedHrHash !== payable.reconciliation_hr_evidence_sha256) {
        return { outcome: 'hr_evidence_invalid' };
      }
      if (payable.reconciliation_hr_actor_role !== 'HR_STAFF'
          || payable.reconciliation_hr_authority_source !== 'users_active_row') {
        return { outcome: 'hr_evidence_invalid' };
      }
      const finalStatus = attestation.decision === 'confirmed_unpaid' ? 'pending' : 'excluded';
      const signedAt = payable.command_at;
      const adminSignature = reconciliationEvidenceHash({
        tenant_id: tenantId,
        payable_id: String(req.params.id),
        revision_id: Number(payable.revision_id),
        staff_uid: payable.staff_uid,
        payable_type: payable.payable_type,
        amount: canonicalMoney(payable.amount),
        reconciliation_reason: payable.reconciliation_reason,
        decision: payable.reconciliation_decision,
        hr_evidence_sha256: payable.reconciliation_hr_evidence_sha256,
        admin_evidence: attestation.evidence,
        admin_actor_uid: adminUid,
        admin_actor_role: adminActorRole,
        admin_authority_source: 'users_active_row',
        admin_authority_checked_at: canonicalDate(signedAt),
        admin_signed_at: canonicalDate(signedAt),
        request_body_sha256: command.requestBodySha256,
      });
      const resolved = await tx.$queryRawUnsafe(
        `UPDATE salary_revision_payables
            SET status = $3,
                reconciliation_admin_by = $4::uuid,
                reconciliation_admin_at = $5::timestamptz,
                reconciliation_admin_evidence = $6::jsonb,
                reconciliation_admin_signature_sha256 = $7,
                reconciliation_admin_request_sha256 = $8::char(64),
                reconciliation_admin_actor_role = $9,
                reconciliation_admin_authority_checked_at = $5::timestamptz,
                reconciliation_admin_authority_source = 'users_active_row',
                updated_at = clock_timestamp()
          WHERE tenant_id = $1::uuid AND id = $2::bigint
            AND status = 'reconciliation_required'
            AND reconciliation_admin_by IS NULL
          RETURNING id::text AS id, revision_id, staff_uid, amount, status,
                    reconciliation_decision, reconciliation_hr_by,
                    reconciliation_admin_by, reconciliation_admin_at,
                    reconciliation_admin_signature_sha256,
                    reconciliation_admin_request_sha256,
                    reconciliation_admin_actor_role,
                    reconciliation_admin_authority_checked_at,
                    reconciliation_admin_authority_source`,
        tenantId,
        req.params.id,
        finalStatus,
        adminUid,
        signedAt,
        JSON.stringify(attestation.evidence),
        adminSignature,
        command.requestBodySha256,
        adminActorRole,
      );
      if (!resolved[0]) return { outcome: 'transition_lost' };
      const message = finalStatus === 'pending'
        ? 'Bonus confirmed unpaid and released to the next payroll'
        : 'Bonus confirmed externally settled and excluded from payroll';
      const committed = await finaliseSalaryRevisionCommandTx(tx, {
        tenantId, command, responseData: resolved[0], message,
      });
      return { outcome: 'resolved', data: committed.responseData, message: committed.message };
    });
    if (outcome.outcome === 'role_forbidden') {
      return error(res, 'Active Admin authority is required', HTTP_STATUS.FORBIDDEN);
    }
    if (outcome.outcome === 'not_found') {
      return error(res, 'HR-attested unresolved bonus payable not found', HTTP_STATUS.NOT_FOUND);
    }
    if (outcome.outcome === 'same_signer') {
      return error(res, 'HR and Admin reconciliation signers must be different people', HTTP_STATUS.FORBIDDEN);
    }
    if (outcome.outcome === 'decision_mismatch') {
      return error(res, 'Admin decision must match the frozen HR attestation', HTTP_STATUS.CONFLICT);
    }
    if (outcome.outcome === 'hr_evidence_invalid') {
      return error(res, 'The frozen HR reconciliation evidence is invalid', HTTP_STATUS.CONFLICT);
    }
    if (outcome.outcome !== 'resolved') throw new Error('Bonus reconciliation Admin transition lost');
    success(res, outcome.data, outcome.message);
  } catch (err) {
    logger.error('Bonus Payable Admin Reconciliation Error:', err);
    error(
      res,
      err instanceof SalaryRevisionCommandError ? err.message : 'Failed to resolve bonus reconciliation',
      err instanceof SalaryRevisionCommandError ? err.statusCode : HTTP_STATUS.INTERNAL_SERVER_ERROR,
    );
  }
};

// ─── Get revisions list ───────────────────────────────────────────────────────
export const getRevisions = async (req, res) => {
  try {
    const { status, staff_uid, limit = 50 } = req.query;
    const conditions = [];
    const params = [];
    let idx = 1;

    // CAN-016: always scope the revision list to the caller's tenant.
    conditions.push(`sr.tenant_id = $${idx++}::uuid`); params.push(resolveTenantOrThrow(req));
    conditions.push('sr.tenant_reconciliation_required = false');
    if (status) { conditions.push(`sr.status = $${idx++}`); params.push(status); }
    if (staff_uid) { conditions.push(`sr.staff_uid = $${idx++}`); params.push(staff_uid); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(Math.min(parseInt(limit) || 50, 200));

    const revisions = await setTenant(params[0], tx => tx.$queryRawUnsafe(`
      SELECT sr.id, sr.staff_uid, sr.revision_type, sr.current_basic, sr.proposed_basic, sr.current_gross, sr.proposed_gross,
             sr.effective_from, sr.status, sr.reason, sr.created_at,
             u.name as staff_name, COALESCE(s.department, ss.department) as department,
             u2.name as proposed_by_name,
             u3.name as hr_signed_by_name,
             u4.name as admin_signed_by_name,
             u5.name as rejected_by_name,
             activation.status AS activation_status,
             activation.attempt_count AS activation_attempt_count,
             activation.next_attempt_at AS activation_next_attempt_at,
             activation.outcome AS activation_outcome,
             activation_event.source_type AS activation_source_type,
             activation_event.created_at AS activation_event_created_at
      FROM salary_revisions sr
      JOIN users u ON sr.staff_uid = u.uid AND u.tenant_id = sr.tenant_id
      LEFT JOIN staff s ON s.user_id = u.uid AND s.tenant_id = sr.tenant_id
      LEFT JOIN staff_salary ss ON ss.staff_uid = u.uid AND ss.tenant_id = sr.tenant_id
      LEFT JOIN users u2 ON sr.proposed_by = u2.uid AND u2.tenant_id = sr.tenant_id
      LEFT JOIN users u3 ON sr.hr_signed_by = u3.uid AND u3.tenant_id = sr.tenant_id
      LEFT JOIN users u4 ON sr.admin_signed_by = u4.uid AND u4.tenant_id = sr.tenant_id
      LEFT JOIN users u5 ON sr.rejected_by = u5.uid AND u5.tenant_id = sr.tenant_id
      LEFT JOIN salary_revision_activation_jobs activation
        ON activation.tenant_id = sr.tenant_id AND activation.revision_id = sr.id
      LEFT JOIN salary_revision_activation_events activation_event
        ON activation_event.tenant_id = sr.tenant_id
       AND activation_event.revision_id = sr.id
       AND activation_event.event_type = 'salary_revision_activated'
      ${where}
      ORDER BY sr.created_at DESC
      LIMIT $${idx}
    `, ...params));

    success(res, revisions, 'Revisions fetched');
  } catch (err) {
    logger.error('Get Revisions Error:', err);
    error(res, 'Failed to fetch revisions', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ─── Annual review reminders ─────────────────────────────────────────────────
export const getAnnualReviewStatus = async (req, res) => {
  try {
    const year = new Date().getFullYear();
    // CAN-016: scope the annual-review enumeration to the caller's tenant.
    const tenantId = resolveTenantOrThrow(req);

    const dueForReview = await setTenant(tenantId, tx => tx.$queryRawUnsafe(`
      SELECT u.uid, u.name, COALESCE(s.department, ss.department) as department, u.role,
             ss.basic_salary, ss.date_of_joining,
             EXTRACT(YEAR FROM AGE(CURRENT_DATE, ss.date_of_joining::date)) as years_of_service,
             arr.status as review_status, arr.id as reminder_id,
             (
               SELECT revision_number FROM salary_revisions
               WHERE staff_uid = u.uid
                 AND tenant_id = $2::uuid
                 AND tenant_reconciliation_required = false
                 AND EXTRACT(YEAR FROM created_at) = $1
                 AND status IN ('approved','applied')
               ORDER BY created_at DESC LIMIT 1
             ) as revision_this_year
      FROM staff_salary ss
      JOIN users u ON ss.staff_uid = u.uid AND u.tenant_id = ss.tenant_id
      LEFT JOIN staff s ON s.user_id = u.uid AND s.tenant_id = ss.tenant_id
      LEFT JOIN annual_review_reminders arr
        ON arr.staff_uid = u.uid
       AND arr.tenant_id = ss.tenant_id
       AND arr.tenant_reconciliation_required = false
       AND arr.review_year = $1
       AND (
         arr.revision_id IS NULL
         OR EXISTS (
           SELECT 1
             FROM salary_revisions linked_revision
            WHERE linked_revision.id = arr.revision_id
              AND linked_revision.tenant_id = arr.tenant_id
              AND linked_revision.staff_uid = arr.staff_uid
              AND linked_revision.tenant_reconciliation_required = false
         )
       )
      WHERE ss.is_active = true
        AND ss.date_of_joining IS NOT NULL
        AND ss.date_of_joining::date <= CURRENT_DATE - INTERVAL '11 months'
        AND ss.tenant_id = $2::uuid
      ORDER BY ss.date_of_joining ASC
    `, year, tenantId));

    success(res, { year, staff: dueForReview }, 'Annual review status fetched');
  } catch (err) {
    logger.error('Annual Review Status Error:', err);
    error(res, 'Failed to fetch annual review status', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ─── Get single revision detail ───────────────────────────────────────────────
export const getRevisionDetail = async (req, res) => {
  try {
    const { id } = req.params;
    const revisionId = Number.parseInt(id, 10);
    const tenantId = resolveTenantOrThrow(req);

    if (!Number.isInteger(revisionId) || revisionId <= 0) {
      return error(res, 'Invalid revision id', HTTP_STATUS.BAD_REQUEST);
    }

    const result = await setTenant(tenantId, tx => tx.$queryRawUnsafe(`
      SELECT sr.id, sr.staff_uid, sr.revision_type, sr.current_basic, sr.proposed_basic, sr.current_gross, sr.proposed_gross,
             sr.effective_from, sr.status, sr.reason, sr.created_at,
             u.name as staff_name, COALESCE(s.department, ss.department) as department,
             u2.name as proposed_by_name,
             u3.name as hr_signed_by_name,
             u4.name as admin_signed_by_name,
             activation.status AS activation_status,
             activation.attempt_count AS activation_attempt_count,
             activation.next_attempt_at AS activation_next_attempt_at,
             activation.outcome AS activation_outcome,
             activation_event.source_type AS activation_source_type,
             activation_event.created_at AS activation_event_created_at
      FROM salary_revisions sr
      JOIN users u ON sr.staff_uid = u.uid AND u.tenant_id = sr.tenant_id
      LEFT JOIN staff s ON s.user_id = u.uid AND s.tenant_id = sr.tenant_id
      LEFT JOIN staff_salary ss ON ss.staff_uid = u.uid AND ss.tenant_id = sr.tenant_id
      LEFT JOIN users u2 ON sr.proposed_by = u2.uid AND u2.tenant_id = sr.tenant_id
      LEFT JOIN users u3 ON sr.hr_signed_by = u3.uid AND u3.tenant_id = sr.tenant_id
      LEFT JOIN users u4 ON sr.admin_signed_by = u4.uid AND u4.tenant_id = sr.tenant_id
      LEFT JOIN salary_revision_activation_jobs activation
        ON activation.tenant_id = sr.tenant_id AND activation.revision_id = sr.id
      LEFT JOIN salary_revision_activation_events activation_event
        ON activation_event.tenant_id = sr.tenant_id
       AND activation_event.revision_id = sr.id
       AND activation_event.event_type = 'salary_revision_activated'
      WHERE sr.id = $1::int
        AND sr.tenant_id = $2::uuid
        AND sr.tenant_reconciliation_required = false
    `, revisionId, tenantId));

    if (result.length === 0) return error(res, 'Revision not found', HTTP_STATUS.NOT_FOUND);
    success(res, result[0], 'Revision detail fetched');
  } catch (err) {
    logger.error('Get Revision Detail Error:', err);
    error(res, 'Failed to fetch revision detail', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const getPayrollReconciliationWorklist = async (req, res) => {
  try {
    const items = await listPayrollReconciliationWorklist({ actorUid: req.user?.uid });
    success(res, { items, open_count: items.length }, 'Payroll reconciliation worklist fetched');
  } catch (err) {
    logger.error('Payroll Reconciliation Worklist Error:', err);
    error(
      res,
      err instanceof SalaryRevisionReconciliationError
        ? err.message
        : 'Failed to fetch payroll reconciliation worklist',
      err instanceof SalaryRevisionReconciliationError
        ? err.statusCode
        : HTTP_STATUS.INTERNAL_SERVER_ERROR,
    );
  }
};

export const attestPayrollReconciliationItem = async (req, res) => {
  try {
    const target = `${req.params.entityType}:${req.params.entityId}`;
    const command = salaryRevisionCommandFromRequest(
      req,
      'payroll_reconciliation_attest',
      target,
    );
    const result = await attestPayrollReconciliation({
      actorUid: req.user?.uid,
      entityType: req.params.entityType,
      entityId: req.params.entityId,
      action: req.body?.action,
      evidence: req.body?.evidence,
      command,
    });
    success(
      res,
      result,
      'Payroll reconciliation attestation recorded — awaiting separate SUPER_ADMIN',
    );
  } catch (err) {
    logger.error('Payroll Reconciliation Attestation Error:', err);
    error(
      res,
      err instanceof SalaryRevisionReconciliationError || err instanceof SalaryRevisionCommandError
        ? err.message
        : 'Failed to attest payroll reconciliation item',
      err instanceof SalaryRevisionReconciliationError || err instanceof SalaryRevisionCommandError
        ? err.statusCode
        : HTTP_STATUS.INTERNAL_SERVER_ERROR,
    );
  }
};

export const resolvePayrollReconciliationItem = async (req, res) => {
  try {
    const target = `${req.params.entityType}:${req.params.entityId}`;
    const command = salaryRevisionCommandFromRequest(
      req,
      'payroll_reconciliation_resolve',
      target,
    );
    const result = await resolvePayrollReconciliation({
      actorUid: req.user?.uid,
      entityType: req.params.entityType,
      entityId: req.params.entityId,
      evidence: req.body?.evidence,
      command,
    });
    success(res, result, 'Payroll reconciliation item resolved');
  } catch (err) {
    logger.error('Payroll Reconciliation Resolution Error:', err);
    error(
      res,
      err instanceof SalaryRevisionReconciliationError || err instanceof SalaryRevisionCommandError
        ? err.message
        : 'Failed to resolve payroll reconciliation item',
      err instanceof SalaryRevisionReconciliationError || err instanceof SalaryRevisionCommandError
        ? err.statusCode
        : HTTP_STATUS.INTERNAL_SERVER_ERROR,
    );
  }
};
