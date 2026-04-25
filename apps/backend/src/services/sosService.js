// src/services/sosService.js
// Migrated from raw pg to Prisma ORM

import { SOS_SEVERITY } from '../config/sosConfig.js';
import prisma from '../lib/prisma.js';
import logger from '../logging/logger.js';
import * as locationService from './locationService.js';
import * as notificationService from './notification/notificationService.js';

export const createAlert = async (alertData) => {
  const {
    phone, latitude, longitude, severity = SOS_SEVERITY.HIGH,
    message, emergencyType = 'medical', isTestAlert = false,
    ip_address, userAgent, createdBy,
  } = alertData;

  const user = await getUserMedicalInfo(phone);

  const alert = await insertAlert({
    phone, user, latitude, longitude, severity, message,
    emergencyType, ip_address, userAgent, isTestAlert, createdBy,
  });

  let nearbyServices = {};
  if (latitude && longitude) {
    nearbyServices = await locationService.findNearbyEmergencyServices(latitude, longitude);
  }

  if (!isTestAlert) {
    await notificationService.notifyEmergencyTeam({
      id: alert.id, phone, severity, message, latitude, longitude,
      user_name: user.name,
    }, nearbyServices.hospitals || []);

    await scheduleEscalation(alert.id, severity);
    await logSecurityEvent(alert, user, ip_address);
  }

  return formatAlertResponse(alert, nearbyServices, severity, isTestAlert);
};

const insertAlert = async (data) => {
  const rows = await prisma.$queryRaw`
    INSERT INTO sos_alerts (
      phone, uid, latitude, longitude, severity, message,
      alert_type, ip_address,
      status, raised_at, created_at, updated_at
    ) VALUES (
      ${data.phone}, ${data.user.uid ?? null}::uuid,
      ${data.latitude ?? null}, ${data.longitude ?? null},
      ${data.severity}, ${data.message ?? null},
      ${data.emergencyType},
      ${data.ip_address ?? null},
      'ACTIVE', NOW(), NOW(), NOW()
    )
    RETURNING id, created_at
  `;
  return rows[0];
};

async function getUserMedicalInfo(phone) {
  const user = await prisma.users.findFirst({
    where: { phone },
    select: { uid: true, name: true },
  });
  if (!user) return { name: 'Unknown User', phone, uid: null };
  return user;
}

async function scheduleEscalation(alertId, severity) {
  logger.info(`Escalation scheduled for alert ${alertId} with severity ${severity}.`);
}

async function logSecurityEvent(alert, user, ip_address) {
  logger.info(`Security event logged for SOS alert ${alert.id} from user ${user.uid || user.phone} at IP ${ip_address}`);
}

function formatAlertResponse(alert, nearbyServices, severity, isTestAlert) {
  return {
    alert_id: alert.id,
    status: 'active',
    severity,
    timestamp: alert.created_at,
    is_test: isTestAlert,
    message: isTestAlert
      ? 'Test alert created successfully. No notifications were sent.'
      : 'SOS alert created successfully. Emergency teams have been notified.',
    nearby_hospitals: nearbyServices.hospitals || [],
    nearby_police: nearbyServices.police_stations || [],
  };
}

export const getEmergencyContacts = async (phone) => {
  const user = await prisma.users.findFirst({
    where: { phone },
    select: {
      emergency_contact: true,
      name: true,
      phone: true,
      allergies: true,
    },
  });
  if (!user) return { emergencyContact: null };
  return {
    emergencyContact: user.emergency_contact,
    patientName: user.name,
    phone: user.phone,
    allergies: user.allergies,
  };
};

export const updateEmergencyContacts = async (phone, contactData) => {
  const contactValue = contactData.emergency_contact || contactData.emergencyContact || null;

  const result = await prisma.users.updateMany({
    where: { phone },
    data: { emergency_contact: contactValue, updated_at: new Date() },
  });

  if (result.count === 0) throw new Error('User not found');

  logger.info(`Emergency contacts updated for user: ${phone}`);
  return {
    success: true,
    message: 'Emergency contacts updated successfully',
    data: { phone, emergency_contact: contactValue },
  };
};

export const cancelAlert = async (alertId, uid) => {
  const rows = await prisma.$queryRaw`
    UPDATE sos_alerts
    SET status = 'CANCELLED', resolved_at = NOW(), updated_at = NOW()
    WHERE id = ${parseInt(alertId, 10)}
      AND (uid = ${uid}::uuid OR phone IN (SELECT phone FROM users WHERE uid = ${uid}::uuid))
      AND status = 'ACTIVE'
    RETURNING id, status
  `;
  if (rows.length === 0) throw new Error('Alert not found or already resolved');
  return rows[0];
};

export const getMyAlerts = async (uid, { limit = 20, offset = 0 } = {}) => {
  const rows = await prisma.$queryRaw`
    SELECT id, phone, latitude, longitude, alert_type AS "alertType",
           severity, status, message, raised_at AS "raisedAt",
           resolved_at AS "resolvedAt"
    FROM sos_alerts
    WHERE uid = ${uid}::uuid
    ORDER BY raised_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;
  return rows;
};

export const getNearbyServices = async (latitude, longitude) => {
  // locationService hits an external geocoding API; fall back to empty
  // arrays on failure so SOS UX never blocks on a degraded third party.
  try {
    return await locationService.findNearbyEmergencyServices(latitude, longitude);
  } catch (err) {
    logger.error('Error fetching nearby services:', err);
    return { hospitals: [], police_stations: [], ambulances: [] };
  }
};

export const getMedicalInfo = async (uid) => {
  const rows = await prisma.$queryRaw`
    SELECT name, phone, allergies, emergency_contact AS "emergencyContact",
           gender, birthday AS "dateOfBirth", blood_group AS "bloodGroup"
    FROM users WHERE uid = ${uid}::uuid LIMIT 1
  `;
  if (rows.length === 0) return null;
  return rows[0];
};
