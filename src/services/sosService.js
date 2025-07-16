// src/services/sosService.js
import db from '../config/database.js';
import { SOS_SEVERITY } from '../config/sosConfig.js';
import logger from '../logging/logger.js';
import * as locationService from './locationService.js';
import * as notificationService from './notification/notificationService.js';

export const createAlert = async (alertData) => {
  const {
    phone, latitude, longitude, severity = SOS_SEVERITY.HIGH,
    message, emergencyType = 'medical', isTestAlert = false,
    ip_address, userAgent, createdBy
  } = alertData;

  // Get user information
  const user = await getUserMedicalInfo(phone);

  // Create SOS alert
  const alert = await insertAlert({
    phone,
    user,
    latitude,
    longitude,
    severity,
    message,
    emergencyType,
    ip_address,
    userAgent,
    isTestAlert,
    createdBy
  });

  // Find nearby services if location provided
  let nearbyServices = {};
  if (latitude && longitude) {
    nearbyServices = await locationService.findNearbyEmergencyServices(latitude, longitude);
  }

  // Handle notifications for non-test alerts
  if (!isTestAlert) {
    await notificationService.notifyEmergencyTeam({
      id: alert.id,
      phone,
      severity,
      message,
      latitude,
      longitude,
      user_name: user.name
    }, nearbyServices.hospitals || []);

    await scheduleEscalation(alert.id, severity);
    await logSecurityEvent(alert, user, ip_address);
  }

  return formatAlertResponse(alert, nearbyServices, severity, isTestAlert);
};

const insertAlert = async (data) => {
  const result = await db.query(`
    INSERT INTO sos_alerts (
      phone, user_uid, latitude, longitude, severity, message,
      emergency_type, contact_preference, ip_address, user_agent,
      medical_conditions, medications, emergency_contact, allergies,
      blood_group, insurance_details, preferred_hospital,
      status, is_test_alert, created_at, created_by
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, NOW(), $20) 
    RETURNING id, created_at
  `, [
    data.phone, data.user.uid, data.latitude, data.longitude, data.severity, data.message,
    data.emergencyType, data.contactPreference || 'hospital', data.ip_address, data.userAgent,
    data.medicalConditions || data.user.medical_conditions,
    data.medications,
    data.emergencyContact || data.user.emergency_contact,
    data.user.allergies,
    data.user.blood_group,
    data.user.insurance_details,
    data.user.preferred_hospital,
    'active',
    data.isTestAlert,
    data.createdBy
  ]);

  return result.rows[0];
};

// Add these new helper functions to the bottom of sosService.js

/**
 * Retrieves essential medical and contact info for a user by their phone number.
 * @param {string} phone - The user's phone number.
 * @returns {Promise<object>} An object with user details.
 */
async function getUserMedicalInfo(phone) {
  const result = await db.query(
    `SELECT uid, name, blood_group, allergies, emergency_contact, insurance_details, preferred_hospital 
     FROM users WHERE phone = $1`,
    [phone]
  );
  if (result.rows.length === 0) {
    // Return a default object if the user is not found to allow guest alerts
    return { name: 'Unknown User', phone };
  }
  return result.rows[0];
}

/**
 * Schedules an escalation task for an SOS alert.
 * (This is a placeholder; a real implementation would use a job queue).
 * @param {number} alertId - The ID of the SOS alert.
 * @param {string} severity - The severity level of the alert.
 */
async function scheduleEscalation(alertId, severity) {
  // In a real app, this would add a job to a queue (e.g., BullMQ)
  // to check if the alert is addressed within a certain time.
  console.log(`Escalation scheduled for alert ${alertId} with severity ${severity}.`);
}

/**
 * Logs a security event related to an SOS alert.
 * @param {object} alert - The created alert object.
 * @param {object} user - The user object associated with the alert.
 * @param {string} ip_address - The IP address of the request.
 */
async function logSecurityEvent(alert, user, ip_address) {
  // This would insert a record into a security_events or audit_logs table.
  console.log(`Security event logged for SOS alert ${alert.id} from user ${user.uid || user.phone} at IP ${ip_address}`);
}

/**
 * Formats the final response object for the created SOS alert.
 * @param {object} alert - The created alert object from the database.
 * @param {object} nearbyServices - The object containing nearby hospitals/services.
 * @param {string} severity - The severity of the alert.
 * @param {boolean} isTestAlert - Flag indicating if it's a test.
 * @returns {object} A structured response object.
 */
function formatAlertResponse(alert, nearbyServices, severity, isTestAlert) {
  return {
    alert_id: alert.id,
    status: 'active',
    severity: severity,
    timestamp: alert.created_at,
    is_test: isTestAlert,
    message: isTestAlert 
      ? "Test alert created successfully. No notifications were sent." 
      : "SOS alert created successfully. Emergency teams have been notified.",
    nearby_hospitals: nearbyServices.hospitals || [],
    nearby_police: nearbyServices.police_stations || []
  };
}