import admin from 'firebase-admin';
import logger from '../../logging/logger.js';

/**
 * Send push notification using Firebase Admin SDK
 * @param {Object} options
 * @param {string|string[]} options.tokens - A single FCM token or an array of tokens
 * @param {string} options.title - Notification title
 * @param {string} options.body - Notification body
 * @param {Object} [options.data] - Optional custom key-value data
 */
export async function sendPushNotification({ tokens, title, body, data = {} }) {
  if (!tokens || (Array.isArray(tokens) && tokens.length === 0)) {
    logger.warn('📭 No FCM tokens provided for push notification');
    return { successCount: 0, failureCount: 0 };
  }

  // Normalize to array
  const tokenArray = Array.isArray(tokens) ? tokens : [tokens];

  const message = {
    notification: { title, body },
    tokens: tokenArray,
    data: {
      ...data,
      click_action: 'FLUTTER_NOTIFICATION_CLICK',
    },
  };

  try {
    const response = await admin.messaging().sendMulticast(message);

    logger.info(`📨 Push notification sent. Success: ${response.successCount}, Failure: ${response.failureCount}`);

    if (response.failureCount > 0) {
      response.responses.forEach((resp, idx) => {
        if (!resp.success) {
          logger.warn(`⚠️ Failed token [${tokenArray[idx]}]: ${resp.error?.message}`);
        }
      });
    }

    return {
      successCount: response.successCount,
      failureCount: response.failureCount,
    };
  } catch (err) {
    logger.error('❌ Error sending push notification:', err.stack || err.toString());
    throw new Error('Push notification failed');
  }
}
