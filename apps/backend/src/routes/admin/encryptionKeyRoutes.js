/**
 * Admin routes for the PHI encryption key registry (Phase E3).
 * Mounted at /api/v1/admin/encryption-keys.
 */

import express from 'express';

import { success } from '../../utils/responseHelper.js';
import {
  listEncryptionKeys,
  markKeyCompromised,
  registerEncryptionKey,
  retireEncryptionKey,
  rotateActiveKey,
} from '../../services/security/encryptionKeyRegistryService.js';

const router = express.Router();

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
