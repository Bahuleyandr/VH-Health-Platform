export const ALERT_CONFIG = {
  webhookUrl: process.env.ALERT_WEBHOOK_URL || null,
  criticalWebhookUrl: process.env.ALERT_WEBHOOK_CRITICAL || null,
  debouncePeriodMs: parseInt(process.env.ALERT_DEBOUNCE_MS || '300000', 10),
  enabled: process.env.ALERTS_ENABLED !== 'false',
};
