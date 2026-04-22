import {
  planRoster,
  planRosterGreedy,
  planRosterWithLinearProgramming,
} from '../../services/ai/rosterOptimizerService.js';

function demandFor(date, code, slots) {
  return { date, shift_code: code, slots_needed: slots };
}

function staffMember(overrides = {}) {
  return {
    staff_uid: 'uid-unset',
    name: 'Staff',
    preferred_shifts: [],
    unavailable_dates: [],
    max_shifts_per_week: 5,
    min_rest_hours: 10,
    ...overrides,
  };
}

describe('planRoster', () => {
  it('fills all slots when staff pool is large enough', () => {
    const staff = Array.from({ length: 6 }, (_, i) => staffMember({ staff_uid: `s${i}`, name: `S${i}` }));
    const demand = [
      demandFor('2026-05-04', 'morning', 2),
      demandFor('2026-05-04', 'evening', 2),
    ];
    const out = planRoster({ demand, staff });
    expect(out.filled_slots).toBe(4);
    expect(out.coverage_gaps.length).toBe(0);
  });

  it('surfaces a coverage gap when demand exceeds availability', () => {
    const staff = [staffMember({ staff_uid: 's1' })];
    const demand = [demandFor('2026-05-04', 'morning', 3)];
    const out = planRoster({ demand, staff });
    expect(out.filled_slots).toBe(1);
    expect(out.coverage_gaps[0].shortfall).toBe(2);
  });

  it('respects unavailable dates', () => {
    const staff = [
      staffMember({ staff_uid: 's1', unavailable_dates: ['2026-05-04'] }),
      staffMember({ staff_uid: 's2' }),
    ];
    const demand = [demandFor('2026-05-04', 'morning', 1)];
    const out = planRoster({ demand, staff });
    expect(out.assignments[0].staff_uid).toBe('s2');
  });

  it('respects max_shifts_per_week', () => {
    const staff = [staffMember({ staff_uid: 's1', max_shifts_per_week: 2 })];
    const demand = [
      demandFor('2026-05-04', 'morning', 1), // Mon
      demandFor('2026-05-05', 'morning', 1), // Tue
      demandFor('2026-05-06', 'morning', 1), // Wed — third in same week, should gap
    ];
    const out = planRoster({ demand, staff });
    expect(out.filled_slots).toBe(2);
    expect(out.coverage_gaps[0].date).toBe('2026-05-06');
  });

  it('respects min_rest_hours between shifts', () => {
    const staff = [staffMember({ staff_uid: 's1', min_rest_hours: 10 })];
    const demand = [
      // evening ends 23:00, next morning starts 07:00 — only 8h rest.
      demandFor('2026-05-04', 'evening', 1),
      demandFor('2026-05-05', 'morning', 1),
    ];
    const out = planRoster({ demand, staff });
    expect(out.filled_slots).toBe(1);
    expect(out.coverage_gaps[0].date).toBe('2026-05-05');
  });

  it('prefers staff whose preferred_shifts match the slot', () => {
    const staff = [
      staffMember({ staff_uid: 'generalist', preferred_shifts: [] }),
      staffMember({ staff_uid: 'morning-lover', preferred_shifts: ['morning'] }),
    ];
    const demand = [demandFor('2026-05-04', 'morning', 1)];
    const out = planRoster({ demand, staff });
    expect(out.assignments[0].staff_uid).toBe('morning-lover');
    expect(out.preference_conflicts.length).toBe(0);
  });

  it('surfaces a preference conflict when a staff with prefs gets off-preference', () => {
    const staff = [
      staffMember({ staff_uid: 's1', preferred_shifts: ['morning'] }),
    ];
    const demand = [demandFor('2026-05-04', 'evening', 1)];
    const out = planRoster({ demand, staff });
    expect(out.preference_conflicts[0].staff_uid).toBe('s1');
    expect(out.preference_conflicts[0].shift_code).toBe('evening');
  });

  it('handles empty staff pool gracefully', () => {
    const demand = [demandFor('2026-05-04', 'morning', 3)];
    const out = planRoster({ demand, staff: [] });
    expect(out.filled_slots).toBe(0);
    expect(out.coverage_gaps[0].shortfall).toBe(3);
  });

  it('uses the solver by default when the problem is small enough', () => {
    const staff = [
      staffMember({ staff_uid: 's1', preferred_shifts: ['morning'] }),
      staffMember({ staff_uid: 's2', preferred_shifts: ['evening'] }),
    ];
    const demand = [
      demandFor('2026-05-04', 'morning', 1),
      demandFor('2026-05-04', 'evening', 1),
    ];
    const out = planRoster({ demand, staff });
    expect(out.optimizer).toBe('mip');
    expect(out.solver_status).toBe('optimal');
    expect(out.filled_slots).toBe(2);
  });

  it('solver can avoid a greedy early assignment that would cause a later gap', () => {
    const staff = [
      staffMember({ staff_uid: 'flex', name: 'Flexible Clinician', preferred_shifts: ['night'] }),
      staffMember({
        staff_uid: 'night-cover',
        name: 'Night Cover',
        preferred_shifts: ['night'],
        unavailable_dates: ['2026-05-05'],
      }),
    ];
    const demand = [
      demandFor('2026-05-04', 'night', 1),
      demandFor('2026-05-05', 'morning', 1),
    ];
    const greedy = planRosterGreedy({ demand, staff });
    const solved = planRosterWithLinearProgramming({ demand, staff });
    expect(greedy.filled_slots).toBe(1);
    expect(solved.filled_slots).toBe(2);
    expect(solved.assignments).toEqual(expect.arrayContaining([
      expect.objectContaining({ staff_uid: 'night-cover', date: '2026-05-04', shift_code: 'night' }),
      expect.objectContaining({ staff_uid: 'flex', date: '2026-05-05', shift_code: 'morning' }),
    ]));
  });
});
