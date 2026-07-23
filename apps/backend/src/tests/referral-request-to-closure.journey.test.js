import { randomUUID } from 'node:crypto';
import { jest } from '@jest/globals';

const DB_CONFIGURED = Boolean(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const prisma = (await import('../lib/prisma.js')).default;
const {
  acceptClosedLoopReferral,
  closeReferralByOriginator,
  createClosedLoopReferral,
  getClosedLoopReferral,
  markReferralSeenClosedLoop,
  recordSignedReferralResponse,
} = await import('../services/referral/referralClosedLoopService.js');
const { runReferralRecoverySweep } = await import(
  '../services/referral/referralRecoverySweepService.js'
);
const { listPatientReferrals } = await import('../services/portal/patientReferralService.js');
const { default: referralService } = await import('../services/referral/referralService.js');
const { withAuditBypass } = await import('./helpers/auditBypass.js');

const TENANT_ID = randomUUID();
const PATIENT_UID = randomUUID();
const ADMIN_UID = randomUUID();
const ORIGINATOR_UID = randomUUID();
const RECEIVER_UID = randomUUID();
const OUTSIDER_UID = randomUUID();
const users = [
  [PATIENT_UID, 'PATIENT', 'Referral Journey Patient'],
  [ADMIN_UID, 'ADMIN', 'Referral Journey Administrator'],
  [ORIGINATOR_UID, 'DOCTOR', 'Referral Journey Originator'],
  [RECEIVER_UID, 'DOCTOR', 'Referral Journey Receiver'],
  [OUTSIDER_UID, 'DOCTOR', 'Referral Journey Outsider'],
];

function phone(index) {
  return `+9196${String(Math.floor(Math.random() * 1e7) + index).padStart(8, '0')}`;
}

function actor(uid, role) {
  return {
    tenantId: TENANT_ID,
    actorUid: uid,
    actorRole: role,
    actorRawRole: role,
    actorRoles: [role],
  };
}

async function cleanup() {
  await withAuditBypass(prisma, async (tx) => {
    await tx.$executeRawUnsafe(`DELETE FROM referral_patient_notifications WHERE tenant_id = $1::uuid`, TENANT_ID);
    await tx.$executeRawUnsafe(`DELETE FROM clinical_document_signatures WHERE tenant_id = $1::uuid AND document_type = 'referral_response'`, TENANT_ID);
    await tx.$executeRawUnsafe(`DELETE FROM referral_responses WHERE tenant_id = $1::uuid`, TENANT_ID);
    await tx.$executeRawUnsafe(`DELETE FROM referral_transition_events WHERE tenant_id = $1::uuid`, TENANT_ID);
    await tx.$executeRawUnsafe(`DELETE FROM task_comments WHERE tenant_id = $1::uuid`, TENANT_ID).catch(() => {});
    await tx.$executeRawUnsafe(`DELETE FROM tasks WHERE tenant_id = $1::uuid`, TENANT_ID);
    await tx.$executeRawUnsafe(`DELETE FROM workflow_sla_instances WHERE tenant_id = $1::uuid AND source_table = 'referrals'`, TENANT_ID);
    await tx.$executeRawUnsafe(`DELETE FROM pathway_projector_inbox WHERE tenant_id = $1::uuid`, TENANT_ID);
    await tx.$executeRawUnsafe(`DELETE FROM event_outbox WHERE tenant_id = $1::uuid`, TENANT_ID);
    await tx.$executeRawUnsafe(`DELETE FROM notifications WHERE tenant_id = $1::uuid`, TENANT_ID);
    await tx.$executeRawUnsafe(`DELETE FROM clinical_timeline_events WHERE tenant_id = $1::uuid`, TENANT_ID);
    await tx.$executeRawUnsafe(`DELETE FROM clinical_audit_events WHERE tenant_id = $1::uuid`, TENANT_ID);
    await tx.$executeRawUnsafe(`DELETE FROM referrals WHERE tenant_id = $1::uuid`, TENANT_ID);
    await tx.$executeRawUnsafe(`DELETE FROM doctors WHERE tenant_id = $1::uuid`, TENANT_ID);
    await tx.$executeRawUnsafe(`DELETE FROM users WHERE tenant_id = $1::uuid`, TENANT_ID);
    await tx.$executeRawUnsafe(`DELETE FROM tenants WHERE id = $1::uuid`, TENANT_ID);
  }).catch(() => {});
}

d('Referral request-to-closure journey', () => {
  beforeAll(async () => {
    await cleanup();
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name, settings)
       VALUES ($1::uuid, $2::text, 'Referral Journey Tenant',
               '{"care_pathways":{"referral_request_to_closure":"active"}}'::jsonb)`,
      TENANT_ID,
      `referral-journey-${TENANT_ID.slice(0, 8)}`,
    );
    for (const [uid, role, name] of users) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO users
           (uid, phone, name, role, is_active, status, is_deleted, tenant_id, updated_at)
         VALUES ($1::uuid, $2::text, $3::text, $4::text, TRUE, 'active', FALSE,
                 $5::uuid, NOW())`,
        uid,
        phone(users.findIndex(([candidate]) => candidate === uid) + 1),
        name,
        role,
        TENANT_ID,
      );
    }
    for (const uid of [RECEIVER_UID, OUTSIDER_UID]) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO doctors
           (user_id, name, department, specialty, is_active, available_days,
            tenant_id, updated_at)
         SELECT id, name, 'Cardiology', 'Cardiology', TRUE, ARRAY[]::text[],
                $2::uuid, NOW()
           FROM users WHERE tenant_id = $2::uuid AND uid = $1::uuid`,
        uid,
        TENANT_ID,
      );
    }
  }, 60_000);

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  });

  it('keeps the SLA running on seen, transfers ownership on named acceptance, and closes only after a signed response and originator plan', async () => {
    const request = {
      tenant_id: TENANT_ID,
      patient_uid: PATIENT_UID,
      requester_id: ADMIN_UID,
      referring_doctor: ORIGINATOR_UID,
      referred_to_doctor: RECEIVER_UID,
      referred_to_department: 'Cardiology',
      referral_type: 'internal',
      reason: 'Specialist review of persistent symptoms',
      urgency: 'urgent',
      source: 'ward',
      expires_at: new Date(Date.now() - 60_000).toISOString(),
      idempotency_key: `referral-journey-${TENANT_ID}`,
    };
    const created = await createClosedLoopReferral(request, actor(ADMIN_UID, 'ADMIN'));
    const replay = await createClosedLoopReferral(request, actor(ADMIN_UID, 'ADMIN'));
    expect(replay).toMatchObject({ id: created.id, replayed: true });

    const initial = await prisma.$queryRawUnsafe(
      `SELECT referral.status, referral.current_owner_uid,
              task.status AS task_status, sla.status AS sla_status
         FROM referrals AS referral
         JOIN tasks AS task
           ON task.tenant_id = referral.tenant_id
          AND task.related_resource_type = 'referrals'
          AND task.related_resource_id = referral.id::text
         JOIN workflow_sla_instances AS sla ON sla.id = task.workflow_sla_instance_id
        WHERE referral.tenant_id = $1::uuid AND referral.id = $2::integer`,
      TENANT_ID,
      created.id,
    );
    expect(initial[0]).toMatchObject({ status: 'pending', task_status: 'open', sla_status: 'active' });
    expect(String(initial[0].current_owner_uid)).toBe(ORIGINATOR_UID);

    await markReferralSeenClosedLoop(created.id, actor(RECEIVER_UID, 'DOCTOR'));
    const afterSeen = await prisma.$queryRawUnsafe(
      `SELECT task.status AS task_status, sla.status AS sla_status
         FROM tasks AS task
         JOIN workflow_sla_instances AS sla ON sla.id = task.workflow_sla_instance_id
        WHERE task.tenant_id = $1::uuid
          AND task.related_resource_type = 'referrals'
          AND task.related_resource_id = $2::text`,
      TENANT_ID,
      String(created.id),
    );
    expect(afterSeen[0]).toMatchObject({ task_status: 'open', sla_status: 'active' });

    await expect(acceptClosedLoopReferral(
      created.id,
      actor(OUTSIDER_UID, 'DOCTOR'),
    )).rejects.toMatchObject({ statusCode: 403 });
    await expect(getClosedLoopReferral(
      created.id,
      actor(OUTSIDER_UID, 'DOCTOR'),
    )).rejects.toMatchObject({ statusCode: 403 });
    await expect(acceptClosedLoopReferral(
      created.id,
      { ...actor(ADMIN_UID, 'ADMIN'), overrideReason: 'Administrative coverage' },
    )).rejects.toMatchObject({ statusCode: 403 });
    await acceptClosedLoopReferral(created.id, actor(RECEIVER_UID, 'DOCTOR'));
    const accepted = await getClosedLoopReferral(created.id, actor(RECEIVER_UID, 'DOCTOR'));
    expect(accepted).toMatchObject({
      status: 'accepted',
      accepted_by: RECEIVER_UID,
      current_owner_uid: RECEIVER_UID,
      closure_status: 'open',
    });
    expect(accepted.ownership_accepted_at).toBeTruthy();

    const afterAccept = await prisma.$queryRawUnsafe(
      `SELECT task.status AS task_status, sla.status AS sla_status
         FROM tasks AS task
         JOIN workflow_sla_instances AS sla ON sla.id = task.workflow_sla_instance_id
        WHERE task.tenant_id = $1::uuid
          AND task.related_resource_type = 'referrals'
          AND task.related_resource_id = $2::text`,
      TENANT_ID,
      String(created.id),
    );
    expect(afterAccept[0]).toMatchObject({ task_status: 'completed', sla_status: 'completed' });
    const responseTaskAfterAccept = await prisma.$queryRawUnsafe(
      `SELECT status, assigned_to_uid
         FROM tasks
        WHERE tenant_id = $1::uuid
          AND related_resource_type = 'referral_specialist_response'
          AND related_resource_id = $2::text
        ORDER BY id DESC LIMIT 1`,
      TENANT_ID,
      String(created.id),
    );
    expect(responseTaskAfterAccept[0]).toMatchObject({
      status: 'open',
      assigned_to_uid: RECEIVER_UID,
    });

    const responseInput = {
      assessment: 'Reviewed by the receiving specialist.',
      recommendations: 'Continue the documented treatment plan.',
      follow_up_plan: 'Originating doctor to review at follow-up.',
      patient_summary: 'Your specialist has reviewed this referral.',
      patient_instructions: 'Follow the plan discussed with your care team.',
      release_to_patient: true,
      continuing_ownership: false,
    };
    const response = await recordSignedReferralResponse(
      created.id,
      responseInput,
      actor(RECEIVER_UID, 'DOCTOR'),
    );
    expect(response).toMatchObject({ status: 'completed', closure_status: 'open' });
    expect(response.signature.id).toBeTruthy();
    const responseTaskAfterSign = await prisma.$queryRawUnsafe(
      `SELECT status
         FROM tasks
        WHERE tenant_id = $1::uuid
          AND related_resource_type = 'referral_specialist_response'
          AND related_resource_id = $2::text
        ORDER BY id DESC LIMIT 1`,
      TENANT_ID,
      String(created.id),
    );
    expect(responseTaskAfterSign[0]?.status).toBe('completed');
    const originatorTaskBeforeClosure = await prisma.$queryRawUnsafe(
      `SELECT status, assigned_to_uid
         FROM tasks
        WHERE tenant_id = $1::uuid
          AND related_resource_type = 'referral_originator_closure'
          AND related_resource_id = $2::text
        ORDER BY id DESC LIMIT 1`,
      TENANT_ID,
      String(created.id),
    );
    expect(originatorTaskBeforeClosure[0]).toMatchObject({
      status: 'open',
      assigned_to_uid: ORIGINATOR_UID,
    });
    const responseReplay = await recordSignedReferralResponse(
      created.id,
      responseInput,
      actor(RECEIVER_UID, 'DOCTOR'),
    );
    expect(responseReplay).toMatchObject({ status: 'completed', replayed: true });
    await prisma.$executeRawUnsafe(
      `UPDATE tenants
          SET settings = jsonb_set(
            COALESCE(settings, '{}'::jsonb),
            '{care_pathways,referral_request_to_closure}',
            '"off"'::jsonb,
            TRUE
          )
        WHERE id = $1::uuid`,
      TENANT_ID,
    );
    expect(await listPatientReferrals({ tenantId: TENANT_ID, patientUid: PATIENT_UID })).toEqual([]);

    await prisma.$executeRawUnsafe(
      `UPDATE tenants
          SET settings = jsonb_set(
            COALESCE(settings, '{}'::jsonb),
            '{care_pathways,referral_request_to_closure}',
            '"active"'::jsonb,
            TRUE
          )
        WHERE id = $1::uuid`,
      TENANT_ID,
    );

    const recovery = await runReferralRecoverySweep({ tenantId: TENANT_ID });
    expect(recovery).toMatchObject({ candidates: 1, materialized: 1 });
    const stillOpen = await getClosedLoopReferral(created.id, actor(ORIGINATOR_UID, 'DOCTOR'));
    expect(stillOpen.closure_status).toBe('open');

    await expect(closeReferralByOriginator(created.id, {
      disposition: 'plan_updated',
      plan_update: 'Unauthorized covering-doctor attempt.',
    }, {
      ...actor(OUTSIDER_UID, 'DOCTOR'),
      overrideReason: 'Covering the originating clinician',
    })).rejects.toMatchObject({ statusCode: 403 });

    await closeReferralByOriginator(created.id, {
      disposition: 'plan_updated',
      plan_update: 'Specialist advice reviewed and incorporated into the patient care plan.',
    }, actor(ORIGINATOR_UID, 'DOCTOR'));
    const closed = await getClosedLoopReferral(created.id, actor(ORIGINATOR_UID, 'DOCTOR'));
    expect(closed).toMatchObject({
      status: 'completed',
      closure_status: 'closed',
      closure_reason: 'plan_updated',
      current_owner_uid: ORIGINATOR_UID,
    });
    expect(closed.transitions.map((event) => event.sequence_number)).toEqual([1, 2, 3, 4, 5]);
    expect(closed.transitions.map((event) => event.event_type)).toEqual([
      'referral.requested',
      'referral.seen',
      'referral.accepted',
      'referral.response_signed',
      'referral.closed',
    ]);
    const originatorTaskAfterClosure = await prisma.$queryRawUnsafe(
      `SELECT status
         FROM tasks
        WHERE tenant_id = $1::uuid
          AND related_resource_type = 'referral_originator_closure'
          AND related_resource_id = $2::text
        ORDER BY id DESC LIMIT 1`,
      TENANT_ID,
      String(created.id),
    );
    expect(originatorTaskAfterClosure[0]?.status).toBe('completed');

    const patientRows = await listPatientReferrals({
      tenantId: TENANT_ID,
      patientUid: PATIENT_UID,
    });
    expect(patientRows).toHaveLength(1);
    expect(patientRows[0]).toMatchObject({
      id: created.id,
      patient_summary: responseInput.patient_summary,
      patient_instructions: responseInput.patient_instructions,
    });
    expect(patientRows[0].assessment).toBeUndefined();
    expect(patientRows[0].recommendations).toBeUndefined();

    await prisma.$executeRawUnsafe(
      `UPDATE tenants
          SET settings = jsonb_set(
            COALESCE(settings, '{}'::jsonb),
            '{care_pathways,referral_request_to_closure}',
            '"shadow"'::jsonb,
            TRUE
          )
        WHERE id = $1::uuid`,
      TENANT_ID,
    );
    const notificationSpy = jest.spyOn(
      referralService,
      '_notifyReferralRecipients',
    ).mockResolvedValue({ notification_count: 1 });
    const shadowReferral = await createClosedLoopReferral({
      ...request,
      reason: 'Shadow-mode referral projection evidence',
      idempotency_key: `referral-shadow-${TENANT_ID}`,
      expires_at: null,
    }, actor(ADMIN_UID, 'ADMIN'));
    expect(notificationSpy).not.toHaveBeenCalled();
    notificationSpy.mockRestore();
    const shadowTaskCount = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::integer AS count
         FROM tasks
        WHERE tenant_id = $1::uuid
          AND related_resource_id = $2::text`,
      TENANT_ID,
      String(shadowReferral.id),
    );
    expect(shadowTaskCount[0]?.count).toBe(0);
  }, 60_000);
});
