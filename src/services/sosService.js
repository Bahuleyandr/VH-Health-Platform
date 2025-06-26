// src/services/sosService.js
import db from '../config/database.js';
import logger from '../logging/logger.js';
import * as notificationService from './notificationService.js';
import * as locationService from './locationService.js';
import { SOS_SEVERITY, RESPONSE_TIMES } from '../config/sosConfig.js';

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

// ... other service methods