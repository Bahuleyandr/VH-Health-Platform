// src/controllers/deviceController.js

import prisma from '../lib/prisma.js';
import logger from '../logging/logger.js';
import { maskPhoneForLog } from '../utils/logMasking.js';
import { success, error } from '../utils/responseHelper.js';

export const registerDevice = async (req, res) => {
  const { phone, fcm_token, platform = 'unknown' } = req.body;

  if (!phone || !fcm_token) {
    // M18: success()/error() take `res` first and send the response themselves
    // (res.status().json()). Passing a string made res.status() throw → every
    // path 500'd. Call them with the correct signature.
    return error(res, 'Phone and FCM token are required.', 400);
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

    logger.info(`[DEVICE REGISTERED] Phone: ${maskPhoneForLog(phone)}, Platform: ${platform}`);

    return success(res, null, 'Device registered successfully.');
  } catch (err) {
    logger.error('Device registration error:', err);
    return error(res, 'Internal server error.', 500);
  }
};
