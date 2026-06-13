// src/routes/user/dependentsRoutes.js
//
// Patient-app surface for the dependent-profile model (migration 202).
//
// `family-members` (companion route) is a guardian's address book of
// non-account contacts. This route is for *user-row* dependents — minors
// who have their own users.uid and whom the guardian acts on behalf of.

import express from 'express';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import { phiAccessLogger } from '../../middleware/phiAccessMiddleware.js';
import { DependentsService } from '../../services/user/dependentsService.js';
import { success, error } from '../../utils/responseHelper.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';

const router = express.Router();

// Every endpoint under /dependents touches another user's demographics +
// minor flag — PHI by HIPAA classification. The middleware fires
// fire-and-forget after the response is sent.
router.use(phiAccessLogger('PATIENT_DEMOGRAPHICS'));

function ensureAuthedUserId(req) {
  const idRaw = req.user?.id;
  const uid = req.user?.uid;
  const id = typeof idRaw === 'number' ? idRaw : parseInt(idRaw, 10);
  if (!Number.isInteger(id) || id <= 0) {
    throw AppError.unauthorized('Authenticated user id missing from session');
  }
  return { id, uid };
}

function handleError(res, err, context) {
  if (err instanceof AppError) {
    return error(res, err.message, err.statusCode, err.details || undefined);
  }
  logger.error(context, err);
  return error(res, 'Internal server error', HTTP_STATUS.INTERNAL_SERVER_ERROR);
}

// GET /users/dependents — minors linked to the caller.
router.get('/', async (req, res) => {
  try {
    const { id } = ensureAuthedUserId(req);
    // Default to minors-only; staff/admin tooling can pass ?include_adults=1.
    const minorsOnly = String(req.query?.include_adults || '') !== '1';
    const dependents = await DependentsService.listDependents(id, { minorsOnly });
    return success(res, { dependents }, 'Dependents retrieved');
  } catch (err) {
    return handleError(res, err, 'List dependents error:');
  }
});

// POST /users/dependents/link
// Body: { dependent_uid_or_phone: string, relationship?: string }
router.post('/link', async (req, res) => {
  try {
    const { id, uid } = ensureAuthedUserId(req);
    const identifier = req.body?.dependent_uid_or_phone
      ?? req.body?.dependent_uid
      ?? req.body?.dependent_phone
      ?? req.body?.phone;
    const dependent = await DependentsService.linkDependent({
      guardianUserId: id,
      guardianUid: uid,
      dependentIdentifier: identifier,
      relationship: req.body?.relationship,
      tenantId: req.tenantId,
    });
    return success(res, { dependent }, 'Dependent linked', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleError(res, err, 'Link dependent error:');
  }
});

// DELETE /users/dependents/:id — unlink.
router.delete('/:id', async (req, res) => {
  try {
    const { id, uid } = ensureAuthedUserId(req);
    const result = await DependentsService.unlinkDependent({
      guardianUserId: id,
      guardianUid: uid,
      dependentId: req.params.id,
      tenantId: req.tenantId,
    });
    return success(res, result, 'Dependent unlinked');
  } catch (err) {
    return handleError(res, err, 'Unlink dependent error:');
  }
});

export default router;
