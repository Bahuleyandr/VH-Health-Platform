// Roadmap C2 — outbound feed pure helpers.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

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
  test('retires the generic replay service and route', () => {
    const service = fs.readFileSync(fileURLToPath(new URL(
      '../../services/hl7/hl7OutboundService.js',
      import.meta.url,
    )), 'utf8');
    const routes = fs.readFileSync(fileURLToPath(new URL(
      '../../routes/hl7/hl7FeedRoutes.js',
      import.meta.url,
    )), 'utf8');
    expect(service).not.toMatch(/replayFeedMessage/);
    expect(routes).not.toMatch(/messages\/:id\/replay/);
  });
});
