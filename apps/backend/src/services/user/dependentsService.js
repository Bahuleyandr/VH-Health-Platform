// src/services/user/dependentsService.js
//
// Dependent-profile linkage for the guardian-with-own-account model.
//
// Migration 202 added `users.guardian_user_id` (self-FK on `users.id`) so
// a minor can be linked to a guardian who has their own user row. The
// admin walk-in dialog wires this on intake; this service surfaces the
// patient app's read/link/unlink endpoints for the guardian to manage
// dependents post-registration.
//
// Distinct from `family_members` (migration 100) — that table is the
// guardian's address book of non-account contacts (siblings, spouse,
// elders the guardian wants to track). This service is for actual user
// rows with their own UID/MRN that the guardian acts on behalf of.

import prisma, { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { normalizePhone } from '../../utils/phoneUtils.js';
import {
  persistRevokeDelegatedTuple,
  publishRevokeDelegatedTuple,
} from '../../utils/tokenBlacklist.js';
import { requireTenantId } from '../tenant/tenantService.js';

const VALID_LINK_RELATIONSHIPS = new Set([
  'parent', 'mother', 'father', 'legal_guardian', 'grandparent',
  'sibling', 'spouse', 'other',
]);

function maskPhoneForDependent(phone) {
  if (!phone) return null;
  // UNIDENT-EMER-* synthetic phones are not real numbers — surface them
  // as-is so the UI can label them clearly.
  if (phone.startsWith('UNIDENT-')) return phone;
  if (phone.length <= 4) return '****';
  return `${phone.slice(0, 3)}****${phone.slice(-2)}`;
}

function shapeDependentRow(row) {
  return {
    id: row.id,
    uid: row.uid,
    name: row.name,
    phone: maskPhoneForDependent(row.phone),
    birthday: row.birthday,
    gender: row.gender,
    is_minor: row.is_minor,
    weight_kg: row.weight_kg !== null && row.weight_kg !== undefined
      ? Number(row.weight_kg)
      : null,
    guardian_relationship: row.guardian_relationship,
    linked_at: row.updated_at,
  };
}

export class DependentsService {
  /**
   * List users whose guardian_user_id matches the given guardian id.
   *
   * @param {number} guardianUserId — int id from req.user.id (the guardian).
   * @param {object} [options]
   * @param {boolean} [options.minorsOnly=true] — when true (default) filter
   *   to is_minor=true so the patient app surfaces only the legal-guardian
   *   use case. Pass false for an admin-side view that may include
   *   adult-dependent rows (rare).
   */
  static async listDependents(guardianUserId, { minorsOnly = true } = {}) {
    if (!Number.isInteger(guardianUserId) || guardianUserId <= 0) {
      throw AppError.badRequest('Invalid guardian user id', 'INVALID_GUARDIAN');
    }

    const conditions = ['guardian_user_id = $1'];
    if (minorsOnly) {
      conditions.push('is_minor = TRUE');
    }

    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, uid, name, phone, birthday, gender, is_minor, weight_kg,
              guardian_relationship, updated_at
         FROM users
        WHERE ${conditions.join(' AND ')}
        ORDER BY name NULLS LAST, id ASC`,
      guardianUserId,
    );

    return rows.map(shapeDependentRow);
  }

  /**
   * Link an existing minor user row to the calling guardian.
   *
   * Phase 0 (pre-flight, plain prisma):
   *   * resolve dependent by uid or phone
   *   * validate minor-flag
   *   * detect already-linked-to-different-guardian conflict
   * Phase 1 (transaction):
   *   * UPDATE users SET guardian_user_id ... WHERE id ... AND (...)
   *   * audit_logs.create — must succeed
   * Link is a single-row write with no downstream session invalidation.
   *
   * Idempotent: re-linking the same (dependent, guardian) pair returns the
   * existing link.
   */
  static async linkDependent({ guardianUserId, guardianUid, dependentIdentifier, relationship, tenantId = null }) {
    if (!Number.isInteger(guardianUserId) || guardianUserId <= 0) {
      throw AppError.badRequest('Invalid guardian user id', 'INVALID_GUARDIAN');
    }
    if (!dependentIdentifier || typeof dependentIdentifier !== 'string') {
      throw AppError.badRequest('dependent_uid_or_phone is required', 'MISSING_IDENTIFIER');
    }

    const relationshipNorm = relationship
      ? String(relationship).toLowerCase().trim().replace(/\s+/g, '_')
      : null;
    if (relationshipNorm && !VALID_LINK_RELATIONSHIPS.has(relationshipNorm)) {
      throw AppError.badRequest(
        'Invalid relationship — must be one of: ' + [...VALID_LINK_RELATIONSHIPS].join(', '),
        'INVALID_RELATIONSHIP',
      );
    }

    // Phase 0 — pre-flight outside transaction.
    const trimmed = dependentIdentifier.trim();
    const looksLikeUid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed);
    let dependent;
    if (looksLikeUid) {
      const rows = await prisma.$queryRawUnsafe(
        `SELECT id, uid, name, phone, birthday, gender, is_minor, weight_kg,
                guardian_relationship, guardian_user_id, role, is_active, updated_at
           FROM users WHERE uid = $1::uuid LIMIT 1`,
        trimmed,
      );
      dependent = rows[0];
    } else {
      const normalized = normalizePhone(trimmed);
      const national = normalized?.startsWith('+91') ? normalized.slice(3) : trimmed.replace(/\D/g, '');
      const candidates = [trimmed];
      if (normalized && !candidates.includes(normalized)) candidates.push(normalized);
      if (national && !candidates.includes(national)) candidates.push(national);
      const placeholders = candidates.map((_, i) => `$${i + 1}`).join(', ');
      const rows = await prisma.$queryRawUnsafe(
        `SELECT id, uid, name, phone, birthday, gender, is_minor, weight_kg,
                guardian_relationship, guardian_user_id, role, is_active, updated_at
           FROM users WHERE phone IN (${placeholders}) LIMIT 1`,
        ...candidates,
      );
      dependent = rows[0];
    }

    if (!dependent) {
      throw AppError.notFound('No user found with that phone or UID', 'DEPENDENT_NOT_FOUND');
    }

    if (String(dependent.id) === String(guardianUserId)) {
      throw AppError.badRequest('Cannot link yourself as a dependent', 'SELF_LINK_FORBIDDEN');
    }

    if (dependent.role && dependent.role !== 'PATIENT') {
      throw AppError.badRequest(
        'Only PATIENT-role users can be linked as dependents',
        'WRONG_ROLE',
      );
    }

    if (!dependent.is_minor) {
      throw AppError.badRequest(
        'Only minors can be linked as dependents under this model',
        'NOT_MINOR',
      );
    }

    // Idempotent path — already linked to this guardian.
    if (dependent.guardian_user_id && String(dependent.guardian_user_id) === String(guardianUserId)) {
      logger.info('Dependent already linked (idempotent)', {
        guardianUserId, dependentId: dependent.id,
      });
      return shapeDependentRow(dependent);
    }

    // Already linked to a different guardian → 409.
    if (dependent.guardian_user_id) {
      throw AppError.conflict(
        'Dependent is already linked to a different guardian',
        'ALREADY_LINKED',
        { dependent_uid: dependent.uid },
      );
    }

    // Phase 1 — atomic mutation + audit. The WHERE-clause guard mirrors the
    // pre-flight: if the row was linked in a concurrent request between
    // Phase 0 and Phase 1, RETURNING comes back empty and we surface a
    // conflict rather than silently overwriting.
    const setRelationshipClause = relationshipNorm ? ', guardian_relationship = $3' : '';
    const params = relationshipNorm
      ? [guardianUserId, dependent.id, relationshipNorm]
      : [guardianUserId, dependent.id];
    const updated = await setTenantTx(requireTenantId(tenantId), async (tx) => {
      const result = await tx.$queryRawUnsafe(
        `UPDATE users
            SET guardian_user_id = $1${setRelationshipClause},
                updated_at = NOW()
          WHERE id = $2
            AND is_minor = TRUE
            AND guardian_user_id IS NULL
          RETURNING id, uid, name, phone, birthday, gender, is_minor, weight_kg,
                    guardian_relationship, updated_at`,
        ...params,
      );

      if (result.length === 0) {
        throw AppError.conflict(
          'Dependent state changed concurrently — refresh and try again',
          'CONCURRENT_LINK',
        );
      }

      await tx.audit_logs.create({
        data: {
          uid: guardianUid || null,
          role: 'PATIENT',
          action: 'DEPENDENT_LINKED',
          resource: 'users',
          resource_id: dependent.uid,
          metadata: {
            dependent_id: dependent.id,
            dependent_uid: dependent.uid,
            guardian_user_id: guardianUserId,
            relationship: relationshipNorm,
          },
        },
      });

      return result[0];
    });

    logger.info('Dependent linked', {
      guardianUserId, dependentId: dependent.id, dependentUid: dependent.uid,
    });

    return shapeDependentRow(updated);
  }

  /**
   * Unlink a dependent — clears guardian_user_id on the dependent row.
   *
   * Same Phase 0 / Phase 1 split as linkDependent. The WHERE clause scopes
   * to the calling guardian's id so a guardian can only unlink their own
   * dependents (IDOR guard).
   */
  static async unlinkDependent({ guardianUserId, guardianUid, dependentId, tenantId = null }) {
    if (!Number.isInteger(guardianUserId) || guardianUserId <= 0) {
      throw AppError.badRequest('Invalid guardian user id', 'INVALID_GUARDIAN');
    }
    const depIdInt = parseInt(dependentId, 10);
    if (!Number.isInteger(depIdInt) || depIdInt <= 0) {
      throw AppError.badRequest('Invalid dependent id', 'INVALID_DEPENDENT_ID');
    }

    // Phase 0 — confirm linkage exists, owned by this guardian.
    const existing = await prisma.$queryRawUnsafe(
      `SELECT id, uid, guardian_user_id FROM users WHERE id = $1 LIMIT 1`,
      depIdInt,
    );
    if (existing.length === 0) {
      throw AppError.notFound('Dependent not found', 'DEPENDENT_NOT_FOUND');
    }
    if (String(existing[0].guardian_user_id) !== String(guardianUserId)) {
      // Don't leak whether the row exists under a different guardian —
      // return the same 404 the no-row branch returns.
      throw AppError.notFound('Dependent not found', 'DEPENDENT_NOT_FOUND');
    }

    // Phase 1 — atomic unlink + audit.
    const tupleRevocation = await setTenantTx(requireTenantId(tenantId), async (tx) => {
      const result = await tx.$queryRawUnsafe(
        `UPDATE users AS dependent
            SET guardian_user_id = NULL,
                updated_at = NOW()
           FROM users AS guardian
          WHERE dependent.id = $1
            AND dependent.guardian_user_id = $2
            AND guardian.id = $2
          RETURNING dependent.id, dependent.uid, guardian.uid AS guardian_uid`,
        depIdInt, guardianUserId,
      );

      if (result.length === 0) {
        throw AppError.notFound('Dependent not found', 'DEPENDENT_NOT_FOUND');
      }

      await tx.audit_logs.create({
        data: {
          uid: guardianUid || null,
          role: 'PATIENT',
          action: 'DEPENDENT_UNLINKED',
          resource: 'users',
          resource_id: result[0].uid,
          metadata: {
            dependent_id: result[0].id,
            dependent_uid: result[0].uid,
            guardian_user_id: guardianUserId,
          },
        },
      });

      const revokedAt = await persistRevokeDelegatedTuple(
        result[0].guardian_uid,
        result[0].uid,
        { client: tx, reason: 'dependent_unlinked' },
      );
      return {
        guardianUid: result[0].guardian_uid,
        dependentUid: result[0].uid,
        revokedAt,
      };
    });

    try {
      await publishRevokeDelegatedTuple(
        tupleRevocation.guardianUid,
        tupleRevocation.dependentUid,
        tupleRevocation.revokedAt,
        { reason: 'dependent_unlinked' },
      );
    } catch (err) {
      logger.warn('Dependent unlink revocation publication failed', {
        guardianUid: tupleRevocation.guardianUid,
        dependentUid: tupleRevocation.dependentUid,
        error: err.message,
      });
    }

    logger.info('Dependent unlinked', {
      guardianUserId, dependentId: depIdInt,
    });

    return { id: depIdInt };
  }
}

export default DependentsService;
