// src\utils\notifications\sendPushNotification.js"

import { getMessaging } from 'firebase-admin/messaging';
import prisma, { setTenant } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { sendToUser } from '../websocket/wsServer.js';

const PRIVATE_LOCK_SCREEN_TITLE = 'VH Health';
const PRIVATE_LOCK_SCREEN_BODY = 'You have a new update. Open the app to view it.';

/**
 * Send a Firebase multicast message with retry logic for transient errors.
 */
async function sendWithRetry(message, maxRetries = 2) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await getMessaging().sendEachForMulticast(message);
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
 * @param {string} options.title - Detailed authenticated-app title; normal FCM display copy is private
 * @param {string} options.body - Detailed authenticated-app body; normal FCM display copy is private
 * @param {Object} [options.data] - Optional custom key-value data
 */
export async function sendPushNotification({ tokens, title, body, data = {}, userId = null, priority = 'normal', channelId = null }) {
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
    return { successCount: 0, failureCount: 0, responses: [] };
  }

  // Normalize to array
  const tokenArray = Array.isArray(tokens) ? tokens : [tokens];

  // Firebase allows max 500 tokens per multicast
  if (tokenArray.length > 500) {
    throw new Error('🚫 Cannot send to more than 500 tokens in a single multicast request.');
  }

  // High-priority messages (Code Blue, critical vitals) are sent data-only so
  // the client can build a full-screen-intent notification locally against a
  // MAX-importance channel. Normal messages use FCM's notification block so
  // Android's system tray renders them directly. Their display copy is always
  // privacy-minimized; authenticated app surfaces retain the detailed copy.
  const isHigh = priority === 'high';
  const transportData = { ...data };
  if (isHigh) {
    transportData.title = title;
    transportData.body = body;
  } else {
    delete transportData.title;
    delete transportData.body;
  }
  const multicastMessage = {
    tokens: tokenArray,
    ...(isHigh
      ? {}
      : {
          notification: {
            title: PRIVATE_LOCK_SCREEN_TITLE,
            body: PRIVATE_LOCK_SCREEN_BODY,
          },
        }),
    data: {
      ...transportData,
      click_action: 'FLUTTER_NOTIFICATION_CLICK',
    },
    ...(isHigh
      ? {
          android: {
            priority: 'high',
            ttl: 60 * 1000, // 60s — Code Blue is irrelevant after the event window
            ...(channelId ? { notification: { channelId, priority: 'max', visibility: 'public' } } : {}),
          },
          apns: {
            headers: { 'apns-priority': '10' },
            payload: { aps: { 'interruption-level': 'critical', sound: 'default' } },
          },
        }
      : {
          android: {
            notification: { visibility: 'private' },
          },
        }),
  };

  try {
    const response = await sendWithRetry(multicastMessage);

    logger.info(`📨 Push notification sent. Success: ${response.successCount}, Failure: ${response.failureCount}`);

    if (response.failureCount > 0) {
      const invalidTokens = [];
      response.responses.forEach((resp, idx) => {
        if (!resp.success) {
          logger.warn(`⚠️ Failed FCM token at index ${idx}: ${resp.error?.message}`);
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
        logger.warn(`Removing ${invalidTokens.length} invalid FCM tokens`);
        setImmediate(async () => {
          try {
            const tenants = await prisma.$queryRawUnsafe(
              'SELECT id::text FROM tenants ORDER BY id'
            );
            await Promise.all(tenants.map(({ id }) => setTenant(id, async tx => {
              await tx.$queryRawUnsafe(
                `UPDATE user_devices
                    SET fcm_token = NULL
                  WHERE tenant_id = $1::uuid
                    AND fcm_token = ANY($2)`,
                id,
                invalidTokens
              );
              await tx.$queryRawUnsafe(
                `UPDATE users
                    SET device_token = NULL
                  WHERE tenant_id = $1::uuid
                    AND device_token = ANY($2)`,
                id,
                invalidTokens
              );
            })));
          } catch (e) {
            logger.warn('Failed to cleanup invalid tokens:', e.message);
          }
        });
      }
    }

    return {
      successCount: response.successCount,
      failureCount: response.failureCount,
      responses: response.responses.map((item, index) => ({
        tokenIndex: index,
        success: item.success,
        messageId: item.messageId || null,
        errorCode: item.error?.code || null,
        errorMessage: item.error?.message || null,
      })),
    };
  } catch (err) {
    logger.error('❌ Error sending push notification:', err.stack || err.toString());
    const failure = new Error('Push notification failed', { cause: err });
    failure.code = err.code || 'FCM_TRANSPORT_FAILURE';
    throw failure;
  }
}
