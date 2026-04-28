// src/routes/user/familyRoutes.js
// Family member CRUD for patient accounts

import express from 'express';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { success, error } from '../../utils/responseHelper.js';

const router = express.Router();

// GET /family-members — list user's family members
router.get('/', async (req, res) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return error(res, 'Unauthorized', HTTP_STATUS.UNAUTHORIZED);

    const rows = await prisma.$queryRawUnsafe(
      `SELECT id::int AS id, name, phone, relationship, date_of_birth AS "dateOfBirth", created_at AS "createdAt"
       FROM family_members
       WHERE patient_uid = $1::uuid
       ORDER BY created_at DESC`,
      uid
    );

    return success(res, rows, 'Family members retrieved');
  } catch (err) {
    // family_members table is part of an unfinished feature — return
    // empty so the Family screen renders. Adds will fail until the
    // table exists, but the screen should at least load.
    if (err?.meta?.code === '42P01') {
      return success(res, [], 'Family members retrieved');
    }
    logger.error('Get family members error:', err);
    return error(res, 'Failed to retrieve family members', HTTP_STATUS.INTERNAL_SERVER_ERROR);
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
