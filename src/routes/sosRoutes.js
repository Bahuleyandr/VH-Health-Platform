// src/routes/sosRoutes.js - Enhanced Emergency SOS System with Full RBAC

import express from 'express';
import db from '../config/database.js';
import logger from '../logging/logger.js';
import { success, error } from '../utils/responseHelper.js';
import { HTTP_STATUS, RESPONSE_MESSAGES } from '../config/responseCodes.js';
import { wrapAutoRBAC, wrapRoutes } from '../config/routeWrapper.js';
import { normalizePhone } from '../utils/phoneUtils.js';
import { sendPushNotification } from '../utils/notifications/sendPushNotification.js';
import { validationResult, body, query, param } from 'express-validator';

const router = express.Router();

// ✅ Emergency contact numbers (configurable via admin)
const EMERGENCY_CONTACTS = {
  ambulance: process.env.AMBULANCE_NUMBER || '108',
  police: process.env.POLICE_NUMBER || '100',
  fire: process.env.FIRE_NUMBER || '101',
  hospital: process.env.HOSPITAL_EMERGENCY || '+91-9876543210',
  mentalHealth: process.env.MENTAL_HEALTH_HELPLINE || '9152987821',
  womenHelpline: process.env.WOMEN_HELPLINE || '1091',
  childHelpline: process.env.CHILD_HELPLINE || '1098'
};

// ✅ SOS Alert Severity Levels
const SOS_SEVERITY = {
  LOW: 'low',           // General health inquiry/non-urgent
  MEDIUM: 'medium',     // Moderate health concern
  HIGH: 'high',         // Urgent medical attention needed
  CRITICAL: 'critical'  // Life-threatening emergency
};

// ✅ Emergency Response Times (in minutes)
const RESPONSE_TIMES = {
  critical: { target: 5, max: 10 },
  high: { target: 15, max: 30 },
  medium: { target: 30, max: 60 },
  low: { target: 60, max: 120 }
};

// ✅ Validation schemas
const sosAlertValidation = [
  body('phone').optional().isMobilePhone('en-IN').withMessage('Valid Indian mobile number required'),
  body('latitude').optional().isFloat({ min: -90, max: 90 }).withMessage('Valid latitude required'),
  body('longitude').optional().isFloat({ min: -180, max: 180 }).withMessage('Valid longitude required'),
  body('severity').optional().isIn(Object.values(SOS_SEVERITY)).withMessage('Valid severity level required'),
  body('emergencyType').optional().isIn(['medical', 'accident', 'violence', 'mental_health', 'fire', 'other']).withMessage('Valid emergency type required'),
  body('message').optional().isLength({ max: 500 }).withMessage('Message too long (max 500 characters)')
];

const emergencyContactValidation = [
  body('emergencyContactName').notEmpty().withMessage('Emergency contact name required'),
  body('emergencyContactPhone').isMobilePhone('en-IN').withMessage('Valid emergency contact phone required'),
  body('relationship').optional().isLength({ max: 50 }).withMessage('Relationship description too long')
];

// ✅ Calculate distance between two coordinates (Haversine formula)
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth's radius in kilometres
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c; // Distance in kilometres
}

// ✅ Create emergency response team notification
async function notifyEmergencyTeam(alertData, nearbyHospitals = []) {
  try {
    const { id: alertId, phone, severity, message, latitude, longitude, user_name } = alertData;
    
    // Get emergency responder device tokens
    const responderTokens = await db.query(`
      SELECT DISTINCT ud.fcm_token 
      FROM user_devices ud
      JOIN users u ON ud.user_uid = u.uid
      WHERE u.role IN ('ADMIN', 'DOCTOR', 'NURSING_STAFF', 'EMERGENCY_RESPONDER')
        AND ud.fcm_token IS NOT NULL
        AND u.notification_preferences->>'emergency_alerts' != 'false'
    `);

    const tokens = responderTokens.rows.map(row => row.fcm_token).filter(Boolean);

    if (tokens.length > 0) {
      const notificationData = {
        tokens,
        title: `🚨 ${severity.toUpperCase()} SOS Alert #${alertId}`,
        body: `Emergency assistance requested by ${user_name || phone}. ${message || 'Location-based emergency.'}`,
        data: {
          type: 'sos_alert',
          alertId: alertId.toString(),
          severity,
          phone,
          latitude: latitude?.toString(),
          longitude: longitude?.toString(),
          nearbyHospitals: JSON.stringify(nearbyHospitals.slice(0, 3)) // Top 3 hospitals
        }
      };

      await sendPushNotification(notificationData);
      
      logger.info(`📱 Emergency team notified: ${tokens.length} devices for SOS #${alertId}`);
    }

    // Create system-wide emergency notification
    await db.query(
      `INSERT INTO notifications (
        recipient_roles, title, body, type, priority, 
        related_id, metadata, created_at, expires_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW() + INTERVAL '24 hours')`,
      [
        JSON.stringify(['ADMIN', 'DOCTOR', 'NURSING_STAFF', 'EMERGENCY_RESPONDER']),
        `🚨 ${severity.toUpperCase()} Emergency Alert #${alertId}`,
        `SOS alert from ${user_name || phone}. Location: ${latitude && longitude ? `${latitude}, ${longitude}` : 'Not provided'}. ${message || 'Immediate assistance required.'}`,
        'sos_alert',
        severity === SOS_SEVERITY.CRITICAL ? 'critical' : 'high',
        alertId,
        JSON.stringify({
          phone,
          severity,
          location: { latitude, longitude },
          nearbyHospitals,
          estimatedResponseTime: RESPONSE_TIMES[severity]
        })
      ]
    );

  } catch (err) {
    logger.error('Emergency Team Notification Error:', err);
  }
}

// ✅ Auto-escalation system for critical alerts
async function scheduleEscalation(alertId, severity) {
  if (severity !== SOS_SEVERITY.CRITICAL) return;
  
  // In production environment, this would use a job queue (Bull, Agenda, etc.)
  setTimeout(async () => {
    try {
      // Check if alert is still active
      const alertCheck = await db.query(
        'SELECT status, escalation_status FROM sos_alerts WHERE id = $1',
        [alertId]
      );
      
      if (alertCheck.rows.length === 0 || alertCheck.rows[0].status !== 'active') {
        return; // Alert resolved or doesn't exist
      }

      // Escalate to external emergency services
      await db.query(
        `UPDATE sos_alerts SET 
          escalation_status = 'escalated_to_emergency_services',
          escalated_at = NOW(),
          escalation_notes = 'Auto-escalated due to no response within 5 minutes'
         WHERE id = $1`,
        [alertId]
      );

      logger.warn(`🚨 CRITICAL SOS Alert ${alertId} auto-escalated to emergency services`);
      
      // In production: Send to emergency services API
      // await callEmergencyServicesAPI(alertId);

    } catch (escalationError) {
      logger.error('SOS Auto-Escalation Error:', escalationError);
    }
  }, 5 * 60 * 1000); // 5 minutes delay for critical escalation
}

// 🚨 ====== PATIENT SOS ROUTES ====== 🚨
wrapAutoRBAC(router, 'sosRoutes', {
  post: [
    // 🚨 Emergency SOS Alert Creation
    [
      '/',
      sosAlertValidation,
      async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
          return res.status(HTTP_STATUS.BAD_REQUEST).json({
            success: false,
            errors: errors.array(),
            message: 'Validation failed'
          });
        }

        const phone = normalizePhone(req.body.phone || req.body.phoneNumber || req.user?.phone);
        const {
          latitude,
          longitude,
          severity = SOS_SEVERITY.HIGH,
          message,
          emergencyType = 'medical',
          contactPreference = 'hospital',
          medicalConditions,
          medications,
          emergencyContact,
          isTestAlert = false
        } = req.body;

        const ip_address = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || null;
        const userAgent = req.headers['user-agent'] || null;

        if (!phone) {
          return res.status(HTTP_STATUS.BAD_REQUEST).json({
            success: false,
            error: 'Phone number is required for emergency contact'
          });
        }

        try {
          // Get user information and medical history
          const userResult = await db.query(`
            SELECT 
              uid, name, age, gender, blood_group, 
              emergency_contact, medical_conditions, allergies,
              insurance_details, preferred_hospital
            FROM users 
            WHERE phone = $1
          `, [phone]);

          const user = userResult.rows[0] || {};

          // Create SOS alert with comprehensive data
          const alertResult = await db.query(`
            INSERT INTO sos_alerts (
              phone, user_uid, latitude, longitude, severity, message,
              emergency_type, contact_preference, ip_address, user_agent,
              medical_conditions, medications, emergency_contact, allergies,
              blood_group, insurance_details, preferred_hospital,
              status, is_test_alert, created_at, created_by
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, NOW(), $20) 
            RETURNING id, created_at
          `, [
            phone, user.uid, latitude, longitude, severity, message,
            emergencyType, contactPreference, ip_address, userAgent,
            medicalConditions || user.medical_conditions,
            medications,
            emergencyContact || user.emergency_contact,
            user.allergies,
            user.blood_group,
            user.insurance_details,
            user.preferred_hospital,
            'active',
            isTestAlert,
            req.user?.uid || 'patient_app'
          ]);

          const alertId = alertResult.rows[0].id;
          const alertTime = alertResult.rows[0].created_at;

          // Find nearby hospitals and emergency services if location provided
          let nearbyHospitals = [];
          let nearbyPharmacies = [];
          
          if (latitude && longitude) {
            try {
              // Find nearby hospitals (within 25km radius)
              const hospitalResult = await db.query(`
                SELECT 
                  id, name, phone as hospital_phone, address, website,
                  latitude as hosp_lat, longitude as hosp_lon,
                  emergency_services, trauma_center, specialties,
                  beds_available, ambulance_available, contact_person,
                  operating_hours, emergency_contact
                FROM hospitals 
                WHERE emergency_services = true
                  AND status = 'active'
                ORDER BY 
                  (6371 * acos(cos(radians($1)) * cos(radians(latitude)) * 
                  cos(radians(longitude) - radians($2)) + sin(radians($1)) * 
                  sin(radians(latitude)))) ASC
                LIMIT 5
              `, [latitude, longitude]);

              nearbyHospitals = hospitalResult.rows.map(hospital => ({
                ...hospital,
                distance_km: parseFloat(calculateDistance(
                  latitude, longitude, 
                  hospital.hosp_lat, hospital.hosp_lon
                ).toFixed(1)),
                estimated_travel_time_minutes: Math.round(calculateDistance(
                  latitude, longitude, 
                  hospital.hosp_lat, hospital.hosp_lon
                ) * 2) // Rough estimate: 2 minutes per km in emergency
              })).filter(h => h.distance_km <= 25);

              // Find nearby 24/7 pharmacies for medication emergencies
              if (emergencyType === 'medical' && (medications || medicalConditions)) {
                const pharmacyResult = await db.query(`
                  SELECT 
                    id, name, phone, address, is_24_7,
                    (6371 * acos(cos(radians($1)) * cos(radians(latitude)) * 
                    cos(radians(longitude) - radians($2)) + sin(radians($1)) * 
                    sin(radians(latitude)))) AS distance_km
                  FROM pharmacies 
                  WHERE status = 'active'
                  HAVING distance_km <= 10
                  ORDER BY 
                    is_24_7 DESC, distance_km ASC
                  LIMIT 3
                `, [latitude, longitude]);

                nearbyPharmacies = pharmacyResult.rows;
              }
            } catch (locationError) {
              logger.warn('Location services error:', locationError);
              // Continue without location data - don't fail the alert
            }
          }

          // Enhanced notification system for non-test alerts
          if (!isTestAlert) {
            await notifyEmergencyTeam({
              id: alertId,
              phone,
              severity,
              message,
              latitude,
              longitude,
              user_name: user.name
            }, nearbyHospitals);

            // Schedule auto-escalation for critical alerts
            await scheduleEscalation(alertId, severity);

            // Log security event for audit
            await db.query(
              `INSERT INTO security_logs (
                event_type, user_uid, phone, ip_address, 
                event_data, severity, created_at
              ) VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
              [
                'SOS_ALERT_CREATED',
                user.uid,
                phone,
                ip_address,
                JSON.stringify({
                  alertId,
                  severity,
                  emergencyType,
                  hasLocation: !!(latitude && longitude),
                  nearbyHospitalsCount: nearbyHospitals.length
                }),
                severity === SOS_SEVERITY.CRITICAL ? 'critical' : 'high'
              ]
            );
          }

          // Calculate response time estimates
          const responseTimeEstimate = RESPONSE_TIMES[severity] || RESPONSE_TIMES.medium;

          logger.info(`🚨 SOS Alert created: ID=${alertId} | Phone=${phone} | Severity=${severity} | Location=${latitude ? `${latitude}, ${longitude}` : 'N/A'} | Test=${isTestAlert}`);

          // Comprehensive response to user
          success(res, {
            alertId,
            alertTime: alertTime.toISOString(),
            severity,
            status: 'active',
            isTestAlert,
            emergencyContacts: EMERGENCY_CONTACTS,
            nearbyHospitals: nearbyHospitals.slice(0, 3), // Top 3 closest
            nearbyPharmacies,
            responseTimeEstimate: {
              target_minutes: responseTimeEstimate.target,
              maximum_minutes: responseTimeEstimate.max,
              description: severity === SOS_SEVERITY.CRITICAL 
                ? 'Emergency response team dispatched immediately'
                : `Medical assistance will contact you within ${responseTimeEstimate.target} minutes`
            },
            immediateInstructions: {
              critical: [
                'Stay calm and keep your phone nearby',
                'Do not hang up if emergency services call',
                'If possible, unlock your front door for responders',
                'Have your medical information ready',
                'Call 108 directly if condition deteriorates'
              ],
              general: [
                'Keep your phone accessible',
                'Stay in a safe location if possible',
                'Prepare any relevant medical information',
                'Emergency team will contact you shortly'
              ]
            }[severity === SOS_SEVERITY.CRITICAL ? 'critical' : 'general'],
            nextSteps: [
              'Your alert is being processed by our emergency team',
              'A medical professional will contact you shortly',
              'If your condition worsens, call emergency services immediately',
              'Keep this app open for real-time updates'
            ],
            userMedicalInfo: {
              bloodGroup: user.blood_group,
              knownAllergies: user.allergies,
              emergencyContact: user.emergency_contact,
              preferredHospital: user.preferred_hospital
            }
          }, isTestAlert ? 'Test SOS alert created successfully' : RESPONSE_MESSAGES.SOS_ALERT_SAVED);

        } catch (err) {
          logger.error('SOS Alert Creation Error:', err.stack || err.toString());
          
          // Even if there's an error, try to log basic emergency info
          try {
            await db.query(
              `INSERT INTO emergency_fallback_logs (
                phone, latitude, longitude, severity, message, 
                error_details, created_at
              ) VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
              [phone, latitude, longitude, severity, message, err.message]
            );
          } catch (fallbackError) {
            logger.error('Emergency fallback logging failed:', fallbackError);
          }

          error(res, 'Failed to process emergency alert. Please call emergency services directly.', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ],

    // 📞 Update Emergency Contact Information
    [
      '/emergency-contact',
      emergencyContactValidation,
      async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
          return res.status(HTTP_STATUS.BAD_REQUEST).json({
            success: false,
            errors: errors.array()
          });
        }

        const phone = normalizePhone(req.body.phone || req.body.phoneNumber || req.user?.phone);
        const { 
          emergencyContactName, 
          emergencyContactPhone, 
          relationship,
          secondaryContactName,
          secondaryContactPhone,
          secondaryRelationship
        } = req.body;

        if (!phone) {
          return error(res, 'Phone number required', HTTP_STATUS.BAD_REQUEST);
        }

        try {
          const emergencyContactData = {
            primary: {
              name: emergencyContactName,
              phone: normalizePhone(emergencyContactPhone),
              relationship: relationship || 'family'
            }
          };

          // Add secondary contact if provided
          if (secondaryContactName && secondaryContactPhone) {
            emergencyContactData.secondary = {
              name: secondaryContactName,
              phone: normalizePhone(secondaryContactPhone),
              relationship: secondaryRelationship || 'friend'
            };
          }

          const result = await db.query(
            `UPDATE users SET 
              emergency_contact = $1,
              updated_at = NOW(),
              updated_by = $3
             WHERE phone = $2
             RETURNING uid, name, emergency_contact`,
            [JSON.stringify(emergencyContactData), phone, req.user?.uid || 'patient_app']
          );

          if (result.rows.length === 0) {
            return error(res, 'User not found', HTTP_STATUS.NOT_FOUND);
          }

          // Log the update for audit
          await db.query(
            `INSERT INTO user_activity_logs (
              user_uid, action, details, ip_address, created_at
            ) VALUES ($1, $2, $3, $4, NOW())`,
            [
              result.rows[0].uid,
              'EMERGENCY_CONTACT_UPDATED',
              JSON.stringify({ primaryContact: emergencyContactData.primary.name }),
              req.headers['x-forwarded-for'] || req.socket?.remoteAddress
            ]
          );

          success(res, emergencyContactData, 'Emergency contact information updated successfully');

        } catch (err) {
          logger.error('Update Emergency Contact Error:', err);
          error(res, 'Failed to update emergency contact information', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ],

    // ❌ Cancel Active SOS Alert
    [
      '/cancel/:alertId',
      [
        param('alertId').isInt({ min: 1 }).withMessage('Valid alert ID required'),
        body('reason').optional().isLength({ max: 200 }).withMessage('Cancellation reason too long'),
        body('resolution').optional().isLength({ max: 500 }).withMessage('Resolution description too long')
      ],
      async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
          return res.status(HTTP_STATUS.BAD_REQUEST).json({
            success: false,
            errors: errors.array()
          });
        }

        const { alertId } = req.params;
        const { reason = 'User cancelled', resolution, falseAlarm = false } = req.body;
        const phone = normalizePhone(req.body.phone || req.user?.phone);

        if (!phone) {
          return error(res, 'Phone number required for security verification', HTTP_STATUS.BAD_REQUEST);
        }

        try {
          const result = await db.query(
            `UPDATE sos_alerts SET 
              status = 'cancelled',
              cancelled_at = NOW(),
              cancelled_by = $1,
              cancellation_reason = $2,
              resolution = $3,
              false_alarm = $4,
              response_time_minutes = EXTRACT(EPOCH FROM (NOW() - created_at))/60
             WHERE id = $5 AND phone = $6 AND status IN ('active', 'responding')
             RETURNING id, severity, created_at, cancelled_at`,
            [req.user?.uid || 'patient_app', reason, resolution, falseAlarm, alertId, phone]
          );

          if (result.rows.length === 0) {
            return error(res, 'Alert not found, already resolved, or unauthorized access', HTTP_STATUS.NOT_FOUND);
          }

          const alert = result.rows[0];

          // Notify emergency responders about cancellation
          await db.query(
            `INSERT INTO notifications (
              recipient_roles, title, body, type, related_id, 
              priority, created_at, expires_at
            ) VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW() + INTERVAL '2 hours')`,
            [
              JSON.stringify(['ADMIN', 'DOCTOR', 'NURSING_STAFF', 'EMERGENCY_RESPONDER']),
              `✅ SOS Alert #${alertId} Cancelled`,
              `Emergency alert has been cancelled by the patient. Reason: ${reason}${falseAlarm ? ' (False Alarm)' : ''}`,
              'sos_cancelled',
              alertId,
              'normal'
            ]
          );

          // Send cancellation notification to emergency team
          const responderTokens = await db.query(`
            SELECT DISTINCT ud.fcm_token 
            FROM user_devices ud
            JOIN users u ON ud.user_uid = u.uid
            WHERE u.role IN ('ADMIN', 'DOCTOR', 'NURSING_STAFF', 'EMERGENCY_RESPONDER')
              AND ud.fcm_token IS NOT NULL
          `);

          if (responderTokens.rows.length > 0) {
            await sendPushNotification({
              tokens: responderTokens.rows.map(row => row.fcm_token),
              title: `✅ SOS Alert #${alertId} Cancelled`,
              body: `Emergency alert cancelled by patient. ${falseAlarm ? 'Marked as false alarm.' : 'Patient is safe.'}`,
              data: {
                type: 'sos_cancelled',
                alertId: alertId.toString(),
                reason
              }
            });
          }

          logger.info(`❌ SOS Alert cancelled: ${alertId} by ${phone} - Reason: ${reason} | False Alarm: ${falseAlarm}`);

          success(res, {
            alertId: parseInt(alertId),
            status: 'cancelled',
            cancelledAt: alert.cancelled_at.toISOString(),
            reason,
            falseAlarm,
            alertDuration: Math.round((alert.cancelled_at - alert.created_at) / 60000) // Duration in minutes
          }, 'SOS alert cancelled successfully');

        } catch (err) {
          logger.error('Cancel SOS Alert Error:', err);
          error(res, 'Failed to cancel emergency alert', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ]
  ],

  get: [
    // 📋 Get My SOS Alert History
    [
      '/my-alerts',
      [
        query('page').optional().isInt({ min: 1 }).withMessage('Valid page number required'),
        query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('Valid limit required (1-100)'),
        query('status').optional().isIn(['active', 'responding', 'resolved', 'cancelled']).withMessage('Valid status required'),
        query('severity').optional().isIn(Object.values(SOS_SEVERITY)).withMessage('Valid severity required')
      ],
      async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
          return res.status(HTTP_STATUS.BAD_REQUEST).json({
            success: false,
            errors: errors.array()
          });
        }

        const phone = normalizePhone(req.user?.phone || req.query.phone);
        const { page = 1, limit = 20, status, severity, startDate, endDate } = req.query;
        const offset = (page - 1) * limit;

        if (!phone) {
          return error(res, 'Phone number required', HTTP_STATUS.BAD_REQUEST);
        }

        try {
          let whereClause = 'WHERE phone = $1 AND is_test_alert = false';
          const params = [phone, parseInt(limit), parseInt(offset)];
          let paramIndex = 4;

          if (status) {
            whereClause += ` AND status = $${paramIndex}`;
            params.push(status);
            paramIndex++;
          }

          if (severity) {
            whereClause += ` AND severity = $${paramIndex}`;
            params.push(severity);
            paramIndex++;
          }

          if (startDate) {
            whereClause += ` AND created_at >= $${paramIndex}`;
            params.push(startDate);
            paramIndex++;
          }

          if (endDate) {
            whereClause += ` AND created_at <= $${paramIndex}`;
            params.push(endDate);
            paramIndex++;
          }

          const alerts = await db.query(`
            SELECT 
              id, severity, message, emergency_type, status,
              created_at, resolved_at, cancelled_at, responded_at,
              latitude, longitude, response_time_minutes,
              resolution, cancellation_reason, false_alarm,
              escalation_status, escalated_at,
              (CASE 
                WHEN status = 'active' THEN EXTRACT(EPOCH FROM (NOW() - created_at))/60
                WHEN cancelled_at IS NOT NULL THEN EXTRACT(EPOCH FROM (cancelled_at - created_at))/60
                WHEN resolved_at IS NOT NULL THEN EXTRACT(EPOCH FROM (resolved_at - created_at))/60
                ELSE NULL
              END) as duration_minutes
            FROM sos_alerts 
            ${whereClause}
            ORDER BY created_at DESC
            LIMIT $2 OFFSET $3
          `, params);

          const total = await db.query(
            `SELECT COUNT(*) FROM sos_alerts ${whereClause}`,
            params.slice(0, paramIndex - 3)
          );

          // Add user-friendly formatting
          const formattedAlerts = alerts.rows.map(alert => ({
            ...alert,
            created_at: alert.created_at.toISOString(),
            resolved_at: alert.resolved_at?.toISOString(),
            cancelled_at: alert.cancelled_at?.toISOString(),
            responded_at: alert.responded_at?.toISOString(),
            escalated_at: alert.escalated_at?.toISOString(),
            duration_minutes: alert.duration_minutes ? Math.round(alert.duration_minutes) : null,
            status_description: {
              active: 'Emergency response in progress',
              responding: 'Help is on the way',
              resolved: 'Emergency resolved successfully',
              cancelled: alert.false_alarm ? 'Cancelled (False Alarm)' : 'Cancelled by user'
            }[alert.status]
          }));

          success(res, {
            alerts: formattedAlerts,
            pagination: {
              page: parseInt(page),
              limit: parseInt(limit),
              total: parseInt(total.rows[0].count),
              totalPages: Math.ceil(total.rows[0].count / limit)
            },
            summary: {
              totalAlerts: parseInt(total.rows[0].count),
              activeAlerts: formattedAlerts.filter(a => a.status === 'active').length,
              resolvedAlerts: formattedAlerts.filter(a => a.status === 'resolved').length,
              averageResponseTime: formattedAlerts
                .filter(a => a.response_time_minutes)
                .reduce((sum, a) => sum + a.response_time_minutes, 0) / 
                formattedAlerts.filter(a => a.response_time_minutes).length || 0
            }
          }, 'SOS alert history retrieved successfully');

        } catch (err) {
          logger.error('Get SOS History Error:', err);
          error(res, 'Failed to fetch SOS alert history', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ],

    // 🏥 Get Nearby Emergency Services
    [
      '/nearby-services',
      [
        query('latitude').isFloat({ min: -90, max: 90 }).withMessage('Valid latitude required'),
        query('longitude').isFloat({ min: -180, max: 180 }).withMessage('Valid longitude required'),
        query('radius').optional().isFloat({ min: 1, max: 50 }).withMessage('Valid radius required (1-50 km)')
      ],
      async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
          return res.status(HTTP_STATUS.BAD_REQUEST).json({
            success: false,
            errors: errors.array()
          });
        }

        const { latitude, longitude, radius = 15, serviceType = 'all' } = req.query;

        try {
          const results = {
            userLocation: { 
              latitude: parseFloat(latitude), 
              longitude: parseFloat(longitude) 
            },
            searchRadius: parseFloat(radius),
            emergencyContacts: EMERGENCY_CONTACTS
          };

          // Find nearby hospitals
          if (serviceType === 'all' || serviceType === 'hospitals') {
            const hospitals = await db.query(`
              SELECT 
                id, name, phone, address, website, emergency_services,
                trauma_center, specialties, beds_available, ambulance_available,
                operating_hours, emergency_contact, contact_person,
                (6371 * acos(cos(radians($1)) * cos(radians(latitude)) * 
                cos(radians(longitude) - radians($2)) + sin(radians($1)) * 
                sin(radians(latitude)))) AS distance_km
              FROM hospitals 
              WHERE emergency_services = true AND status = 'active'
              HAVING distance_km <= $3
              ORDER BY 
                trauma_center DESC,
                distance_km ASC
              LIMIT 10
            `, [latitude, longitude, radius]);

            results.nearbyHospitals = hospitals.rows.map(hospital => ({
              ...hospital,
              distance_km: parseFloat(hospital.distance_km.toFixed(1)),
              estimated_travel_time_minutes: Math.round(hospital.distance_km * 2.5) // Emergency travel estimate
            }));
          }

          // Find nearby pharmacies
          if (serviceType === 'all' || serviceType === 'pharmacies') {
            const pharmacies = await db.query(`
              SELECT 
                id, name, phone, address, is_24_7, services,
                (6371 * acos(cos(radians($1)) * cos(radians(latitude)) * 
                cos(radians(longitude) - radians($2)) + sin(radians($1)) * 
                sin(radians(latitude)))) AS distance_km
              FROM pharmacies 
              WHERE status = 'active'
              HAVING distance_km <= $3
              ORDER BY 
                is_24_7 DESC,
                distance_km ASC
              LIMIT 8
            `, [latitude, longitude, radius]);

            results.nearbyPharmacies = pharmacies.rows.map(pharmacy => ({
              ...pharmacy,
              distance_km: parseFloat(pharmacy.distance_km.toFixed(1))
            }));
          }

          // Find nearby blood banks
          if (serviceType === 'all' || serviceType === 'blood_banks') {
            const bloodBanks = await db.query(`
              SELECT 
                id, name, phone, address, blood_types_available,
                operating_hours, emergency_contact,
                (6371 * acos(cos(radians($1)) * cos(radians(latitude)) * 
                cos(radians(longitude) - radians($2)) + sin(radians($1)) * 
                sin(radians(latitude)))) AS distance_km
              FROM blood_banks 
              WHERE status = 'active'
              HAVING distance_km <= $3
              ORDER BY distance_km ASC
              LIMIT 5
            `, [latitude, longitude, radius]);

            results.nearbyBloodBanks = bloodBanks.rows.map(bank => ({
              ...bank,
              distance_km: parseFloat(bank.distance_km.toFixed(1))
            }));
          }

          // Emergency instructions based on context
          results.emergencyInstructions = {
            immediate: [
              'For life-threatening emergencies, call 108 (Ambulance) immediately',
              'For police emergencies, call 100',
              'For fire emergencies, call 101'
            ],
            medical: [
              'Keep calm and assess the situation',
              'Call emergency services if condition is severe',
              'Visit nearest hospital for urgent medical needs',
              'Use app SOS feature for faster hospital coordination'
            ],
            preparation: [
              'Keep emergency contacts updated in your profile',
              'Know your blood group and allergies',
              'Keep a basic first aid kit accessible',
              'Save important medical documents in the app'
            ]
          };

          success(res, results, 'Nearby emergency services found successfully');

        } catch (err) {
          logger.error('Nearby Services Error:', err);
          error(res, 'Failed to find nearby emergency services', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ],

    // 🩺 Get Emergency Medical Information
    [
      '/medical-info',
      async (req, res) => {
        const phone = normalizePhone(req.user?.phone || req.query.phone);

        if (!phone) {
          return error(res, 'Phone number required', HTTP_STATUS.BAD_REQUEST);
        }

        try {
          const userInfo = await db.query(`
            SELECT 
              name, age, gender, blood_group, allergies,
              medical_conditions, current_medications, 
              emergency_contact, insurance_details,
              preferred_hospital, medical_notes
            FROM users 
            WHERE phone = $1
          `, [phone]);

          if (userInfo.rows.length === 0) {
            return error(res, 'User medical information not found', HTTP_STATUS.NOT_FOUND);
          }

          const medicalInfo = userInfo.rows[0];

          // Get recent medical records if available
          const recentRecords = await db.query(`
            SELECT 
              record_type, record_date, summary, doctor_name,
              hospital_name
            FROM medical_records 
            WHERE phone = $1 
              AND record_date >= NOW() - INTERVAL '6 months'
            ORDER BY record_date DESC
            LIMIT 5
          `, [phone]);

          success(res, {
            personalInfo: {
              name: medicalInfo.name,
              age: medicalInfo.age,
              gender: medicalInfo.gender,
              bloodGroup: medicalInfo.blood_group
            },
            medicalInfo: {
              allergies: medicalInfo.allergies,
              medicalConditions: medicalInfo.medical_conditions,
              currentMedications: medicalInfo.current_medications,
              medicalNotes: medicalInfo.medical_notes
            },
            emergencyContacts: medicalInfo.emergency_contact,
            insuranceDetails: medicalInfo.insurance_details,
            preferredHospital: medicalInfo.preferred_hospital,
            recentMedicalRecords: recentRecords.rows,
            lastUpdated: new Date().toISOString(),
            disclaimer: 'This information is for emergency use only. Always consult healthcare professionals for medical decisions.'
          }, 'Emergency medical information retrieved');

        } catch (err) {
          logger.error('Get Medical Info Error:', err);
          error(res, 'Failed to retrieve medical information', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ]
  ]
});

// 🚑 ====== EMERGENCY RESPONDER ROUTES ====== 🚑
wrapAutoRBAC(router, 'emergencyResponderRoutes', {
  get: [
    // 🚨 Active Emergency Dashboard
    [
      '/responder/dashboard',
      async (req, res) => {
        try {
          // Get active alerts prioritized by severity and time
          const activeAlerts = await db.query(`
            SELECT 
              sa.id, sa.phone, sa.severity, sa.message, sa.emergency_type,
              sa.latitude, sa.longitude, sa.created_at, sa.status,
              sa.medical_conditions, sa.medications, sa.emergency_contact,
              sa.blood_group, sa.allergies, sa.preferred_hospital,
              u.name as user_name, u.age, u.gender,
              EXTRACT(EPOCH FROM (NOW() - sa.created_at))/60 as minutes_elapsed,
              resp.name as responder_name,
              sa.response_message, sa.estimated_arrival
            FROM sos_alerts sa
            LEFT JOIN users u ON sa.phone = u.phone
            LEFT JOIN users resp ON sa.responder_uid = resp.uid
            WHERE sa.status IN ('active', 'responding')
              AND sa.is_test_alert = false
            ORDER BY 
              CASE sa.severity 
                WHEN 'critical' THEN 1
                WHEN 'high' THEN 2  
                WHEN 'medium' THEN 3
                WHEN 'low' THEN 4
              END,
              sa.created_at ASC
          `);

          // Calculate dashboard statistics
          const stats = {
            total: activeAlerts.rows.length,
            critical: activeAlerts.rows.filter(a => a.severity === 'critical').length,
            high: activeAlerts.rows.filter(a => a.severity === 'high').length,
            medium: activeAlerts.rows.filter(a => a.severity === 'medium').length,
            low: activeAlerts.rows.filter(a => a.severity === 'low').length,
            overdue: activeAlerts.rows.filter(a => a.minutes_elapsed > 30).length,
            responding: activeAlerts.rows.filter(a => a.status === 'responding').length
          };

          // Recent activity summary
          const recentActivity = await db.query(`
            SELECT 
              COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '1 hour') as last_hour,
              COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours') as last_24_hours,
              COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days') as last_week
            FROM sos_alerts 
            WHERE is_test_alert = false
          `);

          success(res, {
            activeAlerts: activeAlerts.rows.map(alert => ({
              ...alert,
              created_at: alert.created_at.toISOString(),
              minutes_elapsed: Math.round(alert.minutes_elapsed),
              priority_score: alert.severity === 'critical' ? 100 : 
                            alert.severity === 'high' ? 75 :
                            alert.severity === 'medium' ? 50 : 25,
              has_location: !!(alert.latitude && alert.longitude)
            })),
            statistics: stats,
            recentActivity: recentActivity.rows[0],
            lastUpdated: new Date().toISOString(),
            systemStatus: 'operational'
          }, 'Emergency responder dashboard loaded');

        } catch (err) {
          logger.error('Responder Dashboard Error:', err);
          error(res, 'Failed to load emergency dashboard', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ],

    // 📊 Emergency Analytics for Responders
    [
      '/responder/analytics',
      [
        query('timeframe').optional().isIn(['24h', '7d', '30d', '90d']).withMessage('Valid timeframe required')
      ],
      async (req, res) => {
        try {
          const { timeframe = '7d' } = req.query;
          
          const intervals = {
            '24h': '24 hours',
            '7d': '7 days', 
            '30d': '30 days',
            '90d': '90 days'
          };

          const interval = intervals[timeframe];

          // Overall metrics
          const metrics = await db.query(`
            SELECT 
              COUNT(*) as total_alerts,
              COUNT(*) FILTER (WHERE severity = 'critical') as critical_alerts,
              COUNT(*) FILTER (WHERE severity = 'high') as high_alerts,
              COUNT(*) FILTER (WHERE status = 'resolved') as resolved_alerts,
              COUNT(*) FILTER (WHERE status = 'cancelled') as cancelled_alerts,
              COUNT(*) FILTER (WHERE false_alarm = true) as false_alarms,
              AVG(response_time_minutes) FILTER (WHERE response_time_minutes IS NOT NULL) as avg_response_time,
              COUNT(DISTINCT phone) as unique_users,
              COUNT(*) FILTER (WHERE escalated_at IS NOT NULL) as escalated_alerts
            FROM sos_alerts 
            WHERE created_at > NOW() - INTERVAL '${interval}'
              AND is_test_alert = false
          `);

          // Response time analysis by severity
          const responseAnalysis = await db.query(`
            SELECT 
              severity,
              COUNT(*) as alert_count,
              AVG(response_time_minutes) as avg_response_time,
              MIN(response_time_minutes) as min_response_time,
              MAX(response_time_minutes) as max_response_time,
              COUNT(*) FILTER (WHERE response_time_minutes <= 10) as within_target
            FROM sos_alerts 
            WHERE created_at > NOW() - INTERVAL '${interval}'
              AND response_time_minutes IS NOT NULL
              AND is_test_alert = false
            GROUP BY severity
            ORDER BY 
              CASE severity 
                WHEN 'critical' THEN 1
                WHEN 'high' THEN 2  
                WHEN 'medium' THEN 3
                WHEN 'low' THEN 4
              END
          `);

          // Hourly trends
          const hourlyTrends = await db.query(`
            SELECT 
              EXTRACT(HOUR FROM created_at) as hour,
              COUNT(*) as alert_count
            FROM sos_alerts 
            WHERE created_at > NOW() - INTERVAL '${interval}'
              AND is_test_alert = false
            GROUP BY EXTRACT(HOUR FROM created_at)
            ORDER BY hour
          `);

          // Geographic distribution (if location data available)
          const locationStats = await db.query(`
            SELECT 
              COUNT(*) FILTER (WHERE latitude IS NOT NULL AND longitude IS NOT NULL) as with_location,
              COUNT(*) FILTER (WHERE latitude IS NULL OR longitude IS NULL) as without_location
            FROM sos_alerts 
            WHERE created_at > NOW() - INTERVAL '${interval}'
              AND is_test_alert = false
          `);

          success(res, {
            timeframe,
            overallMetrics: {
              ...metrics.rows[0],
              avg_response_time: metrics.rows[0].avg_response_time ? 
                Math.round(metrics.rows[0].avg_response_time * 10) / 10 : null
            },
            responseTimeAnalysis: responseAnalysis.rows.map(row => ({
              ...row,
              avg_response_time: Math.round(row.avg_response_time * 10) / 10,
              response_rate_percentage: Math.round((row.within_target / row.alert_count) * 100)
            })),
            hourlyTrends: hourlyTrends.rows,
            locationStatistics: locationStats.rows[0],
            performanceTargets: RESPONSE_TIMES,
            generatedAt: new Date().toISOString()
          }, 'Emergency analytics retrieved');

        } catch (err) {
          logger.error('Emergency Analytics Error:', err);
          error(res, 'Failed to generate emergency analytics', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ]
  ],

  post: [
    // ✅ Respond to Emergency Alert
    [
      '/responder/respond/:alertId',
      [
        param('alertId').isInt({ min: 1 }).withMessage('Valid alert ID required'),
        body('responseMessage').optional().isLength({ max: 500 }).withMessage('Response message too long'),
        body('estimatedArrival').optional().isISO8601().withMessage('Valid arrival time required'),
        body('assignedTeam').optional().isLength({ max: 200 }).withMessage('Team assignment too long')
      ],
      async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
          return res.status(HTTP_STATUS.BAD_REQUEST).json({
            success: false,
            errors: errors.array()
          });
        }

        try {
          const { alertId } = req.params;
          const { 
            responseMessage, 
            estimatedArrival, 
            assignedTeam,
            responderLocation 
          } = req.body;
          const responderUid = req.user?.uid;
          const responderName = req.user?.name || 'Emergency Responder';

          const result = await db.query(
            `UPDATE sos_alerts SET 
              status = 'responding',
              responder_uid = $1,
              response_message = $2,
              estimated_arrival = $3,
              assigned_team = $4,
              responder_location = $5,
              responded_at = NOW(),
              response_time_minutes = EXTRACT(EPOCH FROM (NOW() - created_at))/60
             WHERE id = $6 AND status = 'active'
             RETURNING phone, severity, user_uid, created_at, latitude, longitude`,
            [responderUid, responseMessage, estimatedArrival, assignedTeam, 
             responderLocation ? JSON.stringify(responderLocation) : null, alertId]
          );

          if (result.rows.length === 0) {
            return error(res, 'Alert not found or already responded to', HTTP_STATUS.NOT_FOUND);
          }

          const alert = result.rows[0];

          // Notify patient about response
          if (alert.user_uid) {
            await db.query(
              `INSERT INTO notifications (
                user_uid, title, body, type, related_id, 
                priority, created_at, expires_at
              ) VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW() + INTERVAL '4 hours')`,
              [
                alert.user_uid,
                '🚑 Emergency Response Dispatched',
                `Help is on the way! ${responseMessage || `${responderName} is responding to your emergency alert.`}${estimatedArrival ? ` Estimated arrival: ${new Date(estimatedArrival).toLocaleTimeString('en-IN')}` : ''}`,
                'sos_response',
                alertId,
                'high'
              ]
            );

            // Send push notification to patient
            const patientTokens = await db.query(
              'SELECT fcm_token FROM user_devices WHERE user_uid = $1 AND fcm_token IS NOT NULL',
              [alert.user_uid]
            );

            if (patientTokens.rows.length > 0) {
              await sendPushNotification({
                tokens: patientTokens.rows.map(row => row.fcm_token),
                title: '🚑 Help is Coming',
                body: responseMessage || 'Emergency response team is on the way to your location.',
                data: {
                  type: 'sos_response',
                  alertId: alertId.toString(),
                  responder: responderName,
                  estimatedArrival: estimatedArrival || ''
                }
              });
            }
          }

          // Log responder action
          await db.query(
            `INSERT INTO emergency_response_logs (
              alert_id, responder_uid, action, details, created_at
            ) VALUES ($1, $2, $3, $4, NOW())`,
            [
              alertId, 
              responderUid, 
              'RESPONSE_INITIATED', 
              JSON.stringify({
                responseMessage,
                estimatedArrival,
                assignedTeam,
                responseTimeMinutes: Math.round((new Date() - alert.created_at) / 60000)
              })
            ]
          );

          logger.info(`✅ SOS Alert ${alertId} response initiated by ${responderName} (${responderUid})`);

          success(res, {
            alertId: parseInt(alertId),
            status: 'responding',
            responder: {
              uid: responderUid,
              name: responderName
            },
            responseMessage,
            estimatedArrival,
            assignedTeam,
            responseTimeMinutes: Math.round((new Date() - alert.created_at) / 60000)
          }, 'Emergency response recorded successfully');

        } catch (err) {
          logger.error('SOS Response Error:', err);
          error(res, 'Failed to record emergency response', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ],

    // ✅ Resolve Emergency Alert
    [
      '/responder/resolve/:alertId',
      [
        param('alertId').isInt({ min: 1 }).withMessage('Valid alert ID required'),
        body('resolution').notEmpty().withMessage('Resolution description required'),
        body('outcome').optional().isIn(['resolved_successfully', 'patient_safe', 'referred_to_hospital', 'no_emergency_found', 'other']).withMessage('Valid outcome required'),
        body('followUpRequired').optional().isBoolean().withMessage('Follow-up flag must be boolean')
      ],
      async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
          return res.status(HTTP_STATUS.BAD_REQUEST).json({
            success: false,
            errors: errors.array()
          });
        }

        try {
          const { alertId } = req.params;
          const { 
            resolution, 
            outcome = 'resolved_successfully', 
            followUpRequired = false,
            hospitalReferral,
            medicationsPrescribed,
            nextAppointment
          } = req.body;
          const resolverUid = req.user?.uid;
          const resolverName = req.user?.name || 'Emergency Responder';

          const result = await db.query(
            `UPDATE sos_alerts SET 
              status = 'resolved',
              resolved_by = $1,
              resolution = $2,
              outcome = $3,
              follow_up_required = $4,
              hospital_referral = $5,
              medications_prescribed = $6,
              next_appointment = $7,
              resolved_at = NOW(),
              total_response_time_minutes = EXTRACT(EPOCH FROM (NOW() - created_at))/60
             WHERE id = $8 AND status IN ('active', 'responding')
             RETURNING phone, user_uid, severity, created_at, resolved_at`,
            [resolverUid, resolution, outcome, followUpRequired, 
             hospitalReferral, medicationsPrescribed, nextAppointment, alertId]
          );

          if (result.rows.length === 0) {
            return error(res, 'Alert not found or already resolved', HTTP_STATUS.NOT_FOUND);
          }

          const alert = result.rows[0];

          // Create follow-up task if required
          if (followUpRequired) {
            await db.query(
              `INSERT INTO follow_up_tasks (
                alert_id, assigned_to, description, priority, 
                due_date, task_type, created_at, created_by
              ) VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7)`,
              [
                alertId, 
                resolverUid,
                `Follow-up required for emergency alert #${alertId}: ${resolution}`,
                alert.severity === 'critical' ? 'high' : 'medium',
                new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours from now
                'medical_followup',
                resolverUid
              ]
            );
          }

          // Notify patient about resolution
          if (alert.user_uid) {
            const followUpMessage = followUpRequired ? 
              ' A follow-up contact will be scheduled within 24 hours.' : '';
            
            await db.query(
              `INSERT INTO notifications (
                user_uid, title, body, type, related_id, 
                priority, created_at
              ) VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
              [
                alert.user_uid,
                '✅ Emergency Alert Resolved',
                `Your emergency alert has been resolved successfully.${followUpMessage} Thank you for using our emergency services.`,
                'sos_resolved',
                alertId,
                'normal'
              ]
            );

            // Send resolution notification
            const patientTokens = await db.query(
              'SELECT fcm_token FROM user_devices WHERE user_uid = $1 AND fcm_token IS NOT NULL',
              [alert.user_uid]
            );

            if (patientTokens.rows.length > 0) {
              await sendPushNotification({
                tokens: patientTokens.rows.map(row => row.fcm_token),
                title: '✅ Emergency Resolved',
                body: 'Your emergency alert has been resolved. Take care!',
                data: {
                  type: 'sos_resolved',
                  alertId: alertId.toString(),
                  outcome
                }
              });
            }
          }

          // Log resolution
          await db.query(
            `INSERT INTO emergency_response_logs (
              alert_id, responder_uid, action, details, created_at
            ) VALUES ($1, $2, $3, $4, NOW())`,
            [
              alertId, 
              resolverUid, 
              'ALERT_RESOLVED', 
              JSON.stringify({
                resolution,
                outcome,
                followUpRequired,
                totalResponseTimeMinutes: Math.round((alert.resolved_at - alert.created_at) / 60000)
              })
            ]
          );

          logger.info(`✅ SOS Alert ${alertId} resolved by ${resolverName} (${resolverUid}) - Outcome: ${outcome}`);

          success(res, {
            alertId: parseInt(alertId),
            status: 'resolved',
            resolvedBy: {
              uid: resolverUid,
              name: resolverName
            },
            resolution,
            outcome,
            followUpRequired,
            totalResponseTimeMinutes: Math.round((alert.resolved_at - alert.created_at) / 60000),
            resolvedAt: alert.resolved_at.toISOString()
          }, 'Emergency alert resolved successfully');

        } catch (err) {
          logger.error('SOS Resolve Error:', err);
          error(res, 'Failed to resolve emergency alert', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ]
  ]
});

// 🔧 ====== ADMIN SOS MANAGEMENT ROUTES ====== 🔧
wrapAutoRBAC(router, 'adminSosRoutes', {
  get: [
    // 📊 Comprehensive SOS System Analytics
    [
      '/admin/analytics',
      [
        query('startDate').optional().isISO8601().withMessage('Valid start date required'),
        query('endDate').optional().isISO8601().withMessage('Valid end date required'),
        query('reportType').optional().isIn(['summary', 'detailed', 'performance']).withMessage('Valid report type required')
      ],
      async (req, res) => {
        try {
          const { 
            startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
            endDate = new Date().toISOString(),
            reportType = 'summary'
          } = req.query;

          // Overall system performance
          const systemMetrics = await db.query(`
            SELECT 
              COUNT(*) as total_alerts,
              COUNT(*) FILTER (WHERE is_test_alert = false) as real_alerts,
              COUNT(*) FILTER (WHERE is_test_alert = true) as test_alerts,
              COUNT(*) FILTER (WHERE severity = 'critical') as critical_alerts,
              COUNT(*) FILTER (WHERE severity = 'high') as high_alerts,
              COUNT(*) FILTER (WHERE status = 'resolved') as resolved_alerts,
              COUNT(*) FILTER (WHERE status = 'cancelled') as cancelled_alerts,
              COUNT(*) FILTER (WHERE false_alarm = true) as false_alarms,
              AVG(response_time_minutes) FILTER (WHERE response_time_minutes IS NOT NULL) as avg_response_time,
              AVG(total_response_time_minutes) FILTER (WHERE total_response_time_minutes IS NOT NULL) as avg_total_response_time,
              COUNT(DISTINCT phone) as unique_users,
              COUNT(*) FILTER (WHERE escalated_at IS NOT NULL) as escalated_alerts,
              COUNT(*) FILTER (WHERE latitude IS NOT NULL AND longitude IS NOT NULL) as alerts_with_location
            FROM sos_alerts 
            WHERE created_at BETWEEN $1 AND $2
          `, [startDate, endDate]);

          const metrics = systemMetrics.rows[0];

          // Performance by severity level
          const severityPerformance = await db.query(`
            SELECT 
              severity,
              COUNT(*) as alert_count,
              AVG(response_time_minutes) as avg_response_time,
              AVG(total_response_time_minutes) as avg_total_time,
              COUNT(*) FILTER (WHERE response_time_minutes <= 
                CASE severity 
                  WHEN 'critical' THEN 5
                  WHEN 'high' THEN 15
                  WHEN 'medium' THEN 30
                  WHEN 'low' THEN 60
                END
              ) as within_target,
              COUNT(*) FILTER (WHERE status = 'resolved') as resolved_count
            FROM sos_alerts 
            WHERE created_at BETWEEN $1 AND $2
              AND response_time_minutes IS NOT NULL
            GROUP BY severity
            ORDER BY 
              CASE severity 
                WHEN 'critical' THEN 1
                WHEN 'high' THEN 2  
                WHEN 'medium' THEN 3
                WHEN 'low' THEN 4
              END
          `, [startDate, endDate]);

          const result = {
            reportPeriod: { startDate, endDate },
            systemOverview: {
              ...metrics,
              avg_response_time: metrics.avg_response_time ? 
                Math.round(metrics.avg_response_time * 10) / 10 : null,
              avg_total_response_time: metrics.avg_total_response_time ? 
                Math.round(metrics.avg_total_response_time * 10) / 10 : null,
              false_alarm_rate: metrics.total_alerts > 0 ? 
                Math.round((metrics.false_alarms / metrics.total_alerts) * 100) : 0,
              resolution_rate: metrics.total_alerts > 0 ? 
                Math.round((metrics.resolved_alerts / metrics.total_alerts) * 100) : 0,
              location_coverage: metrics.total_alerts > 0 ? 
                Math.round((metrics.alerts_with_location / metrics.total_alerts) * 100) : 0
            },
            performanceByCategory: severityPerformance.rows.map(row => ({
              ...row,
              avg_response_time: Math.round(row.avg_response_time * 10) / 10,
              avg_total_time: Math.round(row.avg_total_time * 10) / 10,
              target_achievement_rate: Math.round((row.within_target / row.alert_count) * 100),
              resolution_rate: Math.round((row.resolved_count / row.alert_count) * 100)
            }))
          };

          // Add detailed analysis for detailed reports
          if (reportType === 'detailed') {
            // Daily trends
            const dailyTrends = await db.query(`
              SELECT 
                DATE(created_at) as alert_date,
                COUNT(*) as total_alerts,
                COUNT(*) FILTER (WHERE severity IN ('critical', 'high')) as urgent_alerts,
                AVG(response_time_minutes) as avg_response_time
              FROM sos_alerts 
              WHERE created_at BETWEEN $1 AND $2
              GROUP BY DATE(created_at)
              ORDER BY alert_date DESC
            `, [startDate, endDate]);

            // Geographic analysis
            const locationAnalysis = await db.query(`
              SELECT 
                CASE 
                  WHEN latitude IS NULL OR longitude IS NULL THEN 'No Location'
                  ELSE 'With Location'
                END as location_status,
                COUNT(*) as alert_count,
                AVG(response_time_minutes) as avg_response_time
              FROM sos_alerts 
              WHERE created_at BETWEEN $1 AND $2
              GROUP BY 
                CASE 
                  WHEN latitude IS NULL OR longitude IS NULL THEN 'No Location'
                  ELSE 'With Location'
                END
            `, [startDate, endDate]);

            // Responder performance
            const responderStats = await db.query(`
              SELECT 
                u.name as responder_name,
                u.role as responder_role,
                COUNT(*) as alerts_handled,
                AVG(sa.response_time_minutes) as avg_response_time,
                COUNT(*) FILTER (WHERE sa.status = 'resolved') as resolved_count
              FROM sos_alerts sa
              JOIN users u ON sa.responder_uid = u.uid
              WHERE sa.created_at BETWEEN $1 AND $2
                AND sa.responder_uid IS NOT NULL
              GROUP BY u.uid, u.name, u.role
              ORDER BY alerts_handled DESC
              LIMIT 10
            `, [startDate, endDate]);

            result.detailedAnalysis = {
              dailyTrends: dailyTrends.rows,
              locationAnalysis: locationAnalysis.rows,
              topResponders: responderStats.rows.map(row => ({
                ...row,
                avg_response_time: Math.round(row.avg_response_time * 10) / 10,
                resolution_rate: Math.round((row.resolved_count / row.alerts_handled) * 100)
              }))
            };
          }

          // Add performance benchmarking
          if (reportType === 'performance') {
            const benchmarks = await db.query(`
              SELECT 
                severity,
                COUNT(*) as total_alerts,
                COUNT(*) FILTER (WHERE response_time_minutes <= 
                  CASE severity 
                    WHEN 'critical' THEN 5
                    WHEN 'high' THEN 15
                    WHEN 'medium' THEN 30
                    WHEN 'low' THEN 60
                  END
                ) as within_target_time,
                COUNT(*) FILTER (WHERE response_time_minutes > 
                  CASE severity 
                    WHEN 'critical' THEN 10
                    WHEN 'high' THEN 30
                    WHEN 'medium' THEN 60
                    WHEN 'low' THEN 120
                  END
                ) as exceeded_max_time,
                MIN(response_time_minutes) as best_response_time,
                MAX(response_time_minutes) as worst_response_time
              FROM sos_alerts 
              WHERE created_at BETWEEN $1 AND $2
                AND response_time_minutes IS NOT NULL
              GROUP BY severity
            `, [startDate, endDate]);

            result.performanceBenchmarks = {
              targets: RESPONSE_TIMES,
              actualPerformance: benchmarks.rows.map(row => ({
                ...row,
                target_achievement_percentage: Math.round((row.within_target_time / row.total_alerts) * 100),
                exceeded_max_percentage: Math.round((row.exceeded_max_time / row.total_alerts) * 100)
              }))
            };
          }

          result.generatedAt = new Date().toISOString();
          result.generatedBy = req.user?.name || 'System Admin';

          success(res, result, 'SOS system analytics generated successfully');

        } catch (err) {
          logger.error('SOS System Analytics Error:', err);
          error(res, 'Failed to generate SOS analytics', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ],

    // 📋 All SOS Alerts Management
    [
      '/admin/alerts',
      [
        query('page').optional().isInt({ min: 1 }).withMessage('Valid page number required'),
        query('limit').optional().isInt({ min: 1, max: 500 }).withMessage('Valid limit required (1-500)'),
        query('status').optional().isIn(['active', 'responding', 'resolved', 'cancelled']).withMessage('Valid status required'),
        query('severity').optional().isIn(Object.values(SOS_SEVERITY)).withMessage('Valid severity required'),
        query('responder').optional().isUUID().withMessage('Valid responder UID required'),
        query('escalated').optional().isBoolean().withMessage('Escalated filter must be boolean')
      ],
      async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
          return res.status(HTTP_STATUS.BAD_REQUEST).json({
            success: false,
            errors: errors.array()
          });
        }

        try {
          const { 
            page = 1, limit = 50, status, severity, emergencyType, 
            startDate, endDate, responder, escalated, includeTestAlerts = false
          } = req.query;
          
          const offset = (page - 1) * limit;
          let whereClause = 'WHERE 1=1';
          const params = [parseInt(limit), parseInt(offset)];
          let paramIndex = 3;

          if (!includeTestAlerts) {
            whereClause += ' AND sa.is_test_alert = false';
          }

          if (status) {
            whereClause += ` AND sa.status = ${paramIndex}`;
            params.push(status);
            paramIndex++;
          }

          if (severity) {
            whereClause += ` AND sa.severity = ${paramIndex}`;
            params.push(severity);
            paramIndex++;
          }

          if (emergencyType) {
            whereClause += ` AND sa.emergency_type = ${paramIndex}`;
            params.push(emergencyType);
            paramIndex++;
          }

          if (responder) {
            whereClause += ` AND sa.responder_uid = ${paramIndex}`;
            params.push(responder);
            paramIndex++;
          }

          if (escalated === 'true') {
            whereClause += ' AND sa.escalated_at IS NOT NULL';
          } else if (escalated === 'false') {
            whereClause += ' AND sa.escalated_at IS NULL';
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

          const alerts = await db.query(`
            SELECT 
              sa.id, sa.phone, sa.severity, sa.message, sa.emergency_type,
              sa.status, sa.created_at, sa.resolved_at, sa.cancelled_at,
              sa.response_time_minutes, sa.total_response_time_minutes,
              sa.resolution, sa.outcome, sa.false_alarm, sa.is_test_alert,
              sa.latitude, sa.longitude, sa.escalated_at, sa.escalation_status,
              u.name as user_name, u.age, u.gender, u.blood_group,
              resp.name as responder_name, resp.role as responder_role,
              resolver.name as resolved_by_name
            FROM sos_alerts sa
            LEFT JOIN users u ON sa.phone = u.phone
            LEFT JOIN users resp ON sa.responder_uid = resp.uid
            LEFT JOIN users resolver ON sa.resolved_by = resolver.uid
            ${whereClause}
            ORDER BY 
              CASE sa.status 
                WHEN 'active' THEN 1
                WHEN 'responding' THEN 2
                ELSE 3
              END,
              CASE sa.severity 
                WHEN 'critical' THEN 1
                WHEN 'high' THEN 2  
                WHEN 'medium' THEN 3
                WHEN 'low' THEN 4
              END,
              sa.created_at DESC
            LIMIT $1 OFFSET $2
          `, params);

          const total = await db.query(
            `SELECT COUNT(*) FROM sos_alerts sa ${whereClause}`,
            params.slice(2)
          );

          // Enhanced alert formatting
          const formattedAlerts = alerts.rows.map(alert => ({
            ...alert,
            created_at: alert.created_at.toISOString(),
            resolved_at: alert.resolved_at?.toISOString(),
            cancelled_at: alert.cancelled_at?.toISOString(),
            escalated_at: alert.escalated_at?.toISOString(),
            response_time_minutes: alert.response_time_minutes ? 
              Math.round(alert.response_time_minutes * 10) / 10 : null,
            total_response_time_minutes: alert.total_response_time_minutes ? 
              Math.round(alert.total_response_time_minutes * 10) / 10 : null,
            has_location: !!(alert.latitude && alert.longitude),
            priority_score: alert.severity === 'critical' ? 100 : 
                          alert.severity === 'high' ? 75 :
                          alert.severity === 'medium' ? 50 : 25,
            is_overdue: alert.status === 'active' && 
              ((new Date() - alert.created_at) / 60000) > RESPONSE_TIMES[alert.severity]?.max
          }));

          success(res, {
            alerts: formattedAlerts,
            pagination: {
              page: parseInt(page),
              limit: parseInt(limit),
              total: parseInt(total.rows[0].count),
              totalPages: Math.ceil(total.rows[0].count / limit)
            },
            filters: { 
              status, severity, emergencyType, startDate, endDate, 
              responder, escalated, includeTestAlerts 
            },
            summary: {
              totalAlerts: parseInt(total.rows[0].count),
              activeAlerts: formattedAlerts.filter(a => a.status === 'active').length,
              overdueAlerts: formattedAlerts.filter(a => a.is_overdue).length,
              testAlerts: formattedAlerts.filter(a => a.is_test_alert).length
            }
          }, 'SOS alerts retrieved successfully');

        } catch (err) {
          logger.error('Admin SOS Alerts Error:', err);
          error(res, 'Failed to fetch SOS alerts', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ],

    // 🏥 Emergency Services Management
    [
      '/admin/emergency-services',
      async (req, res) => {
        try {
          // Get hospitals with emergency services
          const hospitals = await db.query(`
            SELECT 
              id, name, phone, address, emergency_services,
              trauma_center, beds_available, ambulance_available,
              specialties, operating_hours, status, created_at
            FROM hospitals 
            WHERE emergency_services = true
            ORDER BY name ASC
          `);

          // Get blood banks
          const bloodBanks = await db.query(`
            SELECT 
              id, name, phone, address, blood_types_available,
              operating_hours, emergency_contact, status, created_at
            FROM blood_banks 
            WHERE status = 'active'
            ORDER BY name ASC
          `);

          // Get 24/7 pharmacies
          const pharmacies = await db.query(`
            SELECT 
              id, name, phone, address, is_24_7, services,
              status, created_at
            FROM pharmacies 
            WHERE is_24_7 = true AND status = 'active'
            ORDER BY name ASC
          `);

          // System configuration
          const systemConfig = await db.query(`
            SELECT config_value 
            FROM system_config 
            WHERE config_key = 'sos_emergency_config'
          `);

          const config = systemConfig.rows.length > 0 ? 
            JSON.parse(systemConfig.rows[0].config_value) : {
              emergencyContacts: EMERGENCY_CONTACTS,
              autoEscalationTime: 300,
              criticalResponseTime: 600
            };

          success(res, {
            emergencyHospitals: hospitals.rows,
            bloodBanks: bloodBanks.rows,
            emergency24x7Pharmacies: pharmacies.rows,
            systemConfiguration: config,
            emergencyContacts: EMERGENCY_CONTACTS,
            responseTimeTargets: RESPONSE_TIMES,
            lastUpdated: new Date().toISOString()
          }, 'Emergency services information retrieved');

        } catch (err) {
          logger.error('Emergency Services Error:', err);
          error(res, 'Failed to fetch emergency services', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ],

    // 📊 System Performance Report
    [
      '/admin/performance-report',
      [
        query('timeframe').optional().isIn(['daily', 'weekly', 'monthly']).withMessage('Valid timeframe required'),
        query('format').optional().isIn(['summary', 'detailed']).withMessage('Valid format required')
      ],
      async (req, res) => {
        try {
          const { timeframe = 'weekly', format = 'summary' } = req.query;

          const intervals = {
            daily: '24 hours',
            weekly: '7 days',
            monthly: '30 days'
          };

          const interval = intervals[timeframe];

          // Core performance metrics
          const performance = await db.query(`
            SELECT 
              COUNT(*) as total_alerts,
              COUNT(*) FILTER (WHERE is_test_alert = false) as real_alerts,
              AVG(response_time_minutes) FILTER (WHERE response_time_minutes IS NOT NULL) as avg_response_time,
              AVG(total_response_time_minutes) FILTER (WHERE total_response_time_minutes IS NOT NULL) as avg_total_time,
              COUNT(*) FILTER (WHERE response_time_minutes <= 10) as fast_responses,
              COUNT(*) FILTER (WHERE response_time_minutes > 30) as slow_responses,
              COUNT(*) FILTER (WHERE status = 'resolved') as resolution_count,
              COUNT(*) FILTER (WHERE escalated_at IS NOT NULL) as escalation_count,
              COUNT(*) FILTER (WHERE false_alarm = true) as false_alarm_count,
              COUNT(DISTINCT responder_uid) FILTER (WHERE responder_uid IS NOT NULL) as active_responders,
              COUNT(DISTINCT phone) as unique_patients
            FROM sos_alerts 
            WHERE created_at > NOW() - INTERVAL '${interval}'
          `);

          const metrics = performance.rows[0];

          // SLA compliance by severity
          const slaCompliance = await db.query(`
            SELECT 
              severity,
              COUNT(*) as total_alerts,
              COUNT(*) FILTER (WHERE response_time_minutes <= 
                CASE severity 
                  WHEN 'critical' THEN 5
                  WHEN 'high' THEN 15
                  WHEN 'medium' THEN 30
                  WHEN 'low' THEN 60
                END
              ) as sla_compliant,
              AVG(response_time_minutes) as avg_response_time
            FROM sos_alerts 
            WHERE created_at > NOW() - INTERVAL '${interval}'
              AND response_time_minutes IS NOT NULL
            GROUP BY severity
          `);

          const report = {
            reportPeriod: timeframe,
            reportFormat: format,
            generatedAt: new Date().toISOString(),
            generatedBy: req.user?.name || 'System Admin',
            overallPerformance: {
              totalAlerts: parseInt(metrics.total_alerts),
              realAlerts: parseInt(metrics.real_alerts),
              testAlerts: parseInt(metrics.total_alerts) - parseInt(metrics.real_alerts),
              averageResponseTime: metrics.avg_response_time ? 
                Math.round(metrics.avg_response_time * 10) / 10 : 0,
              averageTotalTime: metrics.avg_total_time ? 
                Math.round(metrics.avg_total_time * 10) / 10 : 0,
              fastResponseRate: metrics.total_alerts > 0 ? 
                Math.round((metrics.fast_responses / metrics.total_alerts) * 100) : 0,
              slowResponseRate: metrics.total_alerts > 0 ? 
                Math.round((metrics.slow_responses / metrics.total_alerts) * 100) : 0,
              resolutionRate: metrics.total_alerts > 0 ? 
                Math.round((metrics.resolution_count / metrics.total_alerts) * 100) : 0,
              escalationRate: metrics.total_alerts > 0 ? 
                Math.round((metrics.escalation_count / metrics.total_alerts) * 100) : 0,
              falseAlarmRate: metrics.total_alerts > 0 ? 
                Math.round((metrics.false_alarm_count / metrics.total_alerts) * 100) : 0,
              activeResponders: parseInt(metrics.active_responders),
              uniquePatients: parseInt(metrics.unique_patients)
            },
            slaCompliance: slaCompliance.rows.map(row => ({
              severity: row.severity,
              totalAlerts: parseInt(row.total_alerts),
              slaCompliant: parseInt(row.sla_compliant),
              complianceRate: Math.round((row.sla_compliant / row.total_alerts) * 100),
              averageResponseTime: Math.round(row.avg_response_time * 10) / 10,
              target: RESPONSE_TIMES[row.severity]?.target || 30
            })),
            recommendations: []
          };

          // Generate recommendations based on performance
          if (report.overallPerformance.slowResponseRate > 20) {
            report.recommendations.push({
              type: 'performance',
              priority: 'high',
              issue: 'High slow response rate detected',
              recommendation: 'Consider increasing emergency responder capacity or reviewing dispatch procedures'
            });
          }

          if (report.overallPerformance.escalationRate > 10) {
            report.recommendations.push({
              type: 'escalation',
              priority: 'medium',
              issue: 'High escalation rate observed',
              recommendation: 'Review initial response protocols and responder training'
            });
          }

          if (report.overallPerformance.falseAlarmRate > 15) {
            report.recommendations.push({
              type: 'quality',
              priority: 'medium',
              issue: 'Elevated false alarm rate',
              recommendation: 'Implement user education program about proper SOS usage'
            });
          }

          success(res, report, 'SOS system performance report generated');

        } catch (err) {
          logger.error('SOS Performance Report Error:', err);
          error(res, 'Failed to generate performance report', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ]
  ],

  post: [
    // ⚙️ Update Emergency System Configuration
    [
      '/admin/update-config',
      [
        body('emergencyContacts').optional().isObject().withMessage('Emergency contacts must be an object'),
        body('autoEscalationTime').optional().isInt({ min: 60, max: 1800 }).withMessage('Auto-escalation time must be 60-1800 seconds'),
        body('criticalResponseTime').optional().isInt({ min: 300, max: 3600 }).withMessage('Critical response time must be 300-3600 seconds'),
        body('responseTimeTargets').optional().isObject().withMessage('Response time targets must be an object')
      ],
      async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
          return res.status(HTTP_STATUS.BAD_REQUEST).json({
            success: false,
            errors: errors.array()
          });
        }

        try {
          const { 
            emergencyContacts, 
            autoEscalationTime = 300,
            criticalResponseTime = 600,
            responseTimeTargets,
            enableAutoEscalation = true,
            enableLocationTracking = true,
            requireMedicalInfo = false
          } = req.body;
          
          const adminUid = req.user?.uid;
          const adminName = req.user?.name || 'System Admin';

          const config = {
            emergencyContacts: emergencyContacts || EMERGENCY_CONTACTS,
            autoEscalationTime,
            criticalResponseTime,
            responseTimeTargets: responseTimeTargets || RESPONSE_TIMES,
            features: {
              enableAutoEscalation,
              enableLocationTracking,
              requireMedicalInfo
            },
            lastUpdated: new Date().toISOString(),
            updatedBy: adminUid,
            updatedByName: adminName,
            version: '2.0'
          };

          // Store configuration in database
          await db.query(
            `INSERT INTO system_config (config_key, config_value, updated_by, updated_at)
             VALUES ($1, $2, $3, NOW())
             ON CONFLICT (config_key) 
             DO UPDATE SET 
               config_value = $2, 
               updated_by = $3, 
               updated_at = NOW()`,
            ['sos_emergency_config', JSON.stringify(config), adminUid]
          );

          // Log configuration change
          await db.query(
            `INSERT INTO admin_activity_logs (
              admin_uid, action, description, affected_system, 
              changes_made, ip_address, created_at
            ) VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
            [
              adminUid,
              'SOS_CONFIG_UPDATE',
              'Emergency system configuration updated',
              'SOS_EMERGENCY_SYSTEM',
              JSON.stringify(config),
              req.headers['x-forwarded-for'] || req.socket?.remoteAddress
            ]
          );

          logger.info(`⚙️ SOS Emergency configuration updated by admin ${adminName} (${adminUid})`);

          success(res, {
            configuration: config,
            message: 'Emergency system configuration updated successfully',
            effectiveFrom: new Date().toISOString()
          }, 'Emergency system configuration updated');

        } catch (err) {
          logger.error('Update SOS Config Error:', err);
          error(res, 'Failed to update emergency system configuration', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ],

    // 🚨 Admin Emergency Alert Broadcasting
    [
      '/admin/broadcast-alert',
      [
        body('title').notEmpty().withMessage('Alert title required'),
        body('message').notEmpty().withMessage('Alert message required'),
        body('severity').isIn(['info', 'warning', 'critical']).withMessage('Valid severity required'),
        body('targetRoles').optional().isArray().withMessage('Target roles must be an array'),
        body('expiresIn').optional().isInt({ min: 1, max: 48 }).withMessage('Expiry must be 1-48 hours')
      ],
      async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
          return res.status(HTTP_STATUS.BAD_REQUEST).json({
            success: false,
            errors: errors.array()
          });
        }

        try {
          const {
            title,
            message,
            severity = 'warning',
            targetRoles = ['PATIENT', 'DOCTOR', 'NURSING_STAFF', 'EMERGENCY_RESPONDER'],
            expiresIn = 24,
            requireAcknowledgment = false
          } = req.body;

          const adminUid = req.user?.uid;
          const adminName = req.user?.name || 'System Admin';

          // Create system-wide alert
          const alertResult = await db.query(
            `INSERT INTO system_alerts (
              title, message, severity, target_roles, 
              created_by, expires_at, require_acknowledgment,
              alert_type, created_at
            ) VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '${expiresIn} hours', $6, $7, NOW())
            RETURNING id, created_at`,
            [
              title, message, severity, JSON.stringify(targetRoles),
              adminUid, requireAcknowledgment, 'emergency_broadcast'
            ]
          );

          const alertId = alertResult.rows[0].id;

          // Get target users based on roles
          const targetUsers = await db.query(`
            SELECT DISTINCT ud.fcm_token, u.uid, u.name, u.role
            FROM users u
            LEFT JOIN user_devices ud ON u.uid = ud.user_uid
            WHERE u.role = ANY($1)
              AND u.status = 'active'
              AND (u.notification_preferences->>'emergency_alerts' != 'false' OR u.notification_preferences IS NULL)
          `, [targetRoles]);

          // Send push notifications
          const tokens = targetUsers.rows
            .map(user => user.fcm_token)
            .filter(Boolean);

          if (tokens.length > 0) {
            await sendPushNotification({
              tokens,
              title: `🚨 ${severity.toUpperCase()}: ${title}`,
              body: message,
              data: {
                type: 'emergency_broadcast',
                alertId: alertId.toString(),
                severity,
                requireAcknowledgment: requireAcknowledgment.toString()
              }
            });
          }

          // Create individual notifications for tracking
          const notificationPromises = targetUsers.rows.map(user => 
            db.query(
              `INSERT INTO notifications (
                user_uid, title, body, type, related_id,
                priority, created_at, expires_at, require_acknowledgment
              ) VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW() + INTERVAL '${expiresIn} hours', $7)`,
              [
                user.uid,
                `🚨 ${severity.toUpperCase()}: ${title}`,
                message,
                'emergency_broadcast',
                alertId,
                severity === 'critical' ? 'critical' : 'high',
                requireAcknowledgment
              ]
            )
          );

          await Promise.all(notificationPromises);

          // Log broadcast activity
          await db.query(
            `INSERT INTO admin_activity_logs (
              admin_uid, action, description, affected_users_count,
              details, ip_address, created_at
            ) VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
            [
              adminUid,
              'EMERGENCY_BROADCAST',
              `Emergency alert broadcast: ${title}`,
              targetUsers.rows.length,
              JSON.stringify({
                alertId,
                severity,
                targetRoles,
                expiresIn,
                requireAcknowledgment
              }),
              req.headers['x-forwarded-for'] || req.socket?.remoteAddress
            ]
          );

          logger.info(`📢 Emergency broadcast sent by ${adminName}: "${title}" to ${targetUsers.rows.length} users`);

          success(res, {
            alertId,
            title,
            message,
            severity,
            targetedUsers: targetUsers.rows.length,
            notificationsSent: tokens.length,
            targetRoles,
            expiresAt: new Date(Date.now() + expiresIn * 60 * 60 * 1000).toISOString(),
            broadcastBy: adminName,
            broadcastAt: alertResult.rows[0].created_at.toISOString()
          }, 'Emergency alert broadcast successfully');

        } catch (err) {
          logger.error('Emergency Broadcast Error:', err);
          error(res, 'Failed to send emergency broadcast', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ],

    // 🔄 Manually Escalate SOS Alert
    [
      '/admin/escalate/:alertId',
      [
        param('alertId').isInt({ min: 1 }).withMessage('Valid alert ID required'),
        body('escalationReason').notEmpty().withMessage('Escalation reason required'),
        body('escalationType').isIn(['external_emergency_services', 'senior_medical_staff', 'hospital_transfer']).withMessage('Valid escalation type required'),
        body('notes').optional().isLength({ max: 1000 }).withMessage('Notes too long (max 1000 characters)')
      ],
      async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
          return res.status(HTTP_STATUS.BAD_REQUEST).json({
            success: false,
            errors: errors.array()
          });
        }

        try {
          const { alertId } = req.params;
          const {
            escalationReason,
            escalationType,
            notes,
            priorityLevel = 'high'
          } = req.body;

          const adminUid = req.user?.uid;
          const adminName = req.user?.name || 'System Admin';

          // Verify alert exists and can be escalated
          const alertCheck = await db.query(
            'SELECT id, phone, severity, status, user_uid FROM sos_alerts WHERE id = $1',
            [alertId]
          );

          if (alertCheck.rows.length === 0) {
            return error(res, 'SOS alert not found', HTTP_STATUS.NOT_FOUND);
          }

          const alert = alertCheck.rows[0];

          if (!['active', 'responding'].includes(alert.status)) {
            return error(res, 'Alert cannot be escalated in current status', HTTP_STATUS.BAD_REQUEST);
          }

          // Update alert with escalation
          await db.query(
            `UPDATE sos_alerts SET 
              escalation_status = $1,
              escalated_at = NOW(),
              escalated_by = $2,
              escalation_reason = $3,
              escalation_type = $4,
              escalation_notes = $5,
              escalation_priority = $6
             WHERE id = $7`,
            [
              'manually_escalated',
              adminUid,
              escalationReason,
              escalationType,
              notes,
              priorityLevel,
              alertId
            ]
          );

          // Create escalation notification
          await db.query(
            `INSERT INTO notifications (
              recipient_roles, title, body, type, related_id,
              priority, created_at, expires_at, metadata
            ) VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW() + INTERVAL '4 hours', $7)`,
            [
              JSON.stringify(['ADMIN', 'DOCTOR', 'EMERGENCY_RESPONDER']),
              `⚠️ SOS Alert #${alertId} Escalated`,
              `Emergency alert has been manually escalated by ${adminName}. Type: ${escalationType}. Reason: ${escalationReason}`,
              'sos_escalated',
              alertId,
              'critical',
              JSON.stringify({
                escalationType,
                escalatedBy: adminName,
                originalSeverity: alert.severity
              })
            ]
          );

          // Log escalation
          await db.query(
            `INSERT INTO emergency_response_logs (
              alert_id, responder_uid, action, details, created_at
            ) VALUES ($1, $2, $3, $4, NOW())`,
            [
              alertId,
              adminUid,
              'MANUAL_ESCALATION',
              JSON.stringify({
                escalationReason,
                escalationType,
                notes,
                priorityLevel
              })
            ]
          );

          logger.warn(`⚠️ SOS Alert ${alertId} manually escalated by ${adminName}: ${escalationType} - ${escalationReason}`);

          success(res, {
            alertId: parseInt(alertId),
            escalationType,
            escalationReason,
            escalatedBy: adminName,
            escalatedAt: new Date().toISOString(),
            priorityLevel,
            status: 'escalated'
          }, 'SOS alert escalated successfully');

        } catch (err) {
          logger.error('Manual SOS Escalation Error:', err);
          error(res, 'Failed to escalate SOS alert', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ]
  ]
});

export default router;