// Roadmap C2 — outbound feed pure helpers.

import { nextAttemptDelayMinutes, MAX_DELIVERY_ATTEMPTS } from '../../services/hl7/hl7OutboundService.js';

describe('hl7 outbound backoff', () => {
  test('doubles per attempt and caps at 60 minutes', () => {
    expect(nextAttemptDelayMinutes(1)).toBe(2);
    expect(nextAttemptDelayMinutes(2)).toBe(4);
    expect(nextAttemptDelayMinutes(3)).toBe(8);
    expect(nextAttemptDelayMinutes(5)).toBe(32);
    expect(nextAttemptDelayMinutes(6)).toBe(60);
    expect(nextAttemptDelayMinutes(10)).toBe(60);
  });
  test('handles degenerate inputs conservatively', () => {
    expect(nextAttemptDelayMinutes(0)).toBe(1);
    expect(nextAttemptDelayMinutes(-3)).toBe(1);
  });
  test('messages die after 7 attempts', () => {
    expect(MAX_DELIVERY_ATTEMPTS).toBe(7);
  });
});
