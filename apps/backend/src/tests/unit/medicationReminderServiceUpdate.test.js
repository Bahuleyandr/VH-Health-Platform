/**
 * medicationReminderService — updateReminder + getActiveReminders unit tests.
 *
 * Pins the reversible-toggle contract for the patient app's reminder switch:
 * - PUT accepts `is_active` in BOTH directions (deactivate + reactivate);
 * - omitting `end_date` / `notes` preserves the stored values (a partial
 *   update used to null them via bare `end_date = $8` / `notes = $9`);
 * - an explicit `end_date: null` / `notes: null` still clears them;
 * - the list query filters `is_active = true` by default and drops the
 *   filter when `includeInactive: true` is passed (the app's dimmed
 *   re-enable list).
 */

import { jest } from '@jest/globals';

const queryUnsafeMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryUnsafeMock },
}));

const {
  updateReminder,
  getActiveReminders,
} = await import('../../services/patient/medicationReminderService.js');

const PATIENT_UID = '00000000-0000-4000-8000-000000000042';
const ROW = {
  id: 7,
  patient_uid: PATIENT_UID,
  medication_name: 'Amoxicillin',
  is_active: true,
};

beforeEach(() => {
  queryUnsafeMock.mockReset();
});

function lastCall() {
  return queryUnsafeMock.mock.calls[queryUnsafeMock.mock.calls.length - 1];
}

describe('updateReminder', () => {
  it('passes is_active=false through to the UPDATE (toggle off)', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ ...ROW, is_active: false }]);

    const result = await updateReminder(7, PATIENT_UID, { is_active: false });

    const [sql, ...params] = lastCall();
    expect(sql).toContain('is_active = COALESCE($12::boolean, is_active)');
    expect(params[0]).toBe(7);
    expect(params[1]).toBe(PATIENT_UID);
    expect(params[11]).toBe(false);
    expect(result.is_active).toBe(false);
  });

  it('passes is_active=true through to the UPDATE (reactivate)', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ ...ROW, is_active: true }]);

    const result = await updateReminder(7, PATIENT_UID, { is_active: true });

    const [, ...params] = lastCall();
    expect(params[11]).toBe(true);
    expect(result.is_active).toBe(true);
  });

  it('leaves is_active untouched when the field is omitted', async () => {
    queryUnsafeMock.mockResolvedValueOnce([ROW]);

    await updateReminder(7, PATIENT_UID, { dosage: '250mg' });

    const [, ...params] = lastCall();
    expect(params[11]).toBeNull();
  });

  it('rejects a non-boolean is_active with a 400 AppError', async () => {
    await expect(
      updateReminder(7, PATIENT_UID, { is_active: 'yes' }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(queryUnsafeMock).not.toHaveBeenCalled();
  });

  it('preserves stored end_date and notes when both are omitted', async () => {
    queryUnsafeMock.mockResolvedValueOnce([ROW]);

    await updateReminder(7, PATIENT_UID, {
      medication_name: 'Amoxicillin',
      dosage: '500mg',
      frequency: 'twice_daily',
      reminder_times: ['09:00', '21:00'],
      start_date: '2026-08-15',
    });

    const [sql, ...params] = lastCall();
    // Guarded writes: only touched when the has-flag param is true.
    expect(sql).toContain('end_date = CASE WHEN $8::boolean THEN $9::date ELSE end_date END');
    expect(sql).toContain('notes = CASE WHEN $10::boolean THEN $11::text ELSE notes END');
    expect(params[7]).toBe(false); // hasEndDate
    expect(params[8]).toBeNull();
    expect(params[9]).toBe(false); // hasNotes
    expect(params[10]).toBeNull();
  });

  it('still clears end_date and notes when explicitly set to null', async () => {
    queryUnsafeMock.mockResolvedValueOnce([ROW]);

    await updateReminder(7, PATIENT_UID, { end_date: null, notes: null });

    const [, ...params] = lastCall();
    expect(params[7]).toBe(true);
    expect(params[8]).toBeNull();
    expect(params[9]).toBe(true);
    expect(params[10]).toBeNull();
  });

  it('writes provided end_date and notes values', async () => {
    queryUnsafeMock.mockResolvedValueOnce([ROW]);

    await updateReminder(7, PATIENT_UID, {
      end_date: '2026-09-01',
      notes: 'After food',
    });

    const [, ...params] = lastCall();
    expect(params[7]).toBe(true);
    expect(params[8]).toBe('2026-09-01');
    expect(params[9]).toBe(true);
    expect(params[10]).toBe('After food');
  });

  it('throws 404 when the reminder does not exist for this patient', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);

    await expect(
      updateReminder(7, PATIENT_UID, { is_active: true }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('refuses ANC supplement projection ids with a 403', async () => {
    await expect(
      updateReminder(1_000_000_042, PATIENT_UID, { is_active: false }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(queryUnsafeMock).not.toHaveBeenCalled();
  });
});

describe('getActiveReminders', () => {
  it('filters to active reminders by default', async () => {
    queryUnsafeMock.mockResolvedValueOnce([ROW]);

    await getActiveReminders(PATIENT_UID);

    const [sql, uid] = lastCall();
    expect(sql).toContain('AND is_active = true');
    expect(uid).toBe(PATIENT_UID);
  });

  it('drops the is_active filter when includeInactive is true', async () => {
    queryUnsafeMock.mockResolvedValueOnce([ROW, { ...ROW, id: 8, is_active: false }]);

    const rows = await getActiveReminders(PATIENT_UID, { includeInactive: true });

    const [sql] = lastCall();
    expect(sql).not.toContain('AND is_active = true');
    // The ANC projection stays part of the union either way.
    expect(sql).toContain('anc_supplement');
    expect(rows).toHaveLength(2);
  });

  it('treats a non-boolean includeInactive as false', async () => {
    queryUnsafeMock.mockResolvedValueOnce([ROW]);

    await getActiveReminders(PATIENT_UID, { includeInactive: 'true' });

    const [sql] = lastCall();
    expect(sql).toContain('AND is_active = true');
  });
});
