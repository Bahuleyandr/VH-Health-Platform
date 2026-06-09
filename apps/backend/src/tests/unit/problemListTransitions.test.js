// Roadmap B7 — problem list status machine (pure).

import {
  assertProblemTransition,
  PROBLEM_TRANSITIONS,
  PROBLEM_STATUSES,
} from '../../services/clinical/problemListService.js';

describe('problem list transitions', () => {
  test('allows the documented lifecycle moves', () => {
    expect(() => assertProblemTransition('active', 'resolved')).not.toThrow();
    expect(() => assertProblemTransition('active', 'inactive')).not.toThrow();
    expect(() => assertProblemTransition('active', 'entered_in_error')).not.toThrow();
    expect(() => assertProblemTransition('resolved', 'active')).not.toThrow(); // recurrence
    expect(() => assertProblemTransition('inactive', 'active')).not.toThrow();
    expect(() => assertProblemTransition('inactive', 'resolved')).not.toThrow();
  });

  test('entered_in_error is terminal', () => {
    for (const to of PROBLEM_STATUSES) {
      if (to === 'entered_in_error') continue;
      expect(() => assertProblemTransition('entered_in_error', to)).toThrow(/Invalid state transition/);
    }
  });

  test('rejects unknown statuses with a 400-class error', () => {
    try {
      assertProblemTransition('bogus', 'active');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err.statusCode).toBe(400);
      expect(err.code).toBe('PROBLEM_UNKNOWN_STATUS');
    }
  });

  test('transition map covers every status exactly once', () => {
    expect(Object.keys(PROBLEM_TRANSITIONS).sort()).toEqual([...PROBLEM_STATUSES].sort());
  });

  test('invalid transition error carries from/to/allowed details', () => {
    try {
      assertProblemTransition('active', 'active');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err.code).toBe('INVALID_STATE_TRANSITION');
      expect(err.details).toMatchObject({ from: 'active', to: 'active' });
    }
  });
});
