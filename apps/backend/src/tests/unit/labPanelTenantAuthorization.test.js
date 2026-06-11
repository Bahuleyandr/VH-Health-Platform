import { jest } from '@jest/globals';

const labResultsFindManyMock = jest.fn();
const referenceRangeUpdateManyMock = jest.fn();
const referenceRangeFindFirstMock = jest.fn();
const referenceRangeCreateMock = jest.fn();
const usersFindFirstMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {
    lab_results: {
      findMany: labResultsFindManyMock,
    },
    lab_reference_ranges: {
      updateMany: referenceRangeUpdateManyMock,
      findFirst: referenceRangeFindFirstMock,
      create: referenceRangeCreateMock,
    },
    users: {
      findFirst: usersFindFirstMock,
    },
  },
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

const {
  getLabPanel,
  listPatientPanels,
  getAnalyteTrend,
  upsertReferenceRange,
} = await import('../../services/lab/labPanelService.js');

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = '22222222-2222-4222-8222-222222222222';
const PANEL_ID = '33333333-3333-4333-8333-333333333333';

describe('labPanelService tenant predicates', () => {
  beforeEach(() => {
    labResultsFindManyMock.mockReset();
    referenceRangeUpdateManyMock.mockReset();
    referenceRangeFindFirstMock.mockReset();
    referenceRangeCreateMock.mockReset();
    usersFindFirstMock.mockReset();
  });

  it('fetches a panel by panel_id only inside the caller tenant', async () => {
    labResultsFindManyMock.mockResolvedValueOnce([]);

    await getLabPanel(PANEL_ID, { tenantId: TENANT_ID });

    expect(labResultsFindManyMock).toHaveBeenCalledWith(expect.objectContaining({
      where: { panel_id: PANEL_ID, tenant_id: TENANT_ID },
    }));
  });

  it('lists patient panels only inside the caller tenant', async () => {
    labResultsFindManyMock.mockResolvedValueOnce([]);

    await listPatientPanels(PATIENT_UID, { tenantId: TENANT_ID, panelCode: 'CBC', limit: 10 });

    expect(labResultsFindManyMock).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        tenant_id: TENANT_ID,
        patient_uid: PATIENT_UID,
        panel_code: 'CBC',
      }),
    }));
  });

  it('reads analyte trends only inside the caller tenant', async () => {
    labResultsFindManyMock.mockResolvedValueOnce([]);

    await getAnalyteTrend(PATIENT_UID, 'HGB', { tenantId: TENANT_ID });

    expect(labResultsFindManyMock).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        tenant_id: TENANT_ID,
        patient_uid: PATIENT_UID,
        test_code: 'HGB',
      }),
    }));
  });

  it('updates reference ranges by id and tenant together', async () => {
    referenceRangeUpdateManyMock.mockResolvedValueOnce({ count: 1 });
    referenceRangeFindFirstMock.mockResolvedValueOnce({ id: 9, tenant_id: TENANT_ID });

    await upsertReferenceRange({
      id: 9,
      tenant_id: '99999999-9999-4999-8999-999999999999',
      test_code: 'HGB',
      test_name: 'Hemoglobin',
      unit: 'g/dL',
      range_low: 12,
      range_high: 16,
    }, { tenantId: TENANT_ID });

    expect(referenceRangeUpdateManyMock).toHaveBeenCalledWith({
      where: { id: 9, tenant_id: TENANT_ID },
      data: expect.not.objectContaining({ tenant_id: expect.anything() }),
    });
    expect(referenceRangeFindFirstMock).toHaveBeenCalledWith({
      where: { id: 9, tenant_id: TENANT_ID },
    });
  });

  it('rejects reference-range updates when id belongs to another tenant', async () => {
    referenceRangeUpdateManyMock.mockResolvedValueOnce({ count: 0 });

    await expect(upsertReferenceRange({
      id: 9,
      test_code: 'HGB',
      test_name: 'Hemoglobin',
      unit: 'g/dL',
    }, { tenantId: TENANT_ID })).rejects.toMatchObject({ statusCode: 404 });
  });
});
