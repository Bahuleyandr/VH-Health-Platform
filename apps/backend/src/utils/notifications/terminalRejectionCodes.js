// src/utils/notifications/terminalRejectionCodes.js
//
// Provider rejection codes that are TERMINAL for one recipient but say nothing
// about the rest of the channel (fix R3, audit 2026-08-10). A receipt carrying
// one of these codes means "this recipient can never receive this intent as
// rendered" — a missing/unregistered FCM token, an absent phone or email
// address, a recipient row that does not exist. Retrying the same recipient is
// pointless, and pausing the whole tenant/channel cursor on it wedges every
// later notification (code-blue / deterioration / cold-chain / lab-critical
// pushes) behind one tokenless recipient.
//
// Delivery treats these as skip-and-advance: the rejection receipt is
// recorded (append-only evidence), the outbox row dead-letters normally, and
// the channel cursor resumes so the rest of the queue keeps delivering.
//
// The paused_* cursor states remain reserved for genuinely ambiguous or
// channel-level failures — transport timeouts, 5xx, `smtp_not_configured`,
// `sms_gateway_not_configured`, `*_provider_not_configured` — where pausing is
// honest because nothing on the channel can deliver (operator reset endpoint:
// POST /api/v1/admin/notification-outbox/cursors/:channel/reset).
//
// `operator_replay_superseded` is not a provider code: it marks a
// RECONCILIATION_REQUIRED row whose intent an operator explicitly replayed as
// a new outbox row (accepting duplicate-delivery risk, with a recorded
// reason). Such rows must stop blocking the strict per-channel ordering.
export const TERMINAL_REJECTION_CODES = Object.freeze([
  'fcm_token_missing',
  'fcm_all_tokens_invalid',
  'recipient_identifier_missing',
  'recipient_not_found',
  'email_address_missing',
  'phone_missing',
  // Migration 699 DLT fail-closed gate: this outbox row's template kind has
  // no active sms_template_registrations row, so THIS intent can never be
  // sent as rendered (an unregistered send is forbidden). Terminal per-row,
  // not per-channel: other template kinds keep delivering; the operator
  // registers the template and replays the dead-lettered row.
  'dlt_template_not_registered',
]);

const TERMINAL_SET = new Set(TERMINAL_REJECTION_CODES);

export function isTerminalRejectionCode(providerCode) {
  return TERMINAL_SET.has(String(providerCode || ''));
}

const PERMANENT_FCM_TOKEN_CODES = new Set([
  'messaging/invalid-registration-token',
  'messaging/registration-token-not-registered',
]);

export function classifyFcmProviderResponse(response = {}) {
  const responses = Array.isArray(response.responses) ? response.responses : [];
  const successCount = Number(response.successCount) || 0;
  const failureCount = Number(response.failureCount) || 0;
  const evidence = {
    success_count: successCount,
    failure_count: failureCount,
    responses,
  };

  if (successCount > 0) {
    const accepted = responses.find(item => item?.success);
    return {
      outcome: 'acknowledged',
      providerReference: accepted?.messageId || `fcm-accepted:${successCount}`,
      providerCode: failureCount > 0 ? 'partial_acceptance' : 'accepted',
      evidence,
    };
  }

  const failureCodes = responses
    .filter(item => item && item.success === false)
    .map(item => String(item.errorCode || item.error?.code || ''));
  if (failureCodes.length > 0
    && failureCodes.length === responses.length
    && failureCodes.every(code => PERMANENT_FCM_TOKEN_CODES.has(code))) {
    return {
      outcome: 'rejected',
      providerReference: null,
      providerCode: 'fcm_all_tokens_invalid',
      evidence,
    };
  }

  return {
    outcome: 'uncertain',
    providerReference: null,
    providerCode: 'fcm_no_acceptance_unresolved',
    evidence,
  };
}

// failure_reason stamped on a RECONCILIATION_REQUIRED row whose intent was
// replayed as a fresh intent (by an operator OR by the bounded auto-replay
// sweep — both requeue paths stamp this exact string on purpose: four
// ordering predicates hardcode it as "resolved for ordering", so a distinct
// auto-replay reason would silently re-block the per-channel cursors).
export const OPERATOR_REPLAY_SUPERSEDED_REASON = 'operator_replay_superseded';

// The only RECONCILIATION_REQUIRED failure_reasons the auto-replay sweep may
// requeue. Fail-closed: it excludes OPERATOR_REPLAY_SUPERSEDED_REASON (already
// replayed), AUTO_REPLAY_EXHAUSTED_REASON (bound crossed), and any future
// reason another writer stamps.
export const AUTO_REPLAYABLE_RECONCILIATION_REASONS = Object.freeze([
  'provider_delivery_outcome_uncertain',
  'provider_state_requires_owner_reconciliation',
]);

// failure_reason stamped exactly once on a RECONCILIATION_REQUIRED row whose
// replay chain crossed the generation bound. It is NOT a resolution: the row
// keeps blocking ordering and stays operator-replayable; the stamp is the
// idempotence marker for terminal alerting (counter fires once per chain).
export const AUTO_REPLAY_EXHAUSTED_REASON = 'auto_replay_exhausted';

// Max requeue-as-new-intent generations the sweep may create per intent
// chain. A RECONCILIATION_REQUIRED row at this generation is terminal for
// automation; only the operator endpoints can resolve it.
export const NOTIFICATION_AUTO_REPLAY_MAX_GENERATIONS = 2;

export default TERMINAL_REJECTION_CODES;
