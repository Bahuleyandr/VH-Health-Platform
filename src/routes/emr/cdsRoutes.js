// src/routes/emr/cdsRoutes.js
import express from 'express';
import { success, error } from '../../utils/responseHelper.js';
import logger from '../../logging/logger.js';
import { logPhiAccess } from '../../utils/hipaaAudit.js';
import cdsEngine from '../../services/emr/cdsEngine.js';

const router = express.Router();

// ===================================================================
// POST /emr/cds/check-order — Validate an order (returns alerts)
// ===================================================================

router.post('/cds/check-order', async (req, res, next) => {
  try {
    const { type, medication_name, test_name, details, patient_uid, encounter_id } = req.body;

    if (!type || !patient_uid) {
      return error(res, 'type and patient_uid are required', 400);
    }

    const order = {
      type,
      medication_name: medication_name || null,
      test_name: test_name || null,
      details: details || {},
      patient_uid,
      encounter_id: encounter_id || null,
    };

    const result = await cdsEngine.checkOrder(order);

    logPhiAccess({
      userId: req.user.uid,
      userRole: req.user.role,
      patientId: patient_uid,
      recordType: `cds_check:${type}`,
      action: 'CDS_CHECK',
      ip: req.ip,
      requestId: req.id,
    });

    return success(res, result, 'Order checked');
  } catch (err) {
    next(err);
  }
});

// ===================================================================
// GET /emr/cds/alerts/:patientUid — Active alerts for patient
// ===================================================================

router.get('/cds/alerts/:patientUid', async (req, res, next) => {
  try {
    const { patientUid } = req.params;

    const alerts = await cdsEngine.getActiveAlerts(patientUid);

    logPhiAccess({
      userId: req.user.uid,
      userRole: req.user.role,
      patientId: patientUid,
      recordType: 'cds_alerts',
      action: 'VIEW',
      ip: req.ip,
      requestId: req.id,
    });

    return success(res, alerts, 'Active alerts retrieved');
  } catch (err) {
    next(err);
  }
});

// ===================================================================
// POST /emr/cds/alerts/:id/acknowledge — Acknowledge/override alert
// ===================================================================

router.post('/cds/alerts/:id/acknowledge', async (req, res, next) => {
  try {
    const alertId = parseInt(req.params.id, 10);
    const { override_reason } = req.body;

    if (isNaN(alertId)) {
      return error(res, 'Valid alert ID is required', 400);
    }

    const acknowledged = await cdsEngine.acknowledgeAlert(alertId, req.user.uid, override_reason || null);

    logPhiAccess({
      userId: req.user.uid,
      userRole: req.user.role,
      patientId: acknowledged.patient_uid,
      recordType: 'cds_alert_acknowledge',
      action: 'UPDATE',
      ip: req.ip,
      requestId: req.id,
    });

    return success(res, acknowledged, 'Alert acknowledged');
  } catch (err) {
    next(err);
  }
});

// ===================================================================
// GET /emr/cds/protocols — List clinical protocols
// ===================================================================

router.get('/cds/protocols', async (req, res, next) => {
  try {
    const { category } = req.query;

    const protocols = await cdsEngine.listProtocols(category || null);

    return success(res, protocols, 'Protocols retrieved');
  } catch (err) {
    next(err);
  }
});

// ===================================================================
// POST /emr/cds/protocols — Create protocol (admin)
// ===================================================================

router.post('/cds/protocols', async (req, res, next) => {
  try {
    const { name, category, trigger_conditions, recommendations, priority, is_active } = req.body;

    if (!name || !category || !trigger_conditions || !recommendations) {
      return error(res, 'name, category, trigger_conditions, and recommendations are required', 400);
    }

    const protocol = await cdsEngine.createProtocol({
      name,
      category,
      trigger_conditions,
      recommendations,
      priority: priority || 'medium',
      is_active: is_active !== false,
    });

    return success(res, protocol, 'Protocol created', 201);
  } catch (err) {
    next(err);
  }
});

// ===================================================================
// GET /emr/cds/protocols/check/:patientUid — Check applicable protocols
// ===================================================================

router.get('/cds/protocols/check/:patientUid', async (req, res, next) => {
  try {
    const { patientUid } = req.params;
    const { encounter_id } = req.query;

    const reminders = await cdsEngine.getProtocolReminders(patientUid, encounter_id || null);

    logPhiAccess({
      userId: req.user.uid,
      userRole: req.user.role,
      patientId: patientUid,
      recordType: 'cds_protocol_check',
      action: 'CDS_CHECK',
      ip: req.ip,
      requestId: req.id,
    });

    return success(res, reminders, 'Protocol reminders retrieved');
  } catch (err) {
    next(err);
  }
});

export default router;
