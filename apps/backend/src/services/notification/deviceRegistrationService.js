import { setTenant, setTenantTx } from '../../lib/prisma.js';

function notificationAudience(row) {
  if (!row) return null;
  return Object.freeze({
    version: 1,
    tenantId: String(row.tenant_id),
    recipientUid: String(row.recipient_uid),
    deviceId: String(row.device_id),
    registrationEpoch: String(row.registration_epoch),
    sessionEpoch: String(row.session_epoch),
    authorizationEpoch: String(row.authorization_epoch),
    sessionExpiresAt: new Date(row.session_expires_at).toISOString(),
  });
}

async function claimNotificationDevice({
  tenantId,
  userUid,
  deviceId,
  fcmToken,
  deviceName = null,
  platform = null,
  appVersion = null,
  osVersion = null,
  sessionJti = null,
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
    const registration = rows[0];
    if (!registration || !sessionJti) return registration;
    const authorityRows = await tx.$queryRawUnsafe(
      `SELECT ud.tenant_id::text,
              ud.user_uid::text AS recipient_uid,
              ud.device_id,
              ud.notification_epoch::text AS registration_epoch,
              uas.session_family_id AS session_epoch,
              u.token_epoch::text AS authorization_epoch,
              uas.expires_at AS session_expires_at
         FROM user_devices ud
         JOIN users u
           ON u.tenant_id = ud.tenant_id
          AND u.uid = ud.user_uid
         JOIN user_active_sessions uas
           ON uas.tenant_id = u.tenant_id
          AND uas.user_uid = u.uid
        WHERE ud.tenant_id = $1::uuid
          AND ud.user_uid = $2::uuid
          AND ud.device_id = $3::text
          AND ud.fcm_token = $4::text
          AND u.is_active = TRUE
          AND uas.jti = $5::text
          AND uas.session_family_id IS NOT NULL
          AND uas.expires_at > NOW()
          AND (u.token_epoch_bumped_at IS NULL OR uas.issued_at >= u.token_epoch_bumped_at)
          AND (uas.stable_device_id IS NULL OR uas.stable_device_id::text = ud.device_id)
        LIMIT 1`,
      tenantId,
      userUid,
      deviceId,
      fcmToken,
      sessionJti,
    );
    return {
      ...registration,
      notification_authority: notificationAudience(authorityRows[0]),
    };
  });
}

export async function registerNotificationDevice(options) {
  return claimNotificationDevice({ ...options, requireExisting: false });
}

export async function rotateNotificationDeviceToken(options) {
  return claimNotificationDevice({ ...options, requireExisting: true });
}

export async function validateNotificationAuthority({
  tenantId,
  userUid,
  sessionJti,
  deviceId,
  registrationEpoch,
  sessionEpoch,
  authorizationEpoch,
}) {
  if (!tenantId || !userUid || !sessionJti || !deviceId) return false;
  const rows = await setTenant(
    tenantId,
    tx => tx.$queryRawUnsafe(
      `SELECT 1
         FROM user_devices ud
         JOIN users u
           ON u.tenant_id = ud.tenant_id
          AND u.uid = ud.user_uid
         JOIN user_active_sessions uas
           ON uas.tenant_id = u.tenant_id
          AND uas.user_uid = u.uid
        WHERE ud.tenant_id = $1::uuid
          AND ud.user_uid = $2::uuid
          AND ud.device_id = $3::text
          AND ud.fcm_token IS NOT NULL
          AND ud.notification_epoch = $4::bigint
          AND u.is_active = TRUE
          AND uas.session_family_id = $5::text
          AND u.token_epoch = $6::int
          AND uas.jti = $7::text
          AND uas.expires_at > NOW()
          AND (u.token_epoch_bumped_at IS NULL OR uas.issued_at >= u.token_epoch_bumped_at)
          AND (uas.stable_device_id IS NULL OR uas.stable_device_id::text = ud.device_id)
        LIMIT 1`,
      tenantId,
      userUid,
      deviceId,
      registrationEpoch,
      sessionEpoch,
      authorizationEpoch,
      sessionJti,
    ),
    { readOnly: true },
  );
  return rows.length > 0;
}
