import { jest } from '@jest/globals';

const queryRawUnsafeMock = jest.fn();
const recordClinicalAuditEventMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {
    $queryRawUnsafe: queryRawUnsafeMock,
  },
  isTenantTransactionClient: () => false,
  setTenantTx: jest.fn(),
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  cancelWorkflowSla: jest.fn(),
  currentCanonicalTransactionRevision: jest.fn(),
  recordCanonicalClinicalEvent: jest.fn(),
  recordClinicalAuditEvent: recordClinicalAuditEventMock,
}));

jest.unstable_mockModule('../../services/events/eventOutboxService.js', () => ({
  publishEvent: jest.fn(),
}));

jest.unstable_mockModule('../../services/workflow/workflowHumanOwnerService.js', () => ({
  resolveCurrentHumanActorTx: jest.fn(),
}));

const { resolvePortalPatient } = await import('../../services/portal/portalAccessService.js');

describe('portal proxy consent-trail ordering', () => {
  beforeEach(() => {
    queryRawUnsafeMock.mockReset();
    recordClinicalAuditEventMock.mockReset();
  });

  it('does not return proxy PHI authorization before its audit attempt finishes', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([{ id: 17, scope: ['results'] }]);

    let finishAudit;
    recordClinicalAuditEventMock.mockReturnValueOnce(new Promise((resolve) => {
      finishAudit = resolve;
    }));

    let settled = false;
    const access = resolvePortalPatient({
      requesterUid: '11111111-1111-4111-8111-111111111111',
      forPatientUid: '22222222-2222-4222-8222-222222222222',
      scope: 'results',
    }).then((result) => {
      settled = true;
      return result;
    });

    try {
      await new Promise((resolve) => setImmediate(resolve));
      expect(recordClinicalAuditEventMock).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);
    } finally {
      finishAudit({ id: 'audit-17' });
    }

    await expect(access).resolves.toEqual({
      patientUid: '22222222-2222-4222-8222-222222222222',
      proxy: true,
      grantId: 17,
    });
  });

  it('still permits an authorized proxy read when the recorder reports audit degradation', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([{ id: 18, scope: ['results'] }]);
    recordClinicalAuditEventMock.mockResolvedValueOnce(null);

    await expect(resolvePortalPatient({
      requesterUid: '11111111-1111-4111-8111-111111111111',
      forPatientUid: '22222222-2222-4222-8222-222222222222',
      scope: 'results',
    })).resolves.toEqual({
      patientUid: '22222222-2222-4222-8222-222222222222',
      proxy: true,
      grantId: 18,
    });
  });
});
