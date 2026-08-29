import crypto from 'node:crypto';
import { setTenant } from '../../lib/prisma.js';
import {
  findSalaryRevisionCommandReplayTx,
  finaliseSalaryRevisionCommandTx,
} from './salaryRevisionCommandService.js';

const ENTITY_SOURCES = Object.freeze({
  salary_revision: {
    table: 'salary_revisions',
    predicate: 'tenant_reconciliation_required = true',
  },
  salary_arrears: {
    table: 'salary_arrears',
    predicate: 'tenant_reconciliation_required = true',
  },
  annual_review_reminder: {
    table: 'annual_review_reminders',
    predicate: 'tenant_reconciliation_required = true',
  },
  bulk_revision_job: {
    table: 'bulk_revision_jobs',
    predicate: "tenant_reconciliation_required = true OR status = 'reconciliation_required'",
  },
  bulk_revision_item: {
    table: 'bulk_revision_job_items',
    predicate: "status = 'reconciliation_required'",
  },
  salary_revision_activation: {
    table: 'salary_revision_activation_jobs',
    predicate: "status = 'reconciliation_required'",
  },
  salary_revision_arrears_work: {
    table: 'salary_revision_arrears_work_items',
    predicate: "status = 'reconciliation_required'",
  },
});

const RETRYABLE_ENTITY_TYPES = new Set([
  'bulk_revision_item',
  'salary_revision_activation',
  'salary_revision_arrears_work',
]);
const INACTIVE_TENANT_REASON = 'tenant_inactive';
const INACTIVE_TENANT_MESSAGE = 'Tenant is not active; payroll work parked for governed reconciliation';
const INACTIVE_TENANT_ERROR_SHA256 = crypto.createHash('sha256')
  .update(INACTIVE_TENANT_MESSAGE)
  .digest('hex');

export class SalaryRevisionReconciliationError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'SalaryRevisionReconciliationError';
    this.statusCode = statusCode;
  }
}

function requireEvidence(evidence, label) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)
      || Object.keys(evidence).length === 0) {
    throw new SalaryRevisionReconciliationError(`${label} evidence is required`);
  }
  return evidence;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map(key => [key, canonicalJson(value[key])]),
    );
  }
  return value;
}

function digestJson(value) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(canonicalJson(value)))
    .digest('hex');
}

function iso(value) {
  return value == null ? null : new Date(value).toISOString();
}

function attestationHash(row) {
  return digestJson({
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    observed_tenant_id: row.observed_tenant_id ?? null,
    resolution_generation: Number(row.resolution_generation),
    action: row.action,
    original_evidence_sha256: row.original_evidence_sha256,
    hr_evidence: row.hr_evidence,
    hr_request_sha256: row.hr_request_sha256,
    hr_attested_by: row.hr_attested_by,
    hr_attested_at: iso(row.hr_attested_at),
    hr_actor_role: row.hr_actor_role,
    hr_authority_checked_at: iso(row.hr_authority_checked_at),
    hr_authority_source: row.hr_authority_source,
  });
}

function resolutionHash(row) {
  return digestJson({
    hr_attestation_sha256: row.hr_attestation_sha256,
    action: row.action,
    admin_evidence: row.admin_evidence,
    admin_request_sha256: row.admin_request_sha256,
    admin_resolved_by: row.admin_resolved_by,
    admin_resolved_at: iso(row.admin_resolved_at),
    admin_actor_role: row.admin_actor_role,
    admin_authority_checked_at: iso(row.admin_authority_checked_at),
    admin_authority_source: row.admin_authority_source,
  });
}

async function assertActiveSuperAdminTx(tx, actorUid) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT tenant_id, UPPER(role) AS role,
            clock_timestamp() AS authority_checked_at
       FROM users
      WHERE uid = $1::uuid
        AND is_active = true
        AND COALESCE(is_deleted, false) = false
        AND deleted_at IS NULL
        AND merged_into_uid IS NULL
        AND LOWER(COALESCE(status, 'active')) = 'active'
        AND UPPER(role) = 'SUPER_ADMIN'
      FOR SHARE`,
    actorUid,
  );
  if (rows.length !== 1) {
    throw new SalaryRevisionReconciliationError(
      'An active canonical SUPER_ADMIN identity is required',
      403,
    );
  }
  return rows[0];
}

async function loadEntityEvidenceTx(tx, entityType, entityId, { lock = false } = {}) {
  const source = ENTITY_SOURCES[entityType];
  if (!source || !/^\d+$/.test(String(entityId))) {
    throw new SalaryRevisionReconciliationError('Unsupported payroll reconciliation identity');
  }
  const rows = await tx.$queryRawUnsafe(
    `SELECT id::text AS entity_id, tenant_id AS observed_tenant_id,
            to_jsonb(source_row) AS original_evidence
       FROM ${source.table} source_row
      WHERE id = $1::bigint
        AND (${source.predicate})
      ${lock ? 'FOR UPDATE' : ''}`,
    String(entityId),
  );
  if (rows.length !== 1) {
    throw new SalaryRevisionReconciliationError(
      'Payroll reconciliation item is not open',
      404,
    );
  }
  return rows[0];
}

async function parkInactiveTenantTx(tenantId) {
  return setTenant(tenantId, async (tx) => {
    const tenants = await tx.$queryRawUnsafe(
      `SELECT id, LOWER(COALESCE(status, '')) AS status,
              clock_timestamp() AS parked_at
         FROM tenants
        WHERE id = $1::uuid
          AND LOWER(COALESCE(status, '')) <> 'active'
        FOR SHARE`,
      tenantId,
    );
    if (tenants.length !== 1) {
      return {
        tenant_id: tenantId,
        tenant_status: 'active',
        activation_jobs: 0,
        arrears_work_items: 0,
        bulk_jobs: 0,
        bulk_items: 0,
      };
    }
    const tenant = tenants[0];
    const bulkItems = await tx.$queryRawUnsafe(
      `UPDATE bulk_revision_job_items item
          SET status = 'reconciliation_required',
              claim_token = NULL, claimed_at = NULL, lease_expires_at = NULL,
              last_error = $3,
              outcome = jsonb_build_object(
                'code', 'bulk_revision_staff_failed',
                'reason', $4::text,
                'message', $3::text,
                'attempt_count', item.attempt_count,
                'tenant_status', $2::text
              ),
              finalized_at = $5::timestamptz,
              updated_at = $5::timestamptz
        WHERE item.tenant_id = $1::uuid
          AND item.status IN ('pending', 'processing')
          AND EXISTS (
            SELECT 1
              FROM bulk_revision_jobs job
             WHERE job.tenant_id = item.tenant_id
               AND job.id = item.job_id
               AND job.status IN ('queued', 'processing', 'reconciliation_required')
          )
        RETURNING item.id`,
      tenantId,
      tenant.status,
      INACTIVE_TENANT_MESSAGE,
      INACTIVE_TENANT_REASON,
      tenant.parked_at,
    );
    const bulkJobs = await tx.$queryRawUnsafe(
      `UPDATE bulk_revision_jobs job
          SET status = 'reconciliation_required',
              tenant_reconciliation_evidence = COALESCE(
                job.tenant_reconciliation_evidence, '{}'::jsonb
              ) || jsonb_build_object(
                'reason', $3::text,
                'tenant_status', $2::text,
                'observed_status', job.status,
                'parked_at', $4::timestamptz
              ),
              error_log = concat_ws(E'\\n', NULLIF(job.error_log, ''), $5::text),
              completed_at = NULL,
              last_processed_at = $4::timestamptz,
              updated_at = $4::timestamptz
        WHERE job.tenant_id = $1::uuid
          AND job.status IN ('queued', 'processing')
          AND job.tenant_reconciliation_required = false
        RETURNING job.id`,
      tenantId,
      tenant.status,
      INACTIVE_TENANT_REASON,
      tenant.parked_at,
      INACTIVE_TENANT_MESSAGE,
    );
    const activationJobs = await tx.$queryRawUnsafe(
      `UPDATE salary_revision_activation_jobs job
          SET status = 'reconciliation_required',
              claim_token = NULL, claimed_at = NULL, lease_expires_at = NULL,
              last_error = $3,
              outcome = jsonb_build_object(
                'code', 'salary_revision_activation_failed',
                'reason', $4::text,
                'message', $3::text,
                'attempt_count', job.attempt_count,
                'tenant_status', $2::text
              ),
              applied_at = NULL,
              finalized_at = $5::timestamptz,
              updated_at = $5::timestamptz
        WHERE job.tenant_id = $1::uuid
          AND job.status IN ('queued', 'processing')
        RETURNING job.id`,
      tenantId,
      tenant.status,
      INACTIVE_TENANT_MESSAGE,
      INACTIVE_TENANT_REASON,
      tenant.parked_at,
    );
    const arrearsWork = await tx.$queryRawUnsafe(
      `UPDATE salary_revision_arrears_work_items work
          SET status = 'reconciliation_required',
              claim_token = NULL, claimed_at = NULL, lease_expires_at = NULL,
              last_error_hash = $3::char(64),
              outcome = jsonb_build_object(
                'code', 'arrears_reconciliation_required',
                'reason', $4::text,
                'attempt_count', work.attempt_count,
                'error_sha256', $3::text,
                'tenant_status', $2::text
              ),
              completed_at = $5::timestamptz,
              updated_at = $5::timestamptz
        WHERE work.tenant_id = $1::uuid
          AND work.status IN ('pending', 'processing')
        RETURNING work.id`,
      tenantId,
      tenant.status,
      INACTIVE_TENANT_ERROR_SHA256,
      INACTIVE_TENANT_REASON,
      tenant.parked_at,
    );
    return {
      tenant_id: tenantId,
      tenant_status: tenant.status,
      activation_jobs: activationJobs.length,
      arrears_work_items: arrearsWork.length,
      bulk_jobs: bulkJobs.length,
      bulk_items: bulkItems.length,
    };
  });
}

export async function parkInactiveTenantPayrollRevisionWork() {
  const tenantRows = await setTenant(null, tx => tx.$queryRawUnsafe(
    `SELECT tenant.id
       FROM tenants tenant
      WHERE LOWER(COALESCE(tenant.status, '')) <> 'active'
        AND (
          EXISTS (
            SELECT 1 FROM salary_revision_activation_jobs activation
             WHERE activation.tenant_id = tenant.id
               AND activation.status IN ('queued', 'processing')
          )
          OR EXISTS (
            SELECT 1 FROM salary_revision_arrears_work_items arrears_work
             WHERE arrears_work.tenant_id = tenant.id
               AND arrears_work.status IN ('pending', 'processing')
          )
          OR EXISTS (
            SELECT 1 FROM bulk_revision_jobs bulk_job
             WHERE bulk_job.tenant_id = tenant.id
               AND bulk_job.status IN ('queued', 'processing')
          )
          OR EXISTS (
            SELECT 1 FROM bulk_revision_job_items bulk_item
             WHERE bulk_item.tenant_id = tenant.id
               AND bulk_item.status IN ('pending', 'processing')
          )
        )
      ORDER BY tenant.id`,
  ), { superAdmin: true });
  const results = [];
  for (const tenant of tenantRows) {
    results.push(await parkInactiveTenantTx(tenant.id));
  }
  return {
    tenants_discovered: tenantRows.length,
    tenants_parked: results.filter(result => (
      result.activation_jobs + result.arrears_work_items
      + result.bulk_jobs + result.bulk_items
    ) > 0).length,
    activation_jobs: results.reduce((sum, result) => sum + result.activation_jobs, 0),
    arrears_work_items: results.reduce((sum, result) => sum + result.arrears_work_items, 0),
    bulk_jobs: results.reduce((sum, result) => sum + result.bulk_jobs, 0),
    bulk_items: results.reduce((sum, result) => sum + result.bulk_items, 0),
    results,
  };
}

export async function listPayrollReconciliationWorklist({ actorUid }) {
  return setTenant(null, async (tx) => {
    await assertActiveSuperAdminTx(tx, actorUid);
    return tx.$queryRawUnsafe(
      `WITH open_items AS (
         SELECT 'salary_revision'::text AS entity_type, id::text AS entity_id,
                tenant_id AS observed_tenant_id, status, tenant_reconciliation_reason AS reason,
                 tenant_reconciliation_evidence AS evidence, created_at,
                 id::text AS revision_id, staff_uid, effective_from::date AS effective_on,
                 NULL::timestamptz AS next_attempt_at
           FROM salary_revisions WHERE tenant_reconciliation_required = true
         UNION ALL
         SELECT 'salary_arrears', id::text, tenant_id, status,
                tenant_reconciliation_reason, tenant_reconciliation_evidence, created_at,
                 revision_id::text, staff_uid, NULL::date, NULL::timestamptz
           FROM salary_arrears WHERE tenant_reconciliation_required = true
         UNION ALL
         SELECT 'annual_review_reminder', id::text, tenant_id, status,
                tenant_reconciliation_reason, tenant_reconciliation_evidence, created_at,
                 revision_id::text, staff_uid, NULL::date, NULL::timestamptz
           FROM annual_review_reminders WHERE tenant_reconciliation_required = true
         UNION ALL
         SELECT 'bulk_revision_job', id::text, tenant_id, status,
                COALESCE(tenant_reconciliation_reason,
                         tenant_reconciliation_evidence->>'reason'),
                tenant_reconciliation_evidence, created_at,
                 NULL::text, NULL::uuid, effective_from::date, NULL::timestamptz
           FROM bulk_revision_jobs
          WHERE tenant_reconciliation_required = true OR status = 'reconciliation_required'
         UNION ALL
         SELECT 'bulk_revision_item', item.id::text, item.tenant_id, item.status,
                item.outcome->>'code', item.outcome,
                 item.created_at, item.revision_id::text, item.staff_uid, NULL::date,
                 NULL::timestamptz
           FROM bulk_revision_job_items item WHERE item.status = 'reconciliation_required'
         UNION ALL
         SELECT 'salary_revision_activation', job.id::text, job.tenant_id, job.status,
                COALESCE(job.outcome->>'reason', job.outcome->>'code'),
                job.outcome, job.created_at, job.revision_id::text,
                revision.staff_uid, job.effective_on, NULL::timestamptz
           FROM salary_revision_activation_jobs job
           JOIN salary_revisions revision
             ON revision.tenant_id = job.tenant_id AND revision.id = job.revision_id
          WHERE job.status = 'reconciliation_required'
         UNION ALL
         SELECT 'salary_revision_arrears_work', work.id::text, work.tenant_id, work.status,
                COALESCE(work.outcome->>'reason', work.outcome->>'code'),
                work.outcome, work.created_at, work.revision_id::text,
                work.staff_uid, work.effective_on, work.next_attempt_at
           FROM salary_revision_arrears_work_items work
          WHERE work.status = 'reconciliation_required'
       )
       SELECT item.*,
              CASE WHEN item.entity_type IN (
                     'bulk_revision_item', 'salary_revision_activation',
                     'salary_revision_arrears_work'
                   ) THEN ARRAY['exclude', 'retry']::text[]
                   ELSE ARRAY['exclude']::text[] END AS allowed_actions,
              pending.id AS pending_resolution_id,
              pending.action AS pending_resolution_action,
              pending.hr_attested_by,
              pending.hr_attested_at
         FROM open_items item
         LEFT JOIN payroll_reconciliation_resolutions pending
           ON pending.entity_type = item.entity_type
          AND pending.entity_id = item.entity_id
          AND pending.status = 'pending_admin'
        WHERE NOT EXISTS (
             SELECT 1 FROM payroll_reconciliation_resolutions resolved
              WHERE resolved.entity_type = item.entity_type
                AND resolved.entity_id = item.entity_id
                AND resolved.status = 'resolved'
                AND resolved.action = 'exclude'
           )
        ORDER BY item.created_at, item.entity_type, item.entity_id`,
    );
  }, { superAdmin: true });
}

export async function attestPayrollReconciliation({
  actorUid,
  entityType,
  entityId,
  action,
  evidence,
  command,
}) {
  if (!['exclude', 'retry'].includes(action)) {
    throw new SalaryRevisionReconciliationError('action must be exclude or retry');
  }
  if (action === 'retry' && !RETRYABLE_ENTITY_TYPES.has(entityType)) {
    throw new SalaryRevisionReconciliationError(
      'This evidence cannot authorize reconstruction; exclusion is required',
      409,
    );
  }
  requireEvidence(evidence, 'SUPER_ADMIN attestation');
  return setTenant(null, async (tx) => {
    const authority = await assertActiveSuperAdminTx(tx, actorUid);
    const replay = await findSalaryRevisionCommandReplayTx(tx, authority.tenant_id, command);
    if (replay) return replay.responseData;
    const entity = await loadEntityEvidenceTx(tx, entityType, entityId, { lock: true });
    const pending = await tx.$queryRawUnsafe(
      `SELECT id FROM payroll_reconciliation_resolutions
        WHERE entity_type = $1 AND entity_id = $2 AND status = 'pending_admin'
        FOR UPDATE`,
      entityType,
      String(entityId),
    );
    if (pending.length > 0) {
      throw new SalaryRevisionReconciliationError(
        'This reconciliation item already awaits a separate SUPER_ADMIN',
        409,
      );
    }
    const generation = Number((await tx.$queryRawUnsafe(
      `SELECT COALESCE(MAX(resolution_generation), 0) + 1 AS generation
         FROM payroll_reconciliation_resolutions
        WHERE entity_type = $1 AND entity_id = $2`,
      entityType,
      String(entityId),
    ))[0].generation);
    const originalEvidenceSha256 = digestJson(entity.original_evidence);
    const row = {
      entity_type: entityType,
      entity_id: String(entityId),
      observed_tenant_id: entity.observed_tenant_id,
      resolution_generation: generation,
      action,
      original_evidence_sha256: originalEvidenceSha256,
      hr_evidence: evidence,
      hr_request_sha256: command.requestBodySha256,
      hr_attested_by: actorUid,
      hr_attested_at: authority.authority_checked_at,
      hr_actor_role: authority.role,
      hr_authority_checked_at: authority.authority_checked_at,
      hr_authority_source: 'users_active_row',
    };
    const hash = attestationHash(row);
    const inserted = await tx.$queryRawUnsafe(
      `INSERT INTO payroll_reconciliation_resolutions (
         entity_type, entity_id, observed_tenant_id, resolution_generation,
         action, original_evidence, original_evidence_sha256,
         hr_evidence, hr_request_sha256, hr_attested_by, hr_attested_at,
         hr_actor_role, hr_authority_checked_at, hr_authority_source,
         hr_attestation_sha256
       ) VALUES (
         $1, $2, $3::uuid, $4::int, $5, $6::jsonb, $7::char(64),
         $8::jsonb, $9::char(64), $10::uuid, $11::timestamptz,
         'SUPER_ADMIN', $11::timestamptz, 'users_active_row', $12::char(64)
       )
       RETURNING id, entity_type, entity_id, action, status,
                 resolution_generation, hr_attested_by, hr_attested_at`,
      entityType,
      String(entityId),
      entity.observed_tenant_id,
      generation,
      action,
      JSON.stringify(entity.original_evidence),
      originalEvidenceSha256,
      JSON.stringify(evidence),
      command.requestBodySha256,
      actorUid,
      authority.authority_checked_at,
      hash,
    );
    const committed = await finaliseSalaryRevisionCommandTx(tx, {
      tenantId: authority.tenant_id,
      command,
      responseData: inserted[0],
      message: 'Payroll reconciliation attestation recorded — awaiting separate SUPER_ADMIN',
    });
    return committed.responseData;
  }, { superAdmin: true });
}

async function applyRetryTx(tx, row) {
  const activeTenants = await tx.$queryRawUnsafe(
    `SELECT id FROM tenants
      WHERE id = $1::uuid AND LOWER(COALESCE(status, '')) = 'active'
      FOR SHARE`,
    row.observed_tenant_id,
  );
  if (activeTenants.length !== 1) {
    throw new SalaryRevisionReconciliationError(
      'The tenant must be active before parked payroll work can be retried',
      409,
    );
  }
  if (row.entity_type === 'salary_revision_activation') {
    const updated = await tx.$queryRawUnsafe(
      `UPDATE salary_revision_activation_jobs
          SET status = 'queued', attempt_count = 0, next_attempt_at = clock_timestamp(),
              claim_token = NULL, claimed_at = NULL, lease_expires_at = NULL,
              last_error = NULL, outcome = '{}'::jsonb, applied_at = NULL,
              finalized_at = NULL, updated_at = clock_timestamp()
        WHERE id = $1::bigint AND status = 'reconciliation_required'
        RETURNING id`,
      row.entity_id,
    );
    if (updated.length !== 1) throw new SalaryRevisionReconciliationError('Activation retry transition was lost', 409);
    return;
  }
  if (row.entity_type === 'salary_revision_arrears_work') {
    const updated = await tx.$queryRawUnsafe(
      `UPDATE salary_revision_arrears_work_items
          SET status = 'pending', arrears_id = NULL, outcome = '{}'::jsonb,
              attempt_count = 0, next_attempt_at = clock_timestamp(),
              claim_token = NULL, claimed_at = NULL, lease_expires_at = NULL,
              last_error_hash = NULL, completed_at = NULL,
              updated_at = clock_timestamp()
        WHERE id = $1::bigint AND status = 'reconciliation_required'
        RETURNING id`,
      row.entity_id,
    );
    if (updated.length !== 1) throw new SalaryRevisionReconciliationError('Arrears work retry transition was lost', 409);
    return;
  }
  if (row.entity_type === 'bulk_revision_item') {
    const items = await tx.$queryRawUnsafe(
      `UPDATE bulk_revision_job_items
          SET status = 'pending', attempt_count = 0, next_attempt_at = clock_timestamp(),
              claim_token = NULL, claimed_at = NULL, lease_expires_at = NULL,
              revision_id = NULL, salary_after = NULL, last_error = NULL,
              outcome = '{}'::jsonb, applied_at = NULL, finalized_at = NULL,
              updated_at = clock_timestamp()
        WHERE id = $1::bigint AND status = 'reconciliation_required'
        RETURNING tenant_id, job_id`,
      row.entity_id,
    );
    if (items.length !== 1) throw new SalaryRevisionReconciliationError('Bulk item retry transition was lost', 409);
    const parents = await tx.$queryRawUnsafe(
      `UPDATE bulk_revision_jobs
          SET status = 'processing', completed_at = NULL, updated_at = clock_timestamp()
        WHERE tenant_id = $1::uuid AND id = $2::int
          AND status = 'reconciliation_required'
        RETURNING id`,
      items[0].tenant_id,
      items[0].job_id,
    );
    if (parents.length !== 1) {
      throw new SalaryRevisionReconciliationError('Bulk parent retry transition was lost', 409);
    }
  }
}

export async function resolvePayrollReconciliation({
  actorUid,
  entityType,
  entityId,
  evidence,
  command,
}) {
  requireEvidence(evidence, 'SUPER_ADMIN resolution');
  return setTenant(null, async (tx) => {
    const authority = await assertActiveSuperAdminTx(tx, actorUid);
    const replay = await findSalaryRevisionCommandReplayTx(tx, authority.tenant_id, command);
    if (replay) return replay.responseData;
    const currentEntity = await loadEntityEvidenceTx(tx, entityType, entityId, { lock: true });
    const pendingRows = await tx.$queryRawUnsafe(
      `SELECT * FROM payroll_reconciliation_resolutions
        WHERE entity_type = $1 AND entity_id = $2 AND status = 'pending_admin'
        FOR UPDATE`,
      entityType,
      String(entityId),
    );
    const pending = pendingRows[0];
    if (!pending) throw new SalaryRevisionReconciliationError('Reconciliation attestation not found', 404);
    if (pending.hr_attested_by === actorUid) {
      throw new SalaryRevisionReconciliationError('A separate SUPER_ADMIN must resolve this item', 403);
    }
    if (attestationHash(pending) !== pending.hr_attestation_sha256) {
      throw new SalaryRevisionReconciliationError('Reconciliation attestation evidence changed', 409);
    }
    if (digestJson(currentEntity.original_evidence) !== pending.original_evidence_sha256) {
      throw new SalaryRevisionReconciliationError(
        'The locked payroll source evidence changed after attestation',
        409,
      );
    }
    const resolvedAt = authority.authority_checked_at;
    const resolution = {
      ...pending,
      admin_evidence: evidence,
      admin_request_sha256: command.requestBodySha256,
      admin_resolved_by: actorUid,
      admin_resolved_at: resolvedAt,
      admin_actor_role: authority.role,
      admin_authority_checked_at: resolvedAt,
      admin_authority_source: 'users_active_row',
    };
    const signature = resolutionHash(resolution);
    const resolved = await tx.$queryRawUnsafe(
      `UPDATE payroll_reconciliation_resolutions
          SET status = 'resolved', admin_evidence = $4::jsonb,
              admin_request_sha256 = $5::char(64), admin_resolved_by = $6::uuid,
              admin_resolved_at = $7::timestamptz, admin_actor_role = 'SUPER_ADMIN',
              admin_authority_checked_at = $7::timestamptz,
              admin_authority_source = 'users_active_row',
              admin_resolution_sha256 = $8::char(64)
        WHERE entity_type = $1 AND entity_id = $2 AND id = $3::uuid
          AND status = 'pending_admin'
        RETURNING id, entity_type, entity_id, action, status,
                  resolution_generation, admin_resolved_by, admin_resolved_at`,
      entityType,
      String(entityId),
      pending.id,
      JSON.stringify(evidence),
      command.requestBodySha256,
      actorUid,
      resolvedAt,
      signature,
    );
    if (resolved.length !== 1) {
      throw new SalaryRevisionReconciliationError('Reconciliation resolution transition was lost', 409);
    }
    if (pending.action === 'retry') await applyRetryTx(tx, pending);
    if (pending.action === 'retry') {
      const consumed = await tx.$queryRawUnsafe(
        `UPDATE payroll_reconciliation_resolutions
            SET retry_consumed_at = clock_timestamp()
          WHERE id = $1::uuid AND status = 'resolved' AND action = 'retry'
            AND retry_consumed_at IS NULL
          RETURNING retry_consumed_at`,
        pending.id,
      );
      if (consumed.length !== 1) {
        throw new SalaryRevisionReconciliationError('Payroll retry authority was already consumed', 409);
      }
    }
    const committed = await finaliseSalaryRevisionCommandTx(tx, {
      tenantId: authority.tenant_id,
      command,
      responseData: resolved[0],
      message: pending.action === 'retry'
        ? 'Payroll reconciliation evidence resolved and durable retry queued'
        : 'Payroll reconciliation evidence resolved and source row excluded',
    });
    return committed.responseData;
  }, { superAdmin: true });
}
