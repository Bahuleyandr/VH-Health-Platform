import prisma from '../lib/prisma.js';
import {
  addReportAddendum,
  createReport,
  getReport,
  getSignedReportForPdf,
  markReportPreliminary,
  resolveCaseViewerLink,
  signReport,
  updateReport,
} from '../services/clinical/cathReportService.js';
import { listCases } from '../services/clinical/cathLabService.js';
import { renderCathReportPdf } from '../services/documents/cathReportPdfService.js';

const hasDatabaseUrl = Boolean(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const describeIfDb = hasDatabaseUrl ? describe : describe.skip;

const TENANT_A = '00000000-0000-4000-8000-000000000001';
const TENANT_B = '00000000-0000-4000-8000-00000000c9b2';
const PATIENT_A = 'ca000000-0000-4000-8000-00000000a001';
const DOCTOR_A = 'ca000000-0000-4000-8000-00000000a002';
const RECEPTIONIST_A = 'ca000000-0000-4000-8000-00000000a003';
const PATIENT_B = 'ca000000-0000-4000-8000-00000000b001';
const RLS_ROLE = 'cath_report_rls_app';

function actor(uid, role, requestId) {
  return {
    actorUid: uid,
    actorRole: role,
    requestId,
    ipAddress: '127.0.0.1',
    userAgent: 'cath-reporting-deep-test',
  };
}

async function maintenanceCleanup() {
  await prisma.$transaction(async (tx) => {
    // Teardown runs only on the disposable deep-test database. Disabling user
    // and constraint triggers for this one transaction is what keeps the whole
    // cleanup inside Prisma's 5 s interactive-transaction budget: deleting the
    // fixture rows from `users` and `tenants` otherwise costs ~16 s on a
    // comprehensively seeded database, because Postgres revalidates the 317 and
    // 692 foreign keys that reference them (235 of the `users` ones have no
    // supporting index) once per deleted row. Overrunning that budget fails the
    // suite in `afterAll` with "a commit cannot be executed on an expired
    // transaction" while every assertion passes. Production paths are untouched.
    await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
    await tx.$executeRawUnsafe("SELECT set_config('app.audit_bypass', 'on', true)");
    await tx.$executeRawUnsafe("SELECT set_config('app.cath_report_mutation_bypass', 'on', true)");
    await tx.$executeRawUnsafe(
      `DELETE FROM clinical_audit_events WHERE patient_uid IN ($1::uuid, $2::uuid)`,
      PATIENT_A,
      PATIENT_B,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM clinical_timeline_events WHERE patient_uid IN ($1::uuid, $2::uuid)`,
      PATIENT_A,
      PATIENT_B,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM cath_report_addenda WHERE patient_uid IN ($1::uuid, $2::uuid)`,
      PATIENT_A,
      PATIENT_B,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM cath_procedure_reports WHERE patient_uid IN ($1::uuid, $2::uuid)`,
      PATIENT_A,
      PATIENT_B,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM cath_procedure_logs WHERE patient_uid IN ($1::uuid, $2::uuid)`,
      PATIENT_A,
      PATIENT_B,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM cath_lab_cases WHERE patient_uid IN ($1::uuid, $2::uuid)`,
      PATIENT_A,
      PATIENT_B,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM staff_credentials WHERE staff_uid IN ($1::uuid, $2::uuid)`,
      DOCTOR_A,
      RECEPTIONIST_A,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM cath_report_templates
        WHERE tenant_id = $1::uuid AND template_code = 'CATH_RLS_TEST_TEMPLATE'`,
      TENANT_B,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid, $3::uuid, $4::uuid)`,
      PATIENT_A,
      DOCTOR_A,
      RECEPTIONIST_A,
      PATIENT_B,
    );
    await tx.$executeRawUnsafe(`DELETE FROM tenants WHERE id = $1::uuid`, TENANT_B);
  });
}

async function asRlsRole(tenantId, sql, ...params) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE ${RLS_ROLE}`);
    await tx.$executeRawUnsafe(
      "SELECT set_config('app.current_tenant_id', $1, true)",
      tenantId,
    );
    return tx.$queryRawUnsafe(sql, ...params);
  });
}

describeIfDb('NL-13 P1b cath reporting deep integration', () => {
  let caseId;
  let procedureLogId;
  let templateId;
  let reportId;
  let addendumId;
  const originalPacsViewerUrl = process.env.PACS_VIEWER_URL;
  const originalPacsDicomwebUrl = process.env.PACS_DICOMWEB_URL;

  beforeAll(async () => {
    await maintenanceCleanup();
    await prisma.$executeRawUnsafe(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cath_report_rls_app') THEN
          CREATE ROLE cath_report_rls_app NOLOGIN;
        END IF;
      END $$
    `);
    await prisma.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${RLS_ROLE}`);
    await prisma.$executeRawUnsafe(
      `GRANT SELECT ON cath_lab_cases, cath_procedure_logs, cath_report_templates,
                       cath_procedure_reports, cath_report_addenda TO ${RLS_ROLE}`,
    );
    await prisma.$executeRawUnsafe(`GRANT SELECT ON cath_report_tat_metrics TO ${RLS_ROLE}`);

    await prisma.$queryRawUnsafe(
      `INSERT INTO users (tenant_id, uid, phone, name, role, is_active, updated_at)
       VALUES
         ($1::uuid, $2::uuid, '9011998001', 'Cath Report Patient A', 'PATIENT', TRUE, NOW()),
         ($1::uuid, $3::uuid, '9011998002', 'Dr Cath Signer A', 'DOCTOR', TRUE, NOW()),
         ($1::uuid, $4::uuid, '9011998003', 'Cath Transcription A', 'RECEPTIONIST', TRUE, NOW())`,
      TENANT_A,
      PATIENT_A,
      DOCTOR_A,
      RECEPTIONIST_A,
    );
    const templateRows = await prisma.$queryRawUnsafe(
      `SELECT id
         FROM cath_report_templates
        WHERE tenant_id = $1::uuid
          AND template_code = 'CATH_PTCA_STARTER'
          AND is_active = TRUE
        LIMIT 1`,
      TENANT_A,
    );
    templateId = templateRows[0].id;
    const caseRows = await prisma.$queryRawUnsafe(
      `INSERT INTO cath_lab_cases
         (tenant_id, patient_uid, requested_procedure, status,
          actual_start_at, actual_end_at, created_by, updated_by)
       VALUES ($1::uuid, $2::uuid, 'PTCA', 'completed',
               NOW() - INTERVAL '60 minutes', NOW() - INTERVAL '30 minutes',
               $3::uuid, $3::uuid)
       RETURNING id`,
      TENANT_A,
      PATIENT_A,
      DOCTOR_A,
    );
    caseId = caseRows[0].id;
    const procedureRows = await prisma.$queryRawUnsafe(
      `INSERT INTO cath_procedure_logs
         (tenant_id, case_id, patient_uid, procedure_type, operators,
          findings_summary, status, started_at, ended_at, logged_by)
       VALUES ($1::uuid, $2::bigint, $3::uuid, 'PTCA',
               $4::jsonb, 'Synthetic deep-test finding', 'finalized',
               NOW() - INTERVAL '60 minutes', NOW() - INTERVAL '30 minutes', $5::uuid)
       RETURNING id`,
      TENANT_A,
      caseId,
      PATIENT_A,
      JSON.stringify([{ uid: DOCTOR_A, name: 'Dr Cath Signer A' }]),
      DOCTOR_A,
    );
    procedureLogId = procedureRows[0].id;
    await prisma.$queryRawUnsafe(
      `INSERT INTO staff_credentials
         (tenant_id, staff_uid, credential_type, name, status,
          privilege_catalog_id, valid_from, valid_until, created_by)
       SELECT $1::uuid, $2::uuid, 'privilege', 'cath_report_signing', 'active',
              pc.id, CURRENT_DATE - 1, CURRENT_DATE + 365, $2::uuid
         FROM privilege_catalog pc
        WHERE pc.tenant_id = $1::uuid
          AND pc.privilege_key = 'cath_report_signing'
          AND pc.status = 'active'
        LIMIT 1`,
      TENANT_A,
      DOCTOR_A,
    );
  });

  afterAll(async () => {
    if (originalPacsViewerUrl === undefined) delete process.env.PACS_VIEWER_URL;
    else process.env.PACS_VIEWER_URL = originalPacsViewerUrl;
    if (originalPacsDicomwebUrl === undefined) delete process.env.PACS_DICOMWEB_URL;
    else process.env.PACS_DICOMWEB_URL = originalPacsDicomwebUrl;
    await maintenanceCleanup();
    await prisma.$disconnect().catch(() => {});
  });

  test('runs template draft, edit, preliminary, credentialed sign, addendum, PDF, TAT, and audited viewer flow', async () => {
    const draft = await createReport(caseId, {
      tenantId: TENANT_A,
      template_id: templateId,
      procedure_log_id: procedureLogId,
      report_type: 'ptca',
      narrative_sections: [
        { key: 'indication', title: 'Indication', text: 'Synthetic indication.' },
        { key: 'findings', title: 'Findings', text: 'Synthetic finding.' },
        { key: 'result', title: 'Result', text: 'Synthetic result.' },
      ],
      coded_fields: { vessels_treated: ['LAD'], stents: [{ model: 'Synthetic', length_mm: 18 }] },
    }, actor(RECEPTIONIST_A, 'RECEPTIONIST', 'deep-create'));
    reportId = draft.id;
    expect(draft.status).toBe('draft');
    expect(draft.template_version).toBe(1);

    const edited = await updateReport(reportId, {
      tenantId: TENANT_A,
      findings_summary: 'Synthetic finding summary.',
      viewer_study_accession: '1.2.840.113619.2.55.3.604688433.123.1',
    }, actor(RECEPTIONIST_A, 'RECEPTIONIST', 'deep-edit'));
    expect(edited.findings_summary).toBe('Synthetic finding summary.');

    const preliminary = await markReportPreliminary(
      reportId,
      { tenantId: TENANT_A },
      actor(DOCTOR_A, 'DOCTOR', 'deep-preliminary'),
    );
    expect(preliminary.status).toBe('preliminary');

    const signed = await signReport(
      reportId,
      { tenantId: TENANT_A },
      actor(DOCTOR_A, 'DOCTOR', 'deep-sign'),
    );
    expect(signed.status).toBe('signed');
    expect(signed.signed_by).toBe(DOCTOR_A);

    const addendum = await addReportAddendum(reportId, {
      tenantId: TENANT_A,
      reason: 'Synthetic clarification',
      narrative: 'Synthetic append-only addendum.',
    }, actor(DOCTOR_A, 'DOCTOR', 'deep-addendum'));
    addendumId = addendum.id;

    const firstView = await getReport(
      reportId,
      { tenantId: TENANT_A },
      actor(DOCTOR_A, 'DOCTOR', 'deep-view-1'),
    );
    const secondView = await getReport(
      reportId,
      { tenantId: TENANT_A },
      actor(DOCTOR_A, 'DOCTOR', 'deep-view-2'),
    );
    expect(firstView.addenda).toHaveLength(1);
    expect(firstView.addenda[0]).toMatchObject({
      id: addendumId,
      author_name: 'Dr Cath Signer A',
      author_role: 'DOCTOR',
    });
    expect(secondView.signed_by_name).toBe('Dr Cath Signer A');

    const printable = await getSignedReportForPdf(
      reportId,
      { tenantId: TENANT_A },
      actor(DOCTOR_A, 'DOCTOR', 'deep-pdf'),
    );
    const pdf = await renderCathReportPdf(printable);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(1000);

    process.env.PACS_VIEWER_URL = 'https://viewer.example.test';
    process.env.PACS_DICOMWEB_URL = 'https://dicom.example.test';
    const viewer = await resolveCaseViewerLink(
      caseId,
      { tenantId: TENANT_A },
      actor(DOCTOR_A, 'DOCTOR', 'deep-viewer'),
    );
    expect(viewer).toMatchObject({ viewer_status: 'available' });
    expect(viewer.viewer_url).toContain('StudyInstanceUIDs=');

    const cases = await listCases({ tenantId: TENANT_A, limit: 500 });
    const caseRow = cases.find((entry) => String(entry.id) === String(caseId));
    expect(caseRow.report_tat_minutes).toBeGreaterThanOrEqual(20);
    expect(caseRow.signed_report_count).toBe(1);

    const eventRows = await prisma.$queryRawUnsafe(
      `SELECT event_type
         FROM clinical_timeline_events
        WHERE tenant_id = $1::uuid
          AND patient_uid = $2::uuid
          AND event_type IN ('cath_lab.report_signed', 'cath_lab.report_addendum')`,
      TENANT_A,
      PATIENT_A,
    );
    expect(eventRows.map((row) => row.event_type).sort()).toEqual([
      'cath_lab.report_addendum',
      'cath_lab.report_signed',
    ]);

    const auditRows = await prisma.$queryRawUnsafe(
      `SELECT action, idempotency_key
         FROM clinical_audit_events
        WHERE tenant_id = $1::uuid
          AND patient_uid = $2::uuid
          AND action IN (
            'cath_lab.report_created', 'cath_lab.report_edited',
            'cath_lab.report_preliminary', 'cath_lab.report_signed',
            'cath_lab.report_addendum', 'cath_lab.report_viewed',
            'cath_lab.report_pdf_viewed', 'cath_lab.viewer_link_resolved'
          )`,
      TENANT_A,
      PATIENT_A,
    );
    expect(auditRows.filter((row) => row.action === 'cath_lab.report_viewed')).toHaveLength(2);
    expect(new Set(auditRows.map((row) => row.idempotency_key)).size).toBe(auditRows.length);
    expect(auditRows.map((row) => row.action)).toEqual(expect.arrayContaining([
      'cath_lab.report_created',
      'cath_lab.report_edited',
      'cath_lab.report_preliminary',
      'cath_lab.report_signed',
      'cath_lab.report_addendum',
      'cath_lab.report_pdf_viewed',
      'cath_lab.viewer_link_resolved',
    ]));
  });

  test('enforces signed-report and addendum immutability in PostgreSQL', async () => {
    await expect(prisma.$executeRawUnsafe(
      `UPDATE cath_procedure_reports SET findings_summary = 'forbidden' WHERE id = $1::bigint`,
      reportId,
    )).rejects.toThrow(/signed cath procedure reports are immutable/i);
    await expect(prisma.$executeRawUnsafe(
      `DELETE FROM cath_report_addenda WHERE id = $1::bigint`,
      addendumId,
    )).rejects.toThrow(/append-only/i);
  });

  test('enforces tenant RLS in both directions for report tables', async () => {
    await prisma.$queryRawUnsafe(
      `INSERT INTO tenants (id, slug, name, region, compliance_profile, status)
       VALUES ($1::uuid, 'cath-report-rls-b', 'Cath Report RLS B', 'IN', 'DPDP', 'active')`,
      TENANT_B,
    );
    await prisma.$queryRawUnsafe(
      `INSERT INTO users (tenant_id, uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, $2::uuid, '9011998011', 'Cath Report Patient B', 'PATIENT', TRUE, NOW())`,
      TENANT_B,
      PATIENT_B,
    );
    const templateRows = await prisma.$queryRawUnsafe(
      `INSERT INTO cath_report_templates
         (tenant_id, template_code, name, report_type, sections,
          coded_fields_schema, version, metadata)
       VALUES ($1::uuid, 'CATH_RLS_TEST_TEMPLATE', 'Cath RLS test', 'other',
               '[]'::jsonb, '{}'::jsonb, 1, '{"synthetic":true}'::jsonb)
       RETURNING id`,
      TENANT_B,
    );
    const caseRows = await prisma.$queryRawUnsafe(
      `INSERT INTO cath_lab_cases (tenant_id, patient_uid, requested_procedure, status)
       VALUES ($1::uuid, $2::uuid, 'RLS test', 'scheduled')
       RETURNING id`,
      TENANT_B,
      PATIENT_B,
    );
    const reportRows = await prisma.$queryRawUnsafe(
      `INSERT INTO cath_procedure_reports
         (tenant_id, case_id, patient_uid, report_type, template_id,
          template_version, status, preliminary_by, preliminary_at,
          signed_by, signed_at)
       VALUES ($1::uuid, $2::bigint, $3::uuid, 'other', $4::bigint, 1, 'signed',
               $3::uuid, NOW(), $3::uuid, NOW())
       RETURNING id`,
      TENANT_B,
      caseRows[0].id,
      PATIENT_B,
      templateRows[0].id,
    );
    const addendumRows = await prisma.$queryRawUnsafe(
      `INSERT INTO cath_report_addenda
         (tenant_id, report_id, case_id, patient_uid, author_uid, reason, narrative)
       VALUES ($1::uuid, $2::bigint, $3::bigint, $4::uuid, $4::uuid,
               'RLS test', 'Tenant B addendum')
       RETURNING id`,
      TENANT_B,
      reportRows[0].id,
      caseRows[0].id,
      PATIENT_B,
    );

    const fromA = await asRlsRole(
      TENANT_A,
      `SELECT id, tenant_id FROM cath_procedure_reports WHERE id IN ($1::bigint, $2::bigint)`,
      reportId,
      reportRows[0].id,
    );
    const fromB = await asRlsRole(
      TENANT_B,
      `SELECT id, tenant_id FROM cath_procedure_reports WHERE id IN ($1::bigint, $2::bigint)`,
      reportId,
      reportRows[0].id,
    );
    expect(fromA).toHaveLength(1);
    expect(fromA[0].tenant_id).toBe(TENANT_A);
    expect(fromB).toHaveLength(1);
    expect(fromB[0].tenant_id).toBe(TENANT_B);

    const tatFromA = await asRlsRole(
      TENANT_A,
      `SELECT report_id, tenant_id FROM cath_report_tat_metrics WHERE report_id IN ($1::bigint, $2::bigint)`,
      reportId,
      reportRows[0].id,
    );
    const tatFromB = await asRlsRole(
      TENANT_B,
      `SELECT report_id, tenant_id FROM cath_report_tat_metrics WHERE report_id IN ($1::bigint, $2::bigint)`,
      reportId,
      reportRows[0].id,
    );
    expect(tatFromA).toHaveLength(1);
    expect(tatFromA[0].tenant_id).toBe(TENANT_A);
    expect(tatFromB).toHaveLength(1);
    expect(tatFromB[0].tenant_id).toBe(TENANT_B);

    const templatesFromA = await asRlsRole(
      TENANT_A,
      `SELECT id, tenant_id FROM cath_report_templates WHERE id IN ($1::bigint, $2::bigint)`,
      templateId,
      templateRows[0].id,
    );
    const templatesFromB = await asRlsRole(
      TENANT_B,
      `SELECT id, tenant_id FROM cath_report_templates WHERE id IN ($1::bigint, $2::bigint)`,
      templateId,
      templateRows[0].id,
    );
    expect(templatesFromA).toHaveLength(1);
    expect(templatesFromA[0].tenant_id).toBe(TENANT_A);
    expect(templatesFromB).toHaveLength(1);
    expect(templatesFromB[0].tenant_id).toBe(TENANT_B);

    const addendaFromA = await asRlsRole(
      TENANT_A,
      `SELECT id, tenant_id FROM cath_report_addenda WHERE id IN ($1::bigint, $2::bigint)`,
      addendumId,
      addendumRows[0].id,
    );
    const addendaFromB = await asRlsRole(
      TENANT_B,
      `SELECT id, tenant_id FROM cath_report_addenda WHERE id IN ($1::bigint, $2::bigint)`,
      addendumId,
      addendumRows[0].id,
    );
    expect(addendaFromA).toHaveLength(1);
    expect(addendaFromA[0].tenant_id).toBe(TENANT_A);
    expect(addendaFromB).toHaveLength(1);
    expect(addendaFromB[0].tenant_id).toBe(TENANT_B);
  });
});
