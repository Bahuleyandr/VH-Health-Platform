/**
 * Security Event Webhooks
 * Sends real-time security alerts to external services (Slack, PagerDuty, etc.)
 * via configurable webhook URLs.
 *
 * Environment variables:
 *   SECURITY_WEBHOOK_URL     — Primary webhook (Slack incoming webhook, etc.)
 *   SECURITY_WEBHOOK_CRITICAL — Separate URL for critical-only events (optional)
 *   SECURITY_WEBHOOKS_ENABLED — Set to 'true' to enable (default: disabled)
 */

import crypto from 'crypto';
import logger from '../logging/logger.js';
import { recordSecurityWebhookOutcome } from '../observability/securityEventMetrics.js';

const WEBHOOK_URL = process.env.SECURITY_WEBHOOK_URL;
const CRITICAL_WEBHOOK_URL = process.env.SECURITY_WEBHOOK_CRITICAL || WEBHOOK_URL;
const WEBHOOKS_ENABLED = process.env.SECURITY_WEBHOOKS_ENABLED === 'true';

const CRITICAL_EVENTS = new Set([
  'ACCOUNT_LOCKED',
  'SUSPICIOUS_ACTIVITY',
  'BRUTE_FORCE_DETECTED',
  'TOKEN_REVOKED_ALL',
  'PERMISSION_DENIED',
  // A patient SOS that reached zero responders (audit BE-M3) — patient
  // safety, so it routes to the critical-only channel when configured.
  'SOS_ESCALATION_FAILED',
]);

/**
 * Send a security event to the configured webhook(s).
 * Fire-and-forget — never blocks the caller.
 * @param {string} eventType - Security event name
 * @param {Object} details - Event context
 */
export function sendSecurityWebhook(eventType, details = {}) {
  if (!WEBHOOKS_ENABLED || !WEBHOOK_URL) {
    // Not configured is a legitimate state, but it must be OBSERVABLE: the
    // 2026-08-23 once-over found this early return silently discarding
    // brute-force / break-glass / audit-tamper pages in every deployment.
    // The 'disabled' outcome feeds the SecurityPagingUnconfigured alert.
    recordSecurityWebhookOutcome(eventType, 'disabled');
    return;
  }

  const isCritical = CRITICAL_EVENTS.has(eventType);
  const url = isCritical ? CRITICAL_WEBHOOK_URL : WEBHOOK_URL;

  const payload = {
    text: `*Security Alert: ${eventType}*`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: [
            `*Event:* \`${eventType}\``,
            details.userId ? `*User:* ${details.userId}` : null,
            details.ip ? `*IP:* ${details.ip}` : null,
            details.path ? `*Path:* ${details.path}` : null,
            details.reason ? `*Reason:* ${details.reason}` : null,
            `*Time:* ${new Date().toISOString()}`,
          ].filter(Boolean).join('\n'),
        },
      },
    ],
  };

  // Fire-and-forget
  setImmediate(async () => {
    try {
      const body = JSON.stringify(payload);
      const headers = { 'Content-Type': 'application/json' };

      const webhookSecret = process.env.SECURITY_WEBHOOK_SECRET;
      if (webhookSecret) {
        const signature = crypto.createHmac('sha256', webhookSecret).update(body).digest('hex');
        headers['X-Webhook-Signature'] = `sha256=${signature}`;
      }

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) {
        logger.warn(`Security webhook failed: ${response.status}`);
        recordSecurityWebhookOutcome(eventType, 'send_failed');
      } else {
        recordSecurityWebhookOutcome(eventType, 'sent');
      }
    } catch (err) {
      logger.warn('Security webhook delivery failed:', err.message);
      recordSecurityWebhookOutcome(eventType, 'send_failed');
    }
  });
}
