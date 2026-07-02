const SUPPORTED_CHANNELS = new Set([
  'push',
  'email',
  'inapp',
  'whatsapp',
  'voice',
  'sms',
  'print',
]);

const TYPE_TO_PREFERENCE_KEY = new Map([
  ['appointment_reminder', 'appointment_reminder'],
  ['appointment_reminder_24h', 'appointment_reminder'],
  ['appointment_reminder_1h', 'appointment_reminder'],
  ['reminder', 'appointment_reminder'],
  ['lab_result_ready', 'results_ready'],
  ['investigation_result_ready', 'results_ready'],
  ['result_ready', 'results_ready'],
  ['results_ready', 'results_ready'],
]);

function normalizeChannelList(value) {
  if (!Array.isArray(value)) return [];

  const channels = [];
  const seen = new Set();
  for (const raw of value) {
    const channel = String(raw || '').trim().toLowerCase();
    if (!SUPPORTED_CHANNELS.has(channel) || seen.has(channel)) continue;
    seen.add(channel);
    channels.push(channel);
  }
  return channels;
}

export function notificationPreferenceKeyForType(type) {
  return TYPE_TO_PREFERENCE_KEY.get(String(type || '').trim().toLowerCase()) || null;
}

export function legacyChannelsForOutboxRow(row = {}) {
  const type = String(row.type || '').trim().toLowerCase();
  const hasPhone = !!row.recipient_phone;
  const hasRecipientId = row.recipient_id !== null
    && row.recipient_id !== undefined
    && row.recipient_id !== '';

  if (type === 'sms' || (hasPhone && !hasRecipientId)) return ['sms'];
  return ['push'];
}

export function resolveChannelsForOutboxRow(row = {}, settings = {}) {
  const preferenceKey = notificationPreferenceKeyForType(row.type);
  const legacyChannels = legacyChannelsForOutboxRow(row);

  if (!preferenceKey) {
    return { channels: legacyChannels, preferenceKey: null, source: 'legacy' };
  }

  const configured = normalizeChannelList(settings?.notificationChannels?.[preferenceKey]);
  if (configured.length > 0) {
    return { channels: configured, preferenceKey, source: 'tenant' };
  }

  return { channels: legacyChannels, preferenceKey, source: 'legacy' };
}

export const __testing__ = {
  normalizeChannelList,
  SUPPORTED_CHANNELS,
  TYPE_TO_PREFERENCE_KEY,
};
