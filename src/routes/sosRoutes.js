// src/routes/sosRoutes.js - Enhanced Emergency SOS System

import express from 'express';
import pool from '../db.js';
import logger from '../logging/logger.js';
import { success, error } from '../utils/responseHelper.js';
import { HTTP_STATUS, RESPONSE_MESSAGES } from '../config/responseCodes.js';
import { wrapAutoRBAC, wrapRoutes } from '../config/routeWrapper.js';
import { normalizePhone } from '../utils/phoneUtils.js';
import { sendPushNotification } from '../utils/notifications/sendPushNotification.js';

const router = express.Router();

// ✅ Emergency contact numbers (configurable)
const EMERGENCY_CONTACTS = {
  ambulance: process.env.AMBULANCE_NUMBER || '108',
  police: process.env.POLICE_NUMBER || '100',
  fire: process.env.FIRE_NUMBER || '101',
  hospital: process.env.HOSPITAL_EMERGENCY || '+91-9876543210'
};

// ✅ SOS Alert Severity Levels
const SOS_SEVERITY = {
  LOW: 'low',           // General health inquiry
  MEDIUM: 'medium',     // Non-critical health issue
  HIGH: 'high',         // Urgent medical attention needed
  CRITICAL: 'critical'  // Life-threatening emergency
};

// ✅ Calculate distance between two coordinates
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth's radius in kilometers
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c; // Distance in kilometers
}

// ✅ Patient SOS Routes
wrapAutoRBAC(router, 'sosRoutes', {
  post: [
    // 🚨 Emergency SOS Alert
    [
      '/',
      async (req, res) => {
        const phone = normalizePhone(req.body.phone || req.body.phoneNumber);
        const {
          latitude,
          longitude,
          severity = SOS_SEVERITY.HIGH,
          message,
          emergencyType = 'medical',
          contactPreference = 'ambulance',
          medicalConditions,
          medications,
          emergencyContact
        } = req.body;

        const ip_address = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || null;

        if (!phone) {
          return res.status(HTTP_STATUS.BAD_REQUEST).json({
            error: 'Phone number is required'
          });
        }

        try {
          // Get user information
          const userResult = await pool.query(
            'SELECT uid, name, emergency_contact, medical_conditions FROM users WHERE phone = $1',
            [phone]
          );

          const user = userResult.rows[0] || {};

          // Create SOS alert
          const alertResult = await pool.query(
            `INSERT INTO sos_alerts (
              phone, user_uid, latitude, longitude, severity, message,
              emergency_type, contact_preference, ip_address, 
              medical_conditions, medications, emergency_contact,
              status, created_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW()) 
            RETURNING id, created_at`,
            [
              phone, user.uid, latitude, longitude, severity, message,
              emergencyType, contactPreference, ip_address,
              medicalConditions || user.medical_conditions,
              medications,
              emergencyContact || user.emergency_contact,
              'active'
            ]
          );

          const alertId = alertResult.rows[0].id;
          const alertTime = alertResult.rows[0].created_at;

          // Find nearby hospitals if location provided
          let nearbyHospitals = [];
          if (latitude && longitude) {
            const hospitalResult = await pool.query(`
              SELECT 
                id, name, phone as hospital_phone, address,
                latitude as hosp_lat, longitude as hosp_lon,
                emergency_services, specialties
              FROM hospitals 
              WHERE emergency_services = true
              ORDER BY 
                (6371 * acos(cos(radians($1)) * cos(radians(latitude)) * 
                cos(radians(longitude) - radians($2)) + sin(radians($1)) * 
                sin(radians(latitude)))) ASC
              LIMIT 5
            `, [latitude, longitude]);

            nearbyHospitals = hospitalResult.rows.map(hospital => ({
              ...hospital,
              distance_km: calculateDistance(
                latitude, longitude, 
                hospital.hosp_lat, hospital.hosp_lon
              ).toFixed(1)
            }));
          }

          // Notify emergency responders based on severity
          if (severity === SOS_SEVERITY.CRITICAL || severity === SOS_SEVERITY.HIGH) {
            // Send immediate notifications to admin staff
            const adminTokens = await pool.query(`
              SELECT ud.fcm_token 
              FROM user_devices ud
              JOIN users u ON ud.user_uid = u.uid
              WHERE u.role IN ('ADMIN', 'DOCTOR', 'NURSING_STAFF')
                AND ud.fcm_token IS NOT NULL
            `);

            const tokens = adminTokens.rows.map(row => row.fcm_token).filter(Boolean);

            if (tokens.length > 0) {
              await sendPushNotification({
                tokens,
                title: `🚨 ${severity.toUpperCase()} SOS Alert`,
                body: `Emergency assistance requested by ${user.name || phone}. ${message || ''}`,
                data: {
                  type: 'sos_alert',
                  alertId: alertId.toString(),
                  severity,
                  phone,
                  latitude: latitude?.toString(),
                  longitude: longitude?.toString()
                }
              });
            }

            // Create high-priority notification in system
            await pool.query(
              `INSERT INTO notifications (
                recipient_role, title, body, type, priority, 
                related_id, created_at
              ) VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
              [
                'ADMIN,DOCTOR,NURSING_STAFF',
                `🚨 ${severity.toUpperCase()} Emergency Alert`,
                `SOS alert from ${user.name || phone}. Location: ${latitude ? `${latitude}, ${longitude}` : 'Not provided'}. ${message || ''}`,
                'sos_alert',
                'critical',
                alertId
              ]
            );
          }

          // Auto-escalate critical alerts to external emergency services
          if (severity === SOS_SEVERITY.CRITICAL) {
            setTimeout(async () => {
              try {
                // In production, integrate with emergency services API
                logger.info(`🚨 CRITICAL SOS Alert ${alertId} would be escalated to emergency services`);
                
                await pool.query(
                  'UPDATE sos_alerts SET escalated_at = NOW(), escalation_status = $1 WHERE id = $2',
                  ['escalated_to_emergency_services', alertId]
                );
              } catch (escalationError) {
                logger.error('SOS Escalation Error:', escalationError);
              }
            }, 30000); // 30 seconds delay for critical escalation
          }

          logger.info(`🚨 SOS Alert created: ${phone} | Severity: ${severity} | Location: ${latitude ? `${latitude}, ${longitude}` : 'N/A'}`);

          // Immediate response to user
          success(res, {
            alertId,
            alertTime,
            severity,
            status: 'active',
            emergencyContacts: EMERGENCY_CONTACTS,
            nearbyHospitals,
            estimatedResponseTime: severity === SOS_SEVERITY.CRITICAL ? '5-10 minutes' : '15-30 minutes',
            instructions: severity === SOS_SEVERITY.CRITICAL 
              ? 'Stay calm. Help is on the way. If possible, keep your phone nearby and stay in a safe location.'
              : 'Your alert has been received. Medical assistance will contact you shortly.',
            nextSteps: [
              'Keep your phone accessible',
              'Stay in a safe location if possible',
              'Have your medical information ready',
              'Contact emergency services directly if condition worsens'
            ]
          }, RESPONSE_MESSAGES.SOS_ALERT_SAVED);

        } catch (err) {
          logger.error('SOS Alert Error:', err.stack || err.toString());
          error(res, 'Failed to process emergency alert', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ],

    // 📞 Update Emergency Contact
    [
      '/emergency-contact',
      async (req, res) => {
        const phone = normalizePhone(req.body.phone || req.body.phoneNumber);
        const { emergencyContactName, emergencyContactPhone, relationship } = req.body;

        if (!phone || !emergencyContactPhone) {
          return error(res, 'Phone and emergency contact phone are required', HTTP_STATUS.BAD_REQUEST);
        }

        try {
          const emergencyContactData = {
            name: emergencyContactName,
            phone: normalizePhone(emergencyContactPhone),
            relationship
          };

          await pool.query(
            'UPDATE users SET emergency_contact = $1 WHERE phone = $2',
            [JSON.stringify(emergencyContactData), phone]
          );

          success(res, emergencyContactData, 'Emergency contact updated successfully');

        } catch (err) {
          logger.error('Update Emergency Contact Error:', err);
          error(res, 'Failed to update emergency contact', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ],

    // ❌ Cancel SOS Alert
    [
      '/cancel/:alertId',
      async (req, res) => {
        const { alertId } = req.params;
        const { reason = 'User cancelled', resolution } = req.body;
        const phone = normalizePhone(req.body.phone || req.user?.phone);

        if (!phone) {
          return error(res, 'Phone number required', HTTP_STATUS.BAD_REQUEST);
        }

        try {
          const result = await pool.query(
            `UPDATE sos_alerts SET 
              status = 'cancelled',
              cancelled_at = NOW(),
              cancellation_reason = $1,
              resolution = $2
             WHERE id = $3 AND phone = $4 AND status = 'active'
             RETURNING *`,
            [reason, resolution, alertId, phone]
          );

          if (result.rows.length === 0) {
            return error(res, 'Alert not found or already resolved', HTTP_STATUS.NOT_FOUND);
          }

          // Notify responders about cancellation
          await pool.query(
            `INSERT INTO notifications (
              recipient_role, title, body, type, related_id, created_at
            ) VALUES ($1, $2, $3, $4, $5, NOW())`,
            [
              'ADMIN,DOCTOR,NURSING_STAFF',
              'SOS Alert Cancelled',
              `SOS alert #${alertId} has been cancelled by the user. Reason: ${reason}`,
              'sos_cancelled',
              alertId
            ]
          );

          logger.info(`❌ SOS Alert cancelled: ${alertId} by ${phone} - Reason: ${reason}`);

          success(res, {
            alertId,
            status: 'cancelled',
            cancelledAt: result.rows[0].cancelled_at,
            reason
          }, 'SOS alert cancelled successfully');

        } catch (err) {
          logger.error('Cancel SOS Alert Error:', err);
          error(res, 'Failed to cancel alert', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ]
  ],

  get: [
    // 📋 Get My SOS History
    [
      '/my-alerts',
      async (req, res) => {
        const phone = normalizePhone(req.user?.phone || req.query.phone);
        const { page = 1, limit = 20, status } = req.query;
        const offset = (page - 1) * limit;

        if (!phone) {
          return error(res, 'Phone number required', HTTP_STATUS.BAD_REQUEST);
        }

        try {
          let whereClause = 'WHERE phone = $1';
          const params = [phone, limit, offset];
          let paramIndex = 4;

          if (status) {
            whereClause += ` AND status = ${paramIndex}`;
            params.push(status);
            paramIndex++;
          }

          const alerts = await pool.query(`
            SELECT 
              id, severity, message, emergency_type, status,
              created_at, resolved_at, cancelled_at,
              latitude, longitude, response_time_minutes,
              resolution, cancellation_reason
            FROM sos_alerts 
            ${whereClause}
            ORDER BY created_at DESC
            LIMIT $2 OFFSET $3
          `, params);

          const total = await pool.query(
            `SELECT COUNT(*) FROM sos_alerts ${whereClause}`,
            params.slice(0, -2)
          );

          success(res, {
            alerts: alerts.rows,
            pagination: {
              page: parseInt(page),
              limit: parseInt(limit),
              total: parseInt(total.rows[0].count),
              totalPages: Math.ceil(total.rows[0].count / limit)
            }
          }, 'SOS alert history retrieved');

        } catch (err) {
          logger.error('Get SOS History Error:', err);
          error(res, 'Failed to fetch SOS history', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ],

    // 🏥 Get Nearby Emergency Services
    [
      '/nearby-services',
      async (req, res) => {
        const { latitude, longitude, radius = 10 } = req.query;

        if (!latitude || !longitude) {
          return error(res, 'Latitude and longitude are required', HTTP_STATUS.BAD_REQUEST);
        }

        try {
          // Find nearby hospitals
          const hospitals = await pool.query(`
            SELECT 
              id, name, phone, address, emergency_services,
              specialties, operating_hours,
              (6371 * acos(cos(radians($1)) * cos(radians(latitude)) * 
              cos(radians(longitude) - radians($2)) + sin(radians($1)) * 
              sin(radians(latitude)))) AS distance_km
            FROM hospitals 
            WHERE emergency_services = true
            HAVING distance_km <= $3
            ORDER BY distance_km ASC
            LIMIT 10
          `, [latitude, longitude, radius]);

          // Find nearby pharmacies
          const pharmacies = await pool.query(`
            SELECT 
              id, name, phone, address, is_24_7,
              (6371 * acos(cos(radians($1)) * cos(radians(latitude)) * 
              cos(radians(longitude) - radians($2)) + sin(radians($1)) * 
              sin(radians(latitude)))) AS distance_km
            FROM pharmacies 
            HAVING distance_km <= $3
            ORDER BY distance_km ASC
            LIMIT 5
          `, [latitude, longitude, radius]);

          success(res, {
            userLocation: { latitude, longitude },
            searchRadius: radius,
            emergencyContacts: EMERGENCY_CONTACTS,
            nearbyHospitals: hospitals.rows,
            nearbyPharmacies: pharmacies.rows,
            instructions: {
              critical: 'For life-threatening emergencies, call ambulance immediately',
              urgent: 'For urgent medical needs, visit the nearest hospital',
              general: 'For general health concerns, book an appointment through the app'
            }
          }, 'Nearby emergency services found');

        } catch (err) {
          logger.error('Nearby Services Error:', err);
          error(res, 'Failed to find nearby services', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ]
  ]
});

// ✅ Staff Routes for SOS Management
wrapRoutes(
  router,
  ['ADMIN', 'DOCTOR', 'NURSING_STAFF'], // Emergency responders
  {
    get: [
      // 🚨 Active SOS Alerts Dashboard
      [
        '/staff/active',
        async (req, res) => {
          try {
            const activeAlerts = await pool.query(`
              SELECT 
                sa.id, sa.phone, sa.severity, sa.message, sa.emergency_type,
                sa.latitude, sa.longitude, sa.created_at, sa.status,
                sa.medical_conditions, sa.medications, sa.emergency_contact,
                u.name as user_name, u.age, u.gender,
                EXTRACT(EPOCH FROM (NOW() - sa.created_at))/60 as minutes_elapsed
              FROM sos_alerts sa
              LEFT JOIN users u ON sa.phone = u.phone
              WHERE sa.status = 'active'
              ORDER BY 
                CASE sa.severity 
                  WHEN 'critical' THEN 1
                  WHEN 'high' THEN 2  
                  WHEN 'medium' THEN 3
                  WHEN 'low' THEN 4
                END,
                sa.created_at ASC
            `);

            // Calculate statistics
            const stats = {
              total: activeAlerts.rows.length,
              critical: activeAlerts.rows.filter(a => a.severity === 'critical').length,
              high: activeAlerts.rows.filter(a => a.severity === 'high').length,
              overdue: activeAlerts.rows.filter(a => a.minutes_elapsed > 30).length
            };

            success(res, {
              activeAlerts: activeAlerts.rows,
              statistics: stats,
              lastUpdated: new Date().toISOString()
            }, 'Active SOS alerts retrieved');

          } catch (err) {
            logger.error('Active SOS Alerts Error:', err);
            error(res, 'Failed to fetch active alerts', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ],

      // 📊 SOS Analytics Dashboard
      [
        '/staff/analytics',
        async (req, res) => {
          try {
            const { timeframe = '30d' } = req.query;
            
            let interval;
            switch (timeframe) {
              case '7d': interval = '7 days'; break;
              case '30d': interval = '30 days'; break;
              case '90d': interval = '90 days'; break;
              default: interval = '30 days';
            }

            // Overall statistics
            const overallStats = await pool.query(`
              SELECT 
                COUNT(*) as total_alerts,
                COUNT(*) FILTER (WHERE severity = 'critical') as critical_alerts,
                COUNT(*) FILTER (WHERE severity = 'high') as high_alerts,
                COUNT(*) FILTER (WHERE status = 'resolved') as resolved_alerts,
                COUNT(*) FILTER (WHERE status = 'cancelled') as cancelled_alerts,
                AVG(response_time_minutes) FILTER (WHERE response_time_minutes IS NOT NULL) as avg_response_time,
                COUNT(DISTINCT phone) as unique_users
              FROM sos_alerts 
              WHERE created_at > NOW() - INTERVAL '${interval}'
            `);

            // Daily trends
            const dailyTrends = await pool.query(`
              SELECT 
                DATE(created_at) as alert_date,
                COUNT(*) as total_alerts,
                COUNT(*) FILTER (WHERE severity IN ('critical', 'high')) as urgent_alerts,
                AVG(response_time_minutes) FILTER (WHERE response_time_minutes IS NOT NULL) as avg_response_time
              FROM sos_alerts 
              WHERE created_at > NOW() - INTERVAL '${interval}'
              GROUP BY DATE(created_at)
              ORDER BY alert_date DESC
            `);

            // Response time analysis
            const responseTimeStats = await pool.query(`
              SELECT 
                severity,
                COUNT(*) as alert_count,
                AVG(response_time_minutes) as avg_response_time,
                MIN(response_time_minutes) as min_response_time,
                MAX(response_time_minutes) as max_response_time
              FROM sos_alerts 
              WHERE created_at > NOW() - INTERVAL '${interval}'
                AND response_time_minutes IS NOT NULL
              GROUP BY severity
              ORDER BY 
                CASE severity 
                  WHEN 'critical' THEN 1
                  WHEN 'high' THEN 2  
                  WHEN 'medium' THEN 3
                  WHEN 'low' THEN 4
                END
            `);

            success(res, {
              timeframe,
              overallStatistics: overallStats.rows[0],
              dailyTrends: dailyTrends.rows,
              responseTimeAnalysis: responseTimeStats.rows,
              generatedAt: new Date().toISOString()
            }, 'SOS analytics retrieved');

          } catch (err) {
            logger.error('SOS Analytics Error:', err);
            error(res, 'Failed to fetch SOS analytics', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ],

      // 📋 SOS Alert History with Advanced Filtering
      [
        '/staff/history',
        async (req, res) => {
          try {
            const { 
              page = 1, limit = 50, severity, status, 
              emergencyType, startDate, endDate 
            } = req.query;
            
            const offset = (page - 1) * limit;
            let whereClause = 'WHERE 1=1';
            const params = [limit, offset];
            let paramIndex = 3;

            if (severity) {
              whereClause += ` AND sa.severity = ${paramIndex}`;
              params.push(severity);
              paramIndex++;
            }

            if (status) {
              whereClause += ` AND sa.status = ${paramIndex}`;
              params.push(status);
              paramIndex++;
            }

            if (emergencyType) {
              whereClause += ` AND sa.emergency_type = ${paramIndex}`;
              params.push(emergencyType);
              paramIndex++;
            }

            if (startDate) {
              whereClause += ` AND sa.created_at >= ${paramIndex}`;
              params.push(startDate);
              paramIndex++;
            }

            if (endDate) {
              whereClause += ` AND sa.created_at <= ${paramIndex}`;
              params.push(endDate);
              paramIndex++;
            }

            const alerts = await pool.query(`
              SELECT 
                sa.id, sa.phone, sa.severity, sa.message, sa.emergency_type,
                sa.status, sa.created_at, sa.resolved_at, sa.cancelled_at,
                sa.response_time_minutes, sa.resolution,
                u.name as user_name, u.age, u.gender,
                r.name as resolved_by_name
              FROM sos_alerts sa
              LEFT JOIN users u ON sa.phone = u.phone
              LEFT JOIN users r ON sa.resolved_by = r.uid
              ${whereClause}
              ORDER BY sa.created_at DESC
              LIMIT $1 OFFSET $2
            `, params);

            const total = await pool.query(
              `SELECT COUNT(*) FROM sos_alerts sa ${whereClause}`,
              params.slice(2)
            );

            success(res, {
              alerts: alerts.rows,
              pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total: parseInt(total.rows[0].count),
                totalPages: Math.ceil(total.rows[0].count / limit)
              },
              filters: { severity, status, emergencyType, startDate, endDate }
            }, 'SOS alert history retrieved');

          } catch (err) {
            logger.error('SOS History Error:', err);
            error(res, 'Failed to fetch SOS history', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ]
    ],

    post: [
      // ✅ Respond to SOS Alert
      [
        '/staff/respond/:alertId',
        async (req, res) => {
          try {
            const { alertId } = req.params;
            const { responseMessage, estimatedArrival, assignedTeam } = req.body;
            const responderUid = req.user?.uid;

            const result = await pool.query(
              `UPDATE sos_alerts SET 
                status = 'responding',
                responder_uid = $1,
                response_message = $2,
                estimated_arrival = $3,
                assigned_team = $4,
                responded_at = NOW(),
                response_time_minutes = EXTRACT(EPOCH FROM (NOW() - created_at))/60
               WHERE id = $5 AND status = 'active'
               RETURNING phone, severity, user_uid`,
              [responderUid, responseMessage, estimatedArrival, assignedTeam, alertId]
            );

            if (result.rows.length === 0) {
              return error(res, 'Alert not found or already responded to', HTTP_STATUS.NOT_FOUND);
            }

            const alert = result.rows[0];

            // Notify user about response
            if (alert.user_uid) {
              await pool.query(
                `INSERT INTO notifications (
                  user_uid, title, body, type, related_id, created_at
                ) VALUES ($1, $2, $3, $4, $5, NOW())`,
                [
                  alert.user_uid,
                  'Emergency Response Dispatched',
                  `Help is on the way! ${responseMessage || 'Medical assistance has been dispatched to your location.'}`,
                  'sos_response',
                  alertId
                ]
              );

              // Send push notification
              const deviceTokens = await pool.query(
                'SELECT fcm_token FROM user_devices WHERE user_uid = $1 AND fcm_token IS NOT NULL',
                [alert.user_uid]
              );

              if (deviceTokens.rows.length > 0) {
                await sendPushNotification({
                  tokens: deviceTokens.rows.map(row => row.fcm_token),
                  title: '🚑 Help is Coming',
                  body: responseMessage || 'Emergency response team is on the way to your location.',
                  data: {
                    type: 'sos_response',
                    alertId: alertId.toString()
                  }
                });
              }
            }

            logger.info(`✅ SOS Alert ${alertId} response by ${responderUid}`);

            success(res, {
              alertId,
              status: 'responding',
              responder: responderUid,
              responseMessage,
              estimatedArrival
            }, 'Response recorded successfully');

          } catch (err) {
            logger.error('SOS Response Error:', err);
            error(res, 'Failed to record response', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ],

      // ✅ Resolve SOS Alert
      [
        '/staff/resolve/:alertId',
        async (req, res) => {
          try {
            const { alertId } = req.params;
            const { resolution, outcome, followUpRequired = false } = req.body;
            const resolverUid = req.user?.uid;

            if (!resolution) {
              return error(res, 'Resolution description is required', HTTP_STATUS.BAD_REQUEST);
            }

            const result = await pool.query(
              `UPDATE sos_alerts SET 
                status = 'resolved',
                resolved_by = $1,
                resolution = $2,
                outcome = $3,
                follow_up_required = $4,
                resolved_at = NOW()
               WHERE id = $5 AND status IN ('active', 'responding')
               RETURNING phone, user_uid`,
              [resolverUid, resolution, outcome, followUpRequired, alertId]
            );

            if (result.rows.length === 0) {
              return error(res, 'Alert not found or already resolved', HTTP_STATUS.NOT_FOUND);
            }

            const alert = result.rows[0];

            // Create follow-up task if required
            if (followUpRequired) {
              await pool.query(
                `INSERT INTO follow_up_tasks (
                  related_type, related_id, assigned_to, description, 
                  priority, due_date, created_at
                ) VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
                [
                  'sos_alert', alertId, resolverUid,
                  `Follow-up required for SOS alert #${alertId}: ${resolution}`,
                  'medium',
                  new Date(Date.now() + 24 * 60 * 60 * 1000) // 24 hours from now
                ]
              );
            }

            // Notify user about resolution
            if (alert.user_uid) {
              await pool.query(
                `INSERT INTO notifications (
                  user_uid, title, body, type, related_id, created_at
                ) VALUES ($1, $2, $3, $4, $5, NOW())`,
                [
                  alert.user_uid,
                  'Emergency Alert Resolved',
                  `Your emergency alert has been resolved. ${followUpRequired ? 'A follow-up contact will be scheduled.' : 'Take care!'}`,
                  'sos_resolved',
                  alertId
                ]
              );
            }

            logger.info(`✅ SOS Alert ${alertId} resolved by ${resolverUid}`);

            success(res, {
              alertId,
              status: 'resolved',
              resolvedBy: resolverUid,
              resolution,
              outcome,
              followUpRequired
            }, 'SOS alert resolved successfully');

          } catch (err) {
            logger.error('SOS Resolve Error:', err);
            error(res, 'Failed to resolve alert', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ]
    ]
  },
  {
    requireUID: true,
    requirePhone: false
  }
);

// ✅ Admin Routes for SOS System Management
wrapRoutes(
  router,
  ['ADMIN'], // Admin only
  {
    get: [
      // 📊 System Performance Report
      [
        '/admin/performance-report',
        async (req, res) => {
          try {
            const { startDate, endDate } = req.query;

            let dateFilter = '';
            const params = [];

            if (startDate && endDate) {
              dateFilter = 'WHERE created_at BETWEEN $1 AND $2';
              params.push(startDate, endDate);
            }

            const report = await pool.query(`
              SELECT 
                COUNT(*) as total_alerts,
                AVG(response_time_minutes) as avg_response_time,
                COUNT(*) FILTER (WHERE response_time_minutes <= 10) as responses_under_10min,
                COUNT(*) FILTER (WHERE response_time_minutes > 30) as responses_over_30min,
                COUNT(*) FILTER (WHERE status = 'resolved') as resolution_rate,
                COUNT(*) FILTER (WHERE escalated_at IS NOT NULL) as escalated_count
              FROM sos_alerts 
              ${dateFilter}
            `, params);

            success(res, {
              reportPeriod: { startDate, endDate },
              performanceMetrics: report.rows[0],
              generatedAt: new Date().toISOString()
            }, 'SOS performance report generated');

          } catch (err) {
            logger.error('SOS Performance Report Error:', err);
            error(res, 'Failed to generate performance report', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ]
    ],

    post: [
      // ⚙️ Update Emergency Configuration
      [
        '/admin/update-config',
        async (req, res) => {
          try {
            const { 
              emergencyContacts, 
              autoEscalationTime = 300, // 5 minutes
              criticalResponseTime = 600 // 10 minutes
            } = req.body;
            
            const adminUid = req.user?.uid;

            // Update configuration (in production, store in database)
            const config = {
              emergencyContacts: emergencyContacts || EMERGENCY_CONTACTS,
              autoEscalationTime,
              criticalResponseTime,
              updatedBy: adminUid,
              updatedAt: new Date().toISOString()
            };

            // Store in database
            await pool.query(
              `INSERT INTO system_config (config_key, config_value, updated_by, updated_at)
               VALUES ($1, $2, $3, NOW())
               ON CONFLICT (config_key) 
               DO UPDATE SET config_value = $2, updated_by = $3, updated_at = NOW()`,
              ['sos_emergency_config', JSON.stringify(config), adminUid]
            );

            logger.info(`⚙️ SOS configuration updated by admin ${adminUid}`);

            success(res, config, 'Emergency configuration updated successfully');

          } catch (err) {
            logger.error('Update SOS Config Error:', err);
            error(res, 'Failed to update configuration', HTTP_STATUS.INTERNAL_SERVER_ERROR);
          }
        }
      ]
    ]
  },
  {
    requireUID: true,
    requirePhone: false
  }
);

export default router;