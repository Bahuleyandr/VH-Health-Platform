// src/routes/adminDoctorRoutes.js - COMPLETE VERSION with SECURITY

import express from 'express';
import db from '../config/database.js';
import logger from '../logging/logger.js';
import { success, error } from '../utils/responseHelper.js';
import { HTTP_STATUS, RESPONSE_MESSAGES } from '../config/responseCodes.js';
import { wrapAutoRBAC } from '../config/routeWrapper.js';

const router = express.Router();
console.log('✅ adminDoctorRoutes loaded');

/**
 * ✅ Admin-only Doctor Management with Advanced Features
 * Secured with RBAC, comprehensive doctor operations, analytics, and management
 */
wrapAutoRBAC(
  router,
  'adminDoctorRoutes',
  {
    get: [
      // Test route
      [
        '/test',
        (req, res) => {
          res.json({ 
            message: 'Admin doctor routes working!',
            timestamp: new Date().toISOString(),
            version: '2.0.0',
            user: req.user?.role || 'anonymous'
          });
        }
      ],

      // Get comprehensive doctor management overview
      [
        '/overview',
        async (req, res) => {
          try {
            const [doctorStats, performanceMetrics, departmentDistribution] = await Promise.all([
              // Doctor statistics
              db.query(`
                SELECT 
                  COUNT(*) as total_doctors,
                  COUNT(CASE WHEN d.is_available = true THEN 1 END) as available_doctors,
                  COUNT(CASE WHEN d.is_available = false THEN 1 END) as unavailable_doctors,
                  COUNT(CASE WHEN u.registered_at >= CURRENT_DATE - INTERVAL '30 days' THEN 1 END) as new_doctors_30d,
                  AVG(d.experience_years) as avg_experience,
                  AVG(d.consultation_fee) as avg_consultation_fee
                FROM users u
                JOIN doctors d ON u.id = d.user_id
                WHERE u.role = 'DOCTOR'
              `),
              
              // Performance metrics (last 30 days)
              db.query(`
                SELECT u.id, u.name, d.specialization, d.department,
                       COUNT(a.id) as total_appointments,
                       COUNT(CASE WHEN a.status = 'COMPLETED' THEN 1 END) as completed_appointments,
                       COUNT(CASE WHEN a.status = 'CANCELLED' THEN 1 END) as cancelled_appointments,
                       SUM(CASE WHEN a.status = 'COMPLETED' THEN d.consultation_fee ELSE 0 END) as revenue,
                       ROUND(AVG(CASE WHEN a.status = 'COMPLETED' THEN 5 ELSE 0 END), 2) as avg_rating
                FROM users u
                JOIN doctors d ON u.id = d.user_id
                LEFT JOIN appointments a ON u.id = a.doctor_id 
                  AND a.appointment_date >= CURRENT_DATE - INTERVAL '30 days'
                WHERE u.role = 'DOCTOR'
                GROUP BY u.id, u.name, d.specialization, d.department, d.consultation_fee
                ORDER BY total_appointments DESC
                LIMIT 10
              `),
              
              // Department distribution
              db.query(`
                SELECT d.department, d.specialization,
                       COUNT(*) as doctor_count,
                       COUNT(CASE WHEN d.is_available = true THEN 1 END) as available_count,
                       AVG(d.consultation_fee) as avg_fee
                FROM doctors d
                GROUP BY d.department, d.specialization
                ORDER BY d.department, doctor_count DESC
              `)
            ]);
            
            res.json({
              message: 'Doctor management overview retrieved successfully',
              overview: {
                statistics: doctorStats.rows[0],
                top_performers: performanceMetrics.rows,
                department_distribution: departmentDistribution.rows
              },
              generated_at: new Date().toISOString()
            });
          } catch (error) {
            logger.error('Database error for doctor overview:', error.message);
            res.status(500).json({
              message: 'Failed to retrieve doctor overview',
              error: error.message
            });
          }
        }
      ],

      // Get doctor management list with advanced filtering
      [
        '/manage',
        async (req, res) => {
          try {
            const page = parseInt(req.query.page) || 1;
            const limit = parseInt(req.query.limit) || 20;
            const offset = (page - 1) * limit;
            const department = req.query.department;
            const specialization = req.query.specialization;
            const status = req.query.status; // available, unavailable, all
            const experience_min = req.query.experience_min;
            const experience_max = req.query.experience_max;
            const search = req.query.search;
            
            let query = `
              SELECT u.id, u.uid, u.name, u.phone, u.email, u.gender, u.registered_at,
                     d.specialization, d.department, d.experience_years, d.consultation_fee,
                     d.available_days, d.available_hours, d.is_available, d.bio,
                     d.education, d.certifications,
                     COUNT(a.id) as total_appointments,
                     COUNT(CASE WHEN a.status = 'COMPLETED' AND a.appointment_date >= CURRENT_DATE - INTERVAL '30 days' THEN 1 END) as recent_appointments
              FROM users u
              JOIN doctors d ON u.id = d.user_id
              LEFT JOIN appointments a ON u.id = a.doctor_id
              WHERE u.role = 'DOCTOR'
            `;
            let params = [];
            
            if (department) {
              query += ' AND d.department = $' + (params.length + 1);
              params.push(department);
            }
            
            if (specialization) {
              query += ' AND d.specialization = $' + (params.length + 1);
              params.push(specialization);
            }
            
            if (status === 'available') {
              query += ' AND d.is_available = true';
            } else if (status === 'unavailable') {
              query += ' AND d.is_available = false';
            }
            
            if (experience_min) {
              query += ' AND d.experience_years >= $' + (params.length + 1);
              params.push(parseInt(experience_min));
            }
            
            if (experience_max) {
              query += ' AND d.experience_years <= $' + (params.length + 1);
              params.push(parseInt(experience_max));
            }
            
            if (search) {
              query += ` AND (u.name ILIKE $${params.length + 1} OR d.specialization ILIKE $${params.length + 1} OR d.department ILIKE $${params.length + 1})`;
              params.push(`%${search}%`);
            }
            
            query += ` GROUP BY u.id, u.uid, u.name, u.phone, u.email, u.gender, u.registered_at,
                       d.specialization, d.department, d.experience_years, d.consultation_fee,
                       d.available_days, d.available_hours, d.is_available, d.bio, d.education, d.certifications
                       ORDER BY u.name LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
            params.push(limit, offset);
            
            const result = await db.query(query, params);
            
            // Get total count
            let countQuery = `SELECT COUNT(*) FROM users u JOIN doctors d ON u.id = d.user_id WHERE u.role = 'DOCTOR'`;
            let countParams = [];
            
            if (department) {
              countQuery += ' AND d.department = $' + (countParams.length + 1);
              countParams.push(department);
            }
            if (specialization) {
              countQuery += ' AND d.specialization = $' + (countParams.length + 1);
              countParams.push(specialization);
            }
            if (status === 'available') {
              countQuery += ' AND d.is_available = true';
            } else if (status === 'unavailable') {
              countQuery += ' AND d.is_available = false';
            }
            if (experience_min) {
              countQuery += ' AND d.experience_years >= $' + (countParams.length + 1);
              countParams.push(parseInt(experience_min));
            }
            if (experience_max) {
              countQuery += ' AND d.experience_years <= $' + (countParams.length + 1);
              countParams.push(parseInt(experience_max));
            }
            if (search) {
              countQuery += ` AND (u.name ILIKE $${countParams.length + 1} OR d.specialization ILIKE $${countParams.length + 1} OR d.department ILIKE $${countParams.length + 1})`;
              countParams.push(`%${search}%`);
            }
            
            const countResult = await db.query(countQuery, countParams);
            const totalDoctors = parseInt(countResult.rows[0].count);
            
            res.json({
              message: 'Doctor management data retrieved successfully',
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
                specialization: specialization || null,
                status: status || null,
                experience_range: {
                  min: experience_min || null,
                  max: experience_max || null
                },
                search: search || null
              }
            });
          } catch (error) {
            logger.error('Database error for doctor management:', error.message);
            res.status(500).json({
              message: 'Failed to retrieve doctor management data',
              error: error.message
            });
          }
        }
      ],

      // Get doctor performance analytics
      [
        '/:id/analytics',
        async (req, res) => {
          try {
            const { id } = req.params;
            const months = parseInt(req.query.months) || 6;
            
            // Verify doctor exists
            const doctorCheck = await db.query(
              'SELECT u.name, d.specialization, d.department FROM users u JOIN doctors d ON u.id = d.user_id WHERE u.id = $1',
              [id]
            );
            
            if (doctorCheck.rows.length === 0) {
              return res.status(404).json({ message: 'Doctor not found' });
            }
            
            const [appointmentStats, monthlyTrends, patientFeedback] = await Promise.all([
              // Appointment statistics
              db.query(`
                SELECT 
                  COUNT(*) as total_appointments,
                  COUNT(CASE WHEN status = 'COMPLETED' THEN 1 END) as completed_appointments,
                  COUNT(CASE WHEN status = 'CANCELLED' THEN 1 END) as cancelled_appointments,
                  COUNT(CASE WHEN status = 'NO_SHOW' THEN 1 END) as no_show_appointments,
                  ROUND(COUNT(CASE WHEN status = 'COMPLETED' THEN 1 END)::numeric / NULLIF(COUNT(*), 0) * 100, 2) as completion_rate
                FROM appointments 
                WHERE doctor_id = $1 AND appointment_date >= CURRENT_DATE - INTERVAL '${months} months'
              `, [id]),
              
              // Monthly trends
              db.query(`
                SELECT DATE_TRUNC('month', appointment_date) as month,
                       COUNT(*) as total_appointments,
                       COUNT(CASE WHEN status = 'COMPLETED' THEN 1 END) as completed_appointments,
                       SUM(CASE WHEN status = 'COMPLETED' THEN d.consultation_fee ELSE 0 END) as revenue
                FROM appointments a
                JOIN doctors d ON a.doctor_id = d.user_id
                WHERE a.doctor_id = $1 AND a.appointment_date >= CURRENT_DATE - INTERVAL '${months} months'
                GROUP BY DATE_TRUNC('month', appointment_date)
                ORDER BY month DESC
              `, [id]),
              
              // Patient feedback/ratings (if available)
              db.query(`
                SELECT AVG(rating) as avg_rating, COUNT(*) as total_reviews,
                       COUNT(CASE WHEN rating >= 4 THEN 1 END) as positive_reviews
                FROM patient_feedback 
                WHERE doctor_id = $1 AND created_at >= CURRENT_DATE - INTERVAL '${months} months'
              `, [id])
            ]);
            
            res.json({
              message: 'Doctor analytics retrieved successfully',
              doctor: doctorCheck.rows[0],
              analytics: {
                appointment_statistics: appointmentStats.rows[0],
                monthly_trends: monthlyTrends.rows,
                patient_feedback: patientFeedback.rows[0] || { avg_rating: null, total_reviews: 0, positive_reviews: 0 }
              },
              period_months: months,
              generated_at: new Date().toISOString()
            });
          } catch (error) {
            logger.error('Database error for doctor analytics:', error.message);
            res.status(500).json({
              message: 'Failed to retrieve doctor analytics',
              error: error.message
            });
          }
        }
      ],

      // Get doctor workload analysis
      [
        '/workload-analysis',
        async (req, res) => {
          try {
            const days = parseInt(req.query.days) || 30;
            const department = req.query.department;
            
            let query = `
              SELECT u.id, u.name, d.specialization, d.department,
                     d.available_days, d.available_hours,
                     COUNT(a.id) as total_appointments,
                     COUNT(CASE WHEN a.status = 'COMPLETED' THEN 1 END) as completed_appointments,
                     COUNT(CASE WHEN a.status = 'CANCELLED' THEN 1 END) as cancelled_appointments,
                     ROUND(COUNT(a.id)::numeric / $1, 2) as avg_appointments_per_day,
                     CASE 
                       WHEN COUNT(a.id) > 50 THEN 'HIGH'
                       WHEN COUNT(a.id) > 25 THEN 'MEDIUM'
                       ELSE 'LOW'
                     END as workload_level,
                     SUM(CASE WHEN a.status = 'COMPLETED' THEN d.consultation_fee ELSE 0 END) as revenue
              FROM users u
              JOIN doctors d ON u.id = d.user_id
              LEFT JOIN appointments a ON u.id = a.doctor_id 
                AND a.appointment_date >= CURRENT_DATE - INTERVAL '${days} days'
              WHERE u.role = 'DOCTOR' AND d.is_available = true
            `;
            let params = [days];
            
            if (department) {
              query += ' AND d.department = $2';
              params.push(department);
            }
            
            query += ` GROUP BY u.id, u.name, d.specialization, d.department, 
                       d.available_days, d.available_hours, d.consultation_fee
                       ORDER BY total_appointments DESC`;
            
            const result = await db.query(query, params);
            
            // Calculate workload distribution
            const workloadDistribution = result.rows.reduce((acc, doctor) => {
              const level = doctor.workload_level;
              acc[level] = (acc[level] || 0) + 1;
              return acc;
            }, {});
            
            res.json({
              message: 'Doctor workload analysis retrieved successfully',
              workload_analysis: result.rows,
              distribution: workloadDistribution,
              summary: {
                total_doctors: result.rows.length,
                avg_appointments: Math.round(result.rows.reduce((sum, d) => sum + parseInt(d.total_appointments), 0) / result.rows.length),
                high_workload_doctors: result.rows.filter(d => d.workload_level === 'HIGH').length
              },
              period_days: days,
              department_filter: department || null
            });
          } catch (error) {
            logger.error('Database error for workload analysis:', error.message);
            res.status(500).json({
              message: 'Failed to retrieve workload analysis',
              error: error.message
            });
          }
        }
      ]
    ],

    post: [
      // Legacy simple doctor creation (from deprecated version)
      [
        '/',
        async (req, res) => {
          const { name, department, intro, imageUrl } = req.body;

          if (!name || !department) {
            return res.status(HTTP_STATUS.BAD_REQUEST).json({
              error: RESPONSE_MESSAGES.VALIDATION_FAILED,
              details: 'Doctor name and department are required.'
            });
          }

          try {
            const result = await db.query(
              `INSERT INTO doctors (name, department, intro, image_url) VALUES ($1, $2, $3, $4) RETURNING *`,
              [name, department, intro, imageUrl]
            );
            success(res, result.rows[0], 'Doctor saved successfully');
          } catch (err) {
            logger.error(err.stack || err.toString());
            error(res, RESPONSE_MESSAGES.DATABASE_ERROR);
          }
        }
      ],

      // Create comprehensive doctor account (admin only)
      [
        '/create',
        async (req, res) => {
          try {
            const {
              name, phone, email, gender, address, birthday,
              specialization, department, experience_years, consultation_fee,
              available_days, available_hours, bio, education, certifications
            } = req.body;
            
            if (!name || !phone || !specialization || !department || !consultation_fee) {
              return res.status(400).json({
                message: 'name, phone, specialization, department, and consultation_fee are required'
              });
            }
            
            // Check if user already exists
            const existingUser = await db.query('SELECT id FROM users WHERE phone = $1', [phone]);
            if (existingUser.rows.length > 0) {
              return res.status(409).json({
                message: 'User with this phone number already exists'
              });
            }
            
            // Create user account
            const userResult = await db.query(`
              INSERT INTO users (phone, name, email, gender, address, birthday, role, registered_at)
              VALUES ($1, $2, $3, $4, $5, $6, 'DOCTOR', NOW())
              RETURNING *
            `, [phone, name, email, gender, address, birthday]);
            
            const userId = userResult.rows[0].id;
            
            // Create doctor profile
            const doctorResult = await db.query(`
              INSERT INTO doctors (
                user_id, specialization, department, experience_years, consultation_fee,
                available_days, available_hours, bio, education, certifications,
                is_available, created_at
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true, NOW())
              RETURNING *
            `, [userId, specialization, department, experience_years, consultation_fee,
                available_days, available_hours, bio, education, certifications]);
            
            logger.info(`[adminDoctorRoutes] Doctor account created: ${name} (${phone}) by ${req.user?.uid}`);
            res.status(201).json({
              message: 'Doctor account created successfully',
              user: userResult.rows[0],
              doctor_profile: doctorResult.rows[0]
            });
          } catch (error) {
            logger.error('Database error:', error.message);
            res.status(500).json({
              message: 'Failed to create doctor account',
              error: error.message
            });
          }
        }
      ],

      // Bulk doctor operations
      [
        '/bulk-operations',
        async (req, res) => {
          try {
            const { operation, doctor_ids, data } = req.body;
            
            if (!operation || !doctor_ids || !Array.isArray(doctor_ids)) {
              return res.status(400).json({
                message: 'operation and doctor_ids array are required'
              });
            }
            
            const validOperations = ['activate', 'deactivate', 'update_fee', 'change_department', 'update_schedule'];
            if (!validOperations.includes(operation)) {
              return res.status(400).json({
                message: 'Invalid operation',
                validOperations
              });
            }
            
            let results = [];
            
            switch (operation) {
              case 'activate':
                const activateResult = await db.query(
                  'UPDATE doctors SET is_available = true, updated_at = NOW() WHERE user_id = ANY($1) RETURNING user_id',
                  [doctor_ids]
                );
                results = activateResult.rows;
                break;
                
              case 'deactivate':
                const deactivateResult = await db.query(
                  'UPDATE doctors SET is_available = false, updated_at = NOW() WHERE user_id = ANY($1) RETURNING user_id',
                  [doctor_ids]
                );
                
                // Cancel future appointments for deactivated doctors
                await db.query(`
                  UPDATE appointments SET 
                    status = 'CANCELLED',
                    notes = COALESCE(notes || ' ', '') || 'Doctor deactivated by admin',
                    updated_at = NOW()
                  WHERE doctor_id = ANY($1) AND status = 'SCHEDULED' AND appointment_date > CURRENT_DATE
                `, [doctor_ids]);
                
                results = deactivateResult.rows;
                break;
                
              case 'update_fee':
                if (!data.consultation_fee) {
                  return res.status(400).json({ message: 'consultation_fee is required for update_fee operation' });
                }
                const feeResult = await db.query(
                  'UPDATE doctors SET consultation_fee = $1, updated_at = NOW() WHERE user_id = ANY($2) RETURNING user_id, consultation_fee',
                  [data.consultation_fee, doctor_ids]
                );
                results = feeResult.rows;
                break;
                
              case 'change_department':
                if (!data.department) {
                  return res.status(400).json({ message: 'department is required for change_department operation' });
                }
                const deptResult = await db.query(
                  'UPDATE doctors SET department = $1, updated_at = NOW() WHERE user_id = ANY($2) RETURNING user_id, department',
                  [data.department, doctor_ids]
                );
                results = deptResult.rows;
                break;
                
              case 'update_schedule':
                if (!data.available_days || !data.available_hours) {
                  return res.status(400).json({ message: 'available_days and available_hours are required for update_schedule operation' });
                }
                const scheduleResult = await db.query(
                  'UPDATE doctors SET available_days = $1, available_hours = $2, updated_at = NOW() WHERE user_id = ANY($3) RETURNING user_id, available_days, available_hours',
                  [data.available_days, data.available_hours, doctor_ids]
                );
                results = scheduleResult.rows;
                break;
            }
            
            logger.info(`[adminDoctorRoutes] Bulk ${operation} performed on ${doctor_ids.length} doctors by ${req.user?.uid}`);
            res.json({
              message: `Bulk ${operation} operation completed successfully`,
              operation,
              affected_doctors: results,
              count: results.length
            });
          } catch (error) {
            logger.error('Database error for bulk operations:', error.message);
            res.status(500).json({
              message: 'Failed to perform bulk operation',
              error: error.message
            });
          }
        }
      ]
    ],

    put: [
      // Update doctor profile (admin only)
      [
        '/:id/profile',
        async (req, res) => {
          try {
            const { id } = req.params;
            const { 
              specialization, department, experience_years, consultation_fee,
              available_days, available_hours, bio, education, certifications,
              is_available 
            } = req.body;
            
            // Verify doctor exists
            const doctorCheck = await db.query(
              'SELECT u.name FROM users u JOIN doctors d ON u.id = d.user_id WHERE u.id = $1 AND u.role = $2',
              [id, 'DOCTOR']
            );
            
            if (doctorCheck.rows.length === 0) {
              return res.status(404).json({ message: 'Doctor not found' });
            }
            
            const result = await db.query(`
              UPDATE doctors SET 
                specialization = COALESCE($1, specialization),
                department = COALESCE($2, department),
                experience_years = COALESCE($3, experience_years),
                consultation_fee = COALESCE($4, consultation_fee),
                available_days = COALESCE($5, available_days),
                available_hours = COALESCE($6, available_hours),
                bio = COALESCE($7, bio),
                education = COALESCE($8, education),
                certifications = COALESCE($9, certifications),
                is_available = COALESCE($10, is_available),
                updated_at = NOW()
              WHERE user_id = $11
              RETURNING *
            `, [specialization, department, experience_years, consultation_fee,
                available_days, available_hours, bio, education, certifications,
                is_available, id]);
            
            logger.info(`[adminDoctorRoutes] Doctor profile updated: ${id} by ${req.user?.uid}`);
            res.json({
              message: 'Doctor profile updated successfully',
              doctor: {
                ...result.rows[0],
                name: doctorCheck.rows[0].name
              }
            });
          } catch (error) {
            logger.error('Database error:', error.message);
            res.status(500).json({
              message: 'Failed to update doctor profile',
              error: error.message
            });
          }
        }
      ],

      // Update doctor availability status
      [
        '/:id/availability',
        async (req, res) => {
          try {
            const { id } = req.params;
            const { is_available, available_days, available_hours, reason } = req.body;
            
            if (typeof is_available !== 'boolean') {
              return res.status(400).json({
                message: 'is_available must be a boolean value'
              });
            }
            
            const result = await db.query(`
              UPDATE doctors SET 
                is_available = $1,
                available_days = COALESCE($2, available_days),
                available_hours = COALESCE($3, available_hours),
                notes = COALESCE($4, notes),
                updated_at = NOW()
              WHERE user_id = $5
              RETURNING *
            `, [is_available, available_days, available_hours, reason, id]);
            
            if (result.rows.length === 0) {
              return res.status(404).json({ message: 'Doctor not found' });
            }
            
            // If making unavailable, update any scheduled appointments
            if (!is_available) {
              const affectedAppointments = await db.query(`
                UPDATE appointments SET 
                  status = 'CANCELLED',
                  notes = COALESCE(notes || ' ', '') || 'Doctor became unavailable: ' || COALESCE($1, 'Administrative decision'),
                  updated_at = NOW()
                WHERE doctor_id = $2 AND status = 'SCHEDULED' AND appointment_date > CURRENT_DATE
                RETURNING id, appointment_date, appointment_time
              `, [reason, id]);
              
              logger.info(`[adminDoctorRoutes] Doctor ${id} made unavailable, ${affectedAppointments.rows.length} appointments cancelled by ${req.user?.uid}`);
              res.json({
                message: 'Doctor availability updated successfully',
                doctor: result.rows[0],
                affected_appointments: affectedAppointments.rows.length,
                cancelled_appointments: affectedAppointments.rows
              });
            } else {
              logger.info(`[adminDoctorRoutes] Doctor ${id} made available by ${req.user?.uid}`);
              res.json({
                message: 'Doctor availability updated successfully',
                doctor: result.rows[0]
              });
            }
          } catch (error) {
            logger.error('Database error:', error.message);
            res.status(500).json({
              message: 'Failed to update doctor availability',
              error: error.message
            });
          }
        }
      ]
    ],

    delete: [
      // Legacy simple doctor deletion (from deprecated version)
      [
        '/:doctorId',
        async (req, res) => {
          const { doctorId } = req.params;

          try {
            const deleteResult = await db.query('DELETE FROM doctors WHERE id = $1 RETURNING *', [
              doctorId
            ]);

            if (deleteResult.rowCount === 0) {
              return res.status(HTTP_STATUS.NOT_FOUND).json({
                error: RESPONSE_MESSAGES.NOT_FOUND,
                details: 'Doctor not found or already deleted.'
              });
            }

            logger.info(`[adminDoctorRoutes] Doctor deleted: ${doctorId} by ${req.user?.uid}`);
            success(res, deleteResult.rows[0], 'Doctor deleted successfully');
          } catch (err) {
            logger.error(err.stack || err.toString());
            error(res, RESPONSE_MESSAGES.DATABASE_ERROR);
          }
        }
      ],

      // Advanced doctor account deletion (admin only - soft delete)
      [
        '/:id/account',
        async (req, res) => {
          try {
            const { id } = req.params;
            const { reason, transfer_patients_to } = req.body;
            
            // Verify doctor exists
            const doctorCheck = await db.query(
              'SELECT u.name, d.department FROM users u JOIN doctors d ON u.id = d.user_id WHERE u.id = $1',
              [id]
            );
            
            if (doctorCheck.rows.length === 0) {
              return res.status(404).json({ message: 'Doctor not found' });
            }
            
            // Check for future appointments
            const futureAppointments = await db.query(
              'SELECT COUNT(*) as count FROM appointments WHERE doctor_id = $1 AND status = $2 AND appointment_date > CURRENT_DATE',
              [id, 'SCHEDULED']
            );
            
            const futureCount = parseInt(futureAppointments.rows[0].count);
            
            if (futureCount > 0 && !transfer_patients_to) {
              return res.status(400).json({
                message: 'Doctor has future appointments',
                future_appointments: futureCount,
                suggestion: 'Provide transfer_patients_to doctor ID or cancel appointments first'
              });
            }
            
            // Transfer or cancel future appointments
            if (futureCount > 0) {
              if (transfer_patients_to) {
                // Verify transfer target doctor exists
                const transferDoctor = await db.query(
                  'SELECT name FROM users WHERE id = $1 AND role = $2',
                  [transfer_patients_to, 'DOCTOR']
                );
                
                if (transferDoctor.rows.length === 0) {
                  return res.status(404).json({ message: 'Transfer target doctor not found' });
                }
                
                await db.query(`
                  UPDATE appointments SET 
                    doctor_id = $1,
                    notes = COALESCE(notes || ' ', '') || 'Transferred due to doctor account deletion',
                    updated_at = NOW()
                  WHERE doctor_id = $2 AND status = 'SCHEDULED' AND appointment_date > CURRENT_DATE
                `, [transfer_patients_to, id]);
              } else {
                await db.query(`
                  UPDATE appointments SET 
                    status = 'CANCELLED',
                    notes = COALESCE(notes || ' ', '') || 'Doctor account deleted: ' || COALESCE($1, 'Administrative decision'),
                    updated_at = NOW()
                  WHERE doctor_id = $2 AND status = 'SCHEDULED' AND appointment_date > CURRENT_DATE
                `, [reason, id]);
              }
            }
            
            // Soft delete: deactivate doctor and mark as deleted
            await db.query('UPDATE doctors SET is_available = false, updated_at = NOW() WHERE user_id = $1', [id]);
            
            // In a real system, you might want to keep the user account but mark it as deleted
            // For now, we'll just deactivate the doctor profile
            
            logger.info(`[adminDoctorRoutes] Doctor account deleted: ${doctorCheck.rows[0].name} by ${req.user?.uid} (${futureCount} appointments handled)`);
            res.json({
              message: 'Doctor account deleted successfully',
              doctor: doctorCheck.rows[0],
              appointments_handled: {
                future_appointments: futureCount,
                action: transfer_patients_to ? 'transferred' : 'cancelled',
                transfer_to: transfer_patients_to || null
              },
              deletion_reason: reason
            });
          } catch (error) {
            logger.error('Database error:', error.message);
            res.status(500).json({
              message: 'Failed to delete doctor account',
              error: error.message
            });
          }
        }
      ]
    ]
  },
  {
    requireUID: false,
    requirePhone: false
  }
);

export default router;