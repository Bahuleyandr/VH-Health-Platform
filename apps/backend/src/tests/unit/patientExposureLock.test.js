import { jest } from '@jest/globals';
import {
  assertExposurePatientLocksTx,
  lockDeviceExposurePatientsTx,
  lockPatientExposureTx,
} from '../../services/clinical/patientExposureLock.js';

const tenantId = 'ed000000-0000-4000-8000-000000000001';
const firstPatient = 'ed000000-0000-4000-8000-000000000002';
const secondPatient = 'ed000000-0000-4000-8000-000000000003';
const thirdPatient = 'ed000000-0000-4000-8000-000000000004';

describe('patient exposure admission locks', () => {
  test('locks deduplicated historical subjects and current patient in sorted order before device locking', async () => {
    const subjects = [{ patient_uid: secondPatient }, { patient_uid: firstPatient }, { patient_uid: secondPatient }];
    expect(subjects).toHaveLength(3);
    const query = jest.fn(async sql => sql.includes('SELECT patient_uid') ? subjects : []);
    const tx = { $queryRawUnsafe: query };
    const locked = await lockDeviceExposurePatientsTx(tx, { tenantId, patientUid: secondPatient, deviceId: 7 });
    expect(locked).toHaveLength(2);
    expect(locked).toEqual([firstPatient, secondPatient]);
    const lockCalls = query.mock.calls.filter(([sql]) => sql.includes('pg_advisory_xact_lock'));
    expect(lockCalls).toHaveLength(2);
    expect(lockCalls.map(([, key]) => key)).toEqual([
      `bloodborne-exposure:${tenantId}:${firstPatient}`, `bloodborne-exposure:${tenantId}:${secondPatient}`,
    ]);
    expect(query.mock.calls[0][0]).toContain('reprocessable_device_dialysis_links');
  });

  test('a changed subject population refuses rather than acquiring a late advisory lock', async () => {
    const locked = [firstPatient, secondPatient];
    expect(locked).toHaveLength(2);
    const query = jest.fn(async () => [{ patient_uid: firstPatient }, { patient_uid: thirdPatient }]);
    await expect(assertExposurePatientLocksTx({ $queryRawUnsafe: query }, {
      tenantId, patientUid: secondPatient, deviceId: 7, lockedPatientUids: locked,
    })).rejects.toMatchObject({ code: 'RPD_EXPOSURE_RECONCILIATION_PENDING' });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).not.toContain('pg_advisory_xact_lock');
  });

  test('the writer lock normalizes patient UUID casing and rejects missing identity before SQL', async () => {
    const query = jest.fn(async () => []);
    const tx = { $queryRawUnsafe: query };
    await lockPatientExposureTx(tx, { tenantId, patientUid: firstPatient.toUpperCase() });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][1]).toBe(`bloodborne-exposure:${tenantId}:${firstPatient}`);
    await expect(lockPatientExposureTx(tx, { tenantId, patientUid: null })).rejects.toMatchObject({ code: 'BLOODBORNE_MARKER_INVALID' });
    expect(query).toHaveBeenCalledTimes(1);
  });
});
