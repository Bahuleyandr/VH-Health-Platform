// src/routes/departmentRoutes.js - COMPLETE PRODUCTION VERSION WITH RBAC
import express from 'express';
import db from '../config/database.js';
import { wrapAutoRBAC } from '../config/routeWrapper.js';
import * as departmentController from '../controllers/departmentController.js';
import { success, error } from '../utils/responseHelper.js';
import logger from '../logging/logger.js';
import { HTTP_STATUS } from '../config/responseCodes.js';

const router = express.Router();
console.log('✅ departmentRoutes loaded with RBAC protection');

/**
 * ✅ Department Routes with RBAC protection
 * Includes comprehensive department management and analytics
 * RBAC-controlled via `departmentRoutes` config
 */
wrapAutoRBAC(
  router,
  'departmentRoutes',
  {
    get: [
      // Test route
      [
        '/test',
        (req, res) => {
          success(res, { 
            message: 'Department routes working!',
            timestamp: new Date().toISOString(),
            version: '2.0.0',
            user: req.user?.name || 'Unknown'
          }, 'Department routes operational');
        }
      ],

      // Legacy routes from deprecated version (maintained for backward compatibility)
      ['/', departmentController.getAllDepartments],
      ['/departments-with-doctors', departmentController.getDepartmentsWithDoctors],

      // Enhanced department listing with doctor count
      [
        '/list',
        async (req, res) => {
          try {
            const result = await db.query(`
              SELECT d.id, d.name, d.description, d.head_doctor_id, d.contact_number,
                     d.location, d.is_active, d.created_at, d.updated_at,
                     u.name as head_doctor_name, u.phone as head_doctor_phone,
                     COUNT(doc.user_id) as doctor_count,
                     COUNT(doc.user_id) FILTER (WHERE doc.is_available = true) as available_doctors
              FROM departments d
              LEFT JOIN users u ON d.head_doctor_id = u.id
              LEFT JOIN doctors doc ON doc.department = d.name
              WHERE d.is_active = true
              GROUP BY d.id, d.name, d.description, d.head_doctor_id, d.contact_number, 
                       d.location, d.is_active, d.created_at, d.updated_at, u.name, u.phone
              ORDER BY d.name
            `);
            
            success(res, {
              departments: result.rows,
              count: result.rows.length,
              requestedBy: req.user?.name
            }, 'Departments retrieved successfully');
          } catch (err) {
            logger.error('Database error for departments:', err);
            
            // Fallback: Get unique departments from doctors table
            try {
              const fallbackResult = await db.query(`
                SELECT department as name, COUNT(*) as doctor_count,
                       COUNT(*) FILTER (WHERE is_available = true) as available_doctors
                FROM doctors 
                WHERE department IS NOT NULL
                GROUP BY department
                ORDER BY department
              `);
              
              const departments = fallbackResult.rows.map(dept => ({
                name: dept.name,
                doctor_count: parseInt(dept.doctor_count),
                available_doctors: parseInt(dept.available_doctors),
                description: `${dept.name} Department`,
                is_active: true,
                location: 'Hospital Building',
                contact_number: null,
                head_doctor_name: null
              }));

              success(res, {
                departments,
                count: departments.length,
                note: 'Limited data - create departments table for full functionality',
                requestedBy: req.user?.name
              }, 'Departments retrieved (from doctors table - departments table may not exist)');
            } catch (fallbackError) {
              logger.error('Fallback query failed:', fallbackError);
              error(res, 'Failed to retrieve departments - departments table may not exist', HTTP_STATUS.INTERNAL_SERVER_ERROR);
            }
          }
        }
      ],

      // Get departments with available doctors
      [
        '/available/now',
        async (req, res) => {
          try {
            const today = new Date().toLocaleDateString('en-US', { weekday: 'long' }).toUpperCase();
            
            const result = await db.query(`
              SELECT d.name, d.description, d.location, d.contact_number,
                     COUNT(doc.user_id) as available_doctors,
                     STRING_AGG(u.name, ', ') as doctor_names,
                     STRING_AGG(doc.specialization, ', ') as specializations
              FROM departments d
              LEFT JOIN doctors doc ON doc.department = d.name 
                AND doc.is_available = true 
                AND (doc.available_days IS NULL OR doc.available_days LIKE '%' || $1 || '%')
              LEFT JOIN users u ON doc.user_id = u.id
              WHERE d.is_active = true
              GROUP BY d.name, d.description, d.location, d.contact_number
              HAVING COUNT(doc.user_id) > 0
              ORDER BY available_doctors DESC, d.name
            `, [today]);
            
            success(res, {
              departments: result.rows,
              count: result.rows.length,
              current_day: today,
              requestedBy: req.user?.name
            }, 'Departments with available doctors retrieved successfully');
          } catch (err) {
            logger.error('Database error for available departments:', err);
            
            // Fallback response
            success(res, {
              departments: [],
              count: 0,
              current_day: new Date().toLocaleDateString('en-US', { weekday: 'long' }).toUpperCase(),
              note: 'Could not retrieve available departments - table may not exist',
              requestedBy: req.user?.name
            }, 'Available departments retrieved (empty - table may not exist)');
          }
        }
      ],

      // Get department by ID or name (enhanced)
      [
        '/:identifier',
        async (req, res) => {
          try {
            const { identifier } = req.params;
            const isNumeric = /^\d+$/.test(identifier);
            
            let result;
            if (isNumeric) {
              // Search by ID
              result = await db.query(`
                SELECT d.*, u.name as head_doctor_name, u.phone as head_doctor_phone,
                       u.email as head_doctor_email
                FROM departments d
                LEFT JOIN users u ON d.head_doctor_id = u.id
                WHERE d.id = $1 AND d.is_active = true
              `, [identifier]);
            } else {
              // Search by name
              result = await db.query(`
                SELECT d.*, u.name as head_doctor_name, u.phone as head_doctor_phone,
                       u.email as head_doctor_email
                FROM departments d
                LEFT JOIN users u ON d.head_doctor_id = u.id
                WHERE LOWER(d.name) = LOWER($1) AND d.is_active = true
              `, [identifier]);
            }
            
            if (result.rows.length === 0) {
              return error(res, 'Department not found', HTTP_STATUS.NOT_FOUND);
            }
            
            const department = result.rows[0];
            
            // Get doctors in this department
            const doctorsResult = await db.query(`
              SELECT u.id, u.name, u.phone, u.email,
                     doc.specialization, doc.experience_years, doc.consultation_fee,
                     doc.available_days, doc.available_hours, doc.is_available,
                     doc.qualifications
              FROM users u
              JOIN doctors doc ON u.id = doc.user_id
              WHERE u.role = 'DOCTOR' AND LOWER(doc.department) = LOWER($1)
              ORDER BY doc.is_available DESC, u.name
            `, [department.name]);
            
            success(res, {
              department: {
                ...department,
                doctors: doctorsResult.rows,
                doctor_count: doctorsResult.rows.length,
                available_doctor_count: doctorsResult.rows.filter(d => d.is_available).length
              },
              requestedBy: req.user?.name
            }, 'Department retrieved successfully');
          } catch (err) {
            logger.error('Database error for department:', err);
            error(res, 'Failed to retrieve department', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ],

      // Legacy route by department ID (from deprecated)
      ['/:departmentId', departmentController.getDepartmentById],

      // Get department statistics
      [
        '/:id/stats',
        async (req, res) => {
          try {
            const { id } = req.params;
            
            // Get department info
            const deptResult = await db.query('SELECT name FROM departments WHERE id = $1 AND is_active = true', [id]);
            if (deptResult.rows.length === 0) {
              return error(res, 'Department not found', HTTP_STATUS.NOT_FOUND);
            }
            
            const departmentName = deptResult.rows[0].name;
            
            // Get various statistics
            const [doctorStats, appointmentStats, recordStats] = await Promise.all([
              // Doctor statistics
              db.query(`
                SELECT 
                  COUNT(*) as total_doctors,
                  COUNT(CASE WHEN is_available = true THEN 1 END) as available_doctors,
                  ROUND(AVG(experience_years), 1) as avg_experience,
                  ROUND(AVG(consultation_fee), 2) as avg_consultation_fee,
                  COUNT(DISTINCT specialization) as specialization_count
                FROM doctors 
                WHERE LOWER(department) = LOWER($1)
              `, [departmentName]),
              
              // Appointment statistics (last 30 days)
              db.query(`
                SELECT 
                  COUNT(*) as total_appointments,
                  COUNT(CASE WHEN status = 'COMPLETED' THEN 1 END) as completed_appointments,
                  COUNT(CASE WHEN status = 'SCHEDULED' THEN 1 END) as scheduled_appointments,
                  COUNT(CASE WHEN status = 'CANCELLED' THEN 1 END) as cancelled_appointments,
                  COUNT(DISTINCT patient_id) as unique_patients
                FROM appointments a
                JOIN users d ON a.doctor_id = d.id
                JOIN doctors doc ON d.id = doc.user_id
                WHERE LOWER(doc.department) = LOWER($1) AND a.appointment_date >= CURRENT_DATE - INTERVAL '30 days'
              `, [departmentName]),
              
              // Medical records statistics (last 30 days)
              db.query(`
                SELECT 
                  COUNT(*) as total_records,
                  COUNT(DISTINCT patient_id) as unique_patients
                FROM medical_records r
                JOIN users d ON r.doctor_id = d.id
                JOIN doctors doc ON d.id = doc.user_id
                WHERE LOWER(doc.department) = LOWER($1) AND r.created_at >= CURRENT_DATE - INTERVAL '30 days'
              `, [departmentName])
            ]);
            
            success(res, {
              department: departmentName,
              statistics: {
                doctors: doctorStats.rows[0],
                appointments_last_30_days: appointmentStats.rows[0],
                medical_records_last_30_days: recordStats.rows[0]
              },
              period: 'Last 30 days',
              requestedBy: req.user?.name
            }, 'Department statistics retrieved successfully');
          } catch (err) {
            logger.error('Database error for department stats:', err);
            
            // Fallback with mock data
            success(res, {
              department: req.params.id,
              statistics: {
                doctors: {
                  total_doctors: 0,
                  available_doctors: 0,
                  avg_experience: 0,
                  avg_consultation_fee: 0,
                  specialization_count: 0
                },
                appointments_last_30_days: {
                  total_appointments: 0,
                  completed_appointments: 0,
                  scheduled_appointments: 0,
                  cancelled_appointments: 0,
                  unique_patients: 0
                },
                medical_records_last_30_days: {
                  total_records: 0,
                  unique_patients: 0
                }
              },
              period: 'Last 30 days',
              note: 'Statistics unavailable - related tables may not exist',
              requestedBy: req.user?.name
            }, 'Department statistics retrieved (empty - tables may not exist)');
          }
        }
      ]
    ],

    post: [
      // Legacy add department route (from deprecated)
      ['/', departmentController.addDepartment],

      // Enhanced create department
      [
        '/create',
        async (req, res) => {
          try {
            const { 
              name, description, head_doctor_id, contact_number, 
              location, is_active = true 
            } = req.body;
            
            if (!name || !description) {
              return error(res, 'Name and description are required', HTTP_STATUS.BAD_REQUEST);
            }
            
            // Role-based access control
            if (!['ADMIN', 'DOCTOR'].includes(req.user?.role)) {
              return error(res, 'Insufficient permissions to create departments', HTTP_STATUS.FORBIDDEN);
            }
            
            // Check if department already exists
            const existingDept = await db.query('SELECT id FROM departments WHERE LOWER(name) = LOWER($1)', [name]);
            if (existingDept.rows.length > 0) {
              return res.status(409).json({
                success: false,
                message: 'Department with this name already exists',
                existingDepartmentId: existingDept.rows[0].id
              });
            }
            
            // Verify head doctor exists if provided
            if (head_doctor_id) {
              const doctorCheck = await db.query('SELECT id, name FROM users WHERE id = $1 AND role = $2', [head_doctor_id, 'DOCTOR']);
              if (doctorCheck.rows.length === 0) {
                return error(res, 'Head doctor not found', HTTP_STATUS.NOT_FOUND);
              }
            }
            
            const result = await db.query(`
              INSERT INTO departments (name, description, head_doctor_id, contact_number, location, is_active, created_at)
              VALUES ($1, $2, $3, $4, $5, $6, NOW())
              RETURNING *
            `, [name, description, head_doctor_id, contact_number, location, is_active]);
            
            logger.info(`Department created: ${name} by ${req.user?.name}`);
            
            success(res, {
              department: result.rows[0],
              createdBy: req.user?.name
            }, 'Department created successfully', HTTP_STATUS.CREATED);
          } catch (err) {
            logger.error('Database error creating department:', err);
            error(res, 'Failed to create department', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ]
    ],

    put: [
      // Update department
      [
        '/:id',
        async (req, res) => {
          try {
            const { id } = req.params;
            const { 
              name, description, head_doctor_id, contact_number, 
              location, is_active 
            } = req.body;
            
            // Role-based access control
            if (!['ADMIN', 'DOCTOR'].includes(req.user?.role)) {
              return error(res, 'Insufficient permissions to update departments', HTTP_STATUS.FORBIDDEN);
            }
            
            // Check if department exists
            const existingDept = await db.query('SELECT * FROM departments WHERE id = $1', [id]);
            if (existingDept.rows.length === 0) {
              return error(res, 'Department not found', HTTP_STATUS.NOT_FOUND);
            }
            
            // Verify head doctor exists if provided
            if (head_doctor_id) {
              const doctorCheck = await db.query('SELECT id, name FROM users WHERE id = $1 AND role = $2', [head_doctor_id, 'DOCTOR']);
              if (doctorCheck.rows.length === 0) {
                return error(res, 'Head doctor not found', HTTP_STATUS.NOT_FOUND);
              }
            }
            
            const result = await db.query(`
              UPDATE departments SET 
                name = COALESCE($1, name),
                description = COALESCE($2, description),
                head_doctor_id = COALESCE($3, head_doctor_id),
                contact_number = COALESCE($4, contact_number),
                location = COALESCE($5, location),
                is_active = COALESCE($6, is_active),
                updated_at = NOW()
              WHERE id = $7
              RETURNING *
            `, [name, description, head_doctor_id, contact_number, location, is_active, id]);
            
            logger.info(`Department updated: ${result.rows[0].name} by ${req.user?.name}`);
            
            success(res, {
              department: result.rows[0],
              updatedBy: req.user?.name
            }, 'Department updated successfully');
          } catch (err) {
            logger.error('Database error updating department:', err);
            error(res, 'Failed to update department', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ]
    ],

    delete: [
      // Legacy delete department route (from deprecated)
      ['/:departmentId', departmentController.deleteDepartment],

      // Enhanced delete department (soft delete)
      [
        '/:id/deactivate',
        async (req, res) => {
          try {
            const { id } = req.params;
            const { reason = 'Deactivated by admin' } = req.body;
            
            // Role-based access control
            if (req.user?.role !== 'ADMIN') {
              return error(res, 'Only administrators can deactivate departments', HTTP_STATUS.FORBIDDEN);
            }
            
            // Check if department exists
            const existingDept = await db.query('SELECT * FROM departments WHERE id = $1', [id]);
            if (existingDept.rows.length === 0) {
              return error(res, 'Department not found', HTTP_STATUS.NOT_FOUND);
            }
            
            // Check if department has active doctors
            const activeDoctors = await db.query(`
              SELECT COUNT(*) as count 
              FROM doctors doc 
              JOIN users u ON doc.user_id = u.id 
              WHERE LOWER(doc.department) = LOWER($1) AND doc.is_available = true
            `, [existingDept.rows[0].name]);
            
            if (parseInt(activeDoctors.rows[0].count) > 0) {
              return error(res, `Cannot deactivate department with ${activeDoctors.rows[0].count} active doctors`, HTTP_STATUS.BAD_REQUEST);
            }
            
            // Soft delete by setting is_active to false
            const result = await db.query(`
              UPDATE departments SET 
                is_active = false,
                updated_at = NOW()
              WHERE id = $1
              RETURNING *
            `, [id]);
            
            logger.info(`Department deactivated: ${result.rows[0].name} by ${req.user?.name} - Reason: ${reason}`);
            
            success(res, {
              department: result.rows[0],
              reason,
              deactivatedBy: req.user?.name
            }, 'Department deactivated successfully');
          } catch (err) {
            logger.error('Database error deactivating department:', err);
            error(res, 'Failed to deactivate department', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ]
    ]
  },
  {
    requireUID: true,        // Require user authentication
    requirePhone: false,     // Phone not required for department operations
    auditLog: true,         // Enable audit logging
    rateLimiting: true,     // Enable rate limiting
    roles: ['ADMIN', 'DOCTOR', 'NURSE', 'PATIENT'] // Different access levels for different operations
  }
);

export default router;