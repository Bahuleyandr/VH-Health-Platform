import { jest } from '@jest/globals';

const mockPrisma = { $queryRawUnsafe: jest.fn(), $executeRawUnsafe: jest.fn() };

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: mockPrisma,
  setTenantTx: async (_tenantId, fn) => fn(mockPrisma),
  setTenant: async (_tenantId, fn) => fn(mockPrisma),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(mockPrisma),
  pickTenantClient: () => mockPrisma,
  isTenantTransactionClient: (value) => value === mockPrisma,
  circuitBreakerStatus: () => ({ open: false, consecutiveFailures: 0 }),
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../../services/emr/inpatientPathwayDomainService.js', () => ({
  publishInpatientSourceEventTx: jest.fn(async () => null),
  resolveInpatientPathwayModeTx: jest.fn(async () => 'off'),
}));

const {
  createDraft,
  getOne,
  materializeDischargeComposeSections,
  sign,
} = await import('../../services/discharge/dischargeService.js');

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = '11111111-1111-4111-8111-111111111111';
const ACTOR_UID = '22222222-2222-4222-8222-222222222222';

function completedComposeResult({ warnings = [] } = {}) {
  return {
    builder_sections: [{
      section_key: 'cath_lab_procedures',
      section_title: 'Cath Lab Procedures',
      body: 'PTCA — 2026-07-11\nFindings: LAD treated\nFull report: /api/v1/cath-lab/reports/91',
      structured_data: {
        reports: [{
          report_id: 91,
          signer: { signed_at: '2026-07-11T09:45:00.000Z' },
        }],
      },
      source: 'signed_cath_procedure_reports',
      clinician_editable: true,
      sync_policy: 'compose_snapshot_only',
      source_snapshot_at: '2026-07-11T10:00:00.000Z',
    }],
    completeness_warnings: warnings,
    cath_reporting_source_snapshot: {
      captured_at: '2026-07-11T10:00:00.000Z',
      signed_report_ids: [91],
      pending_procedure_log_ids: warnings.length ? [61] : [],
      post_issue_sync: false,
    },
  };
}

function pendingComposeResult() {
  return {
    builder_sections: [],
    completeness_warnings: [{
      severity: 'high',
      code: 'CATH_REPORT_PENDING',
      message: 'Cath report pending for 1 procedure log(s).',
      pending_procedures: [{
        procedure_log_id: 61,
        procedure_type: 'PPI',
        procedure_date: '2026-07-11T11:00:00.000Z',
      }],
    }],
    cath_reporting_source_snapshot: {
      captured_at: '2026-07-11T12:00:00.000Z',
      signed_report_ids: [],
      pending_procedure_log_ids: [61],
      post_issue_sync: false,
    },
  };
}

describe('migration-159 discharge builder compose materialization', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.$executeRawUnsafe.mockResolvedValue(1);
  });

  it('materializes the signed cath snapshot as an editable builder section', async () => {
    mockPrisma.$queryRawUnsafe
      .mockResolvedValueOnce([{ id: 70, status: 'draft' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 701 }]);

    await expect(materializeDischargeComposeSections({
      tenantId: TENANT_ID,
      admissionId: 55,
      composeResult: completedComposeResult(),
      actorUid: ACTOR_UID,
    })).resolves.toEqual({
      materialized: true,
      discharge_summary_id: 70,
      section_key: 'cath_lab_procedures',
      operation: 'inserted',
    });

    const insertCall = mockPrisma.$queryRawUnsafe.mock.calls.find(
      (call) => /INSERT INTO discharge_summary_sections/i.test(call[0]),
    );
    expect(insertCall).toBeTruthy();
    expect(insertCall[0]).toMatch(/ON CONFLICT \(discharge_summary_id, section_key\) DO NOTHING/i);
    expect(insertCall[2]).toBe('cath_lab_procedures');
    expect(insertCall[3]).toBe('Cath Lab Procedures');
    expect(insertCall[4]).toContain('Full report: /api/v1/cath-lab/reports/91');

    const auditCall = mockPrisma.$executeRawUnsafe.mock.calls.find(
      (call) => /INSERT INTO audit_logs/i.test(call[0]),
    );
    expect(auditCall[2]).toBe('DISCHARGE_SUMMARY_COMPOSE_SECTION_MATERIALIZED');
    expect(JSON.parse(auditCall[4])).toMatchObject({
      admission_id: 55,
      operation: 'inserted',
      snapshot_kind: 'signed',
      signed_report_ids: [91],
      post_issue_sync: false,
    });
  });

  it('preserves a clinician-edited section on a later compose run', async () => {
    mockPrisma.$queryRawUnsafe
      .mockResolvedValueOnce([{ id: 70, status: 'draft' }])
      .mockResolvedValueOnce([{
        id: 701,
        body: 'Clinician-edited cath summary',
        edited_at: '2026-07-11T12:30:00.000Z',
      }]);

    await expect(materializeDischargeComposeSections({
      tenantId: TENANT_ID,
      admissionId: 55,
      composeResult: completedComposeResult(),
    })).resolves.toMatchObject({
      materialized: false,
      reason: 'clinician_edit_preserved',
      discharge_summary_id: 70,
    });
    expect(mockPrisma.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it.each(['signed', 'delivered'])(
    'never auto-syncs a %s summary', async (status) => {
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([{ id: 70, status }]);

    await expect(materializeDischargeComposeSections({
      tenantId: TENANT_ID,
      admissionId: 55,
      composeResult: completedComposeResult(),
    })).resolves.toMatchObject({
      materialized: false,
      reason: 'discharge_summary_immutable',
      discharge_summary_id: 70,
    });
    expect(mockPrisma.$queryRawUnsafe).toHaveBeenCalledTimes(1);
    expect(mockPrisma.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it('rejects a snapshot whose report ids are not the signed source ids', async () => {
    const unsafe = completedComposeResult();
    unsafe.cath_reporting_source_snapshot.signed_report_ids = [92];

    await expect(materializeDischargeComposeSections({
      tenantId: TENANT_ID,
      admissionId: 55,
      composeResult: unsafe,
    })).resolves.toEqual({
      materialized: false,
      reason: 'no_safe_cath_snapshot',
    });
    expect(mockPrisma.$queryRawUnsafe).not.toHaveBeenCalled();
    expect(mockPrisma.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it('consumes the latest completed compose when the builder is created afterward', async () => {
    const compose = completedComposeResult();
    const cathSectionRow = {
      id: 701,
      section_key: 'cath_lab_procedures',
      section_title: 'Cath Lab Procedures',
      display_order: 1,
      body: compose.builder_sections[0].body,
    };
    mockPrisma.$queryRawUnsafe
      .mockResolvedValueOnce([{ id: 1, sections: [] }])
      // In-tx admission linkage validation (A-M4): admission exists, same
      // tenant, and belongs to the summary's patient.
      .mockResolvedValueOnce([{ id: 55, patient_uid: PATIENT_UID }])
      .mockResolvedValueOnce([{ id: 70, admission_id: 55, patient_uid: PATIENT_UID }])
      .mockResolvedValueOnce([{ result: compose }])
      .mockResolvedValueOnce([{ id: 70, status: 'draft' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 701 }])
      .mockResolvedValueOnce([{
        id: 70,
        admission_id: 55,
        patient_uid: PATIENT_UID,
        status: 'draft',
      }])
      .mockResolvedValueOnce([cathSectionRow])
      .mockResolvedValueOnce([{ result: compose }]);

    const draft = await createDraft({
      tenantId: TENANT_ID,
      admission_id: 55,
      patient_uid: PATIENT_UID,
      template_code: 'GENERAL_MEDICINE_V1',
      created_by: ACTOR_UID,
    });

    expect(draft.sections).toEqual([cathSectionRow]);
    expect(draft.completeness_warnings).toEqual([]);
    expect(mockPrisma.$queryRawUnsafe.mock.calls.some(
      (call) => /clinical_ai_workflow_runs/i.test(call[0])
        && /status = 'completed'/i.test(call[0]),
    )).toBe(true);
  });

  it('creates the pending warning section when a pending compose completed first', async () => {
    const compose = pendingComposeResult();
    const pendingSectionRow = {
      id: 702,
      section_key: 'cath_lab_procedures',
      section_title: 'Cath Lab Procedures',
      display_order: 1,
      body: '[PLACEHOLDER — cath report pending; a signed report is required before discharge summary sign-off]\n\n- PPI — 2026-07-11T11:00:00.000Z (procedure log 61)',
    };
    mockPrisma.$queryRawUnsafe
      .mockResolvedValueOnce([{ id: 1, sections: [] }])
      // In-tx admission linkage validation (A-M4): admission exists, same
      // tenant, and belongs to the summary's patient.
      .mockResolvedValueOnce([{ id: 56, patient_uid: PATIENT_UID }])
      .mockResolvedValueOnce([{ id: 71, admission_id: 56, patient_uid: PATIENT_UID }])
      .mockResolvedValueOnce([{ result: compose }])
      .mockResolvedValueOnce([{ id: 71, status: 'draft' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 702 }])
      .mockResolvedValueOnce([{
        id: 71,
        admission_id: 56,
        patient_uid: PATIENT_UID,
        status: 'draft',
      }])
      .mockResolvedValueOnce([pendingSectionRow])
      .mockResolvedValueOnce([{ result: compose }]);

    const draft = await createDraft({
      tenantId: TENANT_ID,
      admission_id: 56,
      patient_uid: PATIENT_UID,
      template_code: 'GENERAL_MEDICINE_V1',
      created_by: ACTOR_UID,
    });

    expect(draft.sections).toEqual([pendingSectionRow]);
    expect(draft.completeness_warnings).toEqual(compose.completeness_warnings);
    const insertCall = mockPrisma.$queryRawUnsafe.mock.calls.find(
      (call) => /INSERT INTO discharge_summary_sections/i.test(call[0]),
    );
    expect(insertCall[4]).toBe(pendingSectionRow.body);
  });

  it('materializes a pending-only compose as a visible blocking builder section', async () => {
    mockPrisma.$queryRawUnsafe
      .mockResolvedValueOnce([{ id: 70, status: 'ready_for_signoff' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 701 }]);

    await expect(materializeDischargeComposeSections({
      tenantId: TENANT_ID,
      admissionId: 55,
      composeResult: pendingComposeResult(),
      actorUid: ACTOR_UID,
    })).resolves.toMatchObject({
      materialized: true,
      discharge_summary_id: 70,
      section_key: 'cath_lab_procedures',
      operation: 'inserted',
    });

    const insertCall = mockPrisma.$queryRawUnsafe.mock.calls.find(
      (call) => /INSERT INTO discharge_summary_sections/i.test(call[0]),
    );
    expect(insertCall[4]).toContain('[PLACEHOLDER — cath report pending');
    expect(insertCall[4]).toContain('PPI');
    expect(insertCall[4]).toContain('procedure log 61');
    expect(insertCall[4]).not.toContain('Findings:');
  });

  it('replaces an unedited pending draft section after a signed recomposition', async () => {
    const pending = pendingComposeResult();
    const pendingBody = '[PLACEHOLDER — cath report pending; a signed report is required before discharge summary sign-off]\n\n- PPI — 2026-07-11T11:00:00.000Z (procedure log 61)';
    mockPrisma.$queryRawUnsafe
      .mockResolvedValueOnce([{ id: 70, status: 'draft' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 701 }])
      .mockResolvedValueOnce([{ id: 70, status: 'draft' }])
      .mockResolvedValueOnce([{ id: 701, body: pendingBody, edited_at: null }]);

    await materializeDischargeComposeSections({
      tenantId: TENANT_ID,
      admissionId: 55,
      composeResult: pending,
      actorUid: ACTOR_UID,
    });
    await expect(materializeDischargeComposeSections({
      tenantId: TENANT_ID,
      admissionId: 55,
      composeResult: completedComposeResult(),
      actorUid: ACTOR_UID,
    })).resolves.toMatchObject({
      materialized: true,
      operation: 'updated',
    });

    const sectionUpdate = mockPrisma.$executeRawUnsafe.mock.calls.find(
      (call) => /UPDATE discharge_summary_sections/i.test(call[0]),
    );
    expect(sectionUpdate).toBeTruthy();
    expect(sectionUpdate[2]).toContain('Full report: /api/v1/cath-lab/reports/91');
    expect(sectionUpdate[2]).not.toContain('cath report pending');
  });

  it('surfaces pending-report warnings only while the builder is editable', async () => {
    const warning = {
      severity: 'high',
      code: 'CATH_REPORT_PENDING',
      message: 'Cath report pending for 1 procedure log(s).',
      pending_procedures: [{ procedure_log_id: 61, procedure_type: 'PPI' }],
    };
    mockPrisma.$queryRawUnsafe
      .mockResolvedValueOnce([{
        id: 70,
        admission_id: 55,
        patient_uid: PATIENT_UID,
        status: 'draft',
      }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ result: completedComposeResult({ warnings: [warning] }) }]);

    const detail = await getOne({ tenantId: TENANT_ID, id: 70 });
    expect(detail.completeness_warnings).toEqual([warning]);

    jest.clearAllMocks();
    mockPrisma.$queryRawUnsafe
      .mockResolvedValueOnce([{
        id: 70,
        admission_id: 55,
        patient_uid: PATIENT_UID,
        status: 'signed',
      }])
      .mockResolvedValueOnce([]);

    const issued = await getOne({ tenantId: TENANT_ID, id: 70 });
    expect(issued.completeness_warnings).toEqual([]);
    expect(mockPrisma.$queryRawUnsafe).toHaveBeenCalledTimes(2);
  });

  it('blocks sign-off while the persisted cath section is still pending', async () => {
    mockPrisma.$queryRawUnsafe
      .mockResolvedValueOnce([{ id: TENANT_ID }])
      .mockResolvedValueOnce([{ id: 70 }])
      .mockResolvedValueOnce([{
        section_key: 'cath_lab_procedures',
        body: '[PLACEHOLDER — cath report pending; a signed report is required before discharge summary sign-off]',
      }]);

    await expect(sign({
      tenantId: TENANT_ID,
      id: 70,
      signed_by: ACTOR_UID,
      signed_by_name: 'Dr Test',
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'DISCHARGE_SUMMARY_INCOMPLETE',
      details: { placeholder_sections: ['cath_lab_procedures'] },
    });
    expect(mockPrisma.$executeRawUnsafe).not.toHaveBeenCalled();
  });
});
