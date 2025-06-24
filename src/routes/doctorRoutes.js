// src/routes/doctorRoutes.js - COMPLETE PRODUCTION VERSION WITH RBAC
import express from 'express';
import db from '../config/database.js';
import { wrapAutoRBAC } from '../config/routeWrapper.js';
import * as doctorController from '../controllers/doctorController.js';
import { success, error } from '../utils/responseHelper.js';
import logger from '../logging/logger.js';
import { HTTP_STATUS } from '../config/responseCodes.js';

const router = express.Router();
console.log('✅ doctorRoutes loaded with RBAC protection');

/**
 * ✅ Doctor Routes with RBAC protection
 * Comprehensive doctor management and profile system
 * RBAC-controlled via `doctorRoutes` config
 */
wrapAutoRBAC(
  router,
  'doctorRoutes',
  {
    get: [
      // Test route
      [
        '/test',
        (req, res) => {
          success(res, { 
            message: 'Doctor routes working!',
            timestamp: new Date().toISOString(),
            version: '2.0.0',
            user: req.user?.name || 'Unknown'
          }, 'Doctor routes operational');
        }
      ],

      // Legacy routes from deprecated version (maintained for backward compatibility)
      ['/', doctorController.getAllDoctors],
      ['/:doctorId', doctorController.getDoctorById],

      // Enhanced doctor listing with filtering and pagination
      [
        '/list',
        async (req, res) => {
          try {
            const page = parseInt(req.query.page) || 1;
            const limit = parseInt(req.query.limit) || 10;
            const offset = (page - 1) * limit;
            const department = req.query.department; // Filter by department
            const available = req.query.available; // Filter by availability
            const search = req.query.search; // Search by name or specialization
            
            let query = `
              SELECT u.id, u.uid, u.phone, u.name, u.email, u.gender, u.registered_at,
                     d.specialization, d.department, d.experience_years, d.consultation_fee,
                     d.available_days, d.available_hours, d.is_available, d.bio, d.education,
                     d.qualifications, d.created_at as profile_created
              FROM users u 
              LEFT JOIN doctors d ON u.id = d.user_id 
              WHERE u.role = 'DOCTOR'
            `;
            let params = [];
            
            if (department) {
              query += ' AND UPPER(d.department) = UPPER($' + (params.length + 1) + ')';
              params.push(department);
            }
            
            if (available !== undefined) {
              query += ' AND d.is_available = $' + (params.length + 1);
              params.push(available === 'true');
            }
            
            if (search) {
              query += ` AND (u.name ILIKE $${params.length + 1} OR d.specialization ILIKE $${params.length + 1})`;
              params.push(`%${search}%`);
            }
            
            query += ' ORDER BY u.name LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2);
            params.push(limit, offset);
            
            const result = await db.query(query, params);
            
            // Get total count with same filters
            let countQuery = 'SELECT COUNT(*) FROM users u LEFT JOIN doctors d ON u.id = d.user_id WHERE u.role = \'DOCTOR\'';
            let countParams = [];
            
            if (department) {
              countQuery += ' AND UPPER(d.department) = UPPER($' + (countParams.length + 1) + ')';
              countParams.push(department);
            }
            if (available !== undefined) {
              countQuery += ` AND d.is_available = $${countParams.length + 1}`;
              countParams.push(available === 'true');
            }
            if (search) {
              countQuery += ` AND (u.name ILIKE $${countParams.length + 1} OR d.specialization ILIKE $${countParams.length + 1})`;
              countParams.push(`%${search}%`);
            }
            
            const countResult = await db.query(countQuery, countParams);
            const totalDoctors = parseInt(countResult.rows[0].count);
            
            success(res, {
              doctors: result.rows,
              pagination: {
                page,
                limit,
                total: totalDoctors,
                totalPages: Math.ceil(totalDoctors / limit),
                hasNext: page * limit < totalDoctors,
                hasPrev: page > 1
              },
              filters: {
                department: department || null,
                available: available || null,
                search: search || null
              },
              requestedBy: req.user?.name
            }, 'Doctors retrieved successfully');
          } catch (err) {
            logger.error('Database error for doctors list:', err);
            
            // Fallback to users with DOCTOR role
            try {
              const limit = parseInt(req.query.limit) || 10;
              const fallbackResult = await db.query(
                'SELECT id, uid, phone, name, email, role, registered_at FROM users WHERE role = $1 ORDER BY name LIMIT $2',
                ['DOCTOR', limit]
              );
              
              success(res, {
                doctors: fallbackResult.rows,
                count: fallbackResult.rows.length,
                note: 'Extended doctor information unavailable - check doctors table schema',
                requestedBy: req.user?.name
              }, 'Doctors retrieved (basic info only - doctors table may not exist)');
            } catch (fallbackError) {
              logger.error('Fallback query failed:', fallbackError);
              error(res, 'Failed to retrieve doctors', HTTP_STATUS.INTERNAL_SERVER_ERROR);
            }
          }
        }
      ],

      // Get doctor by ID or UID (enhanced)
      [
        '/profile/:identifier',
        async (req, res) => {
          try {
            const { identifier } = req.params;
            const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier);
            const column = isUUID ? 'u.uid' : 'u.id';
            
            const result = await db.query(`
              SELECT u.id, u.uid, u.phone, u.name, u.email, u.gender, u.address, 
                     u.birthday, u.profile_picture, u.registered_at,
                     d.specialization, d.department, d.experience_years, d.consultation_fee,
                     d.available_days, d.available_hours, d.is_available, d.bio, d.education,
                     d.qualifications, d.created_at as profile_created, d.updated_at as profile_updated
              FROM users u 
              LEFT JOIN doctors d ON u.id = d.user_id 
              WHERE ${column} = $1 AND u.role = 'DOCTOR'
            `, [identifier]);
            
            if (result.rows.length === 0) {
              return error(res, 'Doctor not found', HTTP_STATUS.NOT_FOUND);
            }
            
            const doctor = result.rows[0];
            
            // Role-based access control for sensitive information
            if (req.user?.role === 'PATIENT') {
              // Patients see limited information
              delete doctor.phone;
              delete doctor.email;
              delete doctor.address;
              delete doctor.birthday;
            }
            
            success(res, {
              doctor,
              requestedBy: req.user?.name
            }, 'Doctor retrieved successfully');
          } catch (err) {
            logger.error('Database error:', err);
            
            // Fallback to basic user info
            try {
              const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.params.identifier);
              const column = isUUID ? 'uid' : 'id';
              
              const fallbackResult = await db.query(
                `SELECT * FROM users WHERE ${column} = $1 AND role = 'DOCTOR'`,
                [req.params.identifier]
              );
              
              if (fallbackResult.rows.length === 0) {
                return error(res, 'Doctor not found', HTTP_STATUS.NOT_FOUND);
              }
              
              success(res, {
                doctor: fallbackResult.rows[0],
                note: 'Extended doctor information unavailable',
                requestedBy: req.user?.name
              }, 'Doctor basic info retrieved');
            } catch (fallbackError) {
              logger.error('Fallback query failed:', fallbackError);
              error(res, 'Failed to retrieve doctor', HTTP_STATUS.INTERNAL_SERVER_ERROR);
            }
          }
        }
      ],

      // Get doctors by department
      [
        '/department/:department',
        async (req, res) => {
          try {
            const { department } = req.params;
            const available_only = req.query.available_only === 'true';
            
            let query = `
              SELECT u.id, u.uid, u.name, u.phone, u.email,
                     d.specialization, d.experience_years, d.consultation_fee, d.is_available,
                     d.available_days, d.available_hours, d.bio
              FROM users u 
              JOIN doctors d ON u.id = d.user_id 
              WHERE u.role = 'DOCTOR' AND UPPER(d.department) = UPPER($1)
            `;
            let params = [department];
            
            if (available_only) {
              query += ' AND d.is_available = true';
            }
            
            query += ' ORDER BY d.is_available DESC, u.name';
            
            const result = await db.query(query, params);
            
            // Filter sensitive information for patients
            const filteredDoctors = result.rows.map(doctor => {
              if (req.user?.role === 'PATIENT') {
                const { phone, email, ...publicInfo } = doctor;
                return publicInfo;
              }
              return doctor;
            });
            
            success(res, {
              doctors: filteredDoctors,
              count: filteredDoctors.length,
              department: department.toUpperCase(),
              filters: { available_only },
              requestedBy: req.user?.name
            }, `Doctors in ${department} department retrieved successfully`);
          } catch (err) {
            logger.error('Database error:', err);
            error(res, 'Failed to retrieve doctors by department', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ],

      // Get available doctors for booking
      [
        '/available/now',
        async (req, res) => {
          try {
            const today = new Date().toLocaleDateString('en-US', { weekday: 'long' }).toUpperCase();
            const currentHour = new Date().getHours();
            
            const result = await db.query(`
              SELECT u.id, u.uid, u.name, u.phone,
                     d.specialization, d.department, d.consultation_fee,
                     d.available_days, d.available_hours, d.bio
              FROM users u 
              JOIN doctors d ON u.id = d.user_id 
              WHERE u.role = 'DOCTOR' 
                AND d.is_available = true
                AND (d.available_days IS NULL OR d.available_days LIKE '%' || $1 || '%')
              ORDER BY d.department, u.name
            `, [today]);
            
            // Filter by current time (basic implementation)
            const availableNow = result.rows.filter(doctor => {
              if (!doctor.available_hours) return true;
              
              try {
                const hours = doctor.available_hours.split('-');
                const startHour = parseInt(hours[0]);
                const endHour = parseInt(hours[1]);
                return currentHour >= startHour && currentHour <= endHour;
              } catch {
                return true; // If can't parse, assume available
              }
            });
            
            // Filter sensitive information for patients
            const filteredDoctors = availableNow.map(doctor => {
              if (req.user?.role === 'PATIENT') {
                const { phone, ...publicInfo } = doctor;
                return publicInfo;
              }
              return doctor;
            });
            
            success(res, {
              doctors: filteredDoctors,
              count: filteredDoctors.length,
              currentTime: {
                day: today,
                hour: currentHour
              },
              requestedBy: req.user?.name
            }, 'Available doctors retrieved successfully');
          } catch (err) {
            logger.error('Database error:', err);
            error(res, 'Failed to retrieve available doctors', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ],

      // Get doctor statistics
      [
        '/stats/:id',
        async (req, res) => {
          try {
            const { id } = req.params;
            
            // Role-based access control
            if (req.user?.role === 'DOCTOR' && req.user.id !== parseInt(id)) {
              return error(res, 'Can only view your own statistics', HTTP_STATUS.FORBIDDEN);
            }
            
            const [appointmentStats, patientStats, revenueStats] = await Promise.all([
              // Appointment statistics (last 30 days)
              db.query(`
                SELECT 
                  COUNT(*) as total_appointments,
                  COUNT(CASE WHEN status = 'COMPLETED' THEN 1 END) as completed_appointments,
                  COUNT(CASE WHEN status = 'SCHEDULED' THEN 1 END) as scheduled_appointments,
                  COUNT(CASE WHEN status = 'CANCELLED' THEN 1 END) as cancelled_appointments
                FROM appointments 
                WHERE doctor_id = $1 AND appointment_date >= CURRENT_DATE - INTERVAL '30 days'
              `, [id]),
              
              // Patient statistics
              db.query(`
                SELECT 
                  COUNT(DISTINCT patient_id) as unique_patients,
                  COUNT(*) as total_consultations
                FROM appointments 
                WHERE doctor_id = $1 AND status = 'COMPLETED'
              `, [id]),
              
              // Revenue statistics (last 30 days)
              db.query(`
                SELECT 
                  COUNT(CASE WHEN a.status = 'COMPLETED' THEN 1 END) * d.consultation_fee as estimated_revenue_30d,
                  d.consultation_fee
                FROM appointments a
                JOIN doctors d ON a.doctor_id = (SELECT user_id FROM doctors WHERE user_id = $1)
                WHERE a.doctor_id = $1 AND a.appointment_date >= CURRENT_DATE - INTERVAL '30 days'
                GROUP BY d.consultation_fee
              `, [id])
            ]);
            
            success(res, {
              doctor_id: id,
              statistics: {
                appointments_last_30_days: appointmentStats.rows[0],
                patient_statistics: patientStats.rows[0],
                revenue_last_30_days: revenueStats.rows[0] || { estimated_revenue_30d: 0, consultation_fee: 0 }
              },
              period: 'Last 30 days',
              requestedBy: req.user?.name
            }, 'Doctor statistics retrieved successfully');
          } catch (err) {
            logger.error('Database error for doctor stats:', err);
            
            // Fallback with mock data
            success(res, {
              doctor_id: req.params.id,
              statistics: {
                appointments_last_30_days: {
                  total_appointments: 0,
                  completed_appointments: 0,
                  scheduled_appointments: 0,
                  cancelled_appointments: 0
                },
                patient_statistics: {
                  unique_patients: 0,
                  total_consultations: 0
                },
                revenue_last_30_days: {
                  estimated_revenue_30d: 0,
                  consultation_fee: 0
                }
              },
              period: 'Last 30 days',
              note: 'Statistics unavailable - related tables may not exist',
              requestedBy: req.user?.name
            }, 'Doctor statistics retrieved (empty - tables may not exist)');
          }
        }
      ]
    ],

    post: [
      // Legacy add doctor route (from deprecated)
      ['/', doctorController.addDoctor],

      // Create doctor profile (requires existing user with DOCTOR role)
      [
        '/profile',
        async (req, res) => {
          try {
            const { 
              user_id, specialization, department, experience_years, 
              consultation_fee, available_days, available_hours, bio, education,
              qualifications
            } = req.body;
            
            if (!user_id || !specialization || !department) {
              return error(res, 'user_id, specialization, and department are required', HTTP_STATUS.BAD_REQUEST);
            }
            
            // Role-based access control
            if (req.user?.role === 'DOCTOR' && req.user.id !== parseInt(user_id)) {
              return error(res, 'Can only create profile for yourself', HTTP_STATUS.FORBIDDEN);
            }
            if (!['ADMIN', 'DOCTOR'].includes(req.user?.role)) {
              return error(res, 'Insufficient permissions to create doctor profile', HTTP_STATUS.FORBIDDEN);
            }
            
            // Verify user exists and is a doctor
            const userCheck = await db.query('SELECT id, role, name FROM users WHERE id = $1', [user_id]);
            if (userCheck.rows.length === 0) {
              return error(res, 'User not found', HTTP_STATUS.NOT_FOUND);
            }
            if (userCheck.rows[0].role !== 'DOCTOR') {
              return error(res, 'User must have DOCTOR role', HTTP_STATUS.BAD_REQUEST);
            }
            
            // Check if doctor profile already exists
            const existingProfile = await db.query('SELECT user_id FROM doctors WHERE user_id = $1', [user_id]);
            if (existingProfile.rows.length > 0) {
              return res.status(409).json({
                success: false,
                message: 'Doctor profile already exists',
                existing_profile_id: existingProfile.rows[0].user_id
              });
            }
            
            const result = await db.query(`
              INSERT INTO doctors (
                user_id, specialization, department, experience_years, 
                consultation_fee, available_days, available_hours, bio, education,
                qualifications, is_available, created_at
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true, NOW())
              RETURNING *
            `, [user_id, specialization, department.toUpperCase(), experience_years, 
                consultation_fee, available_days, available_hours, bio, education, qualifications]);
            
            logger.info(`Doctor profile created for ${userCheck.rows[0].name} by ${req.user?.name}`);
            
            success(res, {
              profile: result.rows[0],
              user_name: userCheck.rows[0].name,
              createdBy: req.user?.name
            }, 'Doctor profile created successfully', HTTP_STATUS.CREATED);
          } catch (err) {
            logger.error('Database error creating doctor profile:', err);
            error(res, 'Failed to create doctor profile', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ]
    ],

    put: [
      // Update doctor availability
      [
        '/:id/availability',
        async (req, res) => {
          try {
            const { id } = req.params;
            const { is_available, available_days, available_hours } = req.body;
            
            // Role-based access control
            if (req.user?.role === 'DOCTOR' && req.user.id !== parseInt(id)) {
              return error(res, 'Can only update your own availability', HTTP_STATUS.FORBIDDEN);
            }
            if (!['ADMIN', 'DOCTOR'].includes(req.user?.role)) {
              return error(res, 'Insufficient permissions to update doctor availability', HTTP_STATUS.FORBIDDEN);
            }
            
            const result = await db.query(`
              UPDATE doctors SET 
                is_available = COALESCE($1, is_available),
                available_days = COALESCE($2, available_days),
                available_hours = COALESCE($3, available_hours),
                updated_at = NOW()
              WHERE user_id = $4
              RETURNING user_id, is_available, available_days, available_hours
            `, [is_available, available_days, available_hours, id]);
            
            if (result.rows.length === 0) {
              return error(res, 'Doctor profile not found', HTTP_STATUS.NOT_FOUND);
            }
            
            logger.info(`Doctor availability updated for user ${id} by ${req.user?.name}`);
            
            success(res, {
              availability: result.rows[0],
              updatedBy: req.user?.name
            }, 'Doctor availability updated successfully');
          } catch (err) {
            logger.error('Database error updating availability:', err);
            error(res, 'Failed to update doctor availability', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ],

      // Update doctor profile
      [
        '/:id/profile',
        async (req, res) => {
          try {
            const { id } = req.params;
            const { 
              specialization, department, experience_years, consultation_fee,
              bio, education, qualifications
            } = req.body;
            
            // Role-based access control
            if (req.user?.role === 'DOCTOR' && req.user.id !== parseInt(id)) {
              return error(res, 'Can only update your own profile', HTTP_STATUS.FORBIDDEN);
            }
            if (!['ADMIN', 'DOCTOR'].includes(req.user?.role)) {
              return error(res, 'Insufficient permissions to update doctor profile', HTTP_STATUS.FORBIDDEN);
            }
            
            const result = await db.query(`
              UPDATE doctors SET 
                specialization = COALESCE($1, specialization),
                department = COALESCE($2, department),
                experience_years = COALESCE($3, experience_years),
                consultation_fee = COALESCE($4, consultation_fee),
                bio = COALESCE($5, bio),
                education = COALESCE($6, education),
                qualifications = COALESCE($7, qualifications),
                updated_at = NOW()
              WHERE user_id = $8
              RETURNING *
            `, [specialization, department?.toUpperCase(), experience_years, consultation_fee,
                bio, education, qualifications, id]);
            
            if (result.rows.length === 0) {
              return error(res, 'Doctor profile not found', HTTP_STATUS.NOT_FOUND);
            }
            
            logger.info(`Doctor profile updated for user ${id} by ${req.user?.name}`);
            
            success(res, {
              profile: result.rows[0],
              updatedBy: req.user?.name
            }, 'Doctor profile updated successfully');
          } catch (err) {
            logger.error('Database error updating profile:', err);
            error(res, 'Failed to update doctor profile', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ]
    ],

    delete: [
      // Legacy delete doctor route (from deprecated)
      ['/:doctorId', doctorController.deleteDoctor],

      // Deactivate doctor profile (soft delete)
      [
        '/:id/deactivate',
        async (req, res) => {
          try {
            const { id } = req.params;
            const { reason = 'Deactivated by admin' } = req.body;
            
            // Role-based access control
            if (req.user?.role !== 'ADMIN') {
              return error(res, 'Only administrators can deactivate doctor profiles', HTTP_STATUS.FORBIDDEN);
            }
            
            // Check for active appointments
            const activeAppointments = await db.query(`
              SELECT COUNT(*) as count 
              FROM appointments 
              WHERE doctor_id = $1 AND status = 'SCHEDULED' AND appointment_date >= CURRENT_DATE
            `, [id]);
            
            if (parseInt(activeAppointments.rows[0].count) > 0) {
              return error(res, `Cannot deactivate doctor with ${activeAppointments.rows[0].count} upcoming appointments`, HTTP_STATUS.BAD_REQUEST);
            }
            
            const result = await db.query(`
              UPDATE doctors SET 
                is_available = false,
                updated_at = NOW()
              WHERE user_id = $1
              RETURNING user_id
            `, [id]);
            
            if (result.rows.length === 0) {
              return error(res, 'Doctor profile not found', HTTP_STATUS.NOT_FOUND);
            }
            
            logger.info(`Doctor profile deactivated for user ${id} by ${req.user?.name} - Reason: ${reason}`);
            
            success(res, {
              doctor_id: id,
              reason,
              deactivatedBy: req.user?.name
            }, 'Doctor profile deactivated successfully');
          } catch (err) {
            logger.error('Database error deactivating doctor:', err);
            error(res, 'Failed to deactivate doctor profile', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ]
    ]
  },
  {
    requireUID: true,        // Require user authentication
    requirePhone: false,     // Phone not required for doctor operations
    auditLog: true,         // Enable audit logging
    rateLimiting: true,     // Enable rate limiting
    roles: ['ADMIN', 'DOCTOR', 'NURSE', 'PATIENT'] // Different access levels for different operations
  }
);

export default router;