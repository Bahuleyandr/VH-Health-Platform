import { createHash, randomUUID } from 'node:crypto';
import { setTenantTx, isTenantTransactionClient } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { recordClinicalAuditEvent } from './canonicalClinicalPlatformService.js';
import { signDocumentTx, verifyDocumentSignatureTx } from './documentIntegrityService.js';

const SCHEMA = 'cath-nnn-dispositions/v2';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const DISPOSITIONS = Object.freeze({
  RUNNING_WITHOUT_RECORDED_START: ['CONFIRMED_NEVER_STARTED', 'CONFIRMED_ACTIVE_NOW'],
  RUNNING_WITH_END: ['CONFIRMED_TERMINAL', 'CONFIRMED_ERRONEOUS_END'],
  PRESTART_WITH_FIRST_START: ['EVIDENCED_HISTORICAL_REOPEN', 'CONFIRMED_ERRONEOUS_START'],
  END_WITHOUT_START_OR_BEFORE_START: ['EVIDENCED_CORRECTION'],
  TERMINAL_WITHOUT_END: ['EVIDENCED_CORRECTION'],
  ORPHAN_PROCEDURE_LOG: ['EVIDENCED_RELINK', 'APPROVED_QUARANTINE'],
  LEGACY_CONSENT_WITHOUT_STRUCTURE: ['PRESERVE_UNKNOWN', 'CONFIRMED_APPLICABLE'],
});

function invalid() {
  return AppError.badRequest('Complete resolved disposition material is required', 'CATH_MIGRATION_MATERIAL_INVALID');
}

export function validateCathDispositionMaterial(input) {
  if (!input || input.schema !== SCHEMA || !Array.isArray(input.rows) || input.rows.length > 1000) throw invalid();
  const seen = new Set();
  for (const row of input.rows) {
    if (!row || !UUID.test(row.tenant_id) || typeof row.case_id !== 'string'
      || !/^[1-9][0-9]*$/.test(row.case_id) || BigInt(row.case_id) > 9223372036854775807n
      || !HASH.test(row.source_sha256) || !Object.hasOwn(DISPOSITIONS, row.issue_class)
      || !DISPOSITIONS[row.issue_class].includes(row.disposition)
      || !row.decision_material || typeof row.decision_material !== 'object' || Array.isArray(row.decision_material)
      || !row.evidence_reference || typeof row.evidence_reference !== 'string'
      || !row.evidence_reference.trim()) throw invalid();
    const key = `${row.tenant_id.toLowerCase()}:${row.case_id}:${row.issue_class}`;
    if (seen.has(key)) throw invalid();
    seen.add(key);
    if (row.disposition === 'EVIDENCED_HISTORICAL_REOPEN') {
      if (!Number.isInteger(row.target_attempt) || row.target_attempt < 2 || row.target_attempt > 2147483647
        || !row.log_identities || typeof row.log_identities !== 'object' || Array.isArray(row.log_identities)) throw invalid();
      for (const [id, identity] of Object.entries(row.log_identities)) {
        if (!/^[1-9][0-9]*$/.test(id) || !identity || !Number.isInteger(identity.procedure_attempt)
          || identity.procedure_attempt < 1 || identity.procedure_attempt >= row.target_attempt
          || !UUID.test(identity.lifecycle_token) || identity.identity_source !== 'evidenced_historical') throw invalid();
      }
    }
  }
  return { schema: SCHEMA, rows: input.rows };
}

async function canonicalMaterialTx(tx, material) {
  const [row] = await tx.$queryRawUnsafe('SELECT $1::jsonb::text AS canonical_text', JSON.stringify(material));
  return createHash('sha256').update(row.canonical_text, 'utf8').digest('hex');
}

async function requirePlatformAuthorityTx(tx, actorUid, tenantIds) {
  const admins = await tx.$queryRawUnsafe(
    `SELECT uid FROM admins WHERE uid = $1::uuid AND tenant_id IS NULL
       AND role = 'SUPER_ADMIN' AND is_active = TRUE AND status = 'active'
       AND totp_enabled = TRUE FOR SHARE`, actorUid,
  );
  if (admins.length !== 1) throw AppError.forbidden('Active platform authority is required', 'CATH_MIGRATION_PLATFORM_AUTHORITY_REQUIRED');
  const tenants = await tx.$queryRawUnsafe(
    `SELECT id FROM tenants WHERE id = ANY($1::uuid[]) AND status = 'active' ORDER BY id FOR SHARE`, tenantIds,
  );
  if (tenants.length !== tenantIds.length) throw AppError.forbidden('Every manifest tenant must be active and in scope', 'CATH_MIGRATION_TENANT_AUTHORITY_REQUIRED');
}

export async function approveCathMigrationDispositions(input, context) {
  if (!context || context.actorRole !== 'SUPER_ADMIN' || context.mfa !== true || !UUID.test(context.actorUid)
    || !UUID.test(context.tenantId)) throw AppError.forbidden('Stepped-up platform authority is required', 'CATH_MIGRATION_PLATFORM_AUTHORITY_REQUIRED');
  const material = validateCathDispositionMaterial(input);
  const tenantIds = [...new Set([context.tenantId, ...material.rows.map((row) => row.tenant_id.toLowerCase())])].sort();
  return setTenantTx(context.tenantId, async (tx) => {
    await requirePlatformAuthorityTx(tx, context.actorUid, tenantIds);
    const signatureId = randomUUID();
    const contentSha256 = await canonicalMaterialTx(tx, material);
    const audit = await recordClinicalAuditEvent({
      tenantId: context.tenantId,
      action: 'cath_lab.migration_dispositions.approved',
      actionStatus: 'success',
      actorUid: context.actorUid,
      actorRole: 'SUPER_ADMIN',
      resourceType: 'cath_migration_approval',
      resourceTable: 'cath_migration_dispositions',
      resourceId: signatureId,
      requestId: context.requestId,
      afterState: material,
      metadata: { authority: 'active_platform_super_admin', tenant_ids: tenantIds, content_sha256: contentSha256 },
      idempotencyKey: `cath_migration_approval:${signatureId}`,
    }, { db: tx });
    if (!audit?.id || !audit.chain_hash) throw AppError.internal('Approval audit was not persisted', 'CATH_MIGRATION_AUDIT_REQUIRED');
    const signature = await signDocumentTx({
      documentType: 'cath_migration_approval',
      documentId: audit.id,
      signatureId,
      canonicalAuditEventId: audit.id,
      canonicalAuditResourceTable: 'cath_migration_dispositions',
      canonicalAuditResourceId: signatureId,
      statement: 'Approve only the exact migration disposition material; no clinical policy activation.',
    }, { actorUid: context.actorUid, actorRole: 'SUPER_ADMIN' }, { tx });
    if (signature.content_hash !== contentSha256) throw AppError.internal('Approval hash mismatch', 'CATH_MIGRATION_SIGNATURE_REQUIRED');
    const envelope = { ...material, approval_event_id: audit.id, content_sha256: contentSha256 };
    await verifyCathMigrationApprovalTx(tx, envelope, context.tenantId);
    return envelope;
  });
}

// This verifies signed approval only. PR 5 must additionally recompute the
// complete issue population and current source hashes under cutover locks.
export async function verifyCathMigrationApprovalTx(tx, envelope, tenantId) {
  if (!isTenantTransactionClient(tx)) throw AppError.internal('Tenant transaction required', 'SIGN_TENANT_TX_REQUIRED');
  const material = validateCathDispositionMaterial(envelope);
  if (!UUID.test(envelope.approval_event_id) || !HASH.test(envelope.content_sha256)
    || envelope.content_sha256 !== await canonicalMaterialTx(tx, material)) throw invalid();
  const rows = await tx.$queryRawUnsafe(
    `SELECT s.id FROM clinical_audit_events a
       JOIN clinical_document_signatures s ON s.audit_event_id = a.id AND s.tenant_id = a.tenant_id
      WHERE a.id = $1::uuid AND a.tenant_id = $2::uuid
        AND a.action = 'cath_lab.migration_dispositions.approved' AND a.action_status = 'success'
        AND a.actor_role = 'SUPER_ADMIN' AND a.actor_uid IS NOT NULL AND a.chain_hash IS NOT NULL
        AND a.chain_hash = audit_chain_hash(a.prev_hash, a.id, a.tenant_id, a.action, a.resource_table,
          a.resource_id, a.actor_uid, a.occurred_at, a.before_state, a.after_state)
        AND a.after_state = $3::jsonb AND a.resource_table = 'cath_migration_dispositions'
        AND a.resource_id = s.id::text AND s.document_id = a.id::text
        AND s.document_table = 'clinical_audit_events' AND s.document_type = 'cath_migration_approval'
        AND s.signer_uid = a.actor_uid AND s.signer_role = 'SUPER_ADMIN'
        AND s.signature_method = 'electronic_attestation' AND s.content_hash = $4::text`,
    envelope.approval_event_id, tenantId, JSON.stringify(material), envelope.content_sha256,
  );
  if (rows.length !== 1) throw AppError.forbidden('Persisted governed approval is required', 'CATH_MIGRATION_APPROVAL_REQUIRED');
  const verified = await verifyDocumentSignatureTx(rows[0].id, { tx });
  if (!verified.intact || verified.signed_hash !== envelope.content_sha256) throw AppError.forbidden('Approval signature is invalid', 'CATH_MIGRATION_SIGNATURE_REQUIRED');
  return { approval_event_id: envelope.approval_event_id, signature_id: rows[0].id, content_sha256: verified.signed_hash };
}
