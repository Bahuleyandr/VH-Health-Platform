// Unit test for the P2 finding:
//   ANC supplement reminders lack a daily-dose schedule.
//
// A maternity_supplements row stored only `frequency` + `reminder_enabled`,
// so the patient app knew "iron, once daily" but had no concrete time to
// fire a reminder. supplementDoseSchedule() maps the frequency to a daily
// dose schedule (IST times) the app can build reminders from. Pure fn.

import { supplementDoseSchedule } from '../../services/maternity/maternityService.js';

describe('supplementDoseSchedule (ANC supplement daily-dose schedule)', () => {
  it('once_daily → a single morning dose', () => {
    expect(supplementDoseSchedule('once_daily')).toEqual({
      frequency: 'once_daily', times: ['09:00'], timezone: 'Asia/Kolkata',
    });
  });

  it('twice_daily → morning + night', () => {
    expect(supplementDoseSchedule('twice_daily').times).toEqual(['09:00', '21:00']);
  });

  it('thrice_daily → three spaced doses', () => {
    expect(supplementDoseSchedule('thrice_daily').times).toEqual(['08:00', '14:00', '20:00']);
  });

  it('as_needed → no fixed schedule', () => {
    expect(supplementDoseSchedule('as_needed').times).toEqual([]);
  });

  it('weekly → a single dose on the dosing day', () => {
    expect(supplementDoseSchedule('weekly').times).toEqual(['09:00']);
  });

  it('falls back to once-daily for unknown/empty frequency', () => {
    expect(supplementDoseSchedule(undefined).times).toEqual(['09:00']);
    expect(supplementDoseSchedule('garbage').times).toEqual(['09:00']);
    expect(supplementDoseSchedule(null).frequency).toBe('once_daily');
  });

  it('always carries an IST timezone so reminder times are unambiguous', () => {
    expect(supplementDoseSchedule('twice_daily').timezone).toBe('Asia/Kolkata');
  });
});
