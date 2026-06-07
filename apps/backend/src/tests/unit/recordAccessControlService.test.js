import { checkDataAccess } from '../../services/record/accessControlService.js';

describe('record access control', () => {
  it('treats string privacy levels as canonical levels for staff access', () => {
    expect(
      checkDataAccess('DOCTOR', {}, { privacy_level: 'RESTRICTED' }),
    ).toBe(true);
    expect(
      checkDataAccess('DOCTOR', {}, { privacy_level: 'CONFIDENTIAL' }),
    ).toBe(true);
    expect(
      checkDataAccess('DOCTOR', {}, { privacy_level: 'HIGHLY_CONFIDENTIAL' }),
    ).toBe(false);
  });

  it('allows patients to read their own UID-scoped records', () => {
    expect(
      checkDataAccess(
        'PATIENT',
        { uid: '4fd0f5a4-42da-4994-a85b-73ce79699147' },
        {
          patient_uid: '4fd0f5a4-42da-4994-a85b-73ce79699147',
          privacy_level: 'RESTRICTED',
        },
      ),
    ).toBe(true);
  });
});
