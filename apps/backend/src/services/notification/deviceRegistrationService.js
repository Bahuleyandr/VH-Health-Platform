import { setTenantTx } from '../../lib/prisma.js';

async function claimNotificationDevice({
  tenantId,
  userUid,
  deviceId,
  fcmToken,
  deviceName = null,
  platform = null,
  appVersion = null,
  osVersion = null,
  requireExisting,
}) {
  return setTenantTx(tenantId, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `SELECT id, device_name, is_new_registration
         FROM public.notification_device_handoff(
           $1::uuid, $2::uuid, $3::text, $4::text, $5::text,
           $6::text, $7::text, $8::text, $9::boolean
         )`,
      tenantId,
      userUid,
      deviceId,
      fcmToken,
      deviceName ?? null,
      platform ?? null,
      appVersion ?? null,
      osVersion ?? null,
      requireExisting,
    );
    return rows[0];
  });
}

export async function registerNotificationDevice(options) {
  return claimNotificationDevice({ ...options, requireExisting: false });
}

export async function rotateNotificationDeviceToken(options) {
  return claimNotificationDevice({ ...options, requireExisting: true });
}
