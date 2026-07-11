import { __testing__ } from '../../services/ai/dischargeComposeService.js';

const {
  COMPOSE_GRAPH_NODES,
  buildCathComposeSnapshot,
  buildCathReportViewAuditInput,
  buildCathViewerAuditInput,
} = __testing__;

const SIGNED_REPORT = {
  id: 91,
  case_id: 41,
  procedure_log_id: 51,
  report_type: 'ptca',
  status: 'signed',
  narrative_sections: [
    { key: 'indication', value: 'Acute coronary syndrome' },
    { key: 'findings', value: 'Critical LAD stenosis treated successfully.' },
  ],
  coded_fields: {
    vessels_treated: ['LAD'],
    stents: [{ model: 'Synthetic DES', size_mm: 3 }],
    internal_working_note: 'not a discharge key field',
  },
  signed_by: '11111111-1111-4111-8111-111111111111',
  signed_by_name: 'Dr Test Cardiologist',
  signed_at: '2026-07-11T09:45:00.000Z',
  viewer_study_accession: '1.2.840.113619.2.55.3.604688123.1',
  procedure_started_at: '2026-07-11T08:00:00.000Z',
  procedure_ended_at: '2026-07-11T09:00:00.000Z',
  operators: [{ name: 'Dr Test Operator' }],
  procedure_findings_summary: 'Procedure-log fallback findings.',
};

const PACS_ENV = {
  PACS_VIEWER_URL: 'https://pacs.example.test/',
  PACS_DICOMWEB_URL: 'https://pacs.example.test/dicom-web',
};

describe('discharge compose cath-report incorporation', () => {
  test('includes signed reports only in an editable Cath Lab Procedures snapshot', () => {
    const preliminary = {
      ...SIGNED_REPORT,
      id: 92,
      report_type: 'ppi',
      status: 'preliminary',
    };

    const snapshot = buildCathComposeSnapshot(
      [SIGNED_REPORT, preliminary],
      [],
      {
        env: PACS_ENV,
        now: new Date('2026-07-11T10:00:00.000Z'),
        viewerAccessAuthorized: true,
      },
    );

    expect(snapshot.section).toMatchObject({
      section_key: 'cath_lab_procedures',
      section_title: 'Cath Lab Procedures',
      auto_populated: true,
      clinician_editable: true,
      sync_policy: 'compose_snapshot_only',
      source_snapshot_at: '2026-07-11T10:00:00.000Z',
    });
    expect(snapshot.section.structured_data.reports).toHaveLength(1);
    expect(snapshot.section.structured_data.reports[0]).toMatchObject({
      report_id: 91,
      report_type: 'ptca',
      procedure_date: '2026-07-11T09:00:00.000Z',
      operators: [{ name: 'Dr Test Operator' }],
      signer: {
        uid: SIGNED_REPORT.signed_by,
        name: 'Dr Test Cardiologist',
        signed_at: '2026-07-11T09:45:00.000Z',
      },
      findings_summary: 'Critical LAD stenosis treated successfully.',
      key_coded_fields: {
        vessels_treated: ['LAD'],
        stents: [{ model: 'Synthetic DES', size_mm: 3 }],
      },
      report_reference: {
        resource_type: 'cath_procedure_report',
        resource_id: '91',
        href: '/api/v1/cath-lab/reports/91',
      },
      viewer_status: 'available',
      viewer_url: '/api/v1/cath-lab/cases/41/viewer-link',
    });
    expect(snapshot.sourceSnapshot).toMatchObject({
      signed_report_ids: [91],
      pending_procedure_log_ids: [],
      post_issue_sync: false,
    });
    expect(snapshot.section.body).toContain('Full report: /api/v1/cath-lab/reports/91');
    expect(JSON.stringify(snapshot)).not.toContain('https://pacs.example.test');
  });

  test('surfaces a pending-report completeness warning and makes readiness false', async () => {
    const cathSnapshot = buildCathComposeSnapshot([], [{
      procedure_log_id: 61,
      case_id: 42,
      procedure_type: 'PPI',
      status: 'finalized',
      ended_at: '2026-07-11T11:00:00.000Z',
    }], {
      env: PACS_ENV,
      now: new Date('2026-07-11T12:00:00.000Z'),
      viewerAccessAuthorized: true,
    });

    const delta = await COMPOSE_GRAPH_NODES.assemble_compose_result({
      admissionId: 501,
      activeChildren: ['discharge_readiness'],
      skippedChildren: [],
      cathReportingSnapshot: cathSnapshot,
      readiness_draft: {
        draft: {
          ready: true,
          blockers: [],
          checklist: { notes_signed: true },
        },
        safety_flags: [],
        draft_generation_id: 301,
        review_id: 401,
        review_status: 'pending',
      },
    });

    expect(delta.overallSafetyBand).toBe('high');
    expect(delta.composeDraft.completeness_warnings).toEqual([
      expect.objectContaining({
        severity: 'high',
        code: 'CATH_REPORT_PENDING',
        message: expect.stringContaining('Cath report pending'),
      }),
    ]);
    expect(delta.composeDraft.components.discharge_readiness.draft).toMatchObject({
      ready: false,
      checklist: {
        notes_signed: true,
        cath_reports_signed: false,
      },
      blockers: [expect.objectContaining({ type: 'cath_report_pending' })],
    });
    expect(delta.composeDraft.builder_sections).toEqual([]);
  });

  test('never emits a broken PACS link and keeps the composed report immutable from source mutations', () => {
    const source = {
      ...SIGNED_REPORT,
      narrative_sections: [{ key: 'findings', value: 'Snapshot finding.' }],
      coded_fields: { vessels_treated: ['RCA'] },
    };
    const snapshot = buildCathComposeSnapshot(
      [source],
      [],
      {
        env: {},
        now: new Date('2026-07-11T13:00:00.000Z'),
        viewerAccessAuthorized: true,
      },
    );
    const report = snapshot.section.structured_data.reports[0];

    expect(report).toMatchObject({
      findings_summary: 'Snapshot finding.',
      key_coded_fields: { vessels_treated: ['RCA'] },
      viewer_url: null,
      viewer_status: 'pacs_not_configured',
    });

    source.narrative_sections[0].value = 'Late addendum must not rewrite issued summaries.';
    source.coded_fields.vessels_treated.push('LAD');

    expect(report.findings_summary).toBe('Snapshot finding.');
    expect(report.key_coded_fields.vessels_treated).toEqual(['RCA']);
    expect(snapshot.sourceSnapshot.post_issue_sync).toBe(false);
  });

  test('rejects non-DICOM accessions instead of constructing an unusable OHIF URL', () => {
    const snapshot = buildCathComposeSnapshot(
      [{ ...SIGNED_REPORT, viewer_study_accession: 'ANGIO-ACCESSION-123' }],
      [],
      { env: PACS_ENV, viewerAccessAuthorized: true },
    );

    expect(snapshot.section.structured_data.reports[0]).toMatchObject({
      viewer_study_accession: 'ANGIO-ACCESSION-123',
      viewer_url: null,
      viewer_status: 'invalid_study_uid',
    });
  });

  test('builds a per-report audit-only viewer-resolution event keyed to the compose run', () => {
    const snapshot = buildCathComposeSnapshot([SIGNED_REPORT], [], {
      env: PACS_ENV,
      viewerAccessAuthorized: true,
    });
    const report = snapshot.section.structured_data.reports[0];
    const audit = buildCathViewerAuditInput({
      reportRow: {
        ...SIGNED_REPORT,
        tenant_id: '00000000-0000-4000-8000-000000000001',
        patient_uid: '22222222-2222-4222-8222-222222222222',
        encounter_id: '33333333-3333-4333-8333-333333333333',
      },
      report,
      admissionId: 501,
      requestedBy: '44444444-4444-4444-8444-444444444444',
      requestContext: { request_id: 'req-cath-compose', requested_by_role: 'CARDIOLOGIST' },
      runId: 701,
    });

    expect(audit).toMatchObject({
      action: 'cath_lab.viewer_link_resolved',
      actionStatus: 'success',
      actorUid: '44444444-4444-4444-8444-444444444444',
      actorRole: 'CARDIOLOGIST',
      resourceTable: 'cath_procedure_reports',
      resourceId: '91',
      requestId: 'req-cath-compose',
      metadata: {
        admission_id: 501,
        case_id: 41,
        procedure_log_id: 51,
        compose_run_id: 701,
        view: 'discharge_compose',
        viewer_access_authorized: true,
        viewer_status: 'available',
      },
      idempotencyKey:
        'cath_procedure_reports:91:audit:viewer_resolved:compose:701:req-cath-compose',
    });
    expect(audit).not.toHaveProperty('eventType');
  });

  test('builds a distinct signed-report view audit for discharge compose', () => {
    const snapshot = buildCathComposeSnapshot([SIGNED_REPORT], [], {
      env: PACS_ENV,
      viewerAccessAuthorized: true,
    });
    const report = snapshot.section.structured_data.reports[0];
    const audit = buildCathReportViewAuditInput({
      reportRow: {
        ...SIGNED_REPORT,
        tenant_id: '00000000-0000-4000-8000-000000000001',
        patient_uid: '22222222-2222-4222-8222-222222222222',
        encounter_id: '33333333-3333-4333-8333-333333333333',
      },
      report,
      admissionId: 501,
      requestedBy: '44444444-4444-4444-8444-444444444444',
      requestContext: { request_id: 'req-cath-compose', requested_by_role: 'CARDIOLOGIST' },
      runId: 701,
    });

    expect(audit).toMatchObject({
      action: 'cath_lab.report_viewed',
      actionStatus: 'success',
      actorRole: 'CARDIOLOGIST',
      resourceType: 'cath_report',
      resourceId: '91',
      metadata: {
        admission_id: 501,
        case_id: 41,
        procedure_log_id: 51,
        compose_run_id: 701,
        report_type: 'ptca',
        report_status: 'signed',
        view: 'discharge_compose',
      },
      idempotencyKey:
        'cath_procedure_reports:91:audit:report_viewed:compose:701:req-cath-compose',
    });
  });

  test('never resolves or embeds a PACS URL when the compose caller lacks viewer access', () => {
    const snapshot = buildCathComposeSnapshot([SIGNED_REPORT], [], {
      env: PACS_ENV,
      viewerAccessAuthorized: false,
    });
    const report = snapshot.section.structured_data.reports[0];

    expect(report).toMatchObject({
      viewer_study_accession: null,
      viewer_url: null,
      viewer_status: 'access_denied',
    });
    expect(snapshot.section.body).not.toContain('Images:');
  });
});
