// Pins for the security-event counters (once-over 2026-08-23 HIGH follow-up):
// the webhook channel can be disabled, but never invisibly — the 'disabled'
// outcome must count every page that would have fired.

import {
  recordSecurityEvent,
  recordSecurityWebhookOutcome,
  serializeSecurityEventMetrics,
} from '../../observability/securityEventMetrics.js';

describe('security event metrics', () => {
  it('counts events and webhook outcomes with bounded labels', () => {
    recordSecurityEvent('BRUTE_FORCE_DETECTED');
    recordSecurityWebhookOutcome('AUDIT_CHAIN_TAMPERED', 'disabled');
    recordSecurityWebhookOutcome('BREAK_GLASS_ACTIVATED', 'sent');

    const out = serializeSecurityEventMetrics();
    expect(out).toContain('vhhealth_security_events_total');
    expect(out).toContain('event_type="BRUTE_FORCE_DETECTED"');
    expect(out).toContain('vhhealth_security_webhook_events_total');
    expect(out).toContain('event_type="AUDIT_CHAIN_TAMPERED",outcome="disabled"');
    expect(out).toContain('event_type="BREAK_GLASS_ACTIVATED",outcome="sent"');
  });

  it('collapses malformed event types and outcomes instead of minting labels', () => {
    recordSecurityEvent('weird event; DROP TABLE');
    recordSecurityWebhookOutcome('ok_lower', 'not-an-outcome');

    const out = serializeSecurityEventMetrics();
    expect(out).toContain('event_type="UNKNOWN"');
    expect(out).not.toContain('DROP TABLE');
    // lowercase input is normalized, junk outcome collapses to send_failed
    expect(out).toContain('event_type="OK_LOWER",outcome="send_failed"');
  });
});
