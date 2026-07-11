import { jest } from '@jest/globals';

const queryUnsafeMock = jest.fn();
const dbMock = { $queryRawUnsafe: queryUnsafeMock };
const setTenantMock = jest.fn(async (_tenantId, fn) => fn(dbMock));
const setTenantTxMock = jest.fn(async (_tenantId, fn) => fn(dbMock));
const recordCanonicalClinicalEventMock = jest.fn(async () => ({
  timeline: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
  audit: { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
}));
const recordClinicalAuditEventMock = jest.fn(async () => ({
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
}));
const assertPrivilegeForGateMock = jest.fn(async () => ({
  enforced: true,
  allowed: true,
  privilege_key: 'cath_report_signing',
}));
const getPacsConfigMock = jest.fn(() => ({
  enabled: false,
  viewer_url: null,
  dicomweb_url: null,
  aet: 'VHHEALTH',
}));
const buildViewerUrlMock = jest.fn((uid) => `https://viewer.example/viewer?StudyInstanceUIDs=${uid}`);

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: dbMock,
  setTenant: setTenantMock,
  setTenantTx: setTenantTxMock,
}));

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  requireTenantId: (tenantId) => tenantId || '00000000-0000-4000-8000-000000000001',
}));

jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  recordCanonicalClinicalEvent: recordCanonicalClinicalEventMock,
  recordClinicalAuditEvent: recordClinicalAuditEventMock,
}));

jest.unstable_mockModule('../../services/staff/credentialingService.js', () => ({
  assertPrivilegeForGate: assertPrivilegeForGateMock,
}));

jest.unstable_mockModule('../../services/radiology/pacsService.js', () => ({
  buildViewerUrl: buildViewerUrlMock,
  getPacsConfig: getPacsConfigMock,
}));

const {
  addReportAddendum,
  createReport,
  listReports,
  resolveCaseViewerLink,
  signReport,
  supersedeReportTemplate,
  updateReport,
  validateReportTransition,
} = await import('../../services/clinical/cathReportService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT = '11111111-1111-4111-8111-111111111111';
const ENCOUNTER = '22222222-2222-4222-8222-222222222222';
const ACTOR = '33333333-3333-4333-8333-333333333333';

const context = (actorRole = 'DOCTOR', requestId = 'request-1') => ({
  actorUid: ACTOR,
  actorRole,
  requestId,
  ipAddress: '127.0.0.1',
  userAgent: 'jest',
});

function cathCase() {
  return {
    id: 42,
    tenant_id: TENANT,
    patient_uid: PATIENT,
    encounter_id: ENCOUNTER,
    requested_procedure: 'PTCA',
    status: 'completed',
    actual_end_at: new Date('2026-07-11T09:00:00.000Z'),
  };
}

function template(version = 1) {
  return {
    id: version === 1 ? 9 : 10,
    tenant_id: TENANT,
    template_code: 'CATH_PTCA_STARTER',
    name: 'PTCA starter report',
    report_type: 'ptca',
    sections: [{ key: 'findings', title: 'Findings', order: 1 }],
    coded_fields_schema: { type: 'object' },
    version,
    is_active: true,
    supersedes_template_id: version === 1 ? null : 9,
    metadata: { starter: true },
  };
}

function report(status = 'draft', id = 51) {
  return {
    id,
    tenant_id: TENANT,
    case_id: 42,
    procedure_log_id: 7,
    patient_uid: PATIENT,
    encounter_id: ENCOUNTER,
    report_type: 'ptca',
    template_id: 9,
    template_version: 1,
    narrative_sections: [{ key: 'findings', title: 'Findings', text: 'Patent vessel.' }],
    coded_fields: { vessels_treated: ['LAD'] },
    findings_summary: 'Patent vessel.',
    status,
    viewer_study_accession: null,
    preliminary_by: status === 'draft' ? null : ACTOR,
    preliminary_at: status === 'draft' ? null : new Date('2026-07-11T09:30:00.000Z'),
    signed_by: status === 'signed' ? ACTOR : null,
    signed_at: status === 'signed' ? new Date('2026-07-11T10:00:00.000Z') : null,
    created_by: ACTOR,
    updated_by: ACTOR,
    created_at: new Date('2026-07-11T09:10:00.000Z'),
    updated_at: new Date('2026-07-11T10:00:00.000Z'),
    metadata: {},
  };
}

beforeEach(() => {
  queryUnsafeMock.mockReset();
  setTenantMock.mockClear();
  setTenantTxMock.mockClear();
  recordCanonicalClinicalEventMock.mockClear();
  recordClinicalAuditEventMock.mockClear();
  assertPrivilegeForGateMock.mockReset();
  assertPrivilegeForGateMock.mockResolvedValue({
    enforced: true,
    allowed: true,
    privilege_key: 'cath_report_signing',
  });
  getPacsConfigMock.mockReset();
  getPacsConfigMock.mockReturnValue({
    enabled: false,
    viewer_url: null,
    dicomweb_url: null,
    aet: 'VHHEALTH',
  });
  buildViewerUrlMock.mockClear();
});

describe('cathReportService lifecycle and templates', () => {
  test('allows only draft to preliminary to signed', () => {
    expect(validateReportTransition('draft', 'preliminary')).toBe('preliminary');
    expect(validateReportTransition('preliminary', 'signed')).toBe('signed');
    expect(() => validateReportTransition('draft', 'signed')).toThrow('Invalid state transition');
    expect(() => validateReportTransition('signed', 'preliminary')).toThrow('Invalid state transition');
  });

  test('supersedes the active template with the next immutable version', async () => {
    queryUnsafeMock
      .mockResolvedValueOnce([template(1)])
      .mockResolvedValueOnce([{ next_version: 2 }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([template(2)]);

    const result = await supersedeReportTemplate(9, {
      tenantId: TENANT,
      name: 'PTCA report v2',
      sections: [{ key: 'findings', title: 'Findings', order: 1 }],
    }, context('CATH_LAB_INCHARGE'));

    expect(result).toMatchObject({ version: 2, supersedes_template_id: 9 });
    expect(queryUnsafeMock.mock.calls[2][0]).toContain('is_active = FALSE');
    expect(queryUnsafeMock.mock.calls[3][0]).toContain('INSERT INTO cath_report_templates');
  });

  test('lets a receptionist create a draft from a matching active template', async () => {
    const draft = report('draft');
    queryUnsafeMock
      .mockResolvedValueOnce([cathCase()])
      .mockResolvedValueOnce([template(1)])
      .mockResolvedValueOnce([{ id: 7, case_id: 42, tenant_id: TENANT }])
      .mockResolvedValueOnce([draft]);

    const result = await createReport(42, {
      tenantId: TENANT,
      template_id: 9,
      procedure_log_id: 7,
      report_type: 'ptca',
      narrative_sections: draft.narrative_sections,
      coded_fields: draft.coded_fields,
    }, context('RECEPTIONIST'));

    expect(result).toMatchObject({ status: 'draft', template_version: 1 });
    expect(recordClinicalAuditEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'cath_lab.report_created' }),
      { db: dbMock },
    );
  });

  test('rejects all in-place edits after sign-off', async () => {
    queryUnsafeMock.mockResolvedValueOnce([report('signed')]);
    await expect(updateReport(51, {
      tenantId: TENANT,
      findings_summary: 'Changed after sign-off',
    }, context('DOCTOR'))).rejects.toMatchObject({ code: 'CATH_REPORT_SIGNED_IMMUTABLE' });
    expect(queryUnsafeMock).toHaveBeenCalledTimes(1);
  });
});

describe('cathReportService signing and addenda', () => {
  test('always invokes the fail-closed cath_report_signing privilege gate', async () => {
    const gateError = Object.assign(new Error('missing privilege'), {
      statusCode: 403,
      code: 'CLINICAL_PRIVILEGE_REQUIRED',
    });
    assertPrivilegeForGateMock.mockRejectedValueOnce(gateError);

    await expect(signReport(51, { tenantId: TENANT }, context('DOCTOR')))
      .rejects.toMatchObject({ code: 'CLINICAL_PRIVILEGE_REQUIRED' });
    expect(assertPrivilegeForGateMock).toHaveBeenCalledWith({
      staffUid: ACTOR,
      privilegeName: 'cath_report_signing',
      tenantId: TENANT,
      gate: 'cath_report_signing',
      enabled: true,
    });
    expect(setTenantTxMock).not.toHaveBeenCalled();
  });

  test('signs a preliminary report with canonical timeline and audit in the same tenant transaction', async () => {
    queryUnsafeMock
      .mockResolvedValueOnce([report('preliminary')])
      .mockResolvedValueOnce([report('signed')]);

    const result = await signReport(51, { tenantId: TENANT }, context('CONSULTANT'));

    expect(result.status).toBe('signed');
    expect(recordCanonicalClinicalEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'cath_lab.report_signed',
        sourceTable: 'cath_procedure_reports',
        sourceId: '51',
      }),
      { db: dbMock },
    );
  });

  test('fails the signing transaction when either canonical event is missing', async () => {
    recordCanonicalClinicalEventMock.mockResolvedValueOnce({ timeline: null, audit: null });
    queryUnsafeMock
      .mockResolvedValueOnce([report('preliminary')])
      .mockResolvedValueOnce([report('signed')]);

    await expect(signReport(51, { tenantId: TENANT }, context('DOCTOR')))
      .rejects.toMatchObject({ code: 'CATH_REPORT_CANONICAL_EVENT_REQUIRED' });
  });

  test('appends a correction row without mutating the signed report', async () => {
    const addendum = {
      id: 91,
      tenant_id: TENANT,
      report_id: 51,
      case_id: 42,
      patient_uid: PATIENT,
      encounter_id: ENCOUNTER,
      author_uid: ACTOR,
      reason: 'Clarification',
      narrative: 'Clarified device model.',
      created_at: new Date('2026-07-11T11:00:00.000Z'),
      metadata: {},
    };
    queryUnsafeMock
      .mockResolvedValueOnce([report('signed')])
      .mockResolvedValueOnce([addendum]);

    const result = await addReportAddendum(51, {
      tenantId: TENANT,
      reason: 'Clarification',
      narrative: 'Clarified device model.',
    }, context('DOCTOR'));

    expect(result).toMatchObject({ id: 91, report_id: 51 });
    expect(queryUnsafeMock.mock.calls[1][0]).toContain('INSERT INTO cath_report_addenda');
    expect(queryUnsafeMock.mock.calls.some(([sql]) => /UPDATE cath_procedure_reports/.test(sql))).toBe(false);
    expect(recordCanonicalClinicalEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'cath_lab.report_addendum' }),
      { db: dbMock },
    );
  });
});

describe('cathReportService audited reads and viewer links', () => {
  test('fails a draft edit when its required clinical audit row is missing', async () => {
    recordClinicalAuditEventMock.mockResolvedValueOnce(null);
    queryUnsafeMock
      .mockResolvedValueOnce([report('draft')])
      .mockResolvedValueOnce([{ ...report('draft'), findings_summary: 'Updated' }]);

    await expect(updateReport(51, {
      tenantId: TENANT,
      findings_summary: 'Updated',
    }, context('DOCTOR'))).rejects.toMatchObject({ code: 'CATH_REPORT_AUDIT_REQUIRED' });
  });

  test('records one distinct clinical audit row for each report exposed in a case list', async () => {
    const first = report('signed', 51);
    const second = report('draft', 52);
    queryUnsafeMock
      .mockResolvedValueOnce([cathCase()])
      .mockResolvedValueOnce([first, second])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const result = await listReports(42, { tenantId: TENANT }, context('NURSING_STAFF', 'list-req'));

    expect(result).toHaveLength(2);
    expect(recordClinicalAuditEventMock).toHaveBeenCalledTimes(2);
    const keys = recordClinicalAuditEventMock.mock.calls.map(([input]) => input.idempotencyKey);
    expect(new Set(keys).size).toBe(2);
    expect(keys).toEqual(expect.arrayContaining([
      expect.stringContaining('51:cath_lab.report_viewed:list-req'),
      expect.stringContaining('52:cath_lab.report_viewed:list-req'),
    ]));
  });

  test('returns pacs_not_configured and audits the resolution for an approved technician', async () => {
    queryUnsafeMock
      .mockResolvedValueOnce([cathCase()])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const result = await resolveCaseViewerLink(
      42,
      { tenantId: TENANT },
      context('TECHNICIAN', 'viewer-req'),
    );

    expect(result).toEqual({
      viewer_url: null,
      viewer_status: 'pacs_not_configured',
      study_accession: null,
      source: null,
    });
    expect(buildViewerUrlMock).not.toHaveBeenCalled();
    expect(recordClinicalAuditEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'cath_lab.viewer_link_resolved',
        metadata: expect.objectContaining({ viewer_status: 'pacs_not_configured' }),
      }),
      { db: dbMock },
    );
  });

  test('rejects viewer resolution for transcription-only receptionist access', async () => {
    await expect(resolveCaseViewerLink(
      42,
      { tenantId: TENANT },
      context('RECEPTIONIST'),
    )).rejects.toMatchObject({ code: 'CATH_REPORT_VIEWER_FORBIDDEN' });
    expect(setTenantTxMock).not.toHaveBeenCalled();
  });

  test('does not construct a viewer URL from a malformed stored StudyInstanceUID', async () => {
    getPacsConfigMock.mockReturnValueOnce({
      enabled: true,
      viewer_url: 'https://viewer.example',
      dicomweb_url: 'https://dicom.example',
      aet: 'VHHEALTH',
    });
    queryUnsafeMock
      .mockResolvedValueOnce([cathCase()])
      .mockResolvedValueOnce([{
        id: 51,
        report_type: 'ptca',
        status: 'signed',
        viewer_study_accession: 'not-a-dicom-study-uid',
      }])
      .mockResolvedValueOnce([]);

    const result = await resolveCaseViewerLink(
      42,
      { tenantId: TENANT },
      context('DOCTOR', 'invalid-viewer-req'),
    );

    expect(result).toMatchObject({
      viewer_url: null,
      viewer_status: 'invalid_study_uid',
    });
    expect(buildViewerUrlMock).not.toHaveBeenCalled();
  });
});
