import express from 'express';
import { success, error } from '../../../utils/responseHelper.js';
import { normalizeRole } from './shared.js';
import {
  assignWorkOrder,
  completeWorkOrder,
  createCalibrationCertificate,
  createDeviceFaultWorkOrder,
  createSchedule,
  createWorkOrder,
  createWorkOrderFromPrediction,
  escalateBreachedWorkOrders,
  listCalibrationCertificates,
  listCmmsBoard,
  listMyWorkOrders,
  listSchedules,
  listWorkOrders,
  materializeDueMaintenanceSchedules,
  startWorkOrder,
  verifyWorkOrder,
} from '../../../services/biomed/biomedCmmsService.js';
import { logClinicalAiAudit } from './audit.js';

const router = express.Router();

const CMMS_ROLES = new Set([
  'BIOMEDICAL_STAFF',
  'MAINTENANCE',
  'FACILITY_MANAGER',
  'ADMIN',
  'SUPER_ADMIN',
  'CMO',
  'MEDICAL_SUPERINTENDENT',
  'IT_ADMIN',
  'IT',
]);

function requireBiomedCmmsRole(req, res, next) {
  const role = normalizeRole(req.user?.role);
  const rawRole = normalizeRole(req.user?.rawRole);
  if (CMMS_ROLES.has(role) || CMMS_ROLES.has(rawRole)) return next();
  return error(res, 'Biomedical CMMS requires biomedical, maintenance, facility, or admin role', 403, {
    code: 'BIOMED_CMMS_ROLE_REQUIRED',
    safe: true,
  });
}

function actor(req) {
  return {
    actorId: req.user?.id || null,
    actorUid: req.user?.uid || null,
    actorRole: req.user?.role || null,
  };
}

router.use(requireBiomedCmmsRole);

router.get('/board', async (req, res, next) => {
  try {
    const result = await listCmmsBoard({ tenantId: req.tenantId, limit: req.query?.limit });
    return success(res, result, 'Biomedical CMMS board retrieved');
  } catch (err) {
    return next(err);
  }
});

router.get('/work-orders', async (req, res, next) => {
  try {
    const result = await listWorkOrders({
      tenantId: req.tenantId,
      status: req.query?.status || null,
      assignedToId: req.query?.assigned_to_id || null,
      assignedToUid: req.query?.assigned_to_uid || null,
      source: req.query?.source || null,
      deviceId: req.query?.biomed_device_id || null,
      limit: req.query?.limit,
    });
    return success(res, result, 'Biomedical work orders retrieved');
  } catch (err) {
    return next(err);
  }
});

router.get('/work-orders/my', async (req, res, next) => {
  try {
    const result = await listMyWorkOrders({
      tenantId: req.tenantId,
      userId: req.user?.id || null,
      userUid: req.user?.uid || null,
      limit: req.query?.limit,
    });
    return success(res, result, 'My biomedical work orders retrieved');
  } catch (err) {
    return next(err);
  }
});

router.post('/work-orders', async (req, res, next) => {
  try {
    const result = await createWorkOrder({
      tenantId: req.tenantId,
      biomedDeviceId: req.body?.biomed_device_id,
      kind: req.body?.kind,
      priority: req.body?.priority,
      description: req.body?.description,
      assignedToId: req.body?.assigned_to_id,
      assignedToUid: req.body?.assigned_to_uid,
      assignedToRole: req.body?.assigned_to_role,
      assignedVendor: req.body?.assigned_vendor,
      slaDueAt: req.body?.sla_due_at,
      source: req.body?.source || 'manual',
      sourceRef: req.body?.source_ref,
      metadata: req.body?.metadata || {},
      ...actor(req),
    });
    await logClinicalAiAudit(req, 'BIOMED_CMMS_WORK_ORDER_CREATED', String(result.id), null, result);
    return success(res, result, 'Biomedical work order created', 201);
  } catch (err) {
    return next(err);
  }
});

router.post('/work-orders/materialize-due', async (req, res, next) => {
  try {
    const result = await materializeDueMaintenanceSchedules({
      tenantId: req.tenantId,
      now: req.body?.now || new Date(),
      limit: req.body?.limit,
    });
    await logClinicalAiAudit(req, 'BIOMED_CMMS_SCHEDULES_MATERIALIZED', 'materialize-due', null, result);
    return success(res, result, 'Due biomedical schedules materialized', 201);
  } catch (err) {
    return next(err);
  }
});

router.post('/work-orders/escalate-breaches', async (req, res, next) => {
  try {
    const result = await escalateBreachedWorkOrders({
      tenantId: req.tenantId,
      now: req.body?.now || new Date(),
      limit: req.body?.limit,
    });
    await logClinicalAiAudit(req, 'BIOMED_CMMS_SLA_BREACHES_ESCALATED', 'sla-breaches', null, result);
    return success(res, result, 'Biomedical SLA breaches escalated');
  } catch (err) {
    return next(err);
  }
});

router.post('/work-orders/from-prediction/:id', async (req, res, next) => {
  try {
    const result = await createWorkOrderFromPrediction({
      tenantId: req.tenantId,
      predictionId: req.params.id,
      actorUid: req.user?.uid || null,
      actorRole: req.user?.role || null,
    });
    await logClinicalAiAudit(req, 'BIOMED_CMMS_WORK_ORDER_FROM_AI_PREDICTION', String(result.id), null, result);
    return success(res, result, 'Biomedical work order created from accepted prediction', 201);
  } catch (err) {
    return next(err);
  }
});

router.post('/work-orders/device-fault', async (req, res, next) => {
  try {
    const result = await createDeviceFaultWorkOrder({
      tenantId: req.tenantId,
      biomedDeviceId: req.body?.biomed_device_id,
      deviceRegistryId: req.body?.device_registry_id,
      sourceRef: req.body?.source_ref,
      faultCode: req.body?.fault_code,
      description: req.body?.description,
      priority: req.body?.priority || 'urgent',
      actorUid: req.user?.uid || null,
      actorRole: req.user?.role || 'DEVICE_GATEWAY',
      metadata: req.body?.metadata || {},
    });
    await logClinicalAiAudit(req, 'BIOMED_CMMS_WORK_ORDER_FROM_DEVICE_FAULT', String(result.id), null, result);
    return success(res, result, 'Biomedical fault work order created', 201);
  } catch (err) {
    return next(err);
  }
});

router.post('/work-orders/:id/assign', async (req, res, next) => {
  try {
    const result = await assignWorkOrder({
      tenantId: req.tenantId,
      workOrderId: req.params.id,
      assignedToId: req.body?.assigned_to_id,
      assignedToUid: req.body?.assigned_to_uid,
      assignedToRole: req.body?.assigned_to_role,
      assignedVendor: req.body?.assigned_vendor,
      ...actor(req),
    });
    return success(res, result, 'Biomedical work order assigned');
  } catch (err) {
    return next(err);
  }
});

router.post('/work-orders/:id/start', async (req, res, next) => {
  try {
    const result = await startWorkOrder({ tenantId: req.tenantId, workOrderId: req.params.id, ...actor(req) });
    return success(res, result, 'Biomedical work order started');
  } catch (err) {
    return next(err);
  }
});

router.post('/work-orders/:id/complete', async (req, res, next) => {
  try {
    const result = await completeWorkOrder({
      tenantId: req.tenantId,
      workOrderId: req.params.id,
      completionNotes: req.body?.completion_notes,
      partsUsed: req.body?.parts_used,
      costAmount: req.body?.cost_amount,
      downtimeEndedAt: req.body?.downtime_ended_at,
      ...actor(req),
    });
    return success(res, result, 'Biomedical work order completed');
  } catch (err) {
    return next(err);
  }
});

router.post('/work-orders/:id/verify', async (req, res, next) => {
  try {
    const result = await verifyWorkOrder({ tenantId: req.tenantId, workOrderId: req.params.id, ...actor(req) });
    return success(res, result, 'Biomedical work order verified');
  } catch (err) {
    return next(err);
  }
});

router.get('/schedules', async (req, res, next) => {
  try {
    const result = await listSchedules({
      tenantId: req.tenantId,
      deviceId: req.query?.biomed_device_id || null,
      active: req.query?.active,
      limit: req.query?.limit,
    });
    return success(res, result, 'Biomedical schedules retrieved');
  } catch (err) {
    return next(err);
  }
});

router.post('/schedules', async (req, res, next) => {
  try {
    const result = await createSchedule({
      tenantId: req.tenantId,
      biomedDeviceId: req.body?.biomed_device_id,
      kind: req.body?.kind,
      intervalDays: req.body?.interval_days,
      intervalUsageHours: req.body?.interval_usage_hours,
      nextDueAt: req.body?.next_due_at,
      nextDueUsageHours: req.body?.next_due_usage_hours,
      assignedRole: req.body?.assigned_role,
      assignedToId: req.body?.assigned_to_id,
      assignedToUid: req.body?.assigned_to_uid,
      assignedVendor: req.body?.assigned_vendor,
      active: req.body?.active ?? true,
      actorUid: req.user?.uid || null,
      metadata: req.body?.metadata || {},
    });
    return success(res, result, 'Biomedical schedule saved', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/calibration-certificates', async (req, res, next) => {
  try {
    const result = await listCalibrationCertificates({
      tenantId: req.tenantId,
      deviceId: req.query?.biomed_device_id || null,
      limit: req.query?.limit,
    });
    return success(res, result, 'Biomedical calibration certificates retrieved');
  } catch (err) {
    return next(err);
  }
});

router.post('/calibration-certificates', async (req, res, next) => {
  try {
    const result = await createCalibrationCertificate({
      tenantId: req.tenantId,
      biomedDeviceId: req.body?.biomed_device_id,
      workOrderId: req.body?.work_order_id,
      certificateNumber: req.body?.certificate_number,
      calibratedAt: req.body?.calibrated_at,
      dueAt: req.body?.due_at,
      performedBy: req.body?.performed_by,
      performedByUid: req.body?.performed_by_uid,
      documentId: req.body?.document_id,
      documentStorageKey: req.body?.document_storage_key,
      documentMimeType: req.body?.document_mime_type,
      result: req.body?.result,
      notes: req.body?.notes,
      actorUid: req.user?.uid || null,
      metadata: req.body?.metadata || {},
      rawPayload: req.body || {},
    });
    await logClinicalAiAudit(req, 'BIOMED_CMMS_CALIBRATION_CERTIFICATE_CREATED', String(result.id), null, result);
    return success(res, result, 'Biomedical calibration certificate saved', 201);
  } catch (err) {
    return next(err);
  }
});

export default router;
