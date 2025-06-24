// src/routes/healthRoutes.js - COMPLETE PRODUCTION VERSION WITH RBAC
import express from 'express';
import db from '../config/database.js';
import { wrapAutoRBAC, wrapRoutes } from '../config/routeWrapper.js';
import { success, error } from '../utils/responseHelper.js';
import logger from '../logging/logger.js';
import { HTTP_STATUS } from '../config/responseCodes.js';

const router = express.Router();
console.log('✅ healthRoutes loaded with RBAC protection');

/**
 * ✅ Public System Health Routes (No RBAC needed)
 * Legacy system health check endpoints from deprecated version
 */
wrapRoutes(
  router,
  [], // No roles required - public health checks
  {
    get: [
      // 🏥 Basic service status (from deprecated)
      [
        '/',
        (req, res) => {
          success(res, { message: 'VH Health API is running.' }, 'Service reachable');
        }
      ],

      // 🔍 Comprehensive health check (enhanced from deprecated)
      [
        '/health-check',
        async (req, res) => {
          try {
            let dbStatus = 'disconnected';
            let retries = 3;
            
            // Database connectivity test with retries
            while (retries) {
              try {
                await db.query('SELECT 1');
                dbStatus = 'connected';
                break;
              } catch (err) {
                retries -= 1;
                if (!retries) {
                  logger.error('Database health check failed after retries:', err.message);
                  throw new Error('Database unreachable after retries');
                }
                await new Promise(resolve => setTimeout(resolve, 1000));
              }
            }

            // Environment variables check
            const requiredEnv = ['API_KEY', 'DATABASE_URL', 'ALLOWED_ORIGINS'];
            const missingEnv = requiredEnv.filter(key => !process.env[key]);
            const envStatus = missingEnv.length === 0 ? 'all variables present' : `missing: ${missingEnv.join(', ')}`;

            if (missingEnv.length > 0) {
              return error(res, `Missing environment variables: ${missingEnv.join(', ')}`, HTTP_STATUS.INTERNAL_SERVER_ERROR);
            }

            success(res, {
              status: 'ok',
              timestamp: new Date().toISOString(),
              checks: {
                database: dbStatus,
                environment: envStatus
              }
            }, 'Detailed health check passed');
          } catch (err) {
            logger.error('Health check error:', err.stack || err.toString());
            error(res, 'Health check failed - Database unreachable', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ],

      // 📱 App version info (from deprecated)
      [
        '/app-version',
        (req, res) => {
          success(res, {
            version: '2.0.0',
            updated_at: '2025-06-24',
            message: 'VH Health API Version 2.0.0 - Enhanced Release with RBAC',
            features: ['RBAC Protection', 'Health Records', 'System Monitoring']
          }, 'App version fetched successfully');
        }
      ],

      // 🖥️ System status monitoring (enhanced from new version)
      [
        '/system/status',
        (req, res) => {
          try {
            const uptime = process.uptime();
            const memoryUsage = process.memoryUsage();
            
            success(res, {
              status: 'healthy',
              uptime_seconds: Math.floor(uptime),
              uptime_formatted: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m ${Math.floor(uptime % 60)}s`,
              memory: {
                used_mb: Math.round(memoryUsage.heapUsed / 1024 / 1024),
                total_mb: Math.round(memoryUsage.heapTotal / 1024 / 1024),
                external_mb: Math.round(memoryUsage.external / 1024 / 1024),
                usage_percent: Math.round((memoryUsage.heapUsed / memoryUsage.heapTotal) * 100)
              },
              timestamp: new Date().toISOString(),
              node_version: process.version,
              environment: process.env.NODE_ENV || 'development'
            }, 'System health check successful');
          } catch (err) {
            logger.error('System status error:', err);
            res.status(500).json({
              success: false,
              message: 'System health check failed',
              status: 'unhealthy',
              error: err.message,
              timestamp: new Date().toISOString()
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

/**
 * ✅ Patient Health Records Routes with RBAC protection
 * Medical data management with role-based access control
 */
wrapAutoRBAC(
  router,
  'healthRecordsRoutes',
  {
    get: [
      // Test route
      [
        '/test',
        (req, res) => {
          success(res, { 
            message: 'Health records routes working!',
            timestamp: new Date().toISOString(),
            version: '2.0.0',
            user: req.user?.name || 'Unknown'
          }, 'Health records routes operational');
        }
      ],

      // 📋 Get all health records with filtering and pagination
      [
        '/records',
        async (req, res) => {
          try {
            // Role-based access control
            if (!['ADMIN', 'DOCTOR', 'NURSE'].includes(req.user?.role)) {
              return error(res, 'Medical staff access required for health records', HTTP_STATUS.FORBIDDEN);
            }

            const page = parseInt(req.query.page) || 1;
            const limit = parseInt(req.query.limit) || 20;
            const offset = (page - 1) * limit;
            const patient_id = req.query.patient_id;
            const type = req.query.type; // VITALS, MEDICATION, ALLERGY, CONDITION
            const date_from = req.query.date_from;
            const date_to = req.query.date_to;
            
            let query = `
              SELECT h.id, h.patient_id, h.record_type, h.recorded_date, h.recorded_by,
                     h.vital_signs, h.measurements, h.symptoms, h.notes,
                     p.name as patient_name, p.phone as patient_phone,
                     r.name as recorded_by_name
              FROM health_records h
              LEFT JOIN users p ON h.patient_id = p.id
              LEFT JOIN users r ON h.recorded_by = r.id
              WHERE 1=1
            `;
            let params = [];
            
            // Doctors can only see records for their patients
            if (req.user?.role === 'DOCTOR') {
              query += ' AND (h.recorded_by = $' + (params.length + 1) + ' OR EXISTS (SELECT 1 FROM appointments WHERE doctor_id = $' + (params.length + 1) + ' AND patient_id = h.patient_id))';
              params.push(req.user.id);
            }
            
            if (patient_id) {
              query += ' AND h.patient_id = $' + (params.length + 1);
              params.push(patient_id);
            }
            
            if (type) {
              query += ' AND h.record_type = $' + (params.length + 1);
              params.push(type.toUpperCase());
            }
            
            if (date_from) {
              query += ' AND DATE(h.recorded_date) >= $' + (params.length + 1);
              params.push(date_from);
            }
            
            if (date_to) {
              query += ' AND DATE(h.recorded_date) <= $' + (params.length + 1);
              params.push(date_to);
            }
            
            query += ' ORDER BY h.recorded_date DESC LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2);
            params.push(limit, offset);
            
            const result = await db.query(query, params);
            
            // Get total count with same filters
            let countQuery = 'SELECT COUNT(*) FROM health_records h WHERE 1=1';
            let countParams = [];
            
            if (req.user?.role === 'DOCTOR') {
              countQuery += ' AND (h.recorded_by = $' + (countParams.length + 1) + ' OR EXISTS (SELECT 1 FROM appointments WHERE doctor_id = $' + (countParams.length + 1) + ' AND patient_id = h.patient_id))';
              countParams.push(req.user.id);
            }
            if (patient_id) {
              countQuery += ' AND h.patient_id = $' + (countParams.length + 1);
              countParams.push(patient_id);
            }
            if (type) {
              countQuery += ' AND h.record_type = $' + (countParams.length + 1);
              countParams.push(type.toUpperCase());
            }
            if (date_from) {
              countQuery += ' AND DATE(h.recorded_date) >= $' + (countParams.length + 1);
              countParams.push(date_from);
            }
            if (date_to) {
              countQuery += ' AND DATE(h.recorded_date) <= $' + (countParams.length + 1);
              countParams.push(date_to);
            }
            
            const countResult = await db.query(countQuery, countParams);
            const totalRecords = parseInt(countResult.rows[0].count);
            
            success(res, {
              health_records: result.rows,
              pagination: {
                page,
                limit,
                total: totalRecords,
                totalPages: Math.ceil(totalRecords / limit),
                hasNext: page * limit < totalRecords,
                hasPrev: page > 1
              },
              filters: {
                patient_id: patient_id || null,
                type: type || null,
                date_from: date_from || null,
                date_to: date_to || null
              },
              requestedBy: req.user?.name
            }, 'Health records retrieved successfully');
          } catch (err) {
            logger.error('Database error for health records:', err);
            
            // Fallback response
            success(res, {
              health_records: [],
              pagination: {
                page: parseInt(req.query.page) || 1,
                limit: parseInt(req.query.limit) || 20,
                total: 0,
                totalPages: 0,
                hasNext: false,
                hasPrev: false
              },
              note: 'Could not retrieve health records - health_records table may not exist',
              requestedBy: req.user?.name
            }, 'Health records retrieved (empty - table may not exist)');
          }
        }
      ],

      // 📄 Get health record by ID
      [
        '/records/:id',
        async (req, res) => {
          try {
            const { id } = req.params;
            
            let query = `
              SELECT h.*, 
                     p.name as patient_name, p.phone as patient_phone, p.email as patient_email,
                     p.birthday, p.gender,
                     r.name as recorded_by_name, r.role as recorded_by_role
              FROM health_records h
              LEFT JOIN users p ON h.patient_id = p.id
              LEFT JOIN users r ON h.recorded_by = r.id
              WHERE h.id = $1
            `;
            let params = [id];
            
            // Role-based access control
            if (req.user?.role === 'DOCTOR') {
              query += ' AND (h.recorded_by = $2 OR EXISTS (SELECT 1 FROM appointments WHERE doctor_id = $2 AND patient_id = h.patient_id))';
              params.push(req.user.id);
            }
            
            const result = await db.query(query, params);
            
            if (result.rows.length === 0) {
              return error(res, 'Health record not found or access denied', HTTP_STATUS.NOT_FOUND);
            }
            
            success(res, {
              health_record: result.rows[0],
              accessedBy: req.user?.name
            }, 'Health record retrieved successfully');
          } catch (err) {
            logger.error('Database error:', err);
            error(res, 'Failed to retrieve health record', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ],

      // 📊 Get patient health summary
      [
        '/patient/:patient_id/summary',
        async (req, res) => {
          try {
            const { patient_id } = req.params;
            const days = parseInt(req.query.days) || 30;
            
            // Role-based access control
            if (req.user?.role === 'DOCTOR') {
              // Check if doctor has treated this patient
              const accessCheck = await db.query(
                'SELECT 1 FROM appointments WHERE doctor_id = $1 AND patient_id = $2 LIMIT 1',
                [req.user.id, patient_id]
              );
              if (accessCheck.rows.length === 0) {
                return error(res, 'Access denied - you have not treated this patient', HTTP_STATUS.FORBIDDEN);
              }
            }
            
            // Get patient basic info
            const patientInfo = await db.query(
              'SELECT name, phone, email, birthday, gender FROM users WHERE id = $1',
              [patient_id]
            );
            
            if (patientInfo.rows.length === 0) {
              return error(res, 'Patient not found', HTTP_STATUS.NOT_FOUND);
            }
            
            // Get comprehensive health data
            const [latestVitals, vitalTrends, activeConditions, medications] = await Promise.all([
              // Latest vitals
              db.query(`
                SELECT vital_signs, measurements, recorded_date, r.name as recorded_by_name
                FROM health_records h
                LEFT JOIN users r ON h.recorded_by = r.id
                WHERE h.patient_id = $1 AND h.record_type = 'VITALS'
                ORDER BY h.recorded_date DESC
                LIMIT 1
              `, [patient_id]),
              
              // Vital trends
              db.query(`
                SELECT DATE(recorded_date) as date, vital_signs, measurements
                FROM health_records 
                WHERE patient_id = $1 AND record_type = 'VITALS'
                  AND recorded_date >= CURRENT_DATE - INTERVAL '${days} days'
                ORDER BY recorded_date DESC
              `, [patient_id]),
              
              // Active conditions
              db.query(`
                SELECT id, symptoms, notes, recorded_date
                FROM health_records 
                WHERE patient_id = $1 AND record_type = 'CONDITION'
                ORDER BY recorded_date DESC
                LIMIT 10
              `, [patient_id]),
              
              // Medications
              db.query(`
                SELECT id, notes as medication_details, recorded_date
                FROM health_records 
                WHERE patient_id = $1 AND record_type = 'MEDICATION'
                ORDER BY recorded_date DESC
                LIMIT 10
              `, [patient_id])
            ]);
            
            success(res, {
              patient: patientInfo.rows[0],
              latest_vitals: latestVitals.rows[0] || null,
              vital_trends: vitalTrends.rows,
              active_conditions: activeConditions.rows,
              recent_medications: medications.rows,
              summary_period_days: days,
              accessedBy: req.user?.name
            }, 'Patient health summary retrieved successfully');
          } catch (err) {
            logger.error('Database error:', err);
            error(res, 'Failed to retrieve patient health summary', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ],

      // 📈 Get patient vital trends
      [
        '/patient/:patient_id/trends',
        async (req, res) => {
          try {
            const { patient_id } = req.params;
            const days = parseInt(req.query.days) || 30;
            const vital_type = req.query.vital_type;
            
            // Role-based access control (same as summary)
            if (req.user?.role === 'DOCTOR') {
              const accessCheck = await db.query(
                'SELECT 1 FROM appointments WHERE doctor_id = $1 AND patient_id = $2 LIMIT 1',
                [req.user.id, patient_id]
              );
              if (accessCheck.rows.length === 0) {
                return error(res, 'Access denied - you have not treated this patient', HTTP_STATUS.FORBIDDEN);
              }
            }
            
            const result = await db.query(`
              SELECT DATE(recorded_date) as date, vital_signs, measurements, recorded_date
              FROM health_records 
              WHERE patient_id = $1 AND record_type = 'VITALS'
                AND recorded_date >= CURRENT_DATE - INTERVAL '${days} days'
              ORDER BY recorded_date ASC
            `, [patient_id]);
            
            // Process data to extract specific vital trends
            const trends = result.rows.map(record => {
              let vitalSigns = {};
              let measurements = {};
              
              try {
                vitalSigns = typeof record.vital_signs === 'string' 
                  ? JSON.parse(record.vital_signs) 
                  : record.vital_signs || {};
                measurements = typeof record.measurements === 'string'
                  ? JSON.parse(record.measurements)
                  : record.measurements || {};
              } catch (e) {
                logger.warn('Failed to parse vital signs data:', e.message);
              }
              
              return {
                date: record.date,
                recorded_date: record.recorded_date,
                vital_signs: vitalSigns,
                measurements: measurements
              };
            });
            
            // Filter by specific vital type if requested
            let filteredData = trends;
            if (vital_type && trends.length > 0) {
              filteredData = trends.map(trend => ({
                date: trend.date,
                recorded_date: trend.recorded_date,
                value: trend.vital_signs[vital_type] || trend.measurements[vital_type] || null
              })).filter(item => item.value !== null);
            }
            
            success(res, {
              trends: filteredData,
              count: filteredData.length,
              patient_id,
              period_days: days,
              vital_type: vital_type || 'all',
              accessedBy: req.user?.name
            }, 'Patient vital trends retrieved successfully');
          } catch (err) {
            logger.error('Database error:', err);
            error(res, 'Failed to retrieve vital trends', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ],

      // 🚨 Get patient allergies
      [
        '/patient/:patient_id/allergies',
        async (req, res) => {
          try {
            const { patient_id } = req.params;
            
            // Role-based access control
            if (req.user?.role === 'DOCTOR') {
              const accessCheck = await db.query(
                'SELECT 1 FROM appointments WHERE doctor_id = $1 AND patient_id = $2 LIMIT 1',
                [req.user.id, patient_id]
              );
              if (accessCheck.rows.length === 0) {
                return error(res, 'Access denied - you have not treated this patient', HTTP_STATUS.FORBIDDEN);
              }
            }
            
            const [allergies, patientInfo] = await Promise.all([
              db.query(`
                SELECT h.id, h.symptoms, h.notes, h.recorded_date,
                       r.name as recorded_by_name
                FROM health_records h
                LEFT JOIN users r ON h.recorded_by = r.id
                WHERE h.patient_id = $1 AND h.record_type = 'ALLERGY'
                ORDER BY h.recorded_date DESC
              `, [patient_id]),
              
              db.query('SELECT name, phone FROM users WHERE id = $1', [patient_id])
            ]);
            
            success(res, {
              allergies: allergies.rows,
              count: allergies.rows.length,
              patient: patientInfo.rows[0] || null,
              accessedBy: req.user?.name
            }, 'Patient allergies retrieved successfully');
          } catch (err) {
            logger.error('Database error:', err);
            error(res, 'Failed to retrieve patient allergies', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ],

      // 🏥 Get patient conditions
      [
        '/patient/:patient_id/conditions',
        async (req, res) => {
          try {
            const { patient_id } = req.params;
            const active_only = req.query.active_only === 'true';
            
            // Role-based access control
            if (req.user?.role === 'DOCTOR') {
              const accessCheck = await db.query(
                'SELECT 1 FROM appointments WHERE doctor_id = $1 AND patient_id = $2 LIMIT 1',
                [req.user.id, patient_id]
              );
              if (accessCheck.rows.length === 0) {
                return error(res, 'Access denied - you have not treated this patient', HTTP_STATUS.FORBIDDEN);
              }
            }
            
            let query = `
              SELECT h.id, h.symptoms, h.notes, h.recorded_date,
                     r.name as recorded_by_name, r.role as recorded_by_role
              FROM health_records h
              LEFT JOIN users r ON h.recorded_by = r.id
              WHERE h.patient_id = $1 AND h.record_type = 'CONDITION'
            `;
            let params = [patient_id];
            
            if (active_only) {
              query += ' AND h.recorded_date >= CURRENT_DATE - INTERVAL \'180 days\'';
            }
            
            query += ' ORDER BY h.recorded_date DESC';
            
            const result = await db.query(query, params);
            
            success(res, {
              conditions: result.rows,
              count: result.rows.length,
              patient_id,
              active_only,
              accessedBy: req.user?.name
            }, 'Patient conditions retrieved successfully');
          } catch (err) {
            logger.error('Database error:', err);
            error(res, 'Failed to retrieve patient conditions', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ],

      // 📊 Health statistics overview
      [
        '/stats/overview',
        async (req, res) => {
          try {
            // Role-based access control
            if (!['ADMIN', 'DOCTOR', 'NURSE'].includes(req.user?.role)) {
              return error(res, 'Medical staff access required for health statistics', HTTP_STATUS.FORBIDDEN);
            }

            const days = parseInt(req.query.days) || 7;
            
            const [recordStats, typeStats, dailyActivity] = await Promise.all([
              // Total health record statistics
              db.query(`
                SELECT 
                  COUNT(*) as total_records,
                  COUNT(DISTINCT patient_id) as unique_patients,
                  COUNT(CASE WHEN recorded_date >= CURRENT_DATE - INTERVAL '${days} days' THEN 1 END) as recent_records
                FROM health_records
              `),
              
              // Record type breakdown
              db.query(`
                SELECT record_type, COUNT(*) as count
                FROM health_records 
                WHERE recorded_date >= CURRENT_DATE - INTERVAL '${days} days'
                GROUP BY record_type
                ORDER BY count DESC
              `),
              
              // Daily activity
              db.query(`
                SELECT DATE(recorded_date) as date, COUNT(*) as records_count
                FROM health_records 
                WHERE recorded_date >= CURRENT_DATE - INTERVAL '${days} days'
                GROUP BY DATE(recorded_date)
                ORDER BY date DESC
              `)
            ]);
            
            success(res, {
              statistics: {
                totals: recordStats.rows[0],
                by_type: typeStats.rows,
                daily_activity: dailyActivity.rows
              },
              period_days: days,
              requestedBy: req.user?.name,
              timestamp: new Date().toISOString()
            }, 'Health statistics retrieved successfully');
          } catch (err) {
            logger.error('Database error:', err);
            
            // Fallback with mock data
            success(res, {
              statistics: {
                totals: {
                  total_records: 0,
                  unique_patients: 0,
                  recent_records: 0
                },
                by_type: [],
                daily_activity: []
              },
              period_days: parseInt(req.query.days) || 7,
              note: 'Statistics unavailable - health_records table may not exist',
              requestedBy: req.user?.name,
              timestamp: new Date().toISOString()
            }, 'Health statistics retrieved (empty - table may not exist)');
          }
        }
      ]
    ],

    post: [
      // 📝 Record new health data
      [
        '/records',
        async (req, res) => {
          try {
            // Role-based access control
            if (!['ADMIN', 'DOCTOR', 'NURSE'].includes(req.user?.role)) {
              return error(res, 'Medical staff access required to record health data', HTTP_STATUS.FORBIDDEN);
            }

            const { 
              patient_id, record_type = 'VITALS', recorded_by,
              vital_signs = {}, measurements = {}, symptoms, notes 
            } = req.body;
            
            if (!patient_id) {
              return error(res, 'patient_id is required', HTTP_STATUS.BAD_REQUEST);
            }
            
            const validTypes = ['VITALS', 'MEDICATION', 'ALLERGY', 'CONDITION', 'SYMPTOM'];
            if (!validTypes.includes(record_type.toUpperCase())) {
              return error(res, `Invalid record type. Valid options: ${validTypes.join(', ')}`, HTTP_STATUS.BAD_REQUEST);
            }
            
            // Use current user as recorder if not specified
            const recorderId = recorded_by || req.user.id;
            
            // Verify patient and recorder exist
            const [patientCheck, recorderCheck] = await Promise.all([
              db.query('SELECT id, name FROM users WHERE id = $1', [patient_id]),
              db.query('SELECT id, name FROM users WHERE id = $1', [recorderId])
            ]);
            
            if (patientCheck.rows.length === 0) {
              return error(res, 'Patient not found', HTTP_STATUS.NOT_FOUND);
            }
            if (recorderCheck.rows.length === 0) {
              return error(res, 'Recorder user not found', HTTP_STATUS.NOT_FOUND);
            }
            
            const result = await db.query(`
              INSERT INTO health_records (
                patient_id, record_type, recorded_by, vital_signs, 
                measurements, symptoms, notes, recorded_date, created_at
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
              RETURNING *
            `, [patient_id, record_type.toUpperCase(), recorderId,
                JSON.stringify(vital_signs), JSON.stringify(measurements), symptoms, notes]);
            
            logger.info(`Health record created by ${req.user?.name} for patient ${patientCheck.rows[0].name}`);
            
            success(res, {
              health_record: result.rows[0],
              patient_name: patientCheck.rows[0].name,
              recorded_by_name: recorderCheck.rows[0].name,
              createdBy: req.user?.name
            }, 'Health record created successfully', HTTP_STATUS.CREATED);
          } catch (err) {
            logger.error('Database error:', err);
            error(res, 'Failed to create health record', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ]
    ],

    put: [
      // ✏️ Update health record
      [
        '/records/:id',
        async (req, res) => {
          try {
            // Role-based access control
            if (!['ADMIN', 'DOCTOR', 'NURSE'].includes(req.user?.role)) {
              return error(res, 'Medical staff access required to update health records', HTTP_STATUS.FORBIDDEN);
            }

            const { id } = req.params;
            const { vital_signs, measurements, symptoms, notes } = req.body;
            
            // Check if record exists and user has permission to modify
            const recordCheck = await db.query('SELECT recorded_by FROM health_records WHERE id = $1', [id]);
            if (recordCheck.rows.length === 0) {
              return error(res, 'Health record not found', HTTP_STATUS.NOT_FOUND);
            }
            
            // Only the original recorder or admin can modify
            if (req.user?.role !== 'ADMIN' && recordCheck.rows[0].recorded_by !== req.user.id) {
              return error(res, 'Can only update records you created', HTTP_STATUS.FORBIDDEN);
            }
            
            const result = await db.query(`
              UPDATE health_records SET 
                vital_signs = COALESCE($1, vital_signs),
                measurements = COALESCE($2, measurements),
                symptoms = COALESCE($3, symptoms),
                notes = COALESCE($4, notes),
                updated_at = NOW()
              WHERE id = $5
              RETURNING *
            `, [
              vital_signs ? JSON.stringify(vital_signs) : null,
              measurements ? JSON.stringify(measurements) : null,
              symptoms, notes, id
            ]);
            
            logger.info(`Health record ${id} updated by ${req.user?.name}`);
            
            success(res, {
              health_record: result.rows[0],
              updatedBy: req.user?.name
            }, 'Health record updated successfully');
          } catch (err) {
            logger.error('Database error:', err);
            error(res, 'Failed to update health record', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ]
    ]
  },
  {
    requireUID: true,        // Require user authentication for health records
    requirePhone: false,     // Phone not required for medical operations
    auditLog: true,         // Enable audit logging
    rateLimiting: true,     // Enable rate limiting
    roles: ['ADMIN', 'DOCTOR', 'NURSE'] // Medical staff only
  }
);

export default router;