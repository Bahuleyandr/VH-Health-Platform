import { AppError } from '../../utils/AppError.js';
import {
  validateIsolationSettingRevision,
  validateProtocol,
  validateProtocolDeviceScope,
} from './reprocessableDeviceRules.js';

const PROTOCOL_APPROVER_ROLES = new Set([
  'INFECTION_CONTROL_OFFICER', 'CONSULTANT', 'ADMIN', 'SUPER_ADMIN',
]);
const ISOLATION_APPLICATOR_ROLES = new Set([
  'INFECTION_CONTROL_OFFICER', 'ADMIN', 'SUPER_ADMIN',
]);

function first(rows) {
  return Array.isArray(rows) ? rows[0] : rows;
}

function positiveId(value, label) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text) || Number(text) < 1 || !Number.isSafeInteger(Number(text))) {
    throw AppError.badRequest(`${label} must be a positive integer`, 'RPD_BAD_ID');
  }
  return Number(text);
}

function clinicalNotes(input, protocol) {
  if (!protocol.hcv_protocol) return input.notes ?? null;
  return JSON.stringify({
    narrative: input.notes ?? null,
    hcv_protocol: protocol.hcv_protocol,
    hcv_rna_representation_version: 1,
  });
}

function hydrateProtocolDefinition(protocol) {
  if (!protocol || protocol.reuse_matrix?.hcv !== 'dedicated_reuse') return protocol;
  if (protocol.hcv_protocol) return protocol;
  try {
    const envelope = JSON.parse(protocol.notes);
    return { ...protocol, hcv_protocol: envelope.hcv_protocol };
  } catch {
    return protocol;
  }
}

export async function createProtocolRevisionTx(tx, { tenantId, input }) {
  const protocol = validateProtocol(input);
  if (!PROTOCOL_APPROVER_ROLES.has(input.approved_role)) {
    throw AppError.forbidden('Role cannot approve a reprocessing protocol',
      'RPD_PROTOCOL_APPROVER_FORBIDDEN');
  }
  const previousRows = await tx.$queryRawUnsafe(
    `SELECT id, revision
       FROM reprocessing_protocols
      WHERE tenant_id = $1::uuid
        AND protocol_key = $2::uuid
      ORDER BY revision DESC
      LIMIT 1
      FOR UPDATE`,
    tenantId,
    input.protocol_key,
  );
  const previous = first(previousRows);
  const suppliedPredecessor = input.supersedes_protocol_id == null
    ? null
    : positiveId(input.supersedes_protocol_id, 'supersedes_protocol_id');
  if ((previous?.id ?? null) !== suppliedPredecessor) {
    throw AppError.conflict(
      'Protocol revision must supersede the current immutable revision',
      'RPD_PROTOCOL_REVISION_CONFLICT',
      { current_protocol_id: previous?.id ?? null },
    );
  }
  const revision = Number(previous?.revision ?? 0) + 1;
  const rows = await tx.$queryRawUnsafe(
    `INSERT INTO reprocessing_protocols (
       tenant_id, protocol_key, revision, supersedes_protocol_id, domain, category,
       name, basis, reference, approved_by, approved_role, approved_at, status,
       tcv_min_pct, baseline_tcv_required, mid_life_enrolment_rule,
       residual_test_required, integrity_test_required, agents, reuse_matrix,
       surveillance_intervals_days, surveillance_overdue_blocks_reuse, prion_rule,
       notes, created_by, updated_by
     ) VALUES (
       $1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10::uuid, $11,
       $12::timestamptz, 'active', $13, $14, $15, $16, $17, $18::jsonb,
       $19::jsonb, $20::jsonb, $21, $22, $23, $24::uuid, $24::uuid
     )
     RETURNING *`,
    tenantId,
    input.protocol_key,
    revision,
    suppliedPredecessor,
    protocol.domain,
    protocol.category,
    input.name,
    protocol.basis,
    protocol.reference,
    input.approved_by,
    input.approved_role,
    input.approved_at,
    protocol.tcv_min_pct,
    protocol.baseline_tcv_required !== false,
    protocol.mid_life_enrolment_rule ?? 'refuse',
    protocol.residual_test_required !== false,
    protocol.integrity_test_required !== false,
    JSON.stringify(protocol.agents),
    protocol.reuse_matrix == null ? null : JSON.stringify(protocol.reuse_matrix),
    JSON.stringify(protocol.surveillance_intervals_days),
    protocol.surveillance_overdue_blocks_reuse !== false,
    protocol.prion_rule ?? 'discard',
    clinicalNotes(input, protocol),
    input.created_by,
  );
  return first(rows);
}

export async function createProtocolDeviceScopeTx(tx, { tenantId, protocolId, input }) {
  const id = positiveId(protocolId, 'protocol_id');
  const protocolRows = await tx.$queryRawUnsafe(
    `SELECT *
       FROM reprocessing_protocols
      WHERE tenant_id = $1::uuid AND id = $2
      FOR SHARE`,
    tenantId,
    id,
  );
  const protocol = hydrateProtocolDefinition(first(protocolRows));
  if (!protocol) throw AppError.notFound('Reprocessing protocol not found', 'RPD_PROTOCOL_NOT_FOUND');
  const scope = validateProtocolDeviceScope(input, protocol);
  const rows = await tx.$queryRawUnsafe(
    `INSERT INTO reprocessing_protocol_device_scopes (
       tenant_id, protocol_id, category, manufacturer, model_name, ifu_reference,
       nominal_tcv_ml, single_use, approved_at, created_by
     ) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, FALSE, $8::timestamptz, $9::uuid)
     RETURNING *`,
    tenantId,
    id,
    scope.category,
    scope.manufacturer.trim(),
    scope.model_name.trim(),
    scope.ifu_reference.trim(),
    scope.nominal_tcv_ml,
    input.approved_at,
    input.created_by,
  );
  return first(rows);
}

export async function createIsolationSettingRevisionTx(tx, { tenantId, input }) {
  const previousRows = await tx.$queryRawUnsafe(
    `SELECT id, revision
       FROM reprocessing_isolation_setting_revisions
      WHERE tenant_id = $1::uuid
      ORDER BY revision DESC
      LIMIT 1
      FOR UPDATE`,
    tenantId,
  );
  const previous = first(previousRows);
  const predecessor = input.supersedes_revision_id == null
    ? null
    : positiveId(input.supersedes_revision_id, 'supersedes_revision_id');
  if ((previous?.id ?? null) !== predecessor) {
    throw AppError.conflict(
      'Isolation setting revision must supersede the current immutable revision',
      'RPD_ISOLATION_REVISION_CONFLICT',
      { current_revision_id: previous?.id ?? null },
    );
  }
  const revisionNumber = Number(previous?.revision ?? 0) + 1;
  const revision = validateIsolationSettingRevision({ ...input, revision: revisionNumber });
  const rows = await tx.$queryRawUnsafe(
    `INSERT INTO reprocessing_isolation_setting_revisions (
       tenant_id, revision, supersedes_revision_id, approved_isolation_groups,
       isolation_groups, vocabulary_approved_by, vocabulary_approved_role,
       vocabulary_approved_at, mapping_approved_by, mapping_approved_role,
       mapping_approved_at, created_by
     ) VALUES (
       $1::uuid, $2, $3, $4::text[], $5::jsonb, $6::uuid, $7, $8::timestamptz,
       $9::uuid, $10, $11::timestamptz, $12::uuid
     )
     RETURNING *`,
    tenantId,
    revisionNumber,
    predecessor,
    revision.approved_isolation_groups,
    JSON.stringify(revision.isolation_groups),
    revision.vocabulary_approved_by,
    revision.vocabulary_approved_role,
    revision.vocabulary_approved_at,
    revision.mapping_approved_by,
    revision.mapping_approved_role,
    revision.mapping_approved_at,
    revision.created_by,
  );
  return first(rows);
}

export async function applyIsolationSettingRevisionTx(tx, {
  tenantId,
  revisionId,
  actor,
}) {
  if (!ISOLATION_APPLICATOR_ROLES.has(actor?.role)) {
    throw AppError.forbidden(
      'Role cannot apply an isolation setting revision',
      'RPD_ISOLATION_APPLICATOR_FORBIDDEN',
    );
  }
  const id = positiveId(revisionId, 'revision_id');
  const revisionRows = await tx.$queryRawUnsafe(
    `SELECT *
       FROM reprocessing_isolation_setting_revisions
      WHERE tenant_id = $1::uuid AND id = $2
      FOR SHARE`,
    tenantId,
    id,
  );
  const revision = first(revisionRows);
  if (!revision) {
    throw AppError.notFound('Isolation setting revision not found', 'RPD_ISOLATION_REVISION_NOT_FOUND');
  }
  validateIsolationSettingRevision(revision);
  const rows = await tx.$queryRawUnsafe(
    `INSERT INTO reprocessing_domain_settings (
       tenant_id, domain, reactive_patient_rule, unknown_serology_rule,
       serology_validity_days, isolation_enforcement, isolation_revision_id,
       isolation_applied_by, isolation_applied_role, isolation_applied_at,
       updated_by
     ) VALUES ($1::uuid, 'dialysis', 'discard', 'warn', 90, 'warn', $2,
       $3::uuid, $4, clock_timestamp(), $3::uuid)
     ON CONFLICT (tenant_id, domain) DO UPDATE SET
       isolation_revision_id = EXCLUDED.isolation_revision_id,
       isolation_applied_by = EXCLUDED.isolation_applied_by,
       isolation_applied_role = EXCLUDED.isolation_applied_role,
       isolation_applied_at = EXCLUDED.isolation_applied_at,
       updated_by = EXCLUDED.updated_by,
       updated_at = clock_timestamp()
     RETURNING *`,
    tenantId,
    id,
    actor.uid,
    actor.role,
  );
  return first(rows);
}

export const _internal = Object.freeze({ clinicalNotes, hydrateProtocolDefinition, positiveId });
