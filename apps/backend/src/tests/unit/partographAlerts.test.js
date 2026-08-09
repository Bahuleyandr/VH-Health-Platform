// Unit tests for the WHO modified partograph alert/action line math
// (services/maternity/maternityService.js#computePartographAlerts).
//
// The active phase begins at 4cm cervical dilatation. Expected
// progression is 1cm/hr. The alert line plots that ideal slope from
// (4cm, time of 4cm). The action line is 4 hours to the right of the
// alert line — i.e., 4 hours of grace before "do something."
//
// Crossing the action line is a clinical escalation trigger.

import { computePartographAlerts } from '../../services/maternity/maternityService.js';

describe('computePartographAlerts', () => {
  const start = '2026-01-01T00:00:00Z';

  it('returns nulls when inputs are missing', () => {
    expect(computePartographAlerts({})).toEqual({ on_alert_line: null, on_action_line: null });
    expect(computePartographAlerts({
      activePhaseStartedAt: start, recordedAt: start, dilationCm: null,
    })).toEqual({ on_alert_line: null, on_action_line: null });
  });

  it('at hour 0, dilation 4cm = on the alert line, NOT below → not flagged', () => {
    const r = computePartographAlerts({
      activePhaseStartedAt: start,
      recordedAt: start,
      dilationCm: 4,
    });
    // expectedAtAlert = 4 + 0 = 4; dilation < 4 → false
    expect(r.on_alert_line).toBe(false);
    expect(r.on_action_line).toBe(false);
  });

  it('at hour 2, dilation 6cm = on alert line (expected 6), not flagged', () => {
    const r = computePartographAlerts({
      activePhaseStartedAt: start,
      recordedAt: '2026-01-01T02:00:00Z',
      dilationCm: 6,
    });
    expect(r.on_alert_line).toBe(false);
    expect(r.on_action_line).toBe(false);
  });

  it('at hour 2, dilation 5cm = below alert line, alert raised but not action', () => {
    const r = computePartographAlerts({
      activePhaseStartedAt: start,
      recordedAt: '2026-01-01T02:00:00Z',
      dilationCm: 5,
    });
    expect(r.on_alert_line).toBe(true);    // expected 6, actual 5 → below alert
    expect(r.on_action_line).toBe(false);  // action line is at 4 (no slope yet)
  });

  it('does not project the action line backwards into its first four hours', () => {
    const r = computePartographAlerts({
      activePhaseStartedAt: start,
      recordedAt: '2026-01-01T02:00:00Z',
      dilationCm: 3,
    });
    expect(r.on_alert_line).toBe(true);
    expect(r.on_action_line).toBe(false);
  });

  it('at hour 5, dilation 4cm = action line crossed (expected at action = 4 + (5-4) = 5)', () => {
    const r = computePartographAlerts({
      activePhaseStartedAt: start,
      recordedAt: '2026-01-01T05:00:00Z',
      dilationCm: 4,
    });
    expect(r.on_alert_line).toBe(true);    // expected at alert = 9, actual 4
    expect(r.on_action_line).toBe(true);   // expected at action = 5, actual 4
  });

  it('a recording before active phase started (clock skew) returns false/false safely', () => {
    const r = computePartographAlerts({
      activePhaseStartedAt: '2026-01-01T03:00:00Z',
      recordedAt: '2026-01-01T01:00:00Z',  // before
      dilationCm: 3,
    });
    expect(r).toEqual({ on_alert_line: false, on_action_line: false });
  });

  it('rapid progress (8cm at hour 2) is not flagged', () => {
    const r = computePartographAlerts({
      activePhaseStartedAt: start,
      recordedAt: '2026-01-01T02:00:00Z',
      dilationCm: 8,
    });
    expect(r.on_alert_line).toBe(false);
    expect(r.on_action_line).toBe(false);
  });
});
