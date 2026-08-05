import { createHash, randomUUID } from 'node:crypto';

import prisma from '../../lib/prisma.js';
import {
  authorizeExternalRecoveryOperabilityResume,
  listExternalRecoveryOperabilityWorkbench,
  registerExternalRecoveryOperabilityOffset,
} from '../../services/downtime/externalRecoveryOperabilityService.js';
import {
  parseExternalRecoveryRegister,
  parseExternalRecoveryResume,
} from '../../validators/externalRecoveryOperabilitySchemas.js';

const adminPromises = new Map();

function identity(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function ensureAdmin(tenantId) {
  if (!adminPromises.has(tenantId)) {
    adminPromises.set(tenantId, (async () => {
      const existing = await prisma.$queryRawUnsafe(
        `SELECT uid::text, UPPER(BTRIM(role)) AS role
           FROM users
          WHERE tenant_id = $1::uuid
            AND UPPER(BTRIM(role)) IN ('ADMIN', 'SUPER_ADMIN')
            AND is_active = TRUE AND is_deleted = FALSE AND status = 'active'
          ORDER BY uid
          LIMIT 1`,
        tenantId,
      );
      if (existing[0]) return existing[0];
      const uid = randomUUID();
      const suffix = identity({ tenantId, uid }).slice(0, 16);
      const rows = await prisma.$queryRawUnsafe(
        `INSERT INTO users
           (uid, tenant_id, phone, email, name, role, is_active, status, updated_at)
         VALUES
           ($1::uuid, $2::uuid, $3::text, $4::text,
            'External recovery test administrator', 'ADMIN', TRUE, 'active', NOW())
         RETURNING uid::text, UPPER(BTRIM(role)) AS role`,
        uid,
        tenantId,
        `98${BigInt(`0x${suffix}`).toString().slice(0, 10).padStart(10, '0')}`,
        `external-recovery-${suffix}@example.test`,
      );
      return rows[0];
    })());
  }
  return adminPromises.get(tenantId);
}

export async function registerExternalRecoveryOffset(input = {}) {
  const actor = await ensureAdmin(input.tenantId);
  const parsed = parseExternalRecoveryRegister({
    facility_id: input.facilityId ?? null,
    interface_family: input.interfaceFamily || 'I10',
    subpath: input.subpath ?? null,
    protocol: input.protocol ?? null,
    stream_direction: input.streamDirection ?? null,
    source_partition: input.sourcePartition,
    generation: input.generation ?? 1,
    initial_position: input.initialPosition ?? null,
    initial_token: input.initialToken ?? null,
    retained_from_position: input.retainedFromPosition ?? null,
    retained_from_token: input.retainedFromToken ?? null,
    policy_version: input.policyVersion,
    policy_signature: input.policySignature,
    retention_policy: input.retentionPolicy,
    retention_until: input.retentionUntil,
    owner_evidence_reference: `test-owner:${input.sourcePartition}`,
    owner_evidence_signature: `test-owner-signature:${input.sourcePartition}`,
    reason_code: input.initialPosition == null
      ? 'marker_absence_recorded'
      : 'initial_marker_reconciled',
    reason_detail: 'Test owner verified the exact retained source marker and partition.',
  });
  return registerExternalRecoveryOperabilityOffset({
    tenantId: input.tenantId,
    actorUid: actor.uid,
    actorRole: actor.role,
    requestId: `test-register-${identity(parsed).slice(0, 24)}`,
    idempotencyKey: `test-register-${identity({ tenantId: input.tenantId, parsed })}`,
    parsed,
  });
}

export async function authorizeExternalRecoveryResume(input = {}) {
  const actor = await ensureAdmin(input.tenantId);
  const workbench = await listExternalRecoveryOperabilityWorkbench({
    tenantId: input.tenantId,
    actorUid: actor.uid,
    actorRole: actor.role,
    filters: { interfaceFamily: input.interfaceFamily || 'I10' },
  });
  const offset = workbench.offsets.find(item => item.offset_id === input.offsetId);
  if (!offset) throw new Error(`External recovery test offset ${input.offsetId} was not found`);
  const parsed = parseExternalRecoveryResume({
    expected_state_fingerprint: offset.state_fingerprint,
    resume_cutoff_position: input.resumeCutoffPosition,
    resume_cutoff_token: input.resumeCutoffToken,
    owner_evidence_reference: `test-owner:${offset.source_partition}`,
    owner_evidence_signature: `test-owner-signature:${offset.source_partition}`,
    reason_code: 'resume_cutoff_reconciled',
    reason_detail: 'Test owner verified the exact retained replay cutoff and source count.',
  });
  return authorizeExternalRecoveryOperabilityResume({
    tenantId: input.tenantId,
    actorUid: actor.uid,
    actorRole: actor.role,
    requestId: `test-resume-${identity(parsed).slice(0, 24)}`,
    idempotencyKey: `test-resume-${identity({ tenantId: input.tenantId, offsetId: input.offsetId, parsed })}`,
    offsetId: input.offsetId,
    parsed,
  });
}

export const registerColdChainRecoveryOffset = registerExternalRecoveryOffset;
export const authorizeColdChainRecoveryResume = authorizeExternalRecoveryResume;
