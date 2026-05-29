// Unit regression for finding H' D12 (a5b0d216).
//
// `dispatchOrderIntegrations` (the post-create hook for medication
// orders) called `marService.scheduleMedications` with only
// `scheduled_time: order.start_date` — never the frequency or
// duration. marService.expandSchedule HAS the BD/TDS/QID/Nh-hourly
// expansion logic but never received the inputs to fire. An IPD
// "Metformin 500mg BD x 5 days" order created ONE MAR row (the first
// dose) and every subsequent dose was effectively missed because no
// row existed for the nurse to administer or even see as pending.
//
// The fix extracts a pure `buildMarEntryFromOrderDetails(details, {
// startDate })` helper that forwards `frequency` (+ CPOE-template
// alias keys: dosage_frequency / freq / dose_interval) AND
// `duration_days` (+ alias `duration`) from `order.details` into
// the MAR entry. expandSchedule then fans the entry out.
//
// Asserts on the pure helper:
//   * BD x 5 days → frequency=BD, duration_days=5, start_time set,
//     scheduled_time NOT set (so expandSchedule fires).
//   * 8-hourly without explicit duration → frequency forwarded,
//     duration_days absent (expander defaults to 1 day).
//   * No frequency at all → scheduled_time fallback (single-dose /
//     PRN / one-off path unchanged).
//   * dosage_frequency + duration alias keys are picked up.

import {
  buildMarEntriesFromOrderDetails,
  buildMarEntryFromOrderDetails,
} from '../../services/emr/orderEntryService.js';

describe('buildMarEntryFromOrderDetails (H D12)', () => {
  it('forwards frequency + duration_days so BD x 5 days expands to 10 doses', () => {
    const entry = buildMarEntryFromOrderDetails({
      medication_name: 'Metformin', dose: '500mg', route: 'oral',
      frequency: 'BD', duration_days: 5,
    }, { startDate: '2026-05-23T09:00:00Z' });

    expect(entry.frequency).toBe('BD');
    expect(entry.duration_days).toBe(5);
    expect(entry.start_time).toBe('2026-05-23T09:00:00Z');
    // Critical: scheduled_time MUST NOT be set when frequency is
    // present — otherwise marService skips the expansion path.
    expect(entry.scheduled_time).toBeUndefined();
    expect(entry.medication_name).toBe('Metformin');
    expect(entry.dose).toBe('500mg');
    expect(entry.route).toBe('oral');
  });

  it('forwards frequency without duration_days (expander defaults to 1 day)', () => {
    const entry = buildMarEntryFromOrderDetails({
      medication_name: 'Pantoprazole', dose: '40mg', route: 'iv',
      frequency: '8-hourly',
    }, { startDate: '2026-05-23T08:00:00Z' });

    expect(entry.frequency).toBe('8-hourly');
    expect(entry.duration_days).toBeUndefined();
    expect(entry.start_time).toBe('2026-05-23T08:00:00Z');
    expect(entry.scheduled_time).toBeUndefined();
  });

  it('falls back to single-dose scheduled_time when no frequency is supplied (PRN / one-off)', () => {
    const entry = buildMarEntryFromOrderDetails({
      medication_name: 'Ondansetron', dose: '4mg', route: 'iv',
      prn_reason: 'nausea',
    }, { startDate: '2026-05-23T11:00:00Z' });

    expect(entry.scheduled_time).toBe('2026-05-23T11:00:00Z');
    expect(entry.frequency).toBeUndefined();
    expect(entry.duration_days).toBeUndefined();
    expect(entry.notes).toBe('nausea');
  });

  it('accepts dosage_frequency + duration alias keys (CPOE template variants)', () => {
    const entry = buildMarEntryFromOrderDetails({
      medication_name: 'Amoxicillin', dose: '500mg', route: 'oral',
      dosage_frequency: 'TDS', duration: 7,
    }, { startDate: '2026-05-23T08:00:00Z' });
    expect(entry.frequency).toBe('TDS');
    expect(entry.duration_days).toBe(7);
  });

  it('accepts freq + dose_interval alias keys', () => {
    const a = buildMarEntryFromOrderDetails({
      medication_name: 'A', dose: '1', route: 'oral', freq: 'QID',
    });
    expect(a.frequency).toBe('QID');

    const b = buildMarEntryFromOrderDetails({
      medication_name: 'B', dose: '1', route: 'oral', dose_interval: '12-hourly',
    });
    expect(b.frequency).toBe('12-hourly');
  });

  it('rejects bogus duration values (non-positive / non-numeric) → omits duration_days', () => {
    const entry = buildMarEntryFromOrderDetails({
      medication_name: 'X', dose: '1', route: 'oral',
      frequency: 'BD', duration_days: '-5',
    });
    expect(entry.duration_days).toBeUndefined();
  });

  it('uses explicit drug chart dose times for exact MAR rows', () => {
    const entries = buildMarEntriesFromOrderDetails({
      medication_name: 'Pantoprazole',
      dose: '40mg',
      route: 'oral',
      dose_times: ['08:00', '20:00'],
      duration_days: 2,
      food_timing: 'before_food',
    }, { startDate: '2026-05-23T09:30:00Z' });

    expect(entries).toHaveLength(4);
    expect(entries.map((e) => {
      const d = new Date(e.scheduled_time);
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    })).toEqual(['08:00', '20:00', '08:00', '20:00']);
    expect(entries[0].notes).toContain('food_timing:before_food');
    expect(entries[0].frequency).toBeUndefined();
  });
});
