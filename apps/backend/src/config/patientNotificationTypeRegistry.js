// Canonical cross-stack contract for every patient notification type the
// mobile app accepts. Keep this module dependency-free: Flutter CI imports it
// directly to generate the Dart action table before backend dependencies are
// installed.

const ACTIONS = Object.freeze({
  NAVIGATE: 'navigate',
  ACKNOWLEDGE_ONLY: 'acknowledge_only',
});

const DEFAULTS = Object.freeze({
  authPolicy: 'current_patient_session',
  biometricPolicy: 'notification_inbox_gate',
  priority: 'NORMAL',
  acknowledgement: 'mark_read',
  expiry: 'source_authoritative',
  lifecycle: 'active',
  stableHydrationIds: Object.freeze([]),
  hydrationValidators: Object.freeze({}),
  extra: Object.freeze({}),
  preferenceKey: null,
  inboxSupported: false,
});

function contract(input) {
  return Object.freeze({
    ...DEFAULTS,
    ...input,
    stableHydrationIds: Object.freeze([...(input.stableHydrationIds || [])]),
    hydrationValidators: Object.freeze({ ...(input.hydrationValidators || {}) }),
    extra: Object.freeze({ ...(input.extra || {}) }),
  });
}

function alias(type, source, overrides = {}) {
  return contract({
    ...source,
    type,
    lifecycle: 'legacy_alias',
    persistence: 'transport_alias',
    deliveryReceipt: 'provider_receipt',
    inboxSupported: false,
    ...overrides,
  });
}

const appointmentReminder = contract({
  type: 'appointment_reminder',
  feedType: 'appointment_reminder',
  writer: 'appointment reminder outbox and scheduled-notification sweep',
  persistence: 'required_feed_before_private_push',
  targetUri: '/appointments',
  fallbackUri: '/appointments',
  action: ACTIONS.NAVIGATE,
  deliveryReceipt: 'feed_commit_and_provider_receipt',
  preferenceKey: 'appointment_reminder',
  owner: 'appointments',
  inboxSupported: true,
});

const appointmentConfirmed = contract({
  ...appointmentReminder,
  type: 'appointment_confirmed',
  feedType: 'appointment_confirmed',
  writer: 'appointment confirmation controller',
  preferenceKey: null,
});

const appointmentCancelled = contract({
  ...appointmentReminder,
  type: 'appointment_cancelled',
  feedType: 'appointment_cancelled',
  writer: 'appointment cancellation controller',
  preferenceKey: null,
});

const appointmentRescheduled = contract({
  ...appointmentReminder,
  type: 'appointment_rescheduled',
  feedType: 'appointment_rescheduled',
  writer: 'appointment reschedule controller',
  preferenceKey: null,
});

const investigationResult = contract({
  type: 'investigation_result',
  feedType: 'investigation_result',
  writer: 'investigation report notification job and legacy order service',
  persistence: 'required_feed_before_private_push',
  targetUri: '/investigations',
  fallbackUri: '/investigations',
  action: ACTIONS.NAVIGATE,
  deliveryReceipt: 'feed_commit_and_provider_receipt',
  owner: 'investigations',
  inboxSupported: true,
});

const investigationResultReady = contract({
  ...investigationResult,
  type: 'investigation_result_ready',
  feedType: 'investigation_result_ready',
  writer: 'investigation result service',
  preferenceKey: 'results_ready',
});

const investigationConfirmed = contract({
  ...investigationResult,
  type: 'investigation_confirmed',
  feedType: 'investigation_confirmed',
  writer: 'investigation booking controller',
});

const investigationBooking = contract({
  ...investigationResult,
  type: 'investigation_booking',
  feedType: 'investigation_booking',
  writer: 'investigation order and booking controllers',
});

const collectorDispatched = contract({
  ...investigationResult,
  type: 'collector_dispatched',
  feedType: 'collector_dispatched',
  writer: 'investigation booking controller',
});

const labResultReady = contract({
  type: 'lab_result_ready',
  feedType: 'lab_result_ready',
  writer: 'lab result release service',
  persistence: 'required_feed_before_private_push',
  targetUri: '/portal/lab-results',
  fallbackUri: '/portal/lab-results',
  action: ACTIONS.NAVIGATE,
  deliveryReceipt: 'feed_commit_and_provider_receipt',
  preferenceKey: 'results_ready',
  owner: 'laboratory',
  inboxSupported: true,
});

const labResultCorrected = contract({
  ...labResultReady,
  type: 'lab_result_corrected',
  feedType: 'lab_result_corrected',
  writer: 'lab result correction service',
});

const diagnosticResultReady = contract({
  type: 'diagnostic_result_ready',
  feedType: 'diagnostic_result_ready',
  writer: 'structured diagnostic patient notification sweep',
  persistence: 'transactional_feed_and_outbox',
  targetUri: '/portal/diagnostic-results',
  fallbackUri: '/portal/diagnostic-results',
  action: ACTIONS.NAVIGATE,
  deliveryReceipt: 'feed_commit_and_provider_receipt',
  preferenceKey: 'results_ready',
  owner: 'diagnostics',
  inboxSupported: true,
});

const patientMessage = contract({
  type: 'patient_message',
  feedType: 'patient_message',
  writer: 'patient portal secure messaging service',
  persistence: 'required_feed_before_private_push',
  targetUri: '/portal/messages/:thread_id',
  fallbackUri: '/portal/messages',
  action: ACTIONS.NAVIGATE,
  stableHydrationIds: ['thread_id'],
  hydrationValidators: { thread_id: 'positive_integer' },
  deliveryReceipt: 'feed_commit_and_provider_receipt',
  owner: 'secure_messaging',
  inboxSupported: true,
});

const referralResponseReady = contract({
  type: 'referral_response_ready',
  feedType: 'referral_response_ready',
  writer: 'referral closed-loop response transaction',
  persistence: 'transactional_feed_and_outbox',
  targetUri: '/portal/referrals',
  fallbackUri: '/portal/referrals',
  action: ACTIONS.NAVIGATE,
  deliveryReceipt: 'feed_commit_and_provider_receipt',
  owner: 'referrals',
  inboxSupported: true,
});

const referralUpdate = contract({
  ...referralResponseReady,
  type: 'referral_update',
  feedType: 'referral_update',
  writer: 'referral workflow notification writer',
  persistence: 'required_feed_before_private_push',
});

const pharmacyOrder = contract({
  type: 'pharmacy_order',
  feedType: 'pharmacy_order',
  writer: 'pharmacy order workflow',
  persistence: 'required_feed_before_private_push',
  targetUri: '/pharmacy',
  fallbackUri: '/pharmacy',
  action: ACTIONS.NAVIGATE,
  deliveryReceipt: 'feed_commit_and_provider_receipt',
  owner: 'pharmacy',
  inboxSupported: true,
});

const pharmacyConfirmed = contract({
  ...pharmacyOrder,
  type: 'pharmacy_confirmed',
  feedType: 'pharmacy_confirmed',
});

const pharmacyDispatched = contract({
  ...pharmacyOrder,
  type: 'pharmacy_dispatched',
  feedType: 'pharmacy_dispatched',
});

const pharmacyDelivered = contract({
  ...pharmacyOrder,
  type: 'pharmacy_delivered',
  feedType: 'pharmacy_delivered',
});

const documentUploaded = contract({
  type: 'document_uploaded',
  feedType: 'document_uploaded',
  writer: 'electronic prescription document workflow',
  persistence: 'dispatcher_inapp',
  targetUri: '/health',
  fallbackUri: '/health',
  action: ACTIONS.NAVIGATE,
  extra: { tab: 1 },
  deliveryReceipt: 'feed_commit_and_provider_receipt',
  owner: 'patient_records',
  inboxSupported: true,
});

const feedbackRequest = contract({
  type: 'feedback_request',
  feedType: 'feedback_request',
  writer: 'scheduled notification sweep',
  persistence: 'required_feed_before_private_push',
  targetUri: '/ask-a-doubt',
  fallbackUri: '/ask-a-doubt',
  action: ACTIONS.NAVIGATE,
  deliveryReceipt: 'feed_commit_and_provider_receipt',
  owner: 'patient_feedback',
  inboxSupported: true,
});

const engagementCampaign = contract({
  type: 'engagement_campaign',
  feedType: 'engagement_campaign',
  writer: 'engagement campaign outbox',
  persistence: 'transactional_feed_and_outbox',
  targetUri: '/notifications',
  fallbackUri: '/notifications',
  action: ACTIONS.ACKNOWLEDGE_ONLY,
  deliveryReceipt: 'feed_commit_and_provider_receipt',
  preferenceKey: 'engagement_campaign',
  owner: 'patient_engagement',
  inboxSupported: true,
});

const billing = contract({
  type: 'billing',
  feedType: 'billing',
  writer: 'legacy billing push transport',
  persistence: 'provider_only',
  targetUri: '/portal/bills',
  fallbackUri: '/portal/bills',
  action: ACTIONS.NAVIGATE,
  deliveryReceipt: 'provider_receipt',
  owner: 'billing',
  inboxSupported: true,
});

const sos = contract({
  type: 'sos',
  feedType: 'sos',
  writer: 'patient safety push transport',
  persistence: 'provider_only',
  targetUri: '/home',
  fallbackUri: '/home',
  action: ACTIONS.NAVIGATE,
  deliveryReceipt: 'provider_receipt',
  owner: 'patient_safety',
  inboxSupported: true,
});

const feedback = contract({
  type: 'feedback',
  feedType: 'feedback',
  writer: 'feedback response push transport',
  persistence: 'provider_only',
  targetUri: '/feedback-history',
  fallbackUri: '/feedback-history',
  action: ACTIONS.NAVIGATE,
  deliveryReceipt: 'provider_receipt',
  owner: 'patient_feedback',
  inboxSupported: true,
});

const stepReward = contract({
  type: 'step_reward',
  feedType: 'step_reward',
  writer: 'wellness reward push transport',
  persistence: 'provider_only',
  targetUri: '/steps',
  fallbackUri: '/steps',
  action: ACTIONS.NAVIGATE,
  deliveryReceipt: 'provider_receipt',
  owner: 'wellness',
  inboxSupported: true,
});

const medicationReminder = contract({
  type: 'medication_reminder',
  feedType: 'medication_reminder',
  writer: 'patient device notification scheduler',
  persistence: 'local_notification',
  targetUri: '/reminders',
  fallbackUri: '/reminders',
  action: ACTIONS.NAVIGATE,
  deliveryReceipt: 'device_scheduler_receipt',
  owner: 'medication_adherence',
  inboxSupported: true,
});

const entries = Object.freeze([
  appointmentReminder,
  appointmentConfirmed,
  appointmentCancelled,
  appointmentRescheduled,
  alias('appointment', appointmentReminder),
  alias('appointment_reminder_24h', appointmentReminder, {
    preferenceKey: 'appointment_reminder',
  }),
  alias('appointment_reminder_1h', appointmentReminder, {
    preferenceKey: 'appointment_reminder',
  }),
  alias('reminder', appointmentReminder, { preferenceKey: 'appointment_reminder' }),
  investigationResult,
  investigationResultReady,
  investigationConfirmed,
  investigationBooking,
  collectorDispatched,
  alias('investigation', investigationResult),
  labResultReady,
  labResultCorrected,
  alias('result_ready', labResultReady, { preferenceKey: 'results_ready' }),
  alias('results_ready', labResultReady, { preferenceKey: 'results_ready' }),
  diagnosticResultReady,
  patientMessage,
  alias('secure_message', patientMessage),
  alias('message', patientMessage),
  alias('portal_message', patientMessage),
  referralResponseReady,
  referralUpdate,
  pharmacyOrder,
  pharmacyConfirmed,
  pharmacyDispatched,
  pharmacyDelivered,
  alias('pharmacy_order_update', pharmacyOrder),
  alias('order_dispatched', pharmacyDispatched),
  alias('order_delivered', pharmacyDelivered),
  documentUploaded,
  alias('prescription', documentUploaded),
  alias('prescription_ready', documentUploaded),
  feedbackRequest,
  engagementCampaign,
  billing,
  alias('bill_ready', billing),
  alias('payment_link', billing),
  sos,
  alias('sos_alert', sos),
  feedback,
  alias('feedback_reply', feedback),
  stepReward,
  alias('step_badge', stepReward),
  medicationReminder,
]);

function validateRegistry(values) {
  const types = new Set();
  const requiredFields = [
    'type', 'feedType', 'writer', 'persistence', 'targetUri',
    'authPolicy', 'biometricPolicy', 'priority', 'deliveryReceipt',
    'acknowledgement', 'expiry', 'fallbackUri', 'owner', 'action',
  ];
  for (const value of values) {
    if (value.type !== value.type.trim().toLowerCase() || types.has(value.type)) {
      throw new Error(`Invalid or duplicate patient notification type: ${value.type}`);
    }
    types.add(value.type);
    for (const field of requiredFields) {
      if (typeof value[field] !== 'string' || value[field].trim() === '') {
        throw new Error(`Patient notification ${value.type} is missing ${field}`);
      }
    }
    if (!Object.values(ACTIONS).includes(value.action)) {
      throw new Error(`Patient notification ${value.type} has invalid action ${value.action}`);
    }
    if (!value.targetUri.startsWith('/') || !value.fallbackUri.startsWith('/')) {
      throw new Error(`Patient notification ${value.type} has a non-local target`);
    }
    const placeholders = [...value.targetUri.matchAll(/:([a-z_][a-z0-9_]*)/g)]
      .map(match => match[1]);
    if (JSON.stringify(placeholders) !== JSON.stringify(value.stableHydrationIds)) {
      throw new Error(`Patient notification ${value.type} hydration ids do not match its target`);
    }
    for (const id of value.stableHydrationIds) {
      if (value.hydrationValidators[id] !== 'positive_integer') {
        throw new Error(`Patient notification ${value.type} lacks a stable validator for ${id}`);
      }
    }
    if (value.inboxSupported && value.feedType !== value.type) {
      throw new Error(`Inbox notification ${value.type} must be its own canonical feed type`);
    }
  }
  for (const value of values) {
    if (!types.has(value.feedType)) {
      throw new Error(`Patient notification ${value.type} maps to unknown feed type ${value.feedType}`);
    }
  }
}

validateRegistry(entries);

export const PATIENT_NOTIFICATION_ACTIONS = ACTIONS;
export const PATIENT_NOTIFICATION_TYPE_CONTRACTS = entries;
export const PATIENT_NOTIFICATION_TYPE_REGISTRY = Object.freeze(
  Object.fromEntries(entries.map(value => [value.type, value])),
);
export const PATIENT_INBOX_NOTIFICATION_TYPES = Object.freeze(
  entries.filter(value => value.inboxSupported).map(value => value.type),
);

export function patientNotificationContractForType(type) {
  const key = String(type || '').trim().toLowerCase();
  return PATIENT_NOTIFICATION_TYPE_REGISTRY[key] || null;
}

export function patientFeedTypeForTransportType(type) {
  return patientNotificationContractForType(type)?.feedType || type;
}

export function patientNotificationPreferenceKeyForType(type) {
  return patientNotificationContractForType(type)?.preferenceKey || null;
}

export default PATIENT_NOTIFICATION_TYPE_REGISTRY;
