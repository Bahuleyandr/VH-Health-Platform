import { jest } from '@jest/globals';

const labResultsFindManyMock = jest.fn();
const usersFindFirstMock = jest.fn();

const __prismaDefaultMock = {
  lab_results: {
    findMany: labResultsFindManyMock,
  },
  lab_reference_ranges: {},
  users: {
    findFirst: usersFindFirstMock,
  },
};
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
  setTenantTx: async (_tenantId, fn) => fn(__prismaDefaultMock),
  setTenant: async (_tenantId, fn) => fn(__prismaDefaultMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(__prismaDefaultMock),
  pickTenantClient: () => __prismaDefaultMock,
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  recordCanonicalClinicalEvent: jest.fn(),
}));

jest.unstable_mockModule('../../services/emr/inpatientPathwayDomainService.js', () => ({
  linkPendingResultOwnerActionsForGenerationTx: jest.fn(),
  publishInpatientDiagnosticResourceLinkedTx: jest.fn(),
}));

jest.unstable_mockModule('../../services/notification/staffNotificationService.js', () => ({
  sendStaffNotifications: jest.fn(),
}));

jest.unstable_mockModule('../../services/lab/labCriticalAlertService.js', () => ({
  materializeLabCriticalAlertGeneration: jest.fn(),
}));

jest.unstable_mockModule('../../services/lab/labCriticalThresholdService.js', () => ({
  evaluateCriticalThreshold: jest.fn(),
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

  it.each([
    ['same-tenant legacy row', { id: 9, tenant_id: TENANT_ID }],
    ['caller-supplied foreign tenant', {
      id: 9,
      tenant_id: '99999999-9999-4999-8999-999999999999',
    }],
  ])('keeps %s immutable and routes changes to governed policy APIs', async (_label, identity) => {
    await expect(upsertReferenceRange({
      ...identity,
      test_code: 'HGB',
      test_name: 'Hemoglobin',
      unit: 'g/dL',
      range_low: 12,
      range_high: 16,
    }, { tenantId: TENANT_ID })).rejects.toMatchObject({
      statusCode: 409,
      code: 'LAB_REFERENCE_RANGE_LEGACY_READ_ONLY',
    });
  });
});
