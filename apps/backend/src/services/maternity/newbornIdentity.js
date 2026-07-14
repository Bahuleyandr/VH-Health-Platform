// src/services/maternity/newbornIdentity.js
//
// D7 Shape-3 newborn identity rules (signed 2026-07-15; decision record
// obgyn-d7-decision-record.md, SHA-256 E82EEC9A054CA3708A31F48568818BB2
// 7F9986D8F5A02C37AF9407F4D5DB9562).
//
// The clinical subject of every infant-scope maternity event is the
// newborn's OWN patient identity (maternity_newborns.newborn_patient_uid).
// A candidate identity is valid only under the signed E-3 predicate:
//
//   role = 'PATIENT'
//   AND is_active = TRUE
//   AND is_deleted = FALSE
//   AND deleted_at IS NULL
//   AND NOT merged-away (no executed patient_merge_requests row naming the
//       uid as secondary_uid in the same tenant)
//   AND uid <> the delivery mother's patient_uid  (mother-exclusion arm)
//
// Absent link, failed predicate, or ambiguity => the mutation is REJECTED
// (fail-closed; no proxy writes, no mother fallback). Ambiguity is closed
// structurally by migration 577's partial unique index on
// (tenant_id, newborn_patient_uid); assertExclusiveNewbornLink is the
// E-c1 in-transaction re-check that backs it under row locks.

import prisma from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';

// Bounded outcome vocabulary (B-2). Identity is minted for a baby who
// lived ('live', 'early_neonatal_death') and NEVER for stillbirths.
export const NEWBORN_OUTCOMES = Object.freeze([
  'live',
  'early_neonatal_death',
  'fresh_stillbirth',
  'macerated_stillbirth',
]);

export const IDENTITY_MINTING_OUTCOMES = Object.freeze(
  new Set(['live', 'early_neonatal_death']),
);

export function newbornIdentityRequired() {
  return AppError.conflict(
    'This clinical action requires the newborn to have their own patient identity',
    'NEWBORN_IDENTITY_REQUIRED',
  );
}

export function newbornIdentityInvalid(reason) {
  return AppError.conflict(
    'The linked newborn patient identity is not a valid clinical subject',
    'NEWBORN_IDENTITY_INVALID',
    { reason },
  );
}

/**
 * Pure E-3 classification of a candidate users row (null = not found in
 * tenant). Exported for unit coverage; the row shape matches
 * loadNewbornIdentityCandidate below.
 *
 * @returns {{ valid: boolean, reason: string|null }}
 */
export function classifyNewbornIdentityCandidate(row, { motherPatientUid = null } = {}) {
  if (!row) return { valid: false, reason: 'not_found' };
  if (String(row.role || '') !== 'PATIENT') return { valid: false, reason: 'not_patient' };
  if (row.is_active !== true) return { valid: false, reason: 'inactive' };
  if (row.is_deleted === true || row.deleted_at != null) {
    return { valid: false, reason: 'deleted' };
  }
  if (row.merged_away === true) return { valid: false, reason: 'merged_away' };
  if (
    motherPatientUid
    && String(row.uid).toLowerCase() === String(motherPatientUid).toLowerCase()
  ) {
    return { valid: false, reason: 'mother_identity' };
  }
  return { valid: true, reason: null };
}

/**
 * Tenant-scoped candidate lookup. `forUpdate: true` locks the users row for
 * the calling transaction (E-c1 re-check under row locks) so a concurrent
 * deactivation/merge serialises against the clinical write.
 */
export async function loadNewbornIdentityCandidate({
  db = prisma, tenantId, candidateUid, forUpdate = false,
}) {
  const rows = await db.$queryRawUnsafe(
    `SELECT u.uid, u.id, u.role, u.is_active, u.is_deleted, u.deleted_at,
            EXISTS (
              SELECT 1
                FROM patient_merge_requests pmr
               WHERE pmr.tenant_id = $1::uuid
                 AND pmr.secondary_uid = u.uid
                 AND pmr.status = 'executed'
            ) AS merged_away
       FROM users u
      WHERE u.tenant_id = $1::uuid
        AND u.uid = $2::uuid
      ${forUpdate ? 'FOR UPDATE OF u' : ''}`,
    tenantId,
    String(candidateUid),
  );
  return rows[0] || null;
}

/**
 * Assert the signed E-3 predicate for a candidate identity; throws
 * NEWBORN_IDENTITY_INVALID with the failing reason otherwise. Returns the
 * validated users row (uid, id).
 */
export async function assertNewbornIdentitySubject({
  db = prisma, tenantId, candidateUid, motherPatientUid = null, forUpdate = false,
}) {
  const row = await loadNewbornIdentityCandidate({
    db, tenantId, candidateUid, forUpdate,
  });
  const verdict = classifyNewbornIdentityCandidate(row, { motherPatientUid });
  if (!verdict.valid) throw newbornIdentityInvalid(verdict.reason);
  return row;
}

/**
 * E-c1 exclusivity re-check: the candidate uid must back at most one
 * maternity newborn row in the tenant.
 *
 * - `newbornId` null (pre-link, e.g. recordNewborn): ANY existing row using
 *   the uid rejects as `already_linked`.
 * - `newbornId` set (post-link, e.g. immunisation writes): any OTHER row
 *   using the uid rejects as `ambiguous_identity`. Migration 577's partial
 *   unique index makes this state impossible to create; the re-check keeps
 *   the write path fail-closed against residual pre-577 data.
 */
export async function assertExclusiveNewbornLink({
  db = prisma, tenantId, candidateUid, newbornId = null,
}) {
  const rows = await db.$queryRawUnsafe(
    `SELECT id
       FROM maternity_newborns
      WHERE tenant_id = $1::uuid
        AND newborn_patient_uid = $2::uuid
      ORDER BY id`,
    tenantId,
    String(candidateUid),
  );
  if (newbornId == null) {
    if (rows.length > 0) throw newbornIdentityInvalid('already_linked');
    return;
  }
  const others = rows.filter((row) => Number(row.id) !== Number(newbornId));
  if (others.length > 0) throw newbornIdentityInvalid('ambiguous_identity');
}
