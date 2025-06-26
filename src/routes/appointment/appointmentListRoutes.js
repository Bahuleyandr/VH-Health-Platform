import express from 'express';
import * as listController from '../../controllers/appointment/appointmentListController.js';
import * as validators from '../../validators/appointment/appointmentQueryValidators.js';

const router = express.Router();

// Test route
router.get('/test', listController.testRoute);

// List appointments with filters and pagination
router.get('/list', validators.listAppointmentsValidators, listController.listAppointments);

// Get appointment by ID
router.get('/:id', validators.getAppointmentByIdValidators, listController.getAppointmentById);

// Get doctor appointments
router.get('/doctor/:doctor_id', validators.getDoctorAppointmentsValidators, listController.getDoctorAppointments);

// Get patient appointments  
router.get('/patient/:patient_id', validators.getPatientAppointmentsValidators, listController.getPatientAppointments);

// Get today's appointments
router.get('/today/list', listController.getTodayAppointments);

export default router;