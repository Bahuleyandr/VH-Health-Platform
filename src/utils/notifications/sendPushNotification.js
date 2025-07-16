// src\utils\notifications\sendPushNotification.js"

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

  // Firebase allows max 500 tokens per multicast
  if (tokenArray.length > 500) {
    throw new Error('🚫 Cannot send to more than 500 tokens in a single multicast request.');
  }

  const multicastMessage = {
    tokens: tokenArray,
    notification: { title, body },
    data: {
      ...data,
      click_action: 'FLUTTER_NOTIFICATION_CLICK',
    },
  };

  try {
    const response = await admin.messaging().sendMulticast(multicastMessage);

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
