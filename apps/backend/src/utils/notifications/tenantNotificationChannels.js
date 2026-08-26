import {
  PATIENT_NOTIFICATION_TYPE_CONTRACTS,
  patientNotificationPreferenceKeyForType,
} from '../../config/patientNotificationTypeRegistry.js';

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
  ...PATIENT_NOTIFICATION_TYPE_CONTRACTS
    .filter(contract => contract.preferenceKey)
    .map(contract => [contract.type, contract.preferenceKey]),
  // Staff-only in-app payslip delivery is outside the patient registry.
  ['payslip_ready', 'payslip_ready'],
]);

// ── outbox transport type → patient-inbox feed type ───────────────────────
//
// When a resolved channel set contains `inapp`, the outbox drain routes
// through `dispatch()`, whose inapp branch writes a `notifications` row typed
// with the OUTBOX ROW's type (notificationDispatcher.js). Some outbox types
// are transport / template identity only and are aliases rather than
// inbox-supported entries in the canonical patient-notification registry. A
// row typed with one of those renders but has no safe action, which is the same
// defect as no row at all. Translate those before the row is written.
//
// Only add an entry here when the transport type and the routed inbox type
// genuinely differ. Types already routed by the handler must NOT appear.
const TRANSPORT_TYPE_TO_FEED_TYPE = new Map(
  PATIENT_NOTIFICATION_TYPE_CONTRACTS
    .filter(contract => contract.feedType !== contract.type)
    .map(contract => [contract.type, contract.feedType]),
);

/**
 * The `notifications.type` an in-app row should carry for a given outbox /
 * dispatch transport type. Returns the input unchanged when no translation is
 * registered, so staff types and canonical patient types pass through
 * untouched.
 */
export function feedRowTypeForTransportType(type) {
  const key = String(type ?? '').trim().toLowerCase();
  return TRANSPORT_TYPE_TO_FEED_TYPE.get(key) || type;
}

export const DELIVERY_CHANNELS_PAYLOAD_KEY = '__delivery_channels';
export const REPLAY_CHAIN_STARTED_AT_PAYLOAD_KEY = '__replay_chain_started_at_ms';
export const PREPERSISTED_FEED_NOTIFICATION_ID_PAYLOAD_KEY = '__feed_notification_id';

export function prePersistedFeedNotificationId(row = {}) {
  const value = row?.payload?.[PREPERSISTED_FEED_NOTIFICATION_ID_PAYLOAD_KEY];
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function normalizeChannelList(value) {
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
  const key = String(type || '').trim().toLowerCase();
  return TYPE_TO_PREFERENCE_KEY.get(key)
    || patientNotificationPreferenceKeyForType(key)
    || null;
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
  const deliveryChannels = row?.payload && typeof row.payload === 'object'
    ? normalizeChannelList(row.payload[DELIVERY_CHANNELS_PAYLOAD_KEY])
    : [];
  const payloadChannels = row?.payload && typeof row.payload === 'object'
    ? normalizeChannelList(row.payload.channels)
    : [];

  if (deliveryChannels.length > 0) {
    return {
      channels: deliveryChannels,
      preferenceKey,
      source: preferenceKey ? 'tenant' : 'legacy',
    };
  }

  if (preferenceKey === 'engagement_campaign' && payloadChannels.length > 0) {
    return { channels: payloadChannels, preferenceKey: preferenceKey || 'engagement_campaign', source: 'tenant' };
  }

  if (preferenceKey === 'payslip_ready') {
    return { channels: ['inapp'], preferenceKey, source: 'tenant' };
  }

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
  TRANSPORT_TYPE_TO_FEED_TYPE,
};
