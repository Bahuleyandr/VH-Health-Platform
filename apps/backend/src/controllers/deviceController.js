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
    // M8 (audit 2026-06-22): stamp tenant_id explicitly. `devices` is a FORCE-RLS
    // table whose tenant_id default reads app.current_tenant_id; this public
    // pre-auth endpoint runs without a tenant context, so the row fell back to
    // the DEFAULT tenant — post-cutover that mis-attributes the device. Use the
    // Host-resolved req.tenantId when present; COALESCE keeps the GUC→default
    // behaviour (single-tenant) when it is not.
    await prisma.$queryRawUnsafe(
      `INSERT INTO devices (phone, fcm_token, platform, tenant_id)
       VALUES ($1, $2, $3,
               COALESCE($4::uuid,
                        (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
                        '00000000-0000-4000-8000-000000000001'::uuid))
       ON CONFLICT (phone) DO UPDATE
       SET fcm_token = EXCLUDED.fcm_token,
           platform = EXCLUDED.platform,
           tenant_id = EXCLUDED.tenant_id,
           updated_at = NOW()`,
      phone, fcm_token, platform, req.tenantId ?? null
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
