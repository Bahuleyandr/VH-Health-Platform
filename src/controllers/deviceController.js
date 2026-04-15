// src/controllers/deviceController.js

import prisma from '../lib/prisma.js';
import logger from '../logging/logger.js';
import { success, error } from '../utils/responseHelper.js';

export const registerDevice = async (req, res) => {
  const { phone, fcm_token, platform = 'unknown' } = req.body;

  if (!phone || !fcm_token) {
    return res.status(400).json(error('Phone and FCM token are required.'));
  }

  try {
    await prisma.$queryRawUnsafe(
      `INSERT INTO devices (phone, fcm_token, platform)
       VALUES ($1, $2, $3)
       ON CONFLICT (phone) DO UPDATE
       SET fcm_token = EXCLUDED.fcm_token,
           platform = EXCLUDED.platform,
           updated_at = NOW()`,
      phone, fcm_token, platform
    );

    await prisma.$queryRawUnsafe(
      `INSERT INTO audit_logs (action, resource, metadata)
       VALUES ($1, $2, $3::jsonb)`,
      'DEVICE_REGISTERED', 'device', JSON.stringify({ phone, platform })
    );

    logger.info(`[DEVICE REGISTERED] Phone: ${phone}, Platform: ${platform}`);

    return res.json(success('Device registered successfully.'));
  } catch (err) {
    logger.error('Device registration error:', err);
    return res.status(500).json(error('Internal server error.'));
  }
};
