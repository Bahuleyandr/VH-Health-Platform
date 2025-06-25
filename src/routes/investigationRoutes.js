// src/routes/investigationRoutes.js - ENHANCED VERSION WITH FULL RBAC
import express from 'express';
import { validationResult } from 'express-validator';
import db from '../config/database.js';
import logger from '../logging/logger.js';
import { success, error } from '../utils/responseHelper.js';
import { investigationRequestValidator, idValidator } from '../config/validationSchemas.js';
import { HTTP_STATUS, RESPONSE_MESSAGES } from '../config/responseCodes.js';
import { wrapAutoRBAC, wrapRoutesWithValidation } from '../config/routeWrapper.js';
import { normalizePhone } from '../utils/phoneUtils.js';
import { logAudit } from '../utils/logAudit.js';

const router = express.Router();
logger.info('✅ Enhanced investigationRoutes loaded with full RBAC protection');

// ✅ PUBLIC TEST ROUTE (for system health checks)
wrapRoutesWithValidation(
  router,
  [], // No roles required - public
  {
    get: [
      [
        '/test',
        (req, res) => {
          success(res, {
            message: 'Investigation routes working!',
            timestamp: new Date().toISOString(),
            version: '3.0.0-enhanced',
            security: 'RBAC-protected'
          }, 'Investigation system operational');
        }
      ]
    ]
  },
  {
    requireUID: false,
    requirePhone: false,
    skipRBAC: true
  }
);

// ✅ PATIENT & MEDICAL STAFF - View investigations with role-based filtering
wrapAutoRBAC(router, 'investigationRoutes', {
  get: [
    // List investigations with comprehensive filtering and pagination
    [
      '/list',
      async (req, res) => {
        try {
          const page = parseInt(req.query.page) || 1;
          const limit = Math.min(parseInt(req.query.limit) || 20, 100);
          const offset = (page - 1) * limit;
          const requestedBy = req.user?.uid || 'system';
          const userRole = req.user?.role?.toUpperCase();
          
          // Role-based filtering
          let baseConditions = '1=1';
          let params = [];
          
          // Patients can only see their own investigations
          if (userRole === 'PATIENT') {
            const userResult = await db.query('SELECT id FROM users WHERE uid = $1', [req.user.uid]);
            if (userResult.rows.length === 0) {
              return res.status(404).json({ message: 'User not found' });
            }
            baseConditions = 'i.patient_id = $1';
            params.push(userResult.rows[0].id);
          }
          
          // Apply query filters
          const { patient_id, doctor_id, type, status, date } = req.query;
          
          if (patient_id && (userRole !== 'PATIENT' || patient_id === userResult?.rows[0]?.id)) {
            baseConditions += ` AND i.patient_id = $${params.length + 1}`;
            params.push(patient_id);
          }
          
          if (doctor_id) {
            baseConditions += ` AND i.doctor_id = $${params.length + 1}`;
            params.push(doctor_id);
          }
          
          if (type) {
            baseConditions += ` AND i.type = $${params.length + 1}`;
            params.push(type.toUpperCase());
          }
          
          if (status) {
            baseConditions += ` AND i.status = $${params.length + 1}`;
            params.push(status.toUpperCase());
          }
          
          if (date) {
            baseConditions += ` AND DATE(i.ordered_date) = $${params.length + 1}`;
            params.push(date);
          }
          
          const query = `
            SELECT i.id, i.test_name, i.test_code, i.type, i.status, i.priority,
                   i.ordered_date, i.scheduled_date, i.completed_date, 
                   ${userRole === 'PATIENT' ? '' : 'i.results,'} i.normal_range, i.unit, i.notes, i.cost,
                   p.name as patient_name, p.phone as patient_phone, p.id as patient_id,
                   d.name as doctor_name, d.phone as doctor_phone, d.id as doctor_id,
                   dept.specialization, i.created_at, i.updated_at
            FROM investigations i
            LEFT JOIN users p ON i.patient_id = p.id
            LEFT JOIN users d ON i.doctor_id = d.id
            LEFT JOIN doctors dept ON d.id = dept.user_id
            WHERE ${baseConditions}
            ORDER BY i.ordered_date DESC 
            LIMIT $${params.length + 1} OFFSET $${params.length + 2}
          `;
          
          params.push(limit, offset);
          const result = await db.query(query, params);
          
          // Get total count for pagination
          const countQuery = `SELECT COUNT(*) FROM investigations i WHERE ${baseConditions}`;
          const countResult = await db.query(countQuery, params.slice(0, -2));
          const totalInvestigations = parseInt(countResult.rows[0].count);
          
          await logAudit(req, 'investigation-list-view', {
            count: result.rows.length,
            filters: { patient_id, doctor_id, type, status, date }
          });
          
          success(res, {
            investigations: result.rows,
            pagination: {
              page,
              limit,
              total: totalInvestigations,
              totalPages: Math.ceil(totalInvestigations / limit),
              hasNext: page * limit < totalInvestigations,
              hasPrev: page > 1
            },
            filters: { patient_id, doctor_id, type, status, date },
            requestedBy,
            userRole
          }, 'Investigations retrieved successfully');
          
        } catch (dbError) {
          logger.error('Database error for investigations:', dbError.message);
          // Graceful fallback
          success(res, {
            investigations: [],
            message: 'Investigation system temporarily unavailable',
            suggestion: 'Database table may need initialization',
            requestedBy: req.user?.uid
          }, 'Investigation service status');
        }
      }
    ],

    // Get single investigation by ID with role-based access
    [
      '/:id',
      idValidator,
      async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
          return res.status(HTTP_STATUS.BAD_REQUEST).json({
            errors: errors.array(),
            message: RESPONSE_MESSAGES.VALIDATION_FAILED
          });
        }

        try {
          const { id } = req.params;
          const userRole = req.user?.role?.toUpperCase();
          const requestedBy = req.user?.uid;
          
          let accessCondition = '1=1';
          let params = [id];
          
          // Patients can only view their own investigations
          if (userRole === 'PATIENT') {
            const userResult = await db.query('SELECT id FROM users WHERE uid = $1', [req.user.uid]);
            if (userResult.rows.length === 0) {
              return res.status(404).json({ message: 'User not found' });
            }
            accessCondition = 'i.patient_id = $2';
            params.push(userResult.rows[0].id);
          }
          
          const result = await db.query(`
            SELECT i.*, 
                   p.name as patient_name, p.phone as patient_phone, p.email as patient_email,
                   p.birthday, p.gender,
                   d.name as doctor_name, d.phone as doctor_phone, d.email as doctor_email,
                   dept.specialization, dept.department
            FROM investigations i
            LEFT JOIN users p ON i.patient_id = p.id
            LEFT JOIN users d ON i.doctor_id = d.id
            LEFT JOIN doctors dept ON d.id = dept.user_id
            WHERE i.id = $1 AND ${accessCondition}
          `, params);
          
          if (result.rows.length === 0) {
            return res.status(404).json({ 
              message: 'Investigation not found or access denied',
              id,
              requestedBy
            });
          }
          
          // Filter sensitive data for patients
          const investigation = result.rows[0];
          if (userRole === 'PATIENT') {
            delete investigation.doctor_phone;
            delete investigation.doctor_email;
            delete investigation.cost;
          }
          
          await logAudit(req, 'investigation-view', { investigation_id: id });
          
          success(res, {
            investigation,
            requestedBy,
            accessLevel: userRole
          }, 'Investigation retrieved successfully');
          
        } catch (dbError) {
          logger.error('Database error:', dbError.message);
          error(res, 'Failed to retrieve investigation', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ],

    // Get investigations for specific patient (with access control)
    [
      '/patient/:patient_id',
      async (req, res) => {
        try {
          const { patient_id } = req.params;
          const userRole = req.user?.role?.toUpperCase();
          const requestedBy = req.user?.uid;
          
          // Access control: patients can only view their own data
          if (userRole === 'PATIENT') {
            const userResult = await db.query('SELECT id FROM users WHERE uid = $1', [req.user.uid]);
            if (userResult.rows.length === 0 || userResult.rows[0].id !== parseInt(patient_id)) {
              return res.status(403).json({ 
                message: 'Access denied: Cannot view other patient records',
                requestedBy
              });
            }
          }
          
          const { type, status, limit: queryLimit } = req.query;
          const limit = Math.min(parseInt(queryLimit) || 50, 100);
          
          let query = `
            SELECT i.id, i.test_name, i.test_code, i.type, i.status, i.priority,
                   i.ordered_date, i.scheduled_date, i.completed_date, 
                   ${userRole === 'PATIENT' ? '' : 'i.results,'} i.normal_range, i.unit, i.notes,
                   d.name as doctor_name, dept.specialization
            FROM investigations i
            LEFT JOIN users d ON i.doctor_id = d.id
            LEFT JOIN doctors dept ON d.id = dept.user_id
            WHERE i.patient_id = $1
          `;
          let params = [patient_id];
          
          if (type) {
            query += ` AND i.type = $${params.length + 1}`;
            params.push(type.toUpperCase());
          }
          
          if (status) {
            query += ` AND i.status = $${params.length + 1}`;
            params.push(status.toUpperCase());
          }
          
          query += ` ORDER BY i.ordered_date DESC LIMIT $${params.length + 1}`;
          params.push(limit);
          
          const result = await db.query(query, params);
          
          // Get patient info (filtered for privacy)
          const patientInfo = await db.query(
            `SELECT name, ${userRole === 'ADMIN' ? 'phone, email,' : ''} birthday, gender 
             FROM users WHERE id = $1`,
            [patient_id]
          );
          
          await logAudit(req, 'patient-investigations-view', { patient_id, count: result.rows.length });
          
          success(res, {
            investigations: result.rows,
            count: result.rows.length,
            patient: patientInfo.rows[0] || null,
            filters: { type, status },
            requestedBy,
            accessLevel: userRole
          }, 'Patient investigations retrieved successfully');
          
        } catch (dbError) {
          logger.error('Database error:', dbError.message);
          error(res, 'Failed to retrieve patient investigations', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ],

    // Get investigations by doctor (medical staff only)
    [
      '/doctor/:doctor_id',
      async (req, res) => {
        try {
          const userRole = req.user?.role?.toUpperCase();
          const requestedBy = req.user?.uid;
          
          // Only medical staff can view doctor's investigations
          if (!['DOCTOR', 'NURSE', 'LAB_TECHNICIAN', 'ADMIN'].includes(userRole)) {
            return res.status(403).json({ 
              message: 'Access denied: Medical staff access required',
              requestedBy
            });
          }
          
          const { doctor_id } = req.params;
          const { date, status = 'PENDING' } = req.query;
          
          let query = `
            SELECT i.id, i.test_name, i.test_code, i.type, i.status, i.priority,
                   i.ordered_date, i.scheduled_date, i.notes,
                   p.name as patient_name, p.phone as patient_phone, p.id as patient_id
            FROM investigations i
            LEFT JOIN users p ON i.patient_id = p.id
            WHERE i.doctor_id = $1 AND i.status = $2
          `;
          let params = [doctor_id, status.toUpperCase()];
          
          if (date) {
            query += ` AND DATE(i.ordered_date) = $${params.length + 1}`;
            params.push(date);
          }
          
          query += ' ORDER BY i.ordered_date DESC, i.priority DESC';
          
          const result = await db.query(query, params);
          
          await logAudit(req, 'doctor-investigations-view', { doctor_id, status, count: result.rows.length });
          
          success(res, {
            investigations: result.rows,
            count: result.rows.length,
            doctor_id,
            filters: { status, date },
            requestedBy
          }, 'Doctor investigations retrieved successfully');
          
        } catch (dbError) {
          logger.error('Database error:', dbError.message);
          error(res, 'Failed to retrieve doctor investigations', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ],

    // Get investigations by type (lab technicians and medical staff)
    [
      '/type/:type',
      async (req, res) => {
        try {
          const userRole = req.user?.role?.toUpperCase();
          const requestedBy = req.user?.uid;
          
          // Only medical staff and lab technicians can filter by type
          if (!['DOCTOR', 'NURSE', 'LAB_TECHNICIAN', 'RADIOLOGIST', 'ADMIN'].includes(userRole)) {
            return res.status(403).json({ 
              message: 'Access denied: Medical staff access required',
              requestedBy
            });
          }
          
          const { type } = req.params;
          const { status, date } = req.query;
          
          let query = `
            SELECT i.id, i.test_name, i.test_code, i.status, i.priority,
                   i.ordered_date, i.scheduled_date, i.completed_date,
                   p.name as patient_name, p.phone as patient_phone,
                   d.name as doctor_name
            FROM investigations i
            LEFT JOIN users p ON i.patient_id = p.id
            LEFT JOIN users d ON i.doctor_id = d.id
            WHERE i.type = $1
          `;
          let params = [type.toUpperCase()];
          
          if (status) {
            query += ` AND i.status = $${params.length + 1}`;
            params.push(status.toUpperCase());
          }
          
          if (date) {
            query += ` AND DATE(i.ordered_date) = $${params.length + 1}`;
            params.push(date);
          }
          
          query += ' ORDER BY i.ordered_date DESC LIMIT 100';
          
          const result = await db.query(query, params);
          
          await logAudit(req, 'investigations-by-type-view', { type, status, count: result.rows.length });
          
          success(res, {
            investigations: result.rows,
            count: result.rows.length,
            type: type.toUpperCase(),
            filters: { status, date },
            requestedBy
          }, `${type} investigations retrieved successfully`);
          
        } catch (dbError) {
          logger.error('Database error:', dbError.message);
          error(res, 'Failed to retrieve investigations by type', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ],

    // Get pending investigations (lab technicians and medical staff)
    [
      '/status/pending',
      async (req, res) => {
        try {
          const userRole = req.user?.role?.toUpperCase();
          const requestedBy = req.user?.uid;
          
          // Only medical staff can view pending investigations
          if (!['DOCTOR', 'NURSE', 'LAB_TECHNICIAN', 'RADIOLOGIST', 'ADMIN'].includes(userRole)) {
            return res.status(403).json({ 
              message: 'Access denied: Medical staff access required',
              requestedBy
            });
          }
          
          const { type, priority } = req.query;
          
          let query = `
            SELECT i.id, i.test_name, i.test_code, i.type, i.priority,
                   i.ordered_date, i.scheduled_date, i.notes,
                   p.name as patient_name, p.phone as patient_phone, p.gender,
                   d.name as doctor_name, dept.department
            FROM investigations i
            LEFT JOIN users p ON i.patient_id = p.id
            LEFT JOIN users d ON i.doctor_id = d.id
            LEFT JOIN doctors dept ON d.id = dept.user_id
            WHERE i.status = 'PENDING'
          `;
          let params = [];
          
          if (type) {
            query += ` AND i.type = $${params.length + 1}`;
            params.push(type.toUpperCase());
          }
          
          if (priority) {
            query += ` AND i.priority = $${params.length + 1}`;
            params.push(priority.toUpperCase());
          }
          
          query += ' ORDER BY i.priority DESC, i.ordered_date ASC';
          
          const result = await db.query(query, params);
          
          await logAudit(req, 'pending-investigations-view', { type, priority, count: result.rows.length });
          
          success(res, {
            investigations: result.rows,
            count: result.rows.length,
            filters: { type, priority },
            requestedBy
          }, 'Pending investigations retrieved successfully');
          
        } catch (dbError) {
          logger.error('Database error:', dbError.message);
          error(res, 'Failed to retrieve pending investigations', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ],

    // Legacy phone-based lookup (for backward compatibility)
    [
      '/:phone',
      async (req, res) => {
        try {
          const phone = normalizePhone(req.params.phone);
          const userRole = req.user?.role?.toUpperCase();
          const requestedBy = req.user?.uid;
          
          // Access control for phone-based lookup
          if (userRole === 'PATIENT') {
            const userResult = await db.query('SELECT phone FROM users WHERE uid = $1', [req.user.uid]);
            if (userResult.rows.length === 0 || userResult.rows[0].phone !== phone) {
              return res.status(403).json({ 
                message: 'Access denied: Cannot view other patient records',
                requestedBy
              });
            }
          }
          
          const result = await db.query('SELECT * FROM investigations WHERE phone = $1', [phone]);
          
          await logAudit(req, 'investigations-phone-lookup', { phone, count: result.rows.length });
          
          success(res, {
            investigations: result.rows,
            requestedBy
          }, 'Investigations fetched successfully');
          
        } catch (dbError) {
          logger.error(dbError.stack || dbError.toString());
          error(res, RESPONSE_MESSAGES.DATABASE_ERROR);
        }
      }
    ],

    // Legacy UID lookup (for backward compatibility)
    [
      '/uid/:uid',
      async (req, res) => {
        try {
          const { uid } = req.params;
          const userRole = req.user?.role?.toUpperCase();
          const requestedBy = req.user?.uid;
          
          // Access control: users can only view their own UID data
          if (userRole === 'PATIENT' && uid !== req.user.uid) {
            return res.status(403).json({ 
              message: 'Access denied: Cannot view other patient records',
              requestedBy
            });
          }
          
          // Resolve UID to phone for legacy compatibility
          const userResult = await db.query('SELECT phone FROM users WHERE uid = $1', [uid]);
          if (userResult.rows.length === 0) {
            return res.status(404).json({ 
              message: 'User not found',
              uid,
              requestedBy
            });
          }
          
          const phone = userResult.rows[0].phone;
          const result = await db.query('SELECT * FROM investigations WHERE phone = $1', [phone]);
          
          await logAudit(req, 'investigations-uid-lookup', { uid, count: result.rows.length });
          
          success(res, {
            investigations: result.rows,
            requestedBy
          }, 'Investigations retrieved by UID');
          
        } catch (dbError) {
          logger.error(dbError.stack || dbError.toString());
          error(res, 'Failed to retrieve investigations by UID', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ]
  ],

  // ✅ DOCTORS & MEDICAL STAFF - Create investigation orders
  post: [
    [
      '/order',
      investigationRequestValidator,
      async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
          return res.status(HTTP_STATUS.BAD_REQUEST).json({
            errors: errors.array(),
            message: RESPONSE_MESSAGES.VALIDATION_FAILED
          });
        }

        try {
          const userRole = req.user?.role?.toUpperCase();
          const requestedBy = req.user?.uid;
          
          // Only doctors and authorized medical staff can order investigations
          if (!['DOCTOR', 'ADMIN'].includes(userRole)) {
            return res.status(403).json({ 
              message: 'Access denied: Doctor privileges required to order investigations',
              requestedBy
            });
          }
          
          const { 
            patient_id, doctor_id, test_name, test_code, type, priority = 'NORMAL',
            scheduled_date, notes, normal_range, unit, cost 
          } = req.body;
          
          if (!patient_id || !doctor_id || !test_name || !type) {
            return res.status(400).json({
              message: 'patient_id, doctor_id, test_name, and type are required',
              requestedBy
            });
          }
          
          const validTypes = ['LAB', 'RADIOLOGY', 'PATHOLOGY', 'CARDIOLOGY', 'PULMONARY', 'ENDOSCOPY'];
          const validPriorities = ['URGENT', 'HIGH', 'NORMAL', 'LOW'];
          
          if (!validTypes.includes(type.toUpperCase())) {
            return res.status(400).json({
              message: 'Invalid investigation type',
              validTypes,
              requestedBy
            });
          }
          
          if (!validPriorities.includes(priority.toUpperCase())) {
            return res.status(400).json({
              message: 'Invalid priority level',
              validPriorities,
              requestedBy
            });
          }
          
          // Verify patient and doctor exist
          const [patientCheck, doctorCheck] = await Promise.all([
            db.query('SELECT id, name FROM users WHERE id = $1', [patient_id]),
            db.query('SELECT id, name FROM users WHERE id = $1 AND role = $2', [doctor_id, 'DOCTOR'])
          ]);
          
          if (patientCheck.rows.length === 0) {
            return res.status(404).json({ message: 'Patient not found', requestedBy });
          }
          if (doctorCheck.rows.length === 0) {
            return res.status(404).json({ message: 'Doctor not found', requestedBy });
          }
          
          const result = await db.query(`
            INSERT INTO investigations (
              patient_id, doctor_id, test_name, test_code, type, priority,
              scheduled_date, notes, normal_range, unit, cost, status,
              ordered_date, created_at, created_by
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'PENDING', NOW(), NOW(), $12)
            RETURNING *
          `, [patient_id, doctor_id, test_name, test_code, type.toUpperCase(), priority.toUpperCase(),
              scheduled_date, notes, normal_range, unit, cost, requestedBy]);
          
          // Create notification for patient
          await db.query(
            `INSERT INTO notifications (phone, title, body, type, created_at, read, created_by)
             VALUES ($1, $2, $3, $4, NOW(), false, $5)`,
            [
              patientCheck.rows[0].phone || 'unknown',
              'New Investigation Ordered',
              `Your doctor has ordered: ${test_name}. Please check your appointments.`,
              'investigation_ordered',
              requestedBy
            ]
          );
          
          await logAudit(req, 'investigation-ordered', { 
            investigation_id: result.rows[0].id,
            patient_id,
            test_name,
            type: type.toUpperCase()
          });
          
          success(res, {
            investigation: result.rows[0],
            patient_name: patientCheck.rows[0].name,
            doctor_name: doctorCheck.rows[0].name,
            orderedBy: requestedBy
          }, 'Investigation ordered successfully');
          
        } catch (dbError) {
          logger.error('Database error:', dbError.message);
          error(res, 'Failed to order investigation', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ],

    // Legacy phone-based investigation request (for backward compatibility)
    [
      '/',
      investigationRequestValidator,
      async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
          return res.status(HTTP_STATUS.BAD_REQUEST).json({
            errors: errors.array(),
            message: RESPONSE_MESSAGES.VALIDATION_FAILED
          });
        }

        try {
          const phone = normalizePhone(req.body.phone || req.body.phoneNumber);
          const { test_name, file_key } = req.body;
          const requestedBy = req.user?.uid;

          if (!phone || !test_name) {
            return res.status(HTTP_STATUS.BAD_REQUEST).json({
              error: 'Phone and test name are required.',
              requestedBy
            });
          }

          const result = await db.query(
            'INSERT INTO investigations (phone, test_name, file_key, created_by) VALUES ($1, $2, $3, $4) RETURNING *',
            [phone, test_name, file_key || null, requestedBy]
          );

          // Save in-app notification
          await db.query(
            `INSERT INTO notifications (phone, title, body, type, created_at, read, created_by)
             VALUES ($1, $2, $3, $4, NOW(), false, $5)`,
            [
              phone,
              'Investigation Report Ready',
              `Your investigation report for "${test_name}" is now available.`,
              'investigation_ready',
              requestedBy
            ]
          );

          await logAudit(req, 'legacy-investigation-requested', { phone, test_name });

          success(res, {
            investigation: result.rows[0],
            requestedBy
          }, RESPONSE_MESSAGES.INVESTIGATION_REQUESTED);
          
        } catch (dbError) {
          logger.error(dbError.stack || dbError.toString());
          error(res, RESPONSE_MESSAGES.DATABASE_ERROR);
        }
      }
    ]
  ],

  // ✅ LAB TECHNICIANS & DOCTORS - Update investigation status and results  
  put: [
    [
      '/:id/status',
      idValidator,
      async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
          return res.status(HTTP_STATUS.BAD_REQUEST).json({
            errors: errors.array(),
            message: RESPONSE_MESSAGES.VALIDATION_FAILED
          });
        }

        try {
          const userRole = req.user?.role?.toUpperCase();
          const requestedBy = req.user?.uid;
          
          // Only lab technicians, doctors, and admin can update status
          if (!['LAB_TECHNICIAN', 'DOCTOR', 'RADIOLOGIST', 'ADMIN'].includes(userRole)) {
            return res.status(403).json({ 
              message: 'Access denied: Lab technician or doctor privileges required',
              requestedBy
            });
          }
          
          const { id } = req.params;
          const { status, notes } = req.body;
          
          const validStatuses = ['PENDING', 'SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'];
          if (!validStatuses.includes(status.toUpperCase())) {
            return res.status(400).json({
              message: 'Invalid status',
              validStatuses,
              requestedBy
            });
          }
          
          let updateFields = 'status = $1, notes = COALESCE($2, notes), updated_at = NOW(), updated_by = $4';
          let params = [status.toUpperCase(), notes, id, requestedBy];
          
          // Set completed_date if status is COMPLETED
          if (status.toUpperCase() === 'COMPLETED') {
            updateFields = 'status = $1, notes = COALESCE($2, notes), completed_date = NOW(), updated_at = NOW(), updated_by = $4';
          }
          
          const result = await db.query(`
            UPDATE investigations SET ${updateFields}
            WHERE id = $3
            RETURNING *
          `, params);
          
          if (result.rows.length === 0) {
            return res.status(404).json({ 
              message: 'Investigation not found',
              requestedBy
            });
          }
          
          await logAudit(req, 'investigation-status-updated', { 
            investigation_id: id,
            old_status: 'unknown',
            new_status: status.toUpperCase()
          });
          
          success(res, {
            investigation: result.rows[0],
            updatedBy: requestedBy
          }, 'Investigation status updated successfully');
          
        } catch (dbError) {
          logger.error('Database error:', dbError.message);
          error(res, 'Failed to update investigation status', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ],

    [
      '/:id/results',
      idValidator,
      async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
          return res.status(HTTP_STATUS.BAD_REQUEST).json({
            errors: errors.array(),
            message: RESPONSE_MESSAGES.VALIDATION_FAILED
          });
        }

        try {
          const userRole = req.user?.role?.toUpperCase();
          const requestedBy = req.user?.uid;
          
          // Only lab technicians, doctors, and admin can add results
          if (!['LAB_TECHNICIAN', 'DOCTOR', 'RADIOLOGIST', 'ADMIN'].includes(userRole)) {
            return res.status(403).json({ 
              message: 'Access denied: Lab technician or doctor privileges required',
              requestedBy
            });
          }
          
          const { id } = req.params;
          const { results, interpretation, technician_notes, reviewed_by } = req.body;
          
          if (!results) {
            return res.status(400).json({
              message: 'Results are required',
              requestedBy
            });
          }
          
          const result = await db.query(`
            UPDATE investigations SET 
              results = $1,
              interpretation = COALESCE($2, interpretation),
              technician_notes = COALESCE($3, technician_notes),
              reviewed_by = COALESCE($4, reviewed_by),
              status = 'COMPLETED',
              completed_date = NOW(),
              updated_at = NOW(),
              updated_by = $6
            WHERE id = $5
            RETURNING *
          `, [results, interpretation, technician_notes, reviewed_by, id, requestedBy]);
          
          if (result.rows.length === 0) {
            return res.status(404).json({ 
              message: 'Investigation not found',
              requestedBy
            });
          }
          
          await logAudit(req, 'investigation-results-added', { investigation_id: id });
          
          success(res, {
            investigation: result.rows[0],
            updatedBy: requestedBy
          }, 'Investigation results added successfully');
          
        } catch (dbError) {
          logger.error('Database error:', dbError.message);
          error(res, 'Failed to add investigation results', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ]
  ]
});

// ✅ ADMIN & MANAGEMENT - Statistics and analytics
wrapAutoRBAC(router, 'ALL', {
  get: [
    [
      '/stats/summary',
      async (req, res) => {
        try {
          const days = parseInt(req.query.days) || 30;
          const requestedBy = req.user?.uid;
          
          const [totalStats, typeStats, statusStats, dailyActivity] = await Promise.all([
            // Total investigation statistics
            db.query(`
              SELECT 
                COUNT(*) as total_investigations,
                COUNT(CASE WHEN status = 'PENDING' THEN 1 END) as pending,
                COUNT(CASE WHEN status = 'COMPLETED' THEN 1 END) as completed,
                COUNT(CASE WHEN status = 'CANCELLED' THEN 1 END) as cancelled,
                COUNT(CASE WHEN ordered_date >= CURRENT_DATE - INTERVAL '${days} days' THEN 1 END) as recent_orders,
                ROUND(AVG(cost), 2) as average_cost
              FROM investigations
            `),
            
            // Type breakdown
            db.query(`
              SELECT type, COUNT(*) as count
              FROM investigations 
              WHERE ordered_date >= CURRENT_DATE - INTERVAL '${days} days'
              GROUP BY type
              ORDER BY count DESC
            `),
            
            // Status distribution
            db.query(`
              SELECT status, COUNT(*) as count
              FROM investigations 
              WHERE ordered_date >= CURRENT_DATE - INTERVAL '${days} days'
              GROUP BY status
              ORDER BY count DESC
            `),
            
            // Daily activity
            db.query(`
              SELECT DATE(ordered_date) as date, COUNT(*) as investigations_ordered
              FROM investigations 
              WHERE ordered_date >= CURRENT_DATE - INTERVAL '${days} days'
              GROUP BY DATE(ordered_date)
              ORDER BY date DESC
            `)
          ]);
          
          await logAudit(req, 'investigation-stats-viewed', { period_days: days });
          
          success(res, {
            statistics: {
              totals: totalStats.rows[0],
              by_type: typeStats.rows,
              by_status: statusStats.rows,
              daily_activity: dailyActivity.rows
            },
            period_days: days,
            generatedBy: requestedBy,
            timestamp: new Date().toISOString()
          }, 'Investigation statistics retrieved successfully');
          
        } catch (dbError) {
          logger.error('Database error:', dbError.message);
          // Graceful fallback for missing tables
          success(res, {
            statistics: {
              totals: { total_investigations: 0, pending: 0, completed: 0, cancelled: 0 },
              by_type: [],
              by_status: [],
              daily_activity: []
            },
            message: 'Investigation statistics temporarily unavailable',
            generatedBy: req.user?.uid
          }, 'Investigation statistics service status');
        }
      }
    ]
  ]
});

export default router;