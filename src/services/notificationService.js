// src/services/notificationService.js
import db from '../config/database.js';
import { sendPushNotification } from '../utils/notifications/sendPushNotification.js';
import logger from '../logging/logger.js';

export const notifyEmergencyTeam = async (alertData, nearbyHospitals = []) => {
  try {
    const { id: alertId, phone, severity, message, latitude, longitude, user_name } = alertData;
    
    // Get emergency responder tokens
    const tokens = await getEmergencyResponderTokens();

    if (tokens.length > 0) {
      await sendEmergencyPushNotifications(tokens, alertData, nearbyHospitals);
    }

    // Create system-wide notification
    await createSystemNotification(alertData, nearbyHospitals);

  } catch (err) {
    logger.error('Emergency Team Notification Error:', err);
  }
};

const getEmergencyResponderTokens = async () => {
  const result = await db.query(`
    SELECT DISTINCT ud.fcm_token 
    FROM user_devices ud
    JOIN users u ON ud.user_uid = u.uid
    WHERE u.role IN ('ADMIN', 'DOCTOR', 'NURSING_STAFF', 'EMERGENCY_RESPONDER')
      AND ud.fcm_token IS NOT NULL
      AND u.notification_preferences->>'emergency_alerts' != 'false'
  `);

  return result.rows.map(row => row.fcm_token).filter(Boolean);
};

// ... other notification methods