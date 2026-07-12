import prisma from '../lib/prisma.js';
import { updateTenant } from '../services/tenant/tenantService.js';
import {
  createCase,
  READINESS_TYPES,
  recordProcedureLog,
  updateReadinessCheck,
} from '../services/clinical/cathLabService.js';
import {
  applyCathOrderSetSlot,
  emitCathProcedureCompletionFollowUps,
  getCaseQuickWins,
  refreshReadinessEvidence,
} from '../services/clinical/cathQuickWinsService.js';

const hasDatabaseUrl = Boolean(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const describeIfDb = hasDatabaseUrl ? describe : describe.skip;

const TENANT_A = '00000000-0000-4000-8000-000000000001';
const TENANT_B = '00000000-0000-4000-8000-00000000c9c2';
const RLS_ROLE = 'cath_qw_rls_app';

// The dev/test connection role owns the schema (RLS is bypassed for
// superusers), so tenant-scope assertions run under a dedicated NOLOGIN
// role — same pattern as cath-reporting.deep.test.js.
function scopedSelect(tenantId, sql, ...params) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE ${RLS_ROLE}`);
    await tx.$executeRawUnsafe(
      "SELECT set_config('app.current_tenant_id', $1, true)",
      tenantId,
    );
    return tx.$queryRawUnsafe(sql, ...params);
  });
}
const PATIENT_A = 'ca000000-0000-4000-8000-00000000e001';
const DOCTOR_A = 'ca000000-0000-4000-8000-00000000e002';
const ORDER_SET_FAMILY = 'CATH-QW-PRE-DEEP';
const CONSENT_TYPE = 'cath_procedure_deep_test';

function actor(uid, role) {
  return { actorUid: uid, actorRole: role, requestId: 'cath-qw-deep' };
}

const quickWinSettings = {
  cathQuickWins: {
    consent: { consentType: CONSENT_TYPE },
    orderSets: { preCathFamilyKey: ORDER_SET_FAMILY },
    followUp: {
      templates: [
        {
          templateKey: 'post_pci_review',
          title: 'Post-PCI review (deep test)',
          description: 'Owner-authored review of access site and DAPT plan',
          procedureTypes: ['PCI'],
          offsetDays: 2,
          staffTaskRole: 'DOCTOR',
        },
      ],
    },
  },
};

async function maintenanceCleanup() {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SELECT set_config('app.audit_bypass', 'on', true)");
    await tx.$executeRawUnsafe(
      'DELETE FROM clinical_audit_events WHERE patient_uid = $1::uuid',
      PATIENT_A,
    );
    await tx.$executeRawUnsafe(
      'DELETE FROM clinical_timeline_events WHERE patient_uid = $1::uuid',
      PATIENT_A,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM engagement_follow_up_events
        WHERE loop_id IN (SELECT id FROM engagement_follow_up_loops WHERE patient_uid = $1::uuid)`,
      PATIENT_A,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM engagement_follow_up_steps
        WHERE loop_id IN (SELECT id FROM engagement_follow_up_loops WHERE patient_uid = $1::uuid)`,
      PATIENT_A,
    );
    await tx.$executeRawUnsafe(
      'DELETE FROM engagement_follow_up_loops WHERE patient_uid = $1::uuid',
      PATIENT_A,
    );
    await tx.$executeRawUnsafe(
      'DELETE FROM tasks WHERE patient_uid = $1::uuid',
      PATIENT_A,
    );
    await tx.$executeRawUnsafe(
      'DELETE FROM clinical_orders WHERE patient_uid = $1::uuid',
      PATIENT_A,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM clinical_order_set_items
        WHERE order_set_id IN (SELECT id FROM clinical_order_sets WHERE family_key = $1)`,
      ORDER_SET_FAMILY,
    );
    await tx.$executeRawUnsafe(
      'DELETE FROM clinical_order_sets WHERE family_key = $1',
      ORDER_SET_FAMILY,
    );
    await tx.$executeRawUnsafe(
      'DELETE FROM consent_signatures WHERE patient_uid = $1::uuid',
      PATIENT_A,
    );
    await tx.$executeRawUnsafe(
      'DELETE FROM patient_consents WHERE patient_uid = $1::uuid',
      PATIENT_A,
    );
    await tx.$executeRawUnsafe(
      'DELETE FROM blood_requests WHERE patient_uid = $1::uuid',
      PATIENT_A,
    );
    await tx.$executeRawUnsafe(
      'DELETE FROM cath_procedure_logs WHERE patient_uid = $1::uuid',
      PATIENT_A,
    );
    await tx.$executeRawUnsafe(
      'DELETE FROM cath_lab_cases WHERE patient_uid = $1::uuid',
      PATIENT_A,
    );
    await tx.$executeRawUnsafe(
      'DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)',
      PATIENT_A,
      DOCTOR_A,
    );
    await tx.$executeRawUnsafe('DELETE FROM tenants WHERE id = $1::uuid', TENANT_B);
  });
}

describeIfDb('NL-13 P1e cath quick wins deep integration', () => {
  let caseId;
  let procedureLogId;

  beforeAll(async () => {
    await maintenanceCleanup();
    await prisma.$queryRawUnsafe(
      `INSERT INTO users (tenant_id, uid, phone, name, role, is_active, updated_at)
       VALUES
         ($1::uuid, $2::uuid, '9011997001', 'Cath QuickWin Patient', 'PATIENT', TRUE, NOW()),
         ($1::uuid, $3::uuid, '9011997002', 'Dr Cath QuickWin', 'DOCTOR', TRUE, NOW())`,
      TENANT_A,
      PATIENT_A,
      DOCTOR_A,
    );
    await prisma.$queryRawUnsafe(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, 'cath-qw-rls-b', 'Cath QW RLS Tenant B')
       ON CONFLICT (id) DO NOTHING`,
      TENANT_B,
    );
    await prisma.$executeRawUnsafe(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cath_qw_rls_app') THEN
          CREATE ROLE cath_qw_rls_app NOLOGIN;
        END IF;
      END $$
    `);
    await prisma.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${RLS_ROLE}`);
    await prisma.$executeRawUnsafe(
      `GRANT SELECT ON engagement_follow_up_loops, cath_lab_readiness_checks TO ${RLS_ROLE}`,
    );
    const created = await createCase(
      {
        tenantId: TENANT_A,
        patient_uid: PATIENT_A,
        requested_procedure: 'Coronary angiogram +/- PCI',
        urgency: 'routine',
      },
      actor(DOCTOR_A, 'DOCTOR'),
    );
    caseId = created.id;
  }, 60000);

  afterAll(async () => {
    await updateTenant(TENANT_A, { settings: {} }).catch(() => null);
    await maintenanceCleanup();
    await prisma.$disconnect();
  }, 60000);

  it('stays fully inert with no owner config and no source rows', async () => {
    await updateTenant(TENANT_A, { settings: {} });
    const quickWins = await getCaseQuickWins(caseId, { tenantId: TENANT_A });
    expect(quickWins.readiness_evidence.blood_bank).toBeNull();
    expect(quickWins.readiness_evidence.consent).toBeNull();
    expect(quickWins.order_sets).toEqual({ pre_cath: null, post_cath: null });
    expect(quickWins.follow_up.configured_template_count).toBe(0);

    const refreshed = await refreshReadinessEvidence(
      caseId,
      { tenantId: TENANT_A },
      actor(DOCTOR_A, 'DOCTOR'),
    );
    expect(refreshed.attached).toEqual([]);
    expect(refreshed.skipped).toHaveLength(2);
  });

  it('surfaces live crossmatch evidence once a blood request exists', async () => {
    await updateTenant(TENANT_A, { settings: quickWinSettings });
    await prisma.$queryRawUnsafe(
      `INSERT INTO blood_requests
         (tenant_id, patient_uid, blood_group, component, units, urgency,
          clinical_indication, cross_match_status, cross_matched_at, status, ordered_by)
       VALUES ($1::uuid, $2::uuid, 'O+', 'prbc', 2, 'routine',
               'Pre-cath standby', 'compatible', NOW(), 'cross_matched', $3::uuid)`,
      TENANT_A,
      PATIENT_A,
      DOCTOR_A,
    );
    const quickWins = await getCaseQuickWins(caseId, { tenantId: TENANT_A });
    expect(quickWins.readiness_evidence.blood_bank).toMatchObject({
      evidence: 'blood_bank_crossmatch',
      cross_match_status: 'compatible',
      request_status: 'cross_matched',
      units: 2,
    });
  });

  it('surfaces signed-consent evidence only when the mapped consent is signed', async () => {
    // Granted but unsigned -> still manual.
    const consentRows = await prisma.$queryRawUnsafe(
      `INSERT INTO patient_consents
         (patient_uid, consent_type, granted, status, granted_at, version, source)
       VALUES ($1::uuid, $2, TRUE, 'active', NOW(), 'v1', 'staff')
       RETURNING id`,
      PATIENT_A,
      CONSENT_TYPE,
    );
    const consentId = consentRows[0].id;
    let quickWins = await getCaseQuickWins(caseId, { tenantId: TENANT_A });
    expect(quickWins.readiness_evidence.consent).toBeNull();

    await prisma.$queryRawUnsafe(
      `INSERT INTO consent_signatures
         (tenant_id, consent_id, patient_uid, signature_role, version,
          storage_key, mime_type, file_size, sha256_hash)
       VALUES ($1::uuid, $2::int, $3::uuid, 'patient', 1,
               'consents/deep-test-signature.png', 'image/png', 2048,
               '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef')`,
      TENANT_A,
      consentId,
      PATIENT_A,
    );
    quickWins = await getCaseQuickWins(caseId, { tenantId: TENANT_A });
    expect(quickWins.readiness_evidence.consent).toMatchObject({
      evidence: 'signed_consent',
      consent_id: consentId,
      artifact_path: `/api/v1/consent/${consentId}/pdf`,
    });
  });

  it('persists evidence onto readiness rows without touching status and audits it', async () => {
    const result = await refreshReadinessEvidence(
      caseId,
      { tenantId: TENANT_A },
      actor(DOCTOR_A, 'DOCTOR'),
    );
    expect(result.attached).toHaveLength(2);

    const rows = await prisma.$queryRawUnsafe(
      `SELECT check_type, status, evidence_owner, source_name, attachment_ref, metadata
         FROM cath_lab_readiness_checks
        WHERE tenant_id = $1::uuid AND case_id = $2::bigint
          AND check_type IN ('blood_bank', 'consent')
        ORDER BY check_type`,
      TENANT_A,
      caseId,
    );
    expect(rows).toHaveLength(2);
    const bloodRow = rows.find((row) => row.check_type === 'blood_bank');
    const consentRow = rows.find((row) => row.check_type === 'consent');
    expect(bloodRow.status).toBe('pending');
    expect(consentRow.status).toBe('pending');
    expect(bloodRow.evidence_owner).toBe('blood_bank');
    expect(consentRow.evidence_owner).toBe('consent_esign');
    expect(bloodRow.metadata.live_evidence.evidence).toBe('blood_bank_crossmatch');
    expect(consentRow.metadata.live_evidence.evidence).toBe('signed_consent');
    expect(consentRow.attachment_ref).toContain('/pdf');

    const audits = await prisma.$queryRawUnsafe(
      `SELECT id FROM clinical_audit_events
        WHERE patient_uid = $1::uuid AND action = 'cath_lab.readiness_evidence_attached'`,
      PATIENT_A,
    );
    expect(audits.length).toBe(2);
  });

  it('applies the mapped pre-cath order set through CPOE and audits the application', async () => {
    const setRows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_order_sets
         (tenant_id, code, family_key, version, status, source, title, specialty,
          active, created_by, approved_by, approved_at)
       VALUES ($1::uuid, $2, $2, 1, 'approved', 'authored', 'Pre-cath bundle (deep)',
               'cardiology', TRUE, $3::uuid, $3::uuid, NOW())
       RETURNING id`,
      TENANT_A,
      ORDER_SET_FAMILY,
      DOCTOR_A,
    );
    const orderSetId = setRows[0].id;
    await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_order_set_items
         (tenant_id, order_set_id, display_order, kind, payload)
       VALUES
         ($1::uuid, $2::int, 1, 'nursing', '{"instructions": "NPO 6 hours pre-procedure"}'::jsonb),
         ($1::uuid, $2::int, 2, 'nursing', '{"instructions": "Right groin prep and shave"}'::jsonb)`,
      TENANT_A,
      orderSetId,
    );

    const quickWins = await getCaseQuickWins(caseId, { tenantId: TENANT_A });
    expect(quickWins.order_sets.pre_cath).toMatchObject({
      order_set_id: orderSetId,
      family_key: ORDER_SET_FAMILY,
      item_count: 2,
    });
    expect(quickWins.order_sets.post_cath).toBeNull();

    const applied = await applyCathOrderSetSlot(
      caseId,
      'pre_cath',
      { tenantId: TENANT_A },
      actor(DOCTOR_A, 'DOCTOR'),
    );
    expect(applied.orders).toHaveLength(2);
    expect(applied.orders.filter((order) => order.error)).toHaveLength(0);

    const orders = await prisma.$queryRawUnsafe(
      `SELECT id, order_type, details FROM clinical_orders WHERE patient_uid = $1::uuid`,
      PATIENT_A,
    );
    expect(orders).toHaveLength(2);
    for (const order of orders) {
      expect(order.order_type).toBe('nursing');
      expect(order.details.order_set_family).toBe(ORDER_SET_FAMILY);
    }

    const audits = await prisma.$queryRawUnsafe(
      `SELECT metadata FROM clinical_audit_events
        WHERE patient_uid = $1::uuid AND action = 'cath_lab.order_set_applied'`,
      PATIENT_A,
    );
    expect(audits.length).toBe(1);
    expect(audits[0].metadata.slot).toBe('pre_cath');
    expect(audits[0].metadata.staged_count).toBe(2);

    // Unmapped slot stays inert: no orders, typed error.
    const before = await prisma.$queryRawUnsafe(
      'SELECT COUNT(*)::int AS count FROM clinical_orders WHERE patient_uid = $1::uuid',
      PATIENT_A,
    );
    await expect(
      applyCathOrderSetSlot(caseId, 'post_cath', { tenantId: TENANT_A }, actor(DOCTOR_A, 'DOCTOR')),
    ).rejects.toMatchObject({ code: 'CATH_QW_ORDER_SET_UNMAPPED' });
    const after = await prisma.$queryRawUnsafe(
      'SELECT COUNT(*)::int AS count FROM clinical_orders WHERE patient_uid = $1::uuid',
      PATIENT_A,
    );
    expect(after[0].count).toBe(before[0].count);
  });

  it('emits owner-template follow-up loops on finalized PCI procedure logs', async () => {
    for (const checkType of READINESS_TYPES) {
      await updateReadinessCheck(
        caseId,
        { tenantId: TENANT_A, check_type: checkType, status: 'pass' },
        actor(DOCTOR_A, 'DOCTOR'),
      );
    }
    const procedure = await recordProcedureLog(
      caseId,
      {
        tenantId: TENANT_A,
        procedure_type: 'PCI',
        status: 'finalized',
        operators: [{ uid: DOCTOR_A, role: 'primary' }],
        findings_summary: 'Deep-test PCI to LAD',
      },
      actor(DOCTOR_A, 'DOCTOR'),
    );
    procedureLogId = procedure.id;

    const loops = await prisma.$queryRawUnsafe(
      `SELECT id, source_type, source_ref, loop_type, status, due_at, metadata
         FROM engagement_follow_up_loops
        WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid`,
      TENANT_A,
      PATIENT_A,
    );
    expect(loops).toHaveLength(1);
    const loop = loops[0];
    expect(loop.source_type).toBe('cath_procedure');
    expect(loop.loop_type).toBe('cath_procedure_follow_up');
    expect(loop.source_ref).toBe(`${procedureLogId}:post_pci_review`);
    expect(loop.status).toBe('scheduled');
    expect(loop.metadata.template_key).toBe('post_pci_review');
    expect(loop.metadata.patient_outreach_policy).toBe('staff_review_only');

    const tasks = await prisma.$queryRawUnsafe(
      `SELECT id, title, task_kind FROM tasks
        WHERE patient_uid = $1::uuid
          AND related_resource_type = 'engagement_follow_up_loop'
          AND related_resource_id = $2`,
      PATIENT_A,
      String(loop.id),
    );
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe('Post-PCI review (deep test)');

    const steps = await prisma.$queryRawUnsafe(
      'SELECT step_kind, status, template_key FROM engagement_follow_up_steps WHERE loop_id = $1::bigint',
      loop.id,
    );
    expect(steps).toHaveLength(1);
    expect(steps[0].step_kind).toBe('staff_task');
    expect(steps[0].template_key).toBe('post_pci_review');

    const events = await prisma.$queryRawUnsafe(
      'SELECT event_kind FROM engagement_follow_up_events WHERE loop_id = $1::bigint ORDER BY id',
      loop.id,
    );
    expect(events.map((event) => event.event_kind)).toEqual(['created', 'task_created']);

    // Re-emission is idempotent while the loop stays open.
    const again = await emitCathProcedureCompletionFollowUps({
      tenantId: TENANT_A,
      procedureLogId,
      actorUid: DOCTOR_A,
    });
    expect(again.created).toEqual([]);
    expect(again.skipped[0].reason).toBe('open_loop_exists');

    // A procedure type with no owner template triggers nothing.
    const unmapped = await recordProcedureLog(
      caseId,
      {
        tenantId: TENANT_A,
        procedure_type: 'Right heart catheterisation',
        status: 'finalized',
        operators: [{ uid: DOCTOR_A, role: 'primary' }],
      },
      actor(DOCTOR_A, 'DOCTOR'),
    );
    expect(unmapped.id).toBeTruthy();
    const loopsAfter = await prisma.$queryRawUnsafe(
      'SELECT COUNT(*)::int AS count FROM engagement_follow_up_loops WHERE patient_uid = $1::uuid',
      PATIENT_A,
    );
    expect(loopsAfter[0].count).toBe(1);
  }, 60000);

  it('scopes quick wins and loops by tenant in both directions (RLS)', async () => {
    await expect(
      getCaseQuickWins(caseId, { tenantId: TENANT_B }),
    ).rejects.toMatchObject({ code: 'CATH_LAB_CASE_NOT_FOUND' });
    await expect(
      refreshReadinessEvidence(caseId, { tenantId: TENANT_B }, actor(DOCTOR_A, 'DOCTOR')),
    ).rejects.toMatchObject({ code: 'CATH_LAB_CASE_NOT_FOUND' });

    const tenantBLoops = await scopedSelect(
      TENANT_B,
      'SELECT id FROM engagement_follow_up_loops WHERE patient_uid = $1::uuid',
      PATIENT_A,
    );
    expect(tenantBLoops).toHaveLength(0);

    const tenantALoops = await scopedSelect(
      TENANT_A,
      'SELECT id FROM engagement_follow_up_loops WHERE patient_uid = $1::uuid',
      PATIENT_A,
    );
    expect(tenantALoops).toHaveLength(1);

    // Readiness evidence rows obey tenant scope the same way.
    const tenantBChecks = await scopedSelect(
      TENANT_B,
      'SELECT id FROM cath_lab_readiness_checks WHERE case_id = $1::bigint',
      caseId,
    );
    expect(tenantBChecks).toHaveLength(0);
    const tenantAChecks = await scopedSelect(
      TENANT_A,
      'SELECT id FROM cath_lab_readiness_checks WHERE case_id = $1::bigint',
      caseId,
    );
    expect(tenantAChecks.length).toBeGreaterThan(0);
  });
});
