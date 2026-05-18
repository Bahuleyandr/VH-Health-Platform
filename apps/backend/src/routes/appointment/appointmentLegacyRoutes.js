import express from 'express';
import * as crudController from '../../controllers/appointment/appointmentCrudController.js';
import * as legacyController from '../../controllers/appointment/appointmentLegacyController.js';
import { sanitizeAppointmentFields } from '../../middleware/sanitizeMiddleware.js';
import {
  createAppointmentValidators,
  legacyAppointmentValidators,
} from '../../validators/appointment/appointmentValidators.js';

const router = express.Router();

function isModernAppointmentPayload(body = {}) {
  return Boolean(
    body.patient_id ||
    body.patient_phone ||
    body.patient_name ||
    body.doctor_id ||
    body.appointment_date ||
    body.appointment_time ||
    body.visit_type ||
    body.department ||
    body.confirm_duplicate !== undefined
  );
}

function requireModernAppointmentPayload(req, _res, next) {
  return isModernAppointmentPayload(req.body) ? next() : next('route');
}

function normalizeModernAppointmentAliases(req, _res, next) {
  if (req.body) {
    if (!req.body.patient_phone && (req.body.phone || req.body.phoneNumber)) {
      req.body.patient_phone = req.body.phone || req.body.phoneNumber;
    }
    if (!req.body.appointment_date && req.body.date) {
      req.body.appointment_date = req.body.date;
    }
    if (!req.body.appointment_time && req.body.time) {
      req.body.appointment_time = req.body.time;
    }
  }
  next();
}

// Legacy routes for backward compatibility
router.post(
  '/',
  requireModernAppointmentPayload,
  normalizeModernAppointmentAliases,
  createAppointmentValidators,
  sanitizeAppointmentFields,
  crudController.createAppointment,
);
router.post('/', legacyAppointmentValidators, legacyController.createLegacyAppointment);
router.get('/phone/:phone', legacyController.getAppointmentsByPhone);
router.get('/uid/:uid', legacyController.getAppointmentsByUID);

export default router;
