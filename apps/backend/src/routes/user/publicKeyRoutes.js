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
    await prisma.$queryRawUnsafe(
      `UPDATE users SET e2e_public_key = $1, e2e_key_updated_at = NOW() WHERE id = $2`,
      publicKey,
      uid,
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
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, e2e_public_key, e2e_key_updated_at FROM users WHERE id = $1`,
      parseInt(req.params.id, 10),
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
