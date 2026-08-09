import { success } from '../../utils/responseHelper.js';
import {
  acceptTransportTask,
  assignTransportTask,
  cancelTransportTask,
  completeTransportTask,
  createTransportTask,
  getTransportTask,
  listTransportTasks,
  listTransportZones,
  pickupTransportTask,
  readTransportSettings,
  updateTransportSettings,
  upsertTransportZone,
  verifyTransportTask,
} from '../../services/patientFlow/porterTransportService.js';

function actorUid(req) {
  return req.user?.uid ?? req.user?.user_uid ?? null;
}

function actorRole(req) {
  return req.user?.role ?? req.user?.role_code ?? null;
}

export async function getTransportSettings(req, res) {
  const settings = await readTransportSettings({ tenantId: req.tenantId });
  return success(res, { settings }, 'Transport settings retrieved');
}

export async function putTransportSettings(req, res) {
  const settings = await updateTransportSettings({
    tenantId: req.tenantId,
    enabled: req.body?.enabled,
    rosterDepartment: req.body?.roster_department ?? req.body?.rosterDepartment,
    rosterTargetType: req.body?.roster_target_type ?? req.body?.rosterTargetType,
    recipientRoleCodes: req.body?.recipient_role_codes ?? req.body?.recipientRoleCodes,
    escalationRoleCodes: req.body?.escalation_role_codes ?? req.body?.escalationRoleCodes,
    sourceSlaMinutes: req.body?.source_sla_minutes ?? req.body?.sourceSlaMinutes,
    sourcePriority: req.body?.source_priority ?? req.body?.sourcePriority,
    actorUid: actorUid(req),
    metadata: req.body?.metadata ?? {},
  });
  return success(res, { settings }, 'Transport settings saved');
}

export async function getTransportZones(req, res) {
  const zones = await listTransportZones({
    tenantId: req.tenantId,
    activeOnly: req.query?.active_only ?? req.query?.activeOnly,
  });
  return success(res, { zones }, 'Transport zones retrieved');
}

export async function putTransportZone(req, res) {
  const zone = await upsertTransportZone({
    tenantId: req.tenantId,
    zoneKey: req.params.zoneKey || req.body?.zone_key || req.body?.zoneKey,
    name: req.body?.name,
    zoneType: req.body?.zone_type ?? req.body?.zoneType,
    building: req.body?.building,
    floor: req.body?.floor,
    roleCodes: req.body?.role_codes ?? req.body?.roleCodes,
    isActive: req.body?.is_active ?? req.body?.isActive ?? true,
    sortOrder: req.body?.sort_order ?? req.body?.sortOrder,
    metadata: req.body?.metadata ?? {},
  });
  return success(res, { zone }, 'Transport zone saved');
}

export async function postTransportTask(req, res) {
  const result = await createTransportTask({
    tenantId: req.tenantId,
    actorUid: actorUid(req),
    actorRole: actorRole(req),
    body: req.body ?? {},
  });
  return success(res, result, 'Transport task created', 201);
}

export async function getTransportTasks(req, res) {
  const tasks = await listTransportTasks({
    tenantId: req.tenantId,
    status: req.query?.status,
    patientUid: req.query?.patient_uid ?? req.query?.patientUid,
    sourceType: req.query?.source_type ?? req.query?.sourceType,
    limit: req.query?.limit,
  });
  return success(res, { tasks }, 'Transport tasks retrieved');
}

export async function getMyTransportTasks(req, res) {
  const tasks = await listTransportTasks({
    tenantId: req.tenantId,
    status: req.query?.status,
    assignedToMeUid: actorUid(req),
    limit: req.query?.limit,
  });
  return success(res, { tasks }, 'Assigned transport tasks retrieved');
}

export async function getTransportTaskById(req, res) {
  const result = await getTransportTask({
    tenantId: req.tenantId,
    taskId: req.params.taskId,
  });
  return success(res, result, 'Transport task retrieved');
}

export async function postTransportTaskAssign(req, res) {
  const task = await assignTransportTask({
    tenantId: req.tenantId,
    taskId: req.params.taskId,
    actorUid: actorUid(req),
    actorRole: actorRole(req),
    body: req.body ?? {},
  });
  return success(res, { task }, 'Transport task assigned');
}

export async function postTransportTaskAccept(req, res) {
  const task = await acceptTransportTask({
    tenantId: req.tenantId,
    taskId: req.params.taskId,
    actorUid: actorUid(req),
    actorRole: actorRole(req),
    body: req.body ?? {},
  });
  return success(res, { task }, 'Transport task accepted');
}

export async function postTransportTaskPickup(req, res) {
  const task = await pickupTransportTask({
    tenantId: req.tenantId,
    taskId: req.params.taskId,
    actorUid: actorUid(req),
    actorRole: actorRole(req),
    body: req.body ?? {},
  });
  return success(res, { task }, 'Transport task picked up');
}

export async function postTransportTaskComplete(req, res) {
  const task = await completeTransportTask({
    tenantId: req.tenantId,
    taskId: req.params.taskId,
    actorUid: actorUid(req),
    actorRole: actorRole(req),
    body: req.body ?? {},
  });
  return success(res, { task }, 'Transport task completed');
}

export async function postTransportTaskVerify(req, res) {
  const task = await verifyTransportTask({
    tenantId: req.tenantId,
    taskId: req.params.taskId,
    actorUid: actorUid(req),
    actorRole: actorRole(req),
    body: req.body ?? {},
  });
  return success(res, { task }, 'Transport handoff verified');
}

export async function postTransportTaskCancel(req, res) {
  const task = await cancelTransportTask({
    tenantId: req.tenantId,
    taskId: req.params.taskId,
    actorUid: actorUid(req),
    actorRole: actorRole(req),
    body: req.body ?? {},
  });
  return success(res, { task }, 'Transport task cancelled');
}
