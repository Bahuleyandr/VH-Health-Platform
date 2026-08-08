import { jest } from '@jest/globals';

import { resolveMergedPatientUidSet } from '../../services/clinical/mergedPatientReadUnion.js';

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT = '11111111-1111-4111-8111-111111111111';

describe('mergedPatientReadUnion', () => {
  it('returns the survivor and merged-away uid family', async () => {
    const merged = '22222222-2222-4222-8222-222222222222';
    const db = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ uid: PATIENT }, { uid: merged }]),
    };

    await expect(resolveMergedPatientUidSet(db, {
      tenantId: TENANT,
      patientUid: PATIENT,
    })).resolves.toEqual([PATIENT, merged]);
  });

  it('fails closed when the uid-family lookup fails', async () => {
    const failure = new Error('database unavailable');
    const db = { $queryRawUnsafe: jest.fn().mockRejectedValue(failure) };

    await expect(resolveMergedPatientUidSet(db, {
      tenantId: TENANT,
      patientUid: PATIENT,
    })).rejects.toBe(failure);
  });

  it('requires tenant context and a usable database client', async () => {
    await expect(resolveMergedPatientUidSet({}, {
      tenantId: null,
      patientUid: PATIENT,
    })).rejects.toMatchObject({
      statusCode: 400,
      code: 'MERGED_PATIENT_TENANT_REQUIRED',
    });
    await expect(resolveMergedPatientUidSet({}, {
      tenantId: TENANT,
      patientUid: PATIENT,
    })).rejects.toMatchObject({
      statusCode: 500,
      code: 'MERGED_PATIENT_READER_UNAVAILABLE',
    });
  });
});
