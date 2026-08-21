// src/routes/user/familyRoutes.js
// Family member CRUD for patient accounts, plus promotion of a contact
// into a *linked dependent* (a minor users row the guardian acts for —
// the migration-202 guardian_user_id mechanism the acting-as hop and
// booking-on-behalf validate).

import express from 'express';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { DependentsService } from '../../services/user/dependentsService.js';
import { success, error, relayAppError } from '../../utils/responseHelper.js';

const router = express.Router();

// GET /family-members — list user's family members
router.get('/', async (req, res) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return error(res, 'Unauthorized', HTTP_STATUS.UNAUTHORIZED);

    const rows = await prisma.$queryRawUnsafe(
      `SELECT id::int AS id, name, phone, relationship, date_of_birth AS "dateOfBirth",
              linked_dependent_uid AS "linkedDependentUid", linked_at AS "linkedAt",
              created_at AS "createdAt"
       FROM family_members
       WHERE patient_uid = $1::uuid
       ORDER BY created_at DESC`,
      uid
    );

    return success(res, rows, 'Family members retrieved');
  } catch (err) {
    logger.error('Get family members error:', err);
    return error(res, 'Failed to retrieve family members', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
});

// POST /family-members/:id/promote — promote a contact into a linked
// dependent (minor patient identity with guardian_user_id set). Requires an
// explicit guardian consent declaration; see
// DependentsService.promoteFamilyMember for the full contract.
router.post('/:id/promote', async (req, res) => {
  try {
    const uid = req.user?.uid;
    const idRaw = req.user?.id;
    const guardianUserId = typeof idRaw === 'number' ? idRaw : parseInt(idRaw, 10);
    if (!uid || !Number.isInteger(guardianUserId) || guardianUserId <= 0) {
      return error(res, 'Unauthorized', HTTP_STATUS.UNAUTHORIZED);
    }

    const result = await DependentsService.promoteFamilyMember({
      guardianUserId,
      guardianUid: uid,
      familyMemberId: req.params.id,
      relationship: req.body?.relationship,
      birthday: req.body?.birthday || req.body?.date_of_birth || null,
      gender: req.body?.gender || null,
      consentConfirmed: req.body?.consent_confirmed === true,
      tenantId: req.tenantId,
    });
    const status = result.already_linked ? HTTP_STATUS.OK : HTTP_STATUS.CREATED;
    return success(res, result, 'Family member promoted to linked dependent', status);
  } catch (err) {
    if (err instanceof AppError) {
      return relayAppError(res, err, 'Failed to promote family member');
    }
    logger.error('Promote family member error:', err);
    return error(res, 'Failed to promote family member', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
});

// POST /family-members — add a family member
router.post('/', async (req, res) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return error(res, 'Unauthorized', HTTP_STATUS.UNAUTHORIZED);

    const { name, phone, relationship, dateOfBirth } = req.body;

    if (!name || !name.trim()) {
      return error(res, 'Name is required', HTTP_STATUS.BAD_REQUEST);
    }

    const result = await prisma.$queryRawUnsafe(
      `INSERT INTO family_members (patient_uid, name, phone, relationship, date_of_birth)
       VALUES ($1::uuid, $2, $3, $4, $5::date)
       RETURNING id::int AS id, name, phone, relationship, date_of_birth AS "dateOfBirth", created_at AS "createdAt"`,
      uid,
      name.trim(),
      phone?.trim() || null,
      relationship?.trim() || null,
      dateOfBirth || null
    );

    return success(res, result[0], 'Family member added', HTTP_STATUS.CREATED);
  } catch (err) {
    logger.error('Add family member error:', err);
    return error(res, 'Failed to add family member', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
});

// DELETE /family-members/:id — remove a family member
router.delete('/:id', async (req, res) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return error(res, 'Unauthorized', HTTP_STATUS.UNAUTHORIZED);

    const { id } = req.params;

    const result = await prisma.$queryRawUnsafe(
      `DELETE FROM family_members WHERE id = $1 AND patient_uid = $2::uuid RETURNING id::int AS id, name`,
      parseInt(id, 10),
      uid
    );

    if (result.length === 0) {
      return error(res, 'Family member not found', HTTP_STATUS.NOT_FOUND);
    }

    return success(res, { id: result[0].id }, 'Family member removed');
  } catch (err) {
    logger.error('Remove family member error:', err);
    return error(res, 'Failed to remove family member', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
});

export default router;
