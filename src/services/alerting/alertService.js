import logger from '../../logging/logger.js';

const DEBOUNCE_MS = 5 * 60 * 1000; // 5 minutes
const recentAlerts = new Map(); // key -> lastSentAt

export async function sendAlert(severity, title, message, context = {}) {
  const key = `${severity}:${title}`;
  const now = Date.now();

  // Debounce
  if (recentAlerts.has(key) && now - recentAlerts.get(key) < DEBOUNCE_MS) {
    return;
  }
  recentAlerts.set(key, now);

  const webhookUrl = getWebhookUrl(severity);
  if (!webhookUrl) return;

  const payload = buildPayload(severity, title, message, context);

  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
    logger.info(`Alert sent: [${severity}] ${title}`);
  } catch (err) {
    logger.error(`Alert delivery failed: ${err.message}`);
  }
}

function getWebhookUrl(severity) {
  if (severity === 'critical' || severity === 'down') {
    return process.env.ALERT_WEBHOOK_CRITICAL || process.env.ALERT_WEBHOOK_URL;
  }
  return process.env.ALERT_WEBHOOK_URL;
}

function buildPayload(severity, title, message, context) {
  // Support Slack, Discord, and generic webhook formats
  const emoji = { info: '\u2139\uFE0F', warning: '\u26A0\uFE0F', critical: '\uD83D\uDEA8', down: '\uD83D\uDD34' }[severity] || '\uD83D\uDCE2';
  return {
    text: `${emoji} *[${severity.toUpperCase()}] ${title}*\n${message}`,
    // Slack-compatible
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `${emoji} *[${severity.toUpperCase()}] ${title}*\n${message}` } },
      ...(Object.keys(context).length > 0 ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: Object.entries(context).map(([k, v]) => `*${k}*: ${v}`).join(' | ') }] }] : []),
    ],
  };
}
