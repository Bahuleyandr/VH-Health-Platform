import { jest } from '@jest/globals';

const queryUnsafeMock = jest.fn();
const __prismaDefaultMock = { $queryRawUnsafe: queryUnsafeMock };
const setTenantTxMock = jest.fn(async (_tenantId, fn) => fn(__prismaDefaultMock));
const setTenantMock = jest.fn(async (_tenantId, fn) => fn(__prismaDefaultMock));

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
  setTenantTx: setTenantTxMock,
  setTenant: setTenantMock,
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(__prismaDefaultMock),
  pickTenantClient: () => __prismaDefaultMock,
}));

const {
  assertActiveTriageScale,
  assertMlcReadyForCertification,
  recordTraumaSurvey,
  upsertMlcCompletenessReview,
} = await import('../../services/ed/edTraumaMlcService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const USER = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  queryUnsafeMock.mockReset();
  setTenantTxMock.mockClear();
  setTenantMock.mockClear();
});

describe('assertActiveTriageScale', () => {
  it('fails closed when the tenant has not activated an ED triage policy', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);

    await expect(assertActiveTriageScale({
      tenantId: TENANT,
      triagePriority: 'esi_2',
    })).rejects.toMatchObject({
      statusCode: 400,
      code: 'ED_TRIAGE_POLICY_REQUIRED',
    });
    expect(queryUnsafeMock.mock.calls[0][0]).toMatch(/FROM tenant_ed_policies/);
  });

  it('rejects a triage priority from a non-canonical tenant scale', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ canonical_triage_scale: 'ctas' }]);

    await expect(assertActiveTriageScale({
      tenantId: TENANT,
      triagePriority: 'esi_2',
    })).rejects.toMatchObject({
      statusCode: 400,
      code: 'ED_TRIAGE_SCALE_MISMATCH',
    });
  });

  it('accepts the tenant canonical scale for human triage', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ canonical_triage_scale: 'ats' }]);

    await expect(assertActiveTriageScale({
      tenantId: TENANT,
      assessmentKind: 'australian',
    })).resolves.toBe('ats');
  });
});

describe('recordTraumaSurvey', () => {
  it('does not complete a trauma survey until ABCDE, reviewer, and citations are present', async () => {
    await expect(recordTraumaSurvey({
      tenantId: TENANT,
      surveyKind: 'primary',
      airway: 'patent',
      completionStatus: 'complete',
    })).rejects.toMatchObject({
      statusCode: 400,
      code: 'TRAUMA_SURVEY_INCOMPLETE',
      details: {
        missing: expect.arrayContaining(['breathing', 'source_citations', 'responsible_clinician_uid']),
      },
    });
    expect(setTenantTxMock).not.toHaveBeenCalled();
  });
});

describe('MLC completeness gates', () => {
  it('does not let assistant prefill complete an MLC review without human review', async () => {
    await expect(upsertMlcCompletenessReview({
      tenantId: TENANT,
      mlcRecordId: 7,
      allegedHistory: 'RTA history documented by clinician',
      injuryDescription: 'Forearm laceration and chest wall bruising',
      injuryDiagramComplete: true,
      policeNotificationComplete: true,
      certificateSignerUid: USER,
      chainOfCustodyComplete: true,
      assistantPrefillOutputId: 44,
      completenessStatus: 'complete',
    })).rejects.toMatchObject({
      statusCode: 400,
      code: 'MLC_COMPLETENESS_INCOMPLETE',
    });
    expect(setTenantTxMock).not.toHaveBeenCalled();
  });

  it('blocks certification until the completeness review is complete and unblocked', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 12,
      completeness_status: 'incomplete',
      certification_blocked: true,
      missing_required_fields: ['police_notification'],
    }]);

    await expect(assertMlcReadyForCertification({
      tenantId: TENANT,
      mlcRecordId: 7,
    })).rejects.toMatchObject({
      statusCode: 400,
      code: 'MLC_CERTIFICATION_BLOCKED',
      details: { missing: ['police_notification'] },
    });
  });
});
