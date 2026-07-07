import { success } from '../../utils/responseHelper.js';
import {
  createKioskSession,
  listKioskSettings,
  patientKioskCheckin,
  supervisedKioskCheckin,
  upsertKioskSetting,
} from '../../services/patientFlow/kioskCheckinService.js';

function actorUid(req) {
  return req.user?.uid ?? req.user?.user_uid ?? null;
}

export async function getKioskSettings(req, res) {
  const settings = await listKioskSettings({ tenantId: req.tenantId });
  return success(res, { settings }, 'Kiosk settings retrieved');
}

export async function putKioskSetting(req, res) {
  const setting = await upsertKioskSetting({
    tenantId: req.tenantId,
    department: req.params.departmentKey || req.body?.department,
    selfServiceEnabled: req.body?.self_service_enabled ?? req.body?.selfServiceEnabled,
    supervisedModeEnabled: req.body?.supervised_mode_enabled ?? req.body?.supervisedModeEnabled,
    qrOtpRequired: req.body?.qr_otp_required ?? req.body?.qrOtpRequired ?? true,
    safeProfileFields: req.body?.safe_profile_fields ?? req.body?.safeProfileFields,
    actorUid: actorUid(req),
    metadata: req.body?.metadata ?? {},
  });
  return success(res, { setting }, 'Kiosk setting saved');
}

export async function postKioskSession(req, res) {
  const result = await createKioskSession({
    tenantId: req.tenantId,
    department: req.body?.department ?? req.body?.department_key ?? req.body?.departmentKey,
    channel: req.body?.channel,
    deviceLabel: req.body?.device_label ?? req.body?.deviceLabel,
    ttlMinutes: req.body?.ttl_minutes ?? req.body?.ttlMinutes,
    actorUid: actorUid(req),
    metadata: req.body?.metadata ?? {},
  });
  return success(res, result, 'Kiosk session created', 201);
}

export async function postPatientCheckin(req, res) {
  const result = await patientKioskCheckin({
    tenantId: req.tenantId,
    patientUid: actorUid(req),
    actorUid: actorUid(req),
    body: req.body ?? {},
  });
  const status = result.checkin?.front_desk_required ? 202 : 201;
  const message = result.checkin?.front_desk_required
    ? 'Front desk review required'
    : 'Patient checked in';
  return success(res, result, message, status);
}

export async function postSupervisedCheckin(req, res) {
  const result = await supervisedKioskCheckin({
    tenantId: req.tenantId,
    actorUid: actorUid(req),
    body: req.body ?? {},
  });
  const status = result.checkin?.front_desk_required ? 202 : 201;
  const message = result.checkin?.front_desk_required
    ? 'Front desk review required'
    : 'Patient checked in';
  return success(res, result, message, status);
}
