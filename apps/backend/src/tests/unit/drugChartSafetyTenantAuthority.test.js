import { jest } from '@jest/globals';

const queryRawUnsafeMock = jest.fn();
const validatePrescriptionSafetyMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryRawUnsafeMock },
}));

jest.unstable_mockModule('../../utils/clinical/prescriptionSafetyCheck.js', () => ({
  validatePrescriptionSafety: validatePrescriptionSafetyMock,
  checkAntithromboticInteractions: jest.fn(() => ({ warnings: [], blockers: [] })),
}));

const { getAdmissionDrugChart } = await import(
  '../../services/clinical/drugChartService.js'
);

const TENANT = '40000000-0000-4000-8000-000000000001';
const PATIENT_UID = '10000000-0000-4000-8000-000000000001';
const ENCOUNTER = '20000000-0000-4000-8000-000000000001';

function arrangeDrugChartRows() {
  queryRawUnsafeMock
    .mockResolvedValueOnce([{
      id: 73,
      patient_uid: PATIENT_UID,
      patient_id: 51,
      encounter_id: ENCOUNTER,
      tenant_id: TENANT,
      status: 'admitted',
      admitted_at: '2026-08-30T08:00:00.000Z',
      discharged_at: null,
      ward_id: 5,
      ward_name: 'Ward A',
    }])
    .mockResolvedValueOnce([{
      id: 91,
      order_number: 'ORD-91',
      patient_uid: PATIENT_UID,
      encounter_id: ENCOUNTER,
      tenant_id: TENANT,
      order_type: 'medication',
      status: 'ordered',
      details: {
        catalog_id: '41',
        medication_name: 'Paracetamol',
        dose: '500 mg',
      },
    }])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([{ id: 41, name: 'Paracetamol 500 mg tablet' }])
    .mockResolvedValueOnce([]);
}

beforeEach(() => {
  queryRawUnsafeMock.mockReset();
  validatePrescriptionSafetyMock.mockReset().mockResolvedValue({
    safe: true,
    warnings: [],
    blockers: [],
  });
});

describe('drug chart medication safety authority', () => {
  it('forwards caller tenant, current-order exclusion, and canonical catalog identity', async () => {
    arrangeDrugChartRows();

    await getAdmissionDrugChart({ admissionId: 73, tenantId: TENANT });

    expect(validatePrescriptionSafetyMock).toHaveBeenCalledWith(
      51,
      [expect.objectContaining({
        catalog_id: 41,
        name: 'Paracetamol',
        medication_name: 'Paracetamol',
      })],
      { tenantId: TENANT, excludeClinicalOrderId: 91 },
    );
  });

  it('does not derive missing tenant authority from the admission row', async () => {
    arrangeDrugChartRows();
    validatePrescriptionSafetyMock.mockResolvedValueOnce({
      safe: false,
      warnings: [],
      blockers: [{ type: 'ACTIVE_THERAPY_CONTEXT_UNAVAILABLE' }],
    });

    const result = await getAdmissionDrugChart({ admissionId: 73, tenantId: null });

    expect(validatePrescriptionSafetyMock).toHaveBeenCalledWith(
      51,
      [expect.objectContaining({ catalog_id: 41 })],
      { tenantId: null, excludeClinicalOrderId: 91 },
    );
    expect(result.medication_orders[0].safety.blockers).toEqual([
      expect.objectContaining({ type: 'ACTIVE_THERAPY_CONTEXT_UNAVAILABLE' }),
    ]);
  });
});
