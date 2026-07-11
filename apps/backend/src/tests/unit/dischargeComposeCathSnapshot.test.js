import { jest } from '@jest/globals';

const setTenantTxMock = jest.fn();
const recordClinicalAuditEventMock = jest.fn();
const materializeDischargeComposeSectionsMock = jest.fn();
const publishEventMock = jest.fn();
const txMock = { $queryRawUnsafe: jest.fn() };

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {},
  setTenantTx: setTenantTxMock,
}));
jest.unstable_mockModule('../../services/events/eventOutboxService.js', () => ({
  publishEvent: publishEventMock,
}));
jest.unstable_mockModule('../../services/discharge/dischargeService.js', () => ({
  materializeDischargeComposeSections: materializeDischargeComposeSectionsMock,
}));
jest.unstable_mockModule('../../services/ai/clinicalAiWorkflowService.js', () => ({
  ADMISSION_MODULES: new Set(),
  getAdmissionAiDraftGraph: jest.fn(),
  requireEnabledModule: jest.fn(),
  resolveTenantId: jest.fn(({ tenantId }) => tenantId),
}));
jest.unstable_mockModule('../../services/ai/clinicalAiModuleService.js', () => ({
  getClinicalAiModule: jest.fn(),
}));
jest.unstable_mockModule('../../services/ai/workflowCheckpointStore.js', () => ({
  getDefaultCheckpointStore: jest.fn(() => ({})),
}));
jest.unstable_mockModule('../../services/radiology/pacsService.js', () => ({
  buildViewerUrl: jest.fn((studyUid) => `https://pacs.example.test/viewer?StudyInstanceUIDs=${studyUid}`),
  getPacsConfig: jest.fn(() => ({
    enabled: true,
    viewer_url: 'https://pacs.example.test/viewer',
  })),
}));
jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  recordClinicalAuditEvent: recordClinicalAuditEventMock,
  recordCanonicalClinicalEvent: jest.fn(),
}));

const { __testing__ } = await import('../../services/ai/dischargeComposeService.js');
const { COMPOSE_GRAPH_NODES, loadCathReportingSnapshot } = __testing__;

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const SIGNED_REPORT = {
  id: 91,
  tenant_id: TENANT_ID,
  patient_uid: '22222222-2222-4222-8222-222222222222',
  encounter_id: '33333333-3333-4333-8333-333333333333',
  case_id: 41,
  procedure_log_id: 51,
  report_type: 'ptca',
  status: 'signed',
  narrative_sections: [{ key: 'findings', value: 'Signed finding.' }],
  coded_fields: { vessels_treated: ['LAD'] },
  signed_by: '44444444-4444-4444-8444-444444444444',
  signed_at: '2026-07-11T09:45:00.000Z',
  viewer_study_accession: '1.2.840.113619.2.55.3.604688123.1',
  procedure_ended_at: '2026-07-11T09:00:00.000Z',
  operators: [{ name: 'Dr Test Operator' }],
};

function arrangeSnapshot({ auditResults = [{ id: 1 }, { id: 2 }] } = {}) {
  txMock.$queryRawUnsafe
    .mockResolvedValueOnce([SIGNED_REPORT])
    .mockResolvedValueOnce([]);
  setTenantTxMock.mockImplementation(async (_tenantId, callback) => callback(txMock));
  for (const result of auditResults) {
    recordClinicalAuditEventMock.mockResolvedValueOnce(result);
  }
}

beforeEach(() => {
  jest.clearAllMocks();
});

test('captures signed and pending rows in one tenant-scoped repeatable-read snapshot', async () => {
  arrangeSnapshot();

  const snapshot = await loadCathReportingSnapshot({
    admissionId: 501,
    tenantId: TENANT_ID,
    requestedBy: '55555555-5555-4555-8555-555555555555',
    requestContext: {
      request_id: 'req-cath-compose',
      requested_by_role: 'RECEPTIONIST',
    },
    runId: 701,
  });

  expect(setTenantTxMock).toHaveBeenCalledWith(
    TENANT_ID,
    expect.any(Function),
    { isolationLevel: 'RepeatableRead' },
  );
  expect(txMock.$queryRawUnsafe).toHaveBeenCalledTimes(2);
  expect(snapshot.section.structured_data.reports[0]).toMatchObject({
    report_id: 91,
    viewer_study_accession: null,
    viewer_url: null,
    viewer_status: 'access_denied',
  });
  expect(recordClinicalAuditEventMock).toHaveBeenNthCalledWith(
    1,
    expect.objectContaining({
      action: 'cath_lab.report_viewed',
      actionStatus: 'success',
      resourceId: '91',
    }),
  );
  expect(recordClinicalAuditEventMock).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({
      action: 'cath_lab.viewer_link_resolved',
      actionStatus: 'denied',
      resourceId: '91',
      metadata: expect.objectContaining({ viewer_access_authorized: false }),
    }),
  );
});

test.each([
  [[null], 'CATH_REPORT_VIEW_AUDIT_FAILED'],
  [[{ id: 1 }, null], 'CATH_VIEWER_AUDIT_FAILED'],
])('fails closed when required compose audit evidence is missing', async (auditResults, code) => {
  arrangeSnapshot({ auditResults });

  await expect(loadCathReportingSnapshot({
    admissionId: 501,
    tenantId: TENANT_ID,
    requestedBy: '55555555-5555-4555-8555-555555555555',
    requestContext: {
      request_id: 'req-cath-compose',
      requested_by_role: 'CARDIOLOGIST',
    },
    runId: 701,
  })).rejects.toMatchObject({ code });
});

test('materializes the cath snapshot into an existing builder before publishing compose', async () => {
  materializeDischargeComposeSectionsMock.mockResolvedValue({
    materialized: true,
    discharge_summary_id: 70,
  });
  publishEventMock.mockResolvedValue({ id: 80 });
  const state = {
    tenantId: TENANT_ID,
    admissionId: 501,
    patientUid: SIGNED_REPORT.patient_uid,
    requestedBy: '55555555-5555-4555-8555-555555555555',
    activeChildren: ['discharge_readiness'],
    overallSafetyBand: 'ok',
    composeGeneration: { id: 701 },
    composeDraft: {
      child_generation_ids: [301],
      builder_sections: [{ section_key: 'cath_lab_procedures' }],
      cath_reporting_source_snapshot: { post_issue_sync: false },
    },
  };

  await expect(COMPOSE_GRAPH_NODES.publish_compose_event(state)).resolves.toEqual({});

  expect(materializeDischargeComposeSectionsMock).toHaveBeenCalledWith({
    tenantId: TENANT_ID,
    admissionId: 501,
    composeResult: state.composeDraft,
    actorUid: state.requestedBy,
  });
  expect(materializeDischargeComposeSectionsMock.mock.invocationCallOrder[0])
    .toBeLessThan(publishEventMock.mock.invocationCallOrder[0]);
});
