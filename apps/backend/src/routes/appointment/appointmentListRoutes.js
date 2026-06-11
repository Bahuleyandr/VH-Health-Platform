import express from 'express';
import { APPOINTMENT_STAFF_ROUTE_ROLES } from '../../config/routeRolePolicy.js';
import * as listController from '../../controllers/appointment/appointmentListController.js';
import { patientAccessGuard, patientAccessGuardForResource } from '../../middleware/phiAccessMiddleware.js';
import { requireRole } from '../../middleware/rbacMiddleware.js';
import { ACCESS_POLICY_CODES } from '../../services/security/accessDecisionService.js';
import * as validators from '../../validators/appointment/appointmentQueryValidators.js';

const router = express.Router();
const guardAppointmentView = patientAccessGuardForResource('APPOINTMENT', {
  policyCode: ACCESS_POLICY_CODES.PATIENT_APPOINTMENT_VIEW,
  resourceType: 'appointment',
  allowNoPatientResource: true,
});

// Test route
router.get('/test', listController.testRoute);

// List appointments with filters and pagination
router.get('/list', validators.listAppointmentsValidators, listController.listAppointments);
// Alias at the resource root — admission counter expected GET
// /api/v1/appointments?advised_for_admission=true to surface the
// worklist of patients advised for admission. Finding:
// 2026-05-09-inpatient-admission-receptionist-no-admission-queue-endpoint.
router.get('/', validators.listAppointmentsValidators, listController.listAppointments);

// Recent completed appointments for document upload pickers.
// Staff-only: returns OTHER patients' names + visit dates (audit finding H2 —
// this was reachable by any authenticated user, including PATIENT).
router.get(
  '/completed/recent',
  requireRole(...APPOINTMENT_STAFF_ROUTE_ROLES),
  listController.getRecentCompletedAppointments
);

// Get today's appointments
router.get('/today/list', listController.getTodayAppointments);

// Get doctor appointments
router.get('/doctor/:doctor_id', validators.getDoctorAppointmentsValidators, listController.getDoctorAppointments);

// Get patient appointments  
router.get('/patient/:patient_id', validators.getPatientAppointmentsValidators, patientAccessGuard('APPOINTMENT', {
  policyCode: ACCESS_POLICY_CODES.PATIENT_APPOINTMENT_VIEW,
}), listController.getPatientAppointments);

// Get appointment by ID
router.get('/:id', validators.getAppointmentByIdValidators, guardAppointmentView, listController.getAppointmentById);

export default router;
