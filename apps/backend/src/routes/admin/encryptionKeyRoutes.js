/**
 * Admin routes for the PHI encryption key registry (Phase E3).
 * Mounted at /api/v1/admin/encryption-keys.
 */

import express from 'express';

import { requireRole } from '../../middleware/rbacMiddleware.js';
import { success } from '../../utils/responseHelper.js';
import {
  listEncryptionKeys,
  markKeyCompromised,
  registerEncryptionKey,
  retireEncryptionKey,
  rotateActiveKey,
} from '../../services/security/encryptionKeyRegistryService.js';

const router = express.Router();

/**
 * SUPER_ADMIN-only console (in-route gate, same intent as the databaseRoutes.js
 * gate; spelled with the shared `requireRole` so a denied attempt lands in the
 * security audit trail as `PERMISSION_DENIED`).
 *
 * The parent `/api/v1/admin` mount gates on ADMIN_ROUTE_ROLES, which resolves
 * to ['SUPER_ADMIN', 'ADMIN'], and `requireSuperAdminStepUp` passes non-supers
 * straight through (rbacMiddleware.js:117) — so before this gate a plain tenant
 * ADMIN could rotate, retire, or mark-compromised the PHI-at-rest key registry.
 * The admin portal has always declared this console SUPER_ADMIN-only
 * (apps/admin/src/lib/navConfig.ts — "Encryption Keys").
 *
 * Router-wide rather than per-mutation on purpose: `GET /` is the key registry
 * itself (key ids, provider references, algorithms, status) — an inventory of
 * the KMS material protecting PHI, not routine admin data. Step-up from the
 * parent mount still applies and is unchanged.
 */
router.use(requireRole('SUPER_ADMIN'));

router.post('/', async (req, res, next) => {
  try {
    const b = req.body || {};
    const row = await registerEncryptionKey({
      tenantId: req.tenantId,
      keyId: b.key_id, provider: b.provider,
      providerReference: b.provider_reference,
      algorithm: b.algorithm, metadata: b.metadata,
      createdBy: req.user?.uid || req.user?.id || null,
    });
    return success(res, row, 'Encryption key registered', 201);
  } catch (err) { return next(err); }
});

router.get('/', async (req, res, next) => {
  try {
    const result = await listEncryptionKeys({
      tenantId: req.tenantId,
      status: req.query.status || null,
    });
    return success(res, result, 'Encryption keys retrieved');
  } catch (err) { return next(err); }
});

router.post('/rotate', async (req, res, next) => {
  try {
    const b = req.body || {};
    const row = await rotateActiveKey({
      tenantId: req.tenantId,
      newKeyId: b.new_key_id, provider: b.provider,
      providerReference: b.provider_reference,
      algorithm: b.algorithm, metadata: b.metadata,
      createdBy: req.user?.uid || req.user?.id || null,
    });
    return success(res, row, 'Encryption key rotated', 201);
  } catch (err) { return next(err); }
});

router.post('/:id/retire', async (req, res, next) => {
  try {
    const row = await retireEncryptionKey({
      tenantId: req.tenantId, id: req.params.id,
    });
    return success(res, row, 'Encryption key retired');
  } catch (err) { return next(err); }
});

router.post('/:id/compromise', async (req, res, next) => {
  try {
    const row = await markKeyCompromised({
      tenantId: req.tenantId, id: req.params.id,
      reason: req.body?.reason,
    });
    return success(res, row, 'Encryption key marked compromised');
  } catch (err) { return next(err); }
});

export default router;
