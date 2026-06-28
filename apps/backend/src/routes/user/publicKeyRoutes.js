// src/routes/user/publicKeyRoutes.js
//
// Publish + fetch X25519 public keys used by MessageCrypto for E2E messaging.
// Private keys never leave the device. This endpoint is an opaque key
// directory — the backend validates base64 shape + byte length but does not
// interpret the key cryptographically.

import express from 'express';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { success, error } from '../../utils/responseHelper.js';

const router = express.Router();

// X25519 public keys are 32 bytes → 44 chars base64 (with padding).
function isValidBase64X25519(s) {
  if (typeof s !== 'string' || s.length < 40 || s.length > 48) return false;
  try {
    const bytes = Buffer.from(s, 'base64');
    return bytes.length === 32;
  } catch {
    return false;
  }
}

// POST /users/me/public-key — publish (or rotate) my own key.
router.post('/me/public-key', async (req, res) => {
  try {
    const { publicKey } = req.body;
    if (!isValidBase64X25519(publicKey)) {
      return error(res, 'publicKey must be base64-encoded 32 bytes (X25519)', 400);
    }
    const uid = req.user?.id;
    if (!uid) return error(res, 'Unauthenticated', 401);
    // CAN-038: scope by tenant so a key write can only ever touch the caller's
    // own tenant row (defense-in-depth alongside RLS / the self-only id).
    const tenantId = req.tenantId || req.user?.tenant_id || null;
    await prisma.$queryRawUnsafe(
      `UPDATE users SET e2e_public_key = $1, e2e_key_updated_at = NOW() WHERE id = $2 AND tenant_id = $3::uuid`,
      publicKey,
      uid,
      tenantId,
    );
    return success(res, { publicKey, updatedAt: new Date().toISOString() }, 'Public key updated');
  } catch (err) {
    logger.error('Publish public key error:', err);
    return error(res, 'Failed to publish public key', 500);
  }
});

// GET /users/:id/public-key — fetch a peer's key for message encryption.
router.get('/:id/public-key', async (req, res) => {
  try {
    // CAN-038: scope the key directory to the caller's tenant so peer keys /
    // account existence cannot be enumerated across tenants by global numeric
    // id. The 404 is intentionally uniform for "no such user", "wrong tenant",
    // and "no key published" so it cannot be used as an existence oracle.
    const tenantId = req.tenantId || req.user?.tenant_id || null;
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, e2e_public_key, e2e_key_updated_at FROM users WHERE id = $1 AND tenant_id = $2::uuid`,
      parseInt(req.params.id, 10),
      tenantId,
    );
    if (rows.length === 0 || !rows[0].e2e_public_key) {
      return error(res, 'Peer has not published a public key', 404);
    }
    return success(res, {
      userId: rows[0].id,
      publicKey: rows[0].e2e_public_key,
      updatedAt: rows[0].e2e_key_updated_at,
    }, 'Peer public key');
  } catch (err) {
    logger.error('Fetch public key error:', err);
    return error(res, 'Failed to fetch public key', 500);
  }
});

export default router;
