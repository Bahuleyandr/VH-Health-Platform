// src/routes/appointmentRoutes.js - COMPLETE PRODUCTION VERSION WITH RBAC
import express from 'express';
import db from '../config/database.js';
import { success, error } from '../utils/responseHelper.js';
import logger from '../logging/logger.js';
import * as appointmentController from '../controllers/appointmentController.js';
import { appointmentValidator } from '../config/validationSchemas.js';
import { HTTP_STATUS, RESPONSE_MESSAGES } from '../config/responseCodes.js';
import { validationResult } from 'express-validator';
import { wrapAutoRBAC } from '../config/routeWrapper.js';
import { normalizePhone } from '../utils/phoneUtils.js';

const router = express.Router();
console.log('✅ appointmentRoutes loaded with RBAC protection');

/**
 * ✅ Centralized appointment routes with RBAC protection
 * Applies RBAC, audit log, identity check, and validation
 * Accessible to all authenticated users with role-based permissions
 */
wrapAutoRBAC(
  router,
  'appointmentRoutes',
  {
    get: [
      // Test route
      [
        '/test',
        (req, res) => {
          res.json({ 
            message: 'Appointment routes working!',
            timestamp: new Date().toISOString(),
            version: '2.0.0',
            user: req.user?.name || 'Unknown'
          });
        }
      ],

      // Get all appointments with filtering and pagination (Admin/Doctor access)
      [
        '/list',
        async (req, res) => {
          try {
            // Role-based access control
            if (!['ADMIN', 'DOCTOR', 'NURSE'].includes(req.user?.role)) {
              return error(res, 'Insufficient permissions to view all appointments', HTTP_STATUS.FORBIDDEN);
            }

            const page = parseInt(req.query.page) || 1;
            const limit = parseInt(req.query.limit) || 10;
            const offset = (page - 1) * limit;
            const status = req.query.status; // SCHEDULED, COMPLETED, CANCELLED
            const doctor_id = req.query.doctor_id;
            const patient_id = req.query.patient_id;
            const date = req.query.date; // YYYY-MM-DD format
            
            let query = `
              SELECT a.id, a.appointment_date, a.appointment_time, a.status, a.reason, a.notes,
                     a.created_at, a.updated_at,
                     p.name as patient_name, p.phone as patient_phone, p.id as patient_id,
                     d.name as doctor_name, d.phone as doctor_phone, d.id as doctor_id,
                     dp.specialization, dp.department
              FROM appointments a
              LEFT JOIN users p ON a.patient_id = p.id
              LEFT JOIN users d ON a.doctor_id = d.id  
              LEFT JOIN doctors dp ON d.id = dp.user_id
              WHERE 1=1
            `;
            let params = [];
            
            // If user is a doctor, only show their appointments
            if (req.user?.role === 'DOCTOR') {
              query += ' AND a.doctor_id = $' + (params.length + 1);
              params.push(req.user.id);
            }
            
            if (status) {
              query += ' AND a.status = $' + (params.length + 1);
              params.push(status.toUpperCase());
            }
            
            if (doctor_id) {
              query += ' AND a.doctor_id = $' + (params.length + 1);
              params.push(doctor_id);
            }
            
            if (patient_id) {
              query += ' AND a.patient_id = $' + (params.length + 1);
              params.push(patient_id);
            }
            
            if (date) {
              query += ' AND DATE(a.appointment_date) = $' + (params.length + 1);
              params.push(date);
            }
            
            query += ' ORDER BY a.appointment_date, a.appointment_time LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2);
            params.push(limit, offset);
            
            const result = await db.query(query, params);
            
            // Get total count with same filters
            let countQuery = 'SELECT COUNT(*) FROM appointments a WHERE 1=1';
            let countParams = [];
            
            if (req.user?.role === 'DOCTOR') {
              countQuery += ' AND a.doctor_id = $' + (countParams.length + 1);
              countParams.push(req.user.id);
            }
            if (status) {
              countQuery += ' AND a.status = $' + (countParams.length + 1);
              countParams.push(status.toUpperCase());
            }
            if (doctor_id) {
              countQuery += ' AND a.doctor_id = $' + (countParams.length + 1);
              countParams.push(doctor_id);
            }
            if (patient_id) {
              countQuery += ' AND a.patient_id = $' + (countParams.length + 1);
              countParams.push(patient_id);
            }
            if (date) {
              countQuery += ' AND DATE(a.appointment_date) = $' + (countParams.length + 1);
              countParams.push(date);
            }
            
            const countResult = await db.query(countQuery, countParams);
            const totalAppointments = parseInt(countResult.rows[0].count);
            
            success(res, {
              appointments: result.rows,
              pagination: {
                page,
                limit,
                total: totalAppointments,
                totalPages: Math.ceil(totalAppointments / limit),
                hasNext: page * limit < totalAppointments,
                hasPrev: page > 1
              },
              filters: {
                status: status || null,
                doctor_id: doctor_id || null,
                patient_id: patient_id || null,
                date: date || null
              },
              requestedBy: req.user?.name
            }, 'Appointments retrieved successfully');
          } catch (err) {
            logger.error('Database error for appointments list:', err);
            error(res, 'Failed to retrieve appointments - appointments table may not exist', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ],

      // Get appointment by ID
      [
        '/:id',
        async (req, res) => {
          try {
            const { id } = req.params;
            
            let query = `
              SELECT a.*, 
                     p.name as patient_name, p.phone as patient_phone, p.email as patient_email,
                     d.name as doctor_name, d.phone as doctor_phone, d.email as doctor_email,
                     dp.specialization, dp.department, dp.consultation_fee
              FROM appointments a
              LEFT JOIN users p ON a.patient_id = p.id
              LEFT JOIN users d ON a.doctor_id = d.id
              LEFT JOIN doctors dp ON d.id = dp.user_id
              WHERE a.id = $1
            `;
            let params = [id];
            
            // Role-based access control
            if (req.user?.role === 'PATIENT') {
              query += ' AND a.patient_id = $2';
              params.push(req.user.id);
            } else if (req.user?.role === 'DOCTOR') {
              query += ' AND a.doctor_id = $2';
              params.push(req.user.id);
            }
            // ADMIN and NURSE can see all appointments
            
            const result = await db.query(query, params);
            
            if (result.rows.length === 0) {
              return error(res, 'Appointment not found or access denied', HTTP_STATUS.NOT_FOUND);
            }
            
            success(res, {
              appointment: result.rows[0],
              accessedBy: req.user?.name
            }, 'Appointment retrieved successfully');
          } catch (err) {
            logger.error('Database error:', err);
            error(res, 'Failed to retrieve appointment', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ],

      // Get appointments for a specific doctor
      [
        '/doctor/:doctor_id',
        async (req, res) => {
          try {
            const { doctor_id } = req.params;
            const date = req.query.date; // Optional date filter
            const status = req.query.status || 'SCHEDULED'; // Default to scheduled
            
            // Role-based access control
            if (req.user?.role === 'DOCTOR' && req.user.id !== parseInt(doctor_id)) {
              return error(res, 'Can only view your own appointments', HTTP_STATUS.FORBIDDEN);
            }
            
            let query = `
              SELECT a.id, a.appointment_date, a.appointment_time, a.status, a.reason, a.notes,
                     p.name as patient_name, p.phone as patient_phone, p.id as patient_id,
                     p.email as patient_email
              FROM appointments a
              LEFT JOIN users p ON a.patient_id = p.id
              WHERE a.doctor_id = $1 AND a.status = $2
            `;
            let params = [doctor_id, status.toUpperCase()];
            
            if (date) {
              query += ' AND DATE(a.appointment_date) = $3';
              params.push(date);
            }
            
            query += ' ORDER BY a.appointment_date, a.appointment_time';
            
            const result = await db.query(query, params);
            
            success(res, {
              appointments: result.rows,
              count: result.rows.length,
              doctor_id,
              filters: { status, date: date || null },
              requestedBy: req.user?.name
            }, 'Doctor appointments retrieved successfully');
          } catch (err) {
            logger.error('Database error:', err);
            error(res, 'Failed to retrieve doctor appointments', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ],

      // Get appointments for a specific patient
      [
        '/patient/:patient_id',
        async (req, res) => {
          try {
            const { patient_id } = req.params;
            const status = req.query.status; // Optional status filter
            
            // Role-based access control
            if (req.user?.role === 'PATIENT' && req.user.id !== parseInt(patient_id)) {
              return error(res, 'Can only view your own appointments', HTTP_STATUS.FORBIDDEN);
            }
            
            let query = `
              SELECT a.id, a.appointment_date, a.appointment_time, a.status, a.reason, a.notes,
                     a.created_at, a.updated_at,
                     d.name as doctor_name, d.phone as doctor_phone, d.id as doctor_id,
                     dp.specialization, dp.department, dp.consultation_fee
              FROM appointments a
              LEFT JOIN users d ON a.doctor_id = d.id
              LEFT JOIN doctors dp ON d.id = dp.user_id
              WHERE a.patient_id = $1
            `;
            let params = [patient_id];
            
            if (status) {
              query += ' AND a.status = $2';
              params.push(status.toUpperCase());
            }
            
            query += ' ORDER BY a.appointment_date DESC, a.appointment_time DESC';
            
            const result = await db.query(query, params);
            
            success(res, {
              appointments: result.rows,
              count: result.rows.length,
              patient_id,
              filter: status ? { status } : null,
              requestedBy: req.user?.name
            }, 'Patient appointments retrieved successfully');
          } catch (err) {
            logger.error('Database error:', err);
            error(res, 'Failed to retrieve patient appointments', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ],

      // Get today's appointments
      [
        '/today/list',
        async (req, res) => {
          try {
            // Role-based access control
            if (!['ADMIN', 'DOCTOR', 'NURSE', 'RECEPTIONIST'].includes(req.user?.role)) {
              return error(res, 'Insufficient permissions to view today\'s appointments', HTTP_STATUS.FORBIDDEN);
            }

            const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
            
            let query = `
              SELECT a.id, a.appointment_time, a.status, a.reason,
                     p.name as patient_name, p.phone as patient_phone,
                     d.name as doctor_name, dp.department, dp.specialization
              FROM appointments a
              LEFT JOIN users p ON a.patient_id = p.id
              LEFT JOIN users d ON a.doctor_id = d.id
              LEFT JOIN doctors dp ON d.id = dp.user_id
              WHERE DATE(a.appointment_date) = $1
            `;
            let params = [today];
            
            // If user is a doctor, only show their appointments
            if (req.user?.role === 'DOCTOR') {
              query += ' AND a.doctor_id = $2';
              params.push(req.user.id);
            }
            
            query += ' ORDER BY a.appointment_time';
            
            const result = await db.query(query, params);
            
            success(res, {
              appointments: result.rows,
              count: result.rows.length,
              date: today,
              requestedBy: req.user?.name
            }, 'Today\'s appointments retrieved successfully');
          } catch (err) {
            logger.error('Database error:', err);
            error(res, 'Failed to retrieve today\'s appointments', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ],

      // Legacy route with phone parameter (from deprecated version)
      [
        '/phone/:phone',
        async (req, res) => {
          try {
            const phone = normalizePhone(req.params.phone);
            
            // Role-based access control
            if (req.user?.role === 'PATIENT' && req.user.phone !== phone) {
              return error(res, 'Can only view your own appointments', HTTP_STATUS.FORBIDDEN);
            }
            
            const result = await db.query(`
              SELECT a.*, d.name as doctor_name, dp.department, dp.specialization
              FROM appointments a
              LEFT JOIN users d ON a.doctor_id = d.id
              LEFT JOIN doctors dp ON d.id = dp.user_id
              LEFT JOIN users p ON a.patient_id = p.id
              WHERE p.phone = $1 
              ORDER BY a.appointment_date DESC
            `, [phone]);
            
            success(res, result.rows, 'Appointments fetched successfully');
          } catch (err) {
            logger.error(err.stack || err.toString());
            error(res, RESPONSE_MESSAGES.DATABASE_ERROR);
          }
        }
      ],

      // Legacy route by UID (from deprecated version)
      ['/uid/:uid', appointmentController.getAppointmentsByUID]
    ],

    post: [
      // Create new appointment with validation (from deprecated version)
      [
        '/',
        appointmentValidator,
        async (req, res) => {
          const errors = validationResult(req);
          if (!errors.isEmpty()) {
            return res.status(HTTP_STATUS.BAD_REQUEST).json({
              errors: errors.array(),
              message: RESPONSE_MESSAGES.VALIDATION_FAILED
            });
          }

          const phone = normalizePhone(req.body.phone || req.body.phoneNumber);
          const { doctor_name, date, time, department } = req.body;

          try {
            const result = await db.query(
              'INSERT INTO appointments (phone, doctor_name, date, time) VALUES ($1, $2, $3, $4) RETURNING *',
              [phone, doctor_name, date, time]
            );

            const appointment = result.rows[0];

            const scheduledAt = new Date(
              `${appointment.date.toISOString().split('T')[0]}T${appointment.time}`
            );

            success(res, {
              id: appointment.id,
              doctor: appointment.doctor_name,
              department: department || null,
              scheduled_at: scheduledAt.toISOString(),
              booked_by: req.user?.name
            }, RESPONSE_MESSAGES.APPOINTMENT_BOOKED);
          } catch (err) {
            logger.error(err.stack || err.toString());
            error(res, RESPONSE_MESSAGES.DATABASE_ERROR);
          }
        }
      ],

      // Enhanced booking with modern schema
      [
        '/book',
        async (req, res) => {
          try {
            const { 
              patient_id, doctor_id, appointment_date, appointment_time, 
              reason, notes = null 
            } = req.body;
            
            // Validation
            if (!patient_id || !doctor_id || !appointment_date || !appointment_time || !reason) {
              return error(res, 'patient_id, doctor_id, appointment_date, appointment_time, and reason are required', HTTP_STATUS.BAD_REQUEST);
            }
            
            // Role-based access control
            if (req.user?.role === 'PATIENT' && req.user.id !== parseInt(patient_id)) {
              return error(res, 'Can only book appointments for yourself', HTTP_STATUS.FORBIDDEN);
            }
            
            // Check if patient and doctor exist
            const patientCheck = await db.query('SELECT id, name FROM users WHERE id = $1', [patient_id]);
            const doctorCheck = await db.query('SELECT id, name FROM users WHERE id = $1 AND role = $2', [doctor_id, 'DOCTOR']);
            
            if (patientCheck.rows.length === 0) {
              return error(res, 'Patient not found', HTTP_STATUS.NOT_FOUND);
            }
            if (doctorCheck.rows.length === 0) {
              return error(res, 'Doctor not found', HTTP_STATUS.NOT_FOUND);
            }
            
            // Check for conflicting appointments
            const conflictCheck = await db.query(`
              SELECT id FROM appointments 
              WHERE doctor_id = $1 AND appointment_date = $2 AND appointment_time = $3 
              AND status = 'SCHEDULED'
            `, [doctor_id, appointment_date, appointment_time]);
            
            if (conflictCheck.rows.length > 0) {
              return res.status(409).json({
                success: false,
                message: 'Time slot already booked',
                conflicting_appointment_id: conflictCheck.rows[0].id
              });
            }
            
            const result = await db.query(`
              INSERT INTO appointments (
                patient_id, doctor_id, appointment_date, appointment_time, 
                reason, notes, status, created_at
              ) VALUES ($1, $2, $3, $4, $5, $6, 'SCHEDULED', NOW())
              RETURNING *
            `, [patient_id, doctor_id, appointment_date, appointment_time, reason, notes]);
            
            success(res, {
              appointment: result.rows[0],
              patient_name: patientCheck.rows[0].name,
              doctor_name: doctorCheck.rows[0].name,
              booked_by: req.user?.name
            }, 'Appointment booked successfully', HTTP_STATUS.CREATED);
          } catch (err) {
            logger.error('Database error:', err);
            error(res, 'Failed to book appointment', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ]
    ],

    put: [
      // Update appointment status
      [
        '/:id/status',
        async (req, res) => {
          try {
            const { id } = req.params;
            const { status, notes } = req.body;
            
            const validStatuses = ['SCHEDULED', 'COMPLETED', 'CANCELLED', 'NO_SHOW'];
            if (!validStatuses.includes(status.toUpperCase())) {
              return error(res, 'Invalid status. Valid options: ' + validStatuses.join(', '), HTTP_STATUS.BAD_REQUEST);
            }
            
            // Check if appointment exists and user has permission
            const appointmentCheck = await db.query('SELECT * FROM appointments WHERE id = $1', [id]);
            if (appointmentCheck.rows.length === 0) {
              return error(res, 'Appointment not found', HTTP_STATUS.NOT_FOUND);
            }
            
            const appointment = appointmentCheck.rows[0];
            
            // Role-based access control
            if (req.user?.role === 'PATIENT' && appointment.patient_id !== req.user.id) {
              return error(res, 'Can only update your own appointments', HTTP_STATUS.FORBIDDEN);
            }
            if (req.user?.role === 'DOCTOR' && appointment.doctor_id !== req.user.id) {
              return error(res, 'Can only update your own appointments', HTTP_STATUS.FORBIDDEN);
            }
            
            const result = await db.query(`
              UPDATE appointments SET 
                status = $1,
                notes = COALESCE($2, notes),
                updated_at = NOW()
              WHERE id = $3
              RETURNING *
            `, [status.toUpperCase(), notes, id]);
            
            success(res, {
              appointment: result.rows[0],
              updated_by: req.user?.name
            }, 'Appointment status updated successfully');
          } catch (err) {
            logger.error('Database error:', err);
            error(res, 'Failed to update appointment status', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ],

      // Update appointment details
      [
        '/:id',
        async (req, res) => {
          try {
            const { id } = req.params;
            const { appointment_date, appointment_time, reason, notes } = req.body;
            
            // Check if appointment exists and user has permission
            const appointmentCheck = await db.query('SELECT * FROM appointments WHERE id = $1', [id]);
            if (appointmentCheck.rows.length === 0) {
              return error(res, 'Appointment not found', HTTP_STATUS.NOT_FOUND);
            }
            
            const appointment = appointmentCheck.rows[0];
            
            // Role-based access control - only allow updates to scheduled appointments
            if (appointment.status !== 'SCHEDULED') {
              return error(res, 'Can only update scheduled appointments', HTTP_STATUS.BAD_REQUEST);
            }
            
            if (req.user?.role === 'PATIENT' && appointment.patient_id !== req.user.id) {
              return error(res, 'Can only update your own appointments', HTTP_STATUS.FORBIDDEN);
            }
            
            // Check for conflicts if time is being changed
            if (appointment_date || appointment_time) {
              const newDate = appointment_date || appointment.appointment_date;
              const newTime = appointment_time || appointment.appointment_time;
              
              const conflictCheck = await db.query(`
                SELECT id FROM appointments 
                WHERE doctor_id = $1 AND appointment_date = $2 AND appointment_time = $3 
                AND status = 'SCHEDULED' AND id != $4
              `, [appointment.doctor_id, newDate, newTime, id]);
              
              if (conflictCheck.rows.length > 0) {
                return res.status(409).json({
                  success: false,
                  message: 'Time slot already booked',
                  conflicting_appointment_id: conflictCheck.rows[0].id
                });
              }
            }
            
            const result = await db.query(`
              UPDATE appointments SET 
                appointment_date = COALESCE($1, appointment_date),
                appointment_time = COALESCE($2, appointment_time),
                reason = COALESCE($3, reason),
                notes = COALESCE($4, notes),
                updated_at = NOW()
              WHERE id = $5
              RETURNING *
            `, [appointment_date, appointment_time, reason, notes, id]);
            
            success(res, {
              appointment: result.rows[0],
              updated_by: req.user?.name
            }, 'Appointment updated successfully');
          } catch (err) {
            logger.error('Database error:', err);
            error(res, 'Failed to update appointment', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ]
    ],

    delete: [
      // Cancel/Delete appointment
      [
        '/:id',
        async (req, res) => {
          try {
            const { id } = req.params;
            
            // Check if appointment exists and user has permission
            const appointmentCheck = await db.query('SELECT * FROM appointments WHERE id = $1', [id]);
            if (appointmentCheck.rows.length === 0) {
              return error(res, 'Appointment not found', HTTP_STATUS.NOT_FOUND);
            }
            
            const appointment = appointmentCheck.rows[0];
            
            // Role-based access control
            if (req.user?.role === 'PATIENT' && appointment.patient_id !== req.user.id) {
              return error(res, 'Can only cancel your own appointments', HTTP_STATUS.FORBIDDEN);
            }
            if (req.user?.role === 'DOCTOR' && appointment.doctor_id !== req.user.id) {
              return error(res, 'Can only cancel your own appointments', HTTP_STATUS.FORBIDDEN);
            }
            
            // Soft delete by updating status to CANCELLED
            const result = await db.query(`
              UPDATE appointments SET 
                status = 'CANCELLED',
                notes = COALESCE(notes || ' | ', '') || 'Cancelled by ' || $1,
                updated_at = NOW()
              WHERE id = $2
              RETURNING *
            `, [req.user?.name || 'User', id]);
            
            success(res, {
              appointment: result.rows[0],
              cancelled_by: req.user?.name
            }, 'Appointment cancelled successfully');
          } catch (err) {
            logger.error('Database error:', err);
            error(res, 'Failed to cancel appointment', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ]
    ]
  },
  {
    requireUID: true,        // Require user authentication
    requirePhone: false,     // Phone not required for all operations
    auditLog: true,         // Enable audit logging
    rateLimiting: true,     // Enable rate limiting
    roles: ['ADMIN', 'DOCTOR', 'PATIENT', 'NURSE', 'RECEPTIONIST'] // All roles can access with appropriate restrictions
  }
);

export default router;