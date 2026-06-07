import { jest } from '@jest/globals';

const updateMock = jest.fn();
const findUniqueMock = jest.fn();
const findManyMock = jest.fn();
const countMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {
    users: {
      findUnique: findUniqueMock,
    },
    investigations: {
      findMany: findManyMock,
      count: countMock,
      findUnique: findUniqueMock,
      update: updateMock,
    },
  },
}));

const {
  getDoctorInvestigations,
  getInvestigations,
  getPatientInvestigations,
  getPendingInvestigations,
  updateStatus,
} = await import('../../services/investigation/investigationService.js');

const LAB_TECH_UID = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-05-15T10:00:00.000Z');

beforeEach(() => {
  jest.useFakeTimers().setSystemTime(NOW);
  findUniqueMock.mockReset();
  findManyMock.mockReset();
  countMock.mockReset();
  updateMock.mockReset();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('investigationService.updateStatus', () => {
  it('stamps collection audit fields when marking an investigation COLLECTED', async () => {
    findUniqueMock.mockResolvedValue({ sample_barcode: null });
    updateMock.mockImplementation(async ({ data }) => ({ id: 20, ...data }));

    const result = await updateStatus(
      20,
      'COLLECTED',
      'Collected urgent IPD sample',
      LAB_TECH_UID
    );

    expect(updateMock).toHaveBeenCalledWith({
      where: { id: 20 },
      data: {
        status: 'COLLECTED',
        notes: 'Collected urgent IPD sample',
        collected_at: NOW,
        collected_by: LAB_TECH_UID,
        collected_notes: 'Collected urgent IPD sample',
        sample_barcode: expect.stringMatching(/^INV-K-/),
        sample_rejected_at: null,
        sample_rejected_by: null,
        sample_rejection_reason: null,
      },
      select: expect.objectContaining({
        id: true,
        status: true,
        collected_at: true,
        collected_by: true,
        collected_notes: true,
        sample_barcode: true,
      }),
    });
    expect(result.collected_at).toEqual(NOW);
    expect(result.collected_by).toBe(LAB_TECH_UID);
    expect(result.sample_barcode).toMatch(/^INV-K-/);
  });
});

describe('investigationService pending worklists', () => {
  it('treats PENDING as a queue alias for REQUESTED and legacy PENDING rows', async () => {
    findManyMock.mockResolvedValueOnce([]);

    const result = await getPendingInvestigations({});

    expect(findManyMock).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        status: { in: ['REQUESTED', 'PENDING'] },
      },
    }));
    expect(result.count).toBe(0);
  });

  it('uses the same PENDING alias for doctor-scoped investigation queues', async () => {
    const doctorUid = '22222222-2222-4222-8222-222222222222';
    findUniqueMock.mockResolvedValueOnce({ uid: doctorUid });
    findManyMock.mockResolvedValueOnce([]);

    const result = await getDoctorInvestigations(99, { status: 'PENDING' });

    expect(findManyMock).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        requested_by: doctorUid,
        status: { in: ['REQUESTED', 'PENDING'] },
      },
    }));
    expect(result.count).toBe(0);
  });

  it('uses the same PENDING alias for patient-scoped investigation queues', async () => {
    findManyMock.mockResolvedValueOnce([]);
    findUniqueMock.mockResolvedValueOnce({ name: 'Patient', birthday: null, gender: null });

    const result = await getPatientInvestigations(
      77,
      { status: 'PENDING', limit: 50 },
      'DOCTOR',
      'doctor-uid'
    );

    expect(findManyMock).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        patient_id: 77,
        status: { in: ['REQUESTED', 'PENDING'] },
      },
    }));
    expect(result.count).toBe(0);
  });
});

describe('investigationService requester provenance', () => {
  it('does not flatten an admin requester as the ordering doctor', async () => {
    const requestedBy = '33333333-3333-4333-8333-333333333333';
    findManyMock.mockResolvedValueOnce([
      {
        id: 44,
        test_name: 'CBC',
        requested_by: requestedBy,
        users_investigations_patient_idTousers: {
          id: 7,
          name: 'Lab Patient',
          phone: '+919000000044',
        },
        users_investigations_requested_byTousers: {
          id: 9,
          uid: requestedBy,
          name: 'Admin Requester',
          role: 'ADMIN',
          phone: '+919000000009',
          doctors: [],
        },
      },
    ]);
    countMock.mockResolvedValueOnce(1);

    const result = await getInvestigations(1, 20, {}, 'ADMIN', 'admin-uid');

    expect(result.investigations[0]).toEqual(expect.objectContaining({
      requested_by_name: 'Admin Requester',
      requested_by_uid: requestedBy,
      requested_by_role: 'ADMIN',
      doctor_name: null,
      doctor_id: null,
      doctor_phone: null,
    }));
  });
});
