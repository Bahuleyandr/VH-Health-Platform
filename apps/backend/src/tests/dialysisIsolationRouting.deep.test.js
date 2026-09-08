import { randomUUID } from 'node:crypto';
import { planIsolationTx } from '../services/clinical/dialysisIsolationRoutingService.js';
import { setTenantTx } from '../lib/prisma.js';
import {
  assertMarkerFree, createPlan4DialysisFixture, describeWithDatabase, prisma,
} from './helpers/plan4DialysisFixtures.js';

describeWithDatabase('dialysis isolation transaction routing', () => {
  let fixture;
  beforeEach(async () => { fixture = await createPlan4DialysisFixture(); });
  afterEach(async () => { await fixture?.cleanup(); });
  afterAll(() => prisma.$disconnect());

  async function reactive(patientUid, marker) {
    return setTenantTx(fixture.tenantId, (tx) => tx.$executeRawUnsafe(
      `INSERT INTO patient_bloodborne_markers
         (tenant_id, patient_uid, marker, result, tested_on, source, recorded_by)
       VALUES ($1::uuid, $2::uuid, $3, 'reactive', $4::date, 'clinical_declaration', $5::uuid)`,
      fixture.tenantId, patientUid, marker, fixture.today, fixture.infectionControlActor.uid,
    ));
  }

  async function sessions() {
    return setTenantTx(fixture.tenantId, (tx) => tx.$queryRawUnsafe(
      'SELECT id FROM dialysis_sessions WHERE tenant_id = $1::uuid ORDER BY id', fixture.tenantId,
    ));
  }

  test('blockModePlanningRefusalLeavesNoOrphanBookingWithPositiveControl', async () => {
    await fixture.schedule();
    expect(await sessions()).toHaveLength(1);
    await setTenantTx(fixture.tenantId, (tx) => tx.$executeRawUnsafe(
      `UPDATE reprocessing_domain_settings SET isolation_enforcement = 'block'
       WHERE tenant_id = $1::uuid AND domain = 'dialysis'`, fixture.tenantId,
    ));
    await reactive(fixture.patientUid, 'hbsag');
    await expect(fixture.schedule({ machine_no: 'Unregistered' }))
      .rejects.toMatchObject({ code: 'DIALYSIS_ISOLATION_MACHINE_BLOCKED', statusCode: 409 });
    expect(await sessions()).toHaveLength(1);
  });

  test('selectedRetiredMachineIsRefusedEvenForClearPatient', async () => {
    await setTenantTx(fixture.tenantId, (tx) => tx.$executeRawUnsafe(
      `INSERT INTO dialysis_machines (tenant_id, machine_no, status, created_by)
       VALUES ($1::uuid, 'Retired', 'retired', $2::uuid)`, fixture.tenantId, fixture.actor.uid,
    ));
    await expect(fixture.schedule({ machine_no: 'Retired' }))
      .rejects.toMatchObject({ code: 'DIALYSIS_MACHINE_INACTIVE', statusCode: 409 });
    expect(await sessions()).toHaveLength(0);
  });

  test('planningCommitsMarkerFreeIsolationAuditWithTheSession', async () => {
    const session = await fixture.schedule();
    const rows = await setTenantTx(fixture.tenantId, (tx) => tx.$queryRawUnsafe(
      `SELECT actor_uid::text, metadata FROM audit_logs
       WHERE tenant_id = $1::uuid AND action = 'dialysis.session.isolation_evaluated'
         AND resource_id = $2`, fixture.tenantId, String(session.id),
    ));
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_uid).toBe(fixture.actor.uid);
    expect(rows[0].metadata.codes).toEqual([]);
    assertMarkerFree(rows);
  });

  test('warningAcknowledgementPersistsReasonWithoutOperationalFreeText', async () => {
    await setTenantTx(fixture.tenantId, (tx) => tx.$executeRawUnsafe(
      `INSERT INTO dialysis_machines (tenant_id, machine_no, isolation_group, created_by)
       VALUES ($1::uuid, 'Dedicated', 'Bay One', $2::uuid)`, fixture.tenantId, fixture.actor.uid,
    ));
    const session = await fixture.schedule({ machine_no: 'Dedicated' });
    await fixture.capture(session.id);
    const reason = 'hcv sentinel acknowledged in protected clinical evidence';
    const started = await fixture.start(session.id, { isolation_override_reason: reason });
    const result = await setTenantTx(fixture.tenantId, async (tx) => ({
      sessions: await tx.$queryRawUnsafe(
        `SELECT isolation_override_reason, isolation_override_by::text FROM dialysis_sessions
         WHERE tenant_id = $1::uuid AND id = $2::integer`, fixture.tenantId, session.id,
      ),
      audits: await tx.$queryRawUnsafe(
        `SELECT metadata FROM audit_logs WHERE tenant_id = $1::uuid
         AND action = 'dialysis.session.isolation_overridden'`, fixture.tenantId,
      ),
    }));
    expect(result.sessions).toHaveLength(1);
    expect(result.audits).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({
      isolation_override_reason: reason, isolation_override_by: fixture.actor.uid,
    });
    assertMarkerFree(started);
    assertMarkerFree(result.audits);
  });

  test('routingReresolvesLiveEvidenceInsteadOfStoredSessionScreen', async () => {
    const session = await fixture.schedule();
    const assess = () => setTenantTx(fixture.tenantId, (tx) => planIsolationTx(tx, {
      tenantId: fixture.tenantId, patientUid: fixture.patientUid,
      sessionId: session.id, sessionDate: session.session_date, machineNo: null,
    }));
    expect((await assess()).codes).toEqual([]);
    await reactive(fixture.patientUid, 'hiv');
    const current = await assess();
    expect(current.codes).toEqual(['DIALYSIS_MACHINE_UNREGISTERED']);
    expect(current.evaluated_at).toEqual(expect.any(String));
    assertMarkerFree(current);
  });

  test('opaqueSameGroupCannotCollapseIncompatibleLiveProfiles', async () => {
    const otherUid = randomUUID();
    await setTenantTx(fixture.tenantId, async (tx) => {
      const [revision] = await tx.$queryRawUnsafe(
        `INSERT INTO reprocessing_isolation_setting_revisions
           (tenant_id, revision, approved_isolation_groups, isolation_groups,
            vocabulary_approved_by, vocabulary_approved_role, vocabulary_approved_at,
            mapping_approved_by, mapping_approved_role, mapping_approved_at, created_by)
         VALUES ($1::uuid, 1, ARRAY['Bay One'], $2::jsonb,
                 $3::uuid, 'INFECTION_CONTROL_OFFICER', clock_timestamp(),
                 $3::uuid, 'INFECTION_CONTROL_OFFICER', clock_timestamp(), $3::uuid)
         RETURNING id`, fixture.tenantId,
        JSON.stringify({ hbsag: 'Bay One', hcv: 'Bay One', hiv: 'Bay One', isolation_mixed: 'Bay One' }),
        fixture.infectionControlActor.uid,
      );
      await tx.$executeRawUnsafe(
        `UPDATE reprocessing_domain_settings SET isolation_revision_id = $2::bigint
         WHERE tenant_id = $1::uuid AND domain = 'dialysis'`, fixture.tenantId, revision.id,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO dialysis_machines (tenant_id, machine_no, isolation_group, created_by)
         VALUES ($1::uuid, 'Shared', 'Bay One', $2::uuid)`, fixture.tenantId, fixture.actor.uid,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO users (uid, tenant_id, phone, name, role, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, 'Cohort control', 'PATIENT', NOW())`,
        otherUid, fixture.tenantId, otherUid.replaceAll('-', '').slice(0, 14),
      );
      const [patient] = await tx.$queryRawUnsafe(
        `INSERT INTO dialysis_patients (tenant_id, patient_uid, modality)
         VALUES ($1::uuid, $2::uuid, 'hd') RETURNING id`, fixture.tenantId, otherUid,
      );
      const markers = ['hbsag', 'hcv', 'hiv'];
      expect(markers).toHaveLength(3);
      for (const marker of markers) {
        await tx.$executeRawUnsafe(
          `INSERT INTO patient_bloodborne_markers
             (tenant_id, patient_uid, marker, result, tested_on, source, recorded_by)
           VALUES ($1::uuid, $2::uuid, $3, $4, $5::date, 'clinical_declaration', $6::uuid)`,
          fixture.tenantId, otherUid, marker, marker === 'hcv' ? 'reactive' : 'non_reactive',
          fixture.today, fixture.infectionControlActor.uid,
        );
      }
      await tx.$executeRawUnsafe(
        `INSERT INTO dialysis_sessions (tenant_id, dialysis_patient_id, machine_no, session_date, modality)
         VALUES ($1::uuid, $2::integer, 'Shared', $3::date, 'hd')`, fixture.tenantId, patient.id, fixture.today,
      );
    });
    await reactive(fixture.patientUid, 'hbsag');
    await expect(fixture.schedule({ machine_no: 'Shared' }))
      .rejects.toMatchObject({ code: 'DIALYSIS_COHORT_INCOMPATIBLE' });
    expect(await sessions()).toHaveLength(1);
  });
});
