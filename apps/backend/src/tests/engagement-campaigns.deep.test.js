import prisma from '../lib/prisma.js';
import {
  approveCampaign,
  createEngagementCampaign,
  createEngagementTemplate,
  dryRunCampaign,
  materializeCampaignRecipients,
  queueDueCampaignRecipients,
  submitCampaignForApproval,
  upsertEngagementSettings,
} from '../services/engagement/engagementCampaignService.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TENANT_ID = '00000000-0000-4000-8000-00000000e901';
const ACTOR_UID = '00000000-0000-4000-8000-00000000e9aa';
const APPROVER_UID = '00000000-0000-4000-8000-00000000e9ab';
const PATIENT_ELIGIBLE = '00000000-0000-4000-8000-00000000e911';
const PATIENT_MISSING = '00000000-0000-4000-8000-00000000e912';
const PATIENT_REVOKED = '00000000-0000-4000-8000-00000000e913';
const PATIENT_STALE = '00000000-0000-4000-8000-00000000e914';

const PATIENTS = [
  [PATIENT_ELIGIBLE, '+919000009911', 'Engage Eligible'],
  [PATIENT_MISSING, '+919000009912', 'Engage Missing'],
  [PATIENT_REVOKED, '+919000009913', 'Engage Revoked'],
  [PATIENT_STALE, '+919000009914', 'Engage Stale'],
];

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM audit_logs
      WHERE action = 'ENGAGEMENT_CAMPAIGN_STATUS_CHANGED'
        AND metadata->>'tenant_id' = $1`,
    TENANT_ID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM notification_outbox
      WHERE payload->>'campaign_id' IS NOT NULL
        AND payload->>'tenant_id' = $1`,
    TENANT_ID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM engagement_campaign_recipients WHERE tenant_id = $1::uuid`, TENANT_ID).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM engagement_suppression_events WHERE tenant_id = $1::uuid`, TENANT_ID).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM engagement_audience_snapshots WHERE tenant_id = $1::uuid`, TENANT_ID).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM engagement_campaigns WHERE tenant_id = $1::uuid`, TENANT_ID).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM engagement_templates WHERE tenant_id = $1::uuid`, TENANT_ID).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM engagement_settings WHERE tenant_id = $1::uuid`, TENANT_ID).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM patient_consents WHERE patient_uid = ANY($1::uuid[])`, PATIENTS.map(([uid]) => uid)).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid = ANY($1::uuid[])`, PATIENTS.map(([uid]) => uid)).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM notification_templates WHERE name LIKE 'engage-test-%'`).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM tenants WHERE id = $1::uuid`, TENANT_ID).catch(() => {});
}

async function seedPatients() {
  for (const [uid, phone, name] of PATIENTS) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO users
         (uid, tenant_id, phone, name, role, is_active, preferred_channel, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, $4, 'PATIENT', true, 'sms', NOW())`,
      uid,
      TENANT_ID,
      phone,
      name,
    );
  }

  await prisma.$executeRawUnsafe(
    `INSERT INTO patient_consents
       (tenant_id, patient_uid, consent_type, granted, status, granted_at,
        data_categories, version, source, created_at, updated_at)
     VALUES ($1::uuid, $2::uuid, 'care_reminder_whatsapp', true, 'active', NOW(),
             '[]'::jsonb, 'v1', 'test', NOW(), NOW())`,
    TENANT_ID,
    PATIENT_ELIGIBLE,
  );

  await prisma.$executeRawUnsafe(
    `INSERT INTO patient_consents
       (tenant_id, patient_uid, consent_type, granted, status, granted_at, revoked_at,
        data_categories, version, source, created_at, updated_at)
     VALUES ($1::uuid, $2::uuid, 'care_reminder_whatsapp', false, 'revoked', NOW() - INTERVAL '1 day', NOW(),
             '[]'::jsonb, 'v1', 'test', NOW(), NOW())`,
    TENANT_ID,
    PATIENT_REVOKED,
  );

  await prisma.$executeRawUnsafe(
    `INSERT INTO patient_consents
       (tenant_id, patient_uid, consent_type, granted, status, granted_at,
        data_categories, version, source, created_at, updated_at)
     VALUES ($1::uuid, $2::uuid, 'care_reminder_whatsapp', true, 'active', NOW() - INTERVAL '730 days',
             '[]'::jsonb, 'v1', 'test', NOW(), NOW())`,
    TENANT_ID,
    PATIENT_STALE,
  );
}

async function seedCampaign() {
  await prisma.$executeRawUnsafe(
    `INSERT INTO tenants (id, slug, name)
     VALUES ($1::uuid, 'engagement-test', 'Engagement Test Tenant')
     ON CONFLICT (id) DO NOTHING`,
    TENANT_ID,
  );
  await seedPatients();
  await upsertEngagementSettings(TENANT_ID, {
    enabled: true,
    acceptance_snapshot: { accepted_by: 'test', gate: 'nl9-p1' },
    quiet_hours_start: '00:00',
    quiet_hours_end: '00:00',
    tenant_daily_cap: 10,
    per_patient_cooldown_hours: 0,
    consent_max_age_days: 365,
  }, ACTOR_UID);

  const templateRows = await prisma.$queryRawUnsafe(
    `INSERT INTO notification_templates
       (name, title_template, message_template, type, priority, variables, is_active, updated_at)
     VALUES ($1, 'Visit reminder', 'Hi {{first_name}}, your visit is {{appointment_window}}.',
             'engagement_campaign', 'NORMAL', '[]'::jsonb, true, NOW())
     RETURNING id`,
    `engage-test-${Date.now()}`,
  );

  const engagementTemplate = await createEngagementTemplate(TENANT_ID, {
    notification_template_id: templateRows[0].id,
    template_kind: 'appointment_recall',
    channel: 'sms',
    allowed_variables: ['first_name', 'appointment_window'],
  }, ACTOR_UID);

  return createEngagementCampaign(TENANT_ID, {
    campaign_type: 'appointment_recall',
    objective: 'Recall patients with an upcoming follow-up',
    template_id: engagementTemplate.id,
    channels: ['sms'],
    rate_policy: { per_patient_cooldown_hours: 0 },
  }, ACTOR_UID);
}

d('NL9-P1 engagement campaigns consent gates', () => {
  beforeAll(async () => {
    await cleanup();
  }, 30000);

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  }, 30000);

  it('dry-runs without outbox rows, suppresses missing/revoked/stale consent, then queues only the eligible patient', async () => {
    const campaign = await seedCampaign();
    const candidates = PATIENTS.map(([patientUid, _phone, name]) => ({
      patient_uid: patientUid,
      channel: 'sms',
      due_at: new Date(Date.now() - 60_000).toISOString(),
      variables: {
        first_name: name.split(' ')[1],
        appointment_window: 'tomorrow morning',
      },
    }));

    const beforeOutbox = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS count FROM notification_outbox WHERE payload->>'campaign_id' = $1`,
      String(campaign.id),
    );

    const dryRun = await dryRunCampaign({
      tenantId: TENANT_ID,
      campaignId: campaign.id,
      input: { patients: candidates, cohort_source: { source_tables: ['users', 'patient_consents'] } },
      actorUid: ACTOR_UID,
    });

    expect(dryRun.counts).toEqual({ materialized: 4, eligible: 1, suppressed: 3 });
    expect(dryRun.recipients.map((row) => row.reason).sort()).toEqual([
      null,
      'missing_consent',
      'revoked_consent',
      'stale_consent',
    ].sort());

    const afterDryRunOutbox = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS count FROM notification_outbox WHERE payload->>'campaign_id' = $1`,
      String(campaign.id),
    );
    expect(afterDryRunOutbox[0].count).toBe(beforeOutbox[0].count);

    const materialized = await materializeCampaignRecipients({
      tenantId: TENANT_ID,
      campaignId: campaign.id,
      input: { patients: candidates, cohort_source: { source_tables: ['users', 'patient_consents'] } },
      actorUid: ACTOR_UID,
    });
    expect(materialized.counts).toEqual({ materialized: 4, eligible: 1, suppressed: 3 });

    await expect(submitCampaignForApproval({
      tenantId: TENANT_ID,
      campaignId: campaign.id,
      actorRole: 'DOCTOR',
    })).rejects.toMatchObject({
      statusCode: 403,
      code: 'ENGAGEMENT_SUBMITTER_IDENTITY_REQUIRED',
    });

    await submitCampaignForApproval({
      tenantId: TENANT_ID,
      campaignId: campaign.id,
      actorUid: ACTOR_UID,
      actorRole: 'DOCTOR',
    });

    await expect(approveCampaign({
      tenantId: TENANT_ID,
      campaignId: campaign.id,
      actorUid: ACTOR_UID,
      actorRole: 'DOCTOR',
      reason: 'Attempted self-approval',
    })).rejects.toMatchObject({
      statusCode: 403,
      code: 'ENGAGEMENT_SELF_APPROVAL_FORBIDDEN',
    });

    await expect(approveCampaign({
      tenantId: TENANT_ID,
      campaignId: campaign.id,
      actorRole: 'DOCTOR',
      reason: 'Missing approver identity',
    })).rejects.toMatchObject({
      statusCode: 403,
      code: 'ENGAGEMENT_APPROVER_IDENTITY_REQUIRED',
    });

    await expect(approveCampaign({
      tenantId: TENANT_ID,
      campaignId: campaign.id,
      actorUid: APPROVER_UID,
      actorRole: 'DOCTOR',
    })).rejects.toMatchObject({
      statusCode: 400,
      code: 'ENGAGEMENT_APPROVAL_REASON_REQUIRED',
    });

    await expect(approveCampaign({
      tenantId: TENANT_ID,
      campaignId: campaign.id,
      actorUid: APPROVER_UID,
      actorRole: 'DOCTOR',
      reason: 'x'.repeat(1001),
    })).rejects.toMatchObject({
      statusCode: 400,
      code: 'ENGAGEMENT_APPROVAL_REASON_INVALID',
    });

    await approveCampaign({
      tenantId: TENANT_ID,
      campaignId: campaign.id,
      actorUid: APPROVER_UID,
      actorRole: 'DOCTOR',
      reason: 'Audience and consent dry-run reviewed',
    });

    const approvalRows = await prisma.$queryRawUnsafe(
      `SELECT submitted_by::text, approved_by::text, status
         FROM engagement_campaigns
        WHERE tenant_id = $1::uuid
          AND id = $2::bigint`,
      TENANT_ID,
      campaign.id,
    );
    expect(approvalRows[0]).toEqual(expect.objectContaining({
      submitted_by: ACTOR_UID,
      approved_by: APPROVER_UID,
      status: 'scheduled',
    }));

    const transitionAudit = await prisma.$queryRawUnsafe(
      `SELECT uid::text, role, metadata
         FROM audit_logs
        WHERE action = 'ENGAGEMENT_CAMPAIGN_STATUS_CHANGED'
          AND resource = 'engagement_campaign'
          AND resource_id = $1
          AND metadata->>'tenant_id' = $2
        ORDER BY id`,
      String(campaign.id),
      TENANT_ID,
    );
    expect(transitionAudit).toHaveLength(2);
    expect(transitionAudit[1]).toEqual(expect.objectContaining({
      uid: APPROVER_UID,
      role: 'DOCTOR',
      metadata: expect.objectContaining({
        previous_status: 'pending_approval',
        next_status: 'scheduled',
        reason: 'Audience and consent dry-run reviewed',
      }),
    }));

    const queued = await queueDueCampaignRecipients({ tenantId: TENANT_ID, campaignId: campaign.id, limit: 10 });
    expect(queued).toEqual({ claimed: 1, queued: 1, suppressed: 0, failed: 0 });

    const recipientRows = await prisma.$queryRawUnsafe(
      `SELECT patient_uid::text, status, suppression_reason, outbox_id
         FROM engagement_campaign_recipients
        WHERE tenant_id = $1::uuid
          AND campaign_id = $2::bigint
        ORDER BY patient_uid::text`,
      TENANT_ID,
      campaign.id,
    );
    const eligible = recipientRows.find((row) => row.patient_uid === PATIENT_ELIGIBLE);
    expect(eligible.status).toBe('queued');
    expect(eligible.outbox_id).toBeTruthy();
    expect(recipientRows.filter((row) => row.status === 'suppressed')).toHaveLength(3);

    const outboxRows = await prisma.$queryRawUnsafe(
      `SELECT id, type, recipient_phone, title, body, payload
         FROM notification_outbox
        WHERE payload->>'campaign_id' = $1`,
      String(campaign.id),
    );
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0].type).toBe('engagement_campaign');
    expect(outboxRows[0].payload.channels).toEqual(['sms']);
    expect(outboxRows[0].body).toContain('tomorrow morning');
  });
});
