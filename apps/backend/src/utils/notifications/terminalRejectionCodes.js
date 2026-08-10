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
  'fcm_no_token_accepted',
  'recipient_identifier_missing',
  'recipient_not_found',
  'email_address_missing',
  'phone_missing',
]);

const TERMINAL_SET = new Set(TERMINAL_REJECTION_CODES);

export function isTerminalRejectionCode(providerCode) {
  return TERMINAL_SET.has(String(providerCode || ''));
}

// failure_reason stamped on a RECONCILIATION_REQUIRED row that an operator
// replayed as a fresh intent; the claim/attempt/advance predicates treat rows
// carrying it as resolved for ordering purposes.
export const OPERATOR_REPLAY_SUPERSEDED_REASON = 'operator_replay_superseded';

export default TERMINAL_REJECTION_CODES;
