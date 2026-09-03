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

import { randomUUID } from 'node:crypto';

import prisma, { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { normalizePhone } from '../../utils/phoneUtils.js';
import {
  persistRevokeDelegatedTuple,
  publishRevokeDelegatedTuple,
  withAuthIdentityLifecycleLocks,
} from '../../utils/tokenBlacklist.js';
import { requireTenantId } from '../tenant/tenantService.js';

const VALID_LINK_RELATIONSHIPS = new Set([
  'parent', 'mother', 'father', 'legal_guardian', 'grandparent',
  'sibling', 'spouse', 'other',
]);

// Synthetic placeholder phone satisfying UNIQUE(users.phone) for a dependent
// identity minted from a family-member contact — same impedance fix as the
// walk-in minor path (appointmentWorkflowController) and the birth workflow's
// NB- prefix. A minted minor must NEVER inherit the contact's real phone:
// users.phone is an OTP login credential, and promotion must not hand
// login-as-the-child to whoever holds an unverified number.
// VARCHAR(15): 'DEPEND-' + 8 hex. Random (not Date.now-derived like the
// walk-in dialog's variant) so concurrent promotions cannot collide on the
// unique phone index.
function syntheticDependentPhone() {
  return `DEPEND-${randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase()}`;
}

function isMinorBirthday(birthday) {
  const dob = new Date(birthday);
  if (Number.isNaN(dob.getTime())) return false;
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - 18);
  return dob > cutoff;
}

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
   * Promote a `family_members` contact into a *linked dependent* — a real
   * minor patient identity the guardian can act for.
   *
   * Reuses the platform's ONE guardian→minor mechanism
   * (`users.guardian_user_id`, migration 202): the acting-as hop, the D72
   * explicit-URL reads, and booking-on-behalf all validate that link — no
   * parallel authorization structure is created. Migration 681 only stamps
   * the contact row with the identity it was promoted into plus the
   * guardian's consent declaration.
   *
   * Identity resolution:
   *   * contact phone matches an existing linkable minor account
   *     (PATIENT + is_minor + unlinked-or-ours) → link that row (same
   *     semantics as linkDependent);
   *   * contact phone matches the guardian themselves, matches nothing, or
   *     the contact has no phone → mint a minor users row with a synthetic
   *     DEPEND- phone (walk-in minor idiom — a minted minor never inherits
   *     an unverified real phone as an OTP login credential);
   *   * contact phone matches any OTHER account (adult, staff, someone
   *     else's dependent) → 409, guardian must fix the contact or use the
   *     explicit /users/dependents/link flow.
   *
   * Consent: caller must send `consent_confirmed: true` plus the declared
   * guardian relationship. Declaration is persisted on the contact row
   * (link_consent_method = 'guardian_declaration') and in the audit log.
   *
   * Phase 0 pre-flight on plain prisma; Phase 1 mutation + consent stamp +
   * audit inside one transaction. Idempotent: re-promoting an
   * already-linked contact returns the existing linked dependent.
   */
  static async promoteFamilyMember({
    guardianUserId,
    guardianUid,
    familyMemberId,
    relationship,
    birthday = null,
    gender = null,
    consentConfirmed = false,
    tenantId = null,
  }) {
    if (!Number.isInteger(guardianUserId) || guardianUserId <= 0) {
      throw AppError.badRequest('Invalid guardian user id', 'INVALID_GUARDIAN');
    }
    const memberIdInt = parseInt(familyMemberId, 10);
    if (!Number.isInteger(memberIdInt) || memberIdInt <= 0) {
      throw AppError.badRequest('Invalid family member id', 'INVALID_FAMILY_MEMBER_ID');
    }

    // Phase 0 — contact lookup, scoped to the calling guardian (IDOR guard).
    const members = await prisma.$queryRawUnsafe(
      `SELECT id::int AS id, patient_uid, name, phone, relationship,
              date_of_birth, linked_dependent_uid
         FROM family_members
        WHERE id = $1 AND patient_uid = $2::uuid
        LIMIT 1`,
      memberIdInt, guardianUid,
    );
    if (members.length === 0) {
      throw AppError.notFound('Family member not found', 'FAMILY_MEMBER_NOT_FOUND');
    }
    const member = members[0];

    // Idempotent path — contact already promoted.
    if (member.linked_dependent_uid) {
      const rows = await prisma.$queryRawUnsafe(
        `SELECT id, uid, name, phone, birthday, gender, is_minor, weight_kg,
                guardian_relationship, updated_at
           FROM users
          WHERE uid = $1::uuid AND guardian_user_id = $2
          LIMIT 1`,
        member.linked_dependent_uid, guardianUserId,
      );
      if (rows.length > 0) {
        return {
          dependent: shapeDependentRow(rows[0]),
          family_member_id: member.id,
          created_identity: false,
          already_linked: true,
        };
      }
      // Linked uid no longer resolves to a dependent of this guardian
      // (unlinked via /users/dependents after promotion). Refuse rather
      // than silently minting a second identity for the same contact.
      throw AppError.conflict(
        'This family member was promoted before but the dependent link was since removed. Re-link it from the dependents screen.',
        'FAMILY_MEMBER_LINK_STALE',
      );
    }

    // Consent declaration is mandatory — this creates (or claims) a patient
    // identity the guardian will act for.
    if (consentConfirmed !== true) {
      throw AppError.badRequest(
        'Guardian consent declaration is required to promote a family member',
        'GUARDIAN_CONSENT_REQUIRED',
      );
    }
    const relationshipNorm = relationship
      ? String(relationship).toLowerCase().trim().replace(/\s+/g, '_')
      : null;
    if (!relationshipNorm || !VALID_LINK_RELATIONSHIPS.has(relationshipNorm)) {
      throw AppError.badRequest(
        'relationship (guardian → dependent) is required — one of: '
          + [...VALID_LINK_RELATIONSHIPS].join(', '),
        'INVALID_RELATIONSHIP',
      );
    }

    // The guardian-of-minor model (acting-as hop, migration 202) covers
    // minors only — an adult contact cannot be promoted.
    const dobRaw = birthday || member.date_of_birth;
    if (!dobRaw) {
      throw AppError.badRequest(
        'Date of birth is required to promote a family member',
        'BIRTHDAY_REQUIRED',
      );
    }
    const dobDate = new Date(dobRaw);
    if (Number.isNaN(dobDate.getTime())) {
      throw AppError.badRequest('Invalid date of birth', 'BIRTHDAY_INVALID');
    }
    if (!isMinorBirthday(dobRaw)) {
      throw AppError.badRequest(
        'Only minors can be linked as dependents under this model',
        'NOT_MINOR',
      );
    }
    const dobIso = dobDate.toISOString().slice(0, 10);
    const genderNorm = gender ? String(gender).toUpperCase().trim() : null;
    if (genderNorm && !['MALE', 'FEMALE', 'OTHER'].includes(genderNorm)) {
      throw AppError.badRequest('gender must be MALE, FEMALE or OTHER', 'INVALID_GENDER');
    }

    // Guardian row — name/phone/tenant feed the minted identity.
    const guardians = await prisma.$queryRawUnsafe(
      `SELECT id, uid, name, phone, tenant_id FROM users WHERE id = $1 LIMIT 1`,
      guardianUserId,
    );
    if (guardians.length === 0) {
      throw AppError.notFound('Guardian account not found', 'GUARDIAN_NOT_FOUND');
    }
    const guardian = guardians[0];

    // Resolve an existing account by the contact's phone.
    let existingUser = null;
    const contactPhone = member.phone ? String(member.phone).trim() : null;
    const guardianOwnPhone = guardian.phone
      && contactPhone
      && (normalizePhone(contactPhone) === normalizePhone(guardian.phone)
        || contactPhone === guardian.phone);
    if (contactPhone && !guardianOwnPhone) {
      const normalized = normalizePhone(contactPhone);
      const national = normalized?.startsWith('+91')
        ? normalized.slice(3)
        : contactPhone.replace(/\D/g, '');
      const candidates = [contactPhone];
      if (normalized && !candidates.includes(normalized)) candidates.push(normalized);
      if (national && !candidates.includes(national)) candidates.push(national);
      const placeholders = candidates.map((_, i) => `$${i + 1}`).join(', ');
      const rows = await prisma.$queryRawUnsafe(
        `SELECT id, uid, name, phone, birthday, gender, is_minor, weight_kg,
                guardian_relationship, guardian_user_id, role, is_active, updated_at
           FROM users WHERE phone IN (${placeholders}) LIMIT 1`,
        ...candidates,
      );
      existingUser = rows[0] || null;
    }

    let linkExisting = false;
    if (existingUser) {
      const linkable = existingUser.role === 'PATIENT'
        && existingUser.is_minor === true
        && (existingUser.guardian_user_id == null
          || String(existingUser.guardian_user_id) === String(guardianUserId));
      if (!linkable) {
        throw AppError.conflict(
          'The phone on this family member belongs to an account that cannot be linked as your dependent. Correct the phone, or use the dependent-link flow with the account holder.',
          'FAMILY_MEMBER_PHONE_ACCOUNT_CONFLICT',
        );
      }
      linkExisting = true;
    }

    // Phase 1 — mint/link identity + consent stamp + audit, atomically.
    const result = await setTenantTx(requireTenantId(tenantId), async (tx) => {
      // Re-read the contact under lock so a concurrent promotion of the
      // same row cannot double-mint.
      const locked = await tx.$queryRawUnsafe(
        `SELECT id::int AS id, linked_dependent_uid
           FROM family_members
          WHERE id = $1 AND patient_uid = $2::uuid
          FOR UPDATE`,
        memberIdInt, guardianUid,
      );
      if (locked.length === 0) {
        throw AppError.notFound('Family member not found', 'FAMILY_MEMBER_NOT_FOUND');
      }
      if (locked[0].linked_dependent_uid) {
        throw AppError.conflict(
          'Family member was promoted concurrently — refresh and try again',
          'CONCURRENT_PROMOTION',
        );
      }

      let dependentRow;
      let createdIdentity = false;
      if (linkExisting) {
        const updated = await tx.$queryRawUnsafe(
          `UPDATE users
              SET guardian_user_id = $1,
                  guardian_relationship = $3,
                  updated_at = NOW()
            WHERE id = $2
              AND is_minor = TRUE
              AND (guardian_user_id IS NULL OR guardian_user_id = $1)
            RETURNING id, uid, name, phone, birthday, gender, is_minor, weight_kg,
                      guardian_relationship, updated_at`,
          guardianUserId, existingUser.id, relationshipNorm,
        );
        if (updated.length === 0) {
          throw AppError.conflict(
            'Dependent state changed concurrently — refresh and try again',
            'CONCURRENT_LINK',
          );
        }
        dependentRow = updated[0];
      } else {
        const inserted = await tx.$queryRawUnsafe(
          `INSERT INTO users
             (phone, name, birthday, gender, role,
              is_minor, is_active,
              guardian_user_id, guardian_name, guardian_phone, guardian_relationship,
              tenant_id, updated_at)
           VALUES ($1, $2, $3::date, $4, 'PATIENT',
                   true, true,
                   $5::int, $6, $7, $8,
                   $9::uuid, NOW())
           RETURNING id, uid, name, phone, birthday, gender, is_minor, weight_kg,
                     guardian_relationship, updated_at`,
          syntheticDependentPhone(),
          String(member.name).slice(0, 255),
          dobIso,
          genderNorm,
          guardianUserId,
          guardian.name || null,
          guardian.phone || null,
          relationshipNorm,
          guardian.tenant_id || requireTenantId(tenantId),
        );
        dependentRow = inserted[0];
        await withAuthIdentityLifecycleLocks(tx, [dependentRow.uid], async () => undefined);
        createdIdentity = true;
      }

      const stamped = await tx.$queryRawUnsafe(
        `UPDATE family_members
            SET linked_dependent_uid = $2::uuid,
                linked_at = NOW(),
                link_consent_method = 'guardian_declaration',
                updated_at = NOW()
          WHERE id = $1
          RETURNING id::int AS id`,
        memberIdInt, dependentRow.uid,
      );
      if (stamped.length === 0) {
        throw AppError.conflict(
          'Family member state changed concurrently — refresh and try again',
          'CONCURRENT_PROMOTION',
        );
      }

      await tx.audit_logs.create({
        data: {
          uid: guardianUid || null,
          role: 'PATIENT',
          action: 'FAMILY_MEMBER_PROMOTED',
          resource: 'family_members',
          resource_id: String(memberIdInt),
          metadata: {
            family_member_id: memberIdInt,
            dependent_id: dependentRow.id,
            dependent_uid: dependentRow.uid,
            guardian_user_id: guardianUserId,
            relationship: relationshipNorm,
            created_identity: createdIdentity,
            consent_method: 'guardian_declaration',
            consent_confirmed: true,
          },
        },
      });

      return { dependentRow, createdIdentity };
    });

    logger.info('Family member promoted to linked dependent', {
      guardianUserId,
      familyMemberId: memberIdInt,
      dependentId: result.dependentRow.id,
      createdIdentity: result.createdIdentity,
    });

    return {
      dependent: shapeDependentRow(result.dependentRow),
      family_member_id: memberIdInt,
      created_identity: result.createdIdentity,
      already_linked: false,
    };
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
      `SELECT dependent.id, dependent.uid, dependent.guardian_user_id,
              guardian.uid AS guardian_uid
         FROM users AS dependent
         JOIN users AS guardian ON guardian.id = dependent.guardian_user_id
        WHERE dependent.id = $1
        LIMIT 1`,
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
      const dependentUid = String(existing[0].uid);
      const linkedGuardianUid = String(existing[0].guardian_uid);
      return withAuthIdentityLifecycleLocks(
        tx,
        [linkedGuardianUid, dependentUid],
        async () => {
          // Tuple persistence takes the third canonical advisory lock. All
          // three xact locks remain held through the identity-row mutation and
          // commit, matching delegated WS registration's lock-before-row order.
          const revokedAt = await persistRevokeDelegatedTuple(
            linkedGuardianUid,
            dependentUid,
            { client: tx, reason: 'dependent_unlinked' },
          );

          const result = await tx.$queryRawUnsafe(
            `UPDATE users AS dependent
                SET guardian_user_id = NULL,
                    updated_at = NOW()
               FROM users AS guardian
              WHERE dependent.id = $1
                AND dependent.uid = $2::uuid
                AND dependent.guardian_user_id = $3
                AND guardian.id = $3
                AND guardian.uid = $4::uuid
              RETURNING dependent.id, dependent.uid, guardian.uid AS guardian_uid`,
            depIdInt, dependentUid, guardianUserId, linkedGuardianUid,
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

          return {
            guardianUid: result[0].guardian_uid,
            dependentUid: result[0].uid,
            revokedAt,
          };
        },
      );
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
