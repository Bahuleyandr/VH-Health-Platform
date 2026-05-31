import { jest } from '@jest/globals';
import { resolveDoctorRef } from '../../services/doctor/doctorRefService.js';

const TENANT = '00000000-0000-4000-8000-000000000001';

describe('resolveDoctorRef tenant scoping', () => {
  it('threads tenant_id into doctor resolution queries', async () => {
    const db = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([{
        input_user: { id: 42, role: 'DOCTOR' },
        direct_doctor: {
          id: 42,
          uid: '11111111-1111-4111-8111-111111111111',
          name: 'Dr Tenant Scoped',
          role: 'DOCTOR',
          doctor_row_id: 7,
          department: 'OPD',
        },
        profile_doctor: null,
      }]),
    };

    const doctor = await resolveDoctorRef(db, 42, { tenantId: TENANT });

    expect(db.$queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('u.tenant_id = $2::uuid'),
      42,
      TENANT,
    );
    expect(doctor).toEqual(expect.objectContaining({
      id: 42,
      uid: '11111111-1111-4111-8111-111111111111',
      department: 'OPD',
    }));
  });
});
