// src\utils\notifications\sendPushNotification.js"

import admin from 'firebase-admin';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { sendToUser } from '../websocket/wsServer.js';

/**
 * Send a Firebase multicast message with retry logic for transient errors.
 */
async function sendWithRetry(message, maxRetries = 2) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await admin.messaging().sendEachForMulticast(message);
    } catch (err) {
      if (attempt === maxRetries) throw err;
      // Only retry on transient errors (network, server errors)
      if (err.code === 'messaging/server-unavailable' || err.code === 'messaging/internal-error' || err.message?.includes('ECONNRESET')) {
        const delay = 1000 * Math.pow(2, attempt);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      throw err; // Non-transient error, don't retry
    }
  }
}

/**
 * Send push notification using Firebase Admin SDK
 * @param {Object} options
 * @param {string|string[]} options.tokens - A single FCM token or an array of tokens
 * @param {string} options.title - Notification title
 * @param {string} options.body - Notification body
 * @param {Object} [options.data] - Optional custom key-value data
 */
export async function sendPushNotification({ tokens, title, body, data = {}, userId = null }) {
  // Also push via WebSocket if userId is provided
  if (userId) {
    try {
      sendToUser(String(userId), 'notification', { title, body, data });
    } catch {
      // WebSocket delivery is best-effort
    }
  }
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
    const response = await sendWithRetry(multicastMessage);

    logger.info(`📨 Push notification sent. Success: ${response.successCount}, Failure: ${response.failureCount}`);

    if (response.failureCount > 0) {
      const invalidTokens = [];
      response.responses.forEach((resp, idx) => {
        if (!resp.success) {
          logger.warn(`⚠️ Failed token [${tokenArray[idx]}]: ${resp.error?.message}`);
          // Collect tokens with permanent failure codes for cleanup
          const errorCode = resp.error?.code;
          if (errorCode === 'messaging/registration-token-not-registered' ||
              errorCode === 'messaging/invalid-registration-token' ||
              errorCode === 'messaging/invalid-argument') {
            invalidTokens.push(tokenArray[idx]);
          }
        }
      });

      // Clean up invalid tokens from the database
      if (invalidTokens.length > 0) {
        logger.warn(`Removing ${invalidTokens.length} invalid device tokens`);
        setImmediate(async () => {
          try {
            // Deactivate invalid tokens in user_devices (fcm_token column)
            await prisma.$queryRawUnsafe(
              `UPDATE user_devices SET fcm_token = NULL WHERE fcm_token = ANY($1)`,
              [invalidTokens]
            );
            // Deactivate invalid tokens in staff_devices (device_token column)
            await prisma.$queryRawUnsafe(
              `UPDATE staff_devices SET is_active = false, device_token = NULL WHERE device_token = ANY($1)`,
              [invalidTokens]
            );
            // Clear invalid tokens from users table (device_token column)
            await prisma.$queryRawUnsafe(
              `UPDATE users SET device_token = NULL WHERE device_token = ANY($1)`,
              [invalidTokens]
            );
          } catch (e) {
            logger.warn('Failed to cleanup invalid tokens:', e.message);
          }
        });
      }
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
