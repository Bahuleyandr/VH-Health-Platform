// apps/backend/src/tests/engagement-list-endpoints.deep.test.js
//
// Covers the read half of the NL9 engagement console
// (routes/engagement/engagementListQueries.js), added because the router
// shipped write-only and a campaign parked in `pending_approval` was
// invisible to anyone but the session that submitted it.
//
// The suite owns its own tenants (TENANT_A / TENANT_B) so the isolation
// assertion is real rather than incidental, and so a parallel shard cannot
// see its rows.

import {
  getEngagementCampaign,
  listEngagementCampaigns,
  listEngagementTemplates,
} from '../routes/engagement/engagementListQueries.js';
import prisma from '../lib/prisma.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TENANT_A = '00000000-0000-4000-8000-00000000ea01';
const TENANT_B = '00000000-0000-4000-8000-00000000ea02';
const ACTOR_UID = '00000000-0000-4000-8000-00000000eaaa';
const NOTIFICATION_TEMPLATE_NAME = 'engage-list-test-copy';

const seeded = {
  notificationTemplateId: null,
  templateA: null,
  templateARetired: null,
  templateB: null,
  campaigns: [],
  campaignB: null,
};

async function cleanup() {
  for (const tenant of [TENANT_A, TENANT_B]) {
    await prisma.$executeRawUnsafe(`DELETE FROM engagement_campaigns WHERE tenant_id = $1::uuid`, tenant).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM engagement_templates WHERE tenant_id = $1::uuid`, tenant).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM engagement_settings WHERE tenant_id = $1::uuid`, tenant).catch(() => {});
  }
  await prisma.$executeRawUnsafe(
    `DELETE FROM notification_templates WHERE name = $1`,
    NOTIFICATION_TEMPLATE_NAME,
  ).catch(() => {});
  for (const tenant of [TENANT_A, TENANT_B]) {
    await prisma.$executeRawUnsafe(`DELETE FROM tenants WHERE id = $1::uuid`, tenant).catch(() => {});
  }
}

async function insertTemplate(tenantId, { channel, kind = 'appointment_recall', retired = false }) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO engagement_templates
       (tenant_id, notification_template_id, template_kind, channel,
        variables_schema, allowed_variables, phi_classification, locale,
        approved_by, approved_at, retired_at, created_by, updated_at)
     VALUES ($1::uuid, $2::int, $3, $4, '{"allowed":[]}'::jsonb, '{}'::text[],
             'minimal', 'en-IN', $5::uuid, NOW(),
             CASE WHEN $6 THEN NOW() ELSE NULL END, $5::uuid, NOW())
     RETURNING id`,
    tenantId,
    seeded.notificationTemplateId,
    kind,
    channel,
    ACTOR_UID,
    retired,
  );
  return Number(rows[0].id);
}

async function insertCampaign(tenantId, templateId, { status, campaignType = 'appointment_recall' }) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO engagement_campaigns
       (tenant_id, campaign_type, objective, status, template_id, channels,
        audience_kind, approval_required_role, created_by, updated_at)
     VALUES ($1::uuid, $2, $3, $4, $5::bigint, ARRAY['sms']::text[],
             'cohort', 'care_team', $6::uuid, NOW())
     RETURNING id`,
    tenantId,
    campaignType,
    `objective ${status}`,
    status,
    templateId,
    ACTOR_UID,
  );
  return Number(rows[0].id);
}

async function seed() {
  for (const [tenant, slug] of [[TENANT_A, 'engage-list-a'], [TENANT_B, 'engage-list-b']]) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name) VALUES ($1::uuid, $2, $3)
       ON CONFLICT (id) DO NOTHING`,
      tenant,
      slug,
      `Engagement list ${slug}`,
    );
  }

  const copy = await prisma.$queryRawUnsafe(
    `INSERT INTO notification_templates
       (name, title_template, message_template, type, priority, variables, is_active, updated_at)
     VALUES ($1, 'Visit reminder', 'Hi {{first_name}}.', 'engagement_campaign',
             'NORMAL', '[]'::jsonb, true, NOW())
     RETURNING id`,
    NOTIFICATION_TEMPLATE_NAME,
  );
  seeded.notificationTemplateId = copy[0].id;

  seeded.templateA = await insertTemplate(TENANT_A, { channel: 'sms' });
  seeded.templateARetired = await insertTemplate(TENANT_A, { channel: 'push', retired: true });
  seeded.templateB = await insertTemplate(TENANT_B, { channel: 'sms' });

  // Three campaigns for tenant A across two statuses, one for tenant B.
  seeded.campaigns = [
    await insertCampaign(TENANT_A, seeded.templateA, { status: 'draft' }),
    await insertCampaign(TENANT_A, seeded.templateA, { status: 'pending_approval' }),
    await insertCampaign(TENANT_A, seeded.templateA, {
      status: 'pending_approval',
      campaignType: 'no_show_recall',
    }),
  ];
  seeded.campaignB = await insertCampaign(TENANT_B, seeded.templateB, { status: 'pending_approval' });
}

d('NL9 engagement console read endpoints', () => {
  beforeAll(async () => {
    await cleanup();
    await seed();
  }, 60000);

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  }, 60000);

  it('lists a tenant\'s campaigns with the neighbouring pagination envelope', async () => {
    const result = await listEngagementCampaigns(TENANT_A, {});

    expect(result.campaigns).toHaveLength(3);
    expect(result.pagination).toEqual({
      page: 1,
      limit: 20,
      total: 3,
      totalPages: 1,
      hasNext: false,
      hasPrev: false,
    });
    // BIGSERIAL ids must arrive JSON-safe, not as BigInt — a BigInt would make
    // res.json() throw at serialise time rather than fail a test.
    for (const row of result.campaigns) {
      expect(typeof row.id).toBe('number');
      expect(typeof row.created_at).toBe('string');
    }
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it('is the endpoint a second approver needs: filters to pending_approval', async () => {
    const result = await listEngagementCampaigns(TENANT_A, { status: 'pending_approval' });

    expect(result.pagination.total).toBe(2);
    expect(result.campaigns.map((row) => row.status)).toEqual(['pending_approval', 'pending_approval']);
  });

  it('filters by campaign_type and paginates', async () => {
    const byType = await listEngagementCampaigns(TENANT_A, { campaign_type: 'no_show_recall' });
    expect(byType.pagination.total).toBe(1);
    expect(byType.campaigns[0].campaign_type).toBe('no_show_recall');

    const firstPage = await listEngagementCampaigns(TENANT_A, { limit: 2, page: 1 });
    expect(firstPage.campaigns).toHaveLength(2);
    expect(firstPage.pagination).toMatchObject({ total: 3, totalPages: 2, hasNext: true, hasPrev: false });

    const secondPage = await listEngagementCampaigns(TENANT_A, { limit: 2, page: 2 });
    expect(secondPage.campaigns).toHaveLength(1);
    expect(secondPage.pagination).toMatchObject({ hasNext: false, hasPrev: true });

    const ids = [...firstPage.campaigns, ...secondPage.campaigns].map((row) => row.id);
    expect(new Set(ids).size).toBe(3);
  });

  it('rejects an unknown filter value instead of returning an empty page', async () => {
    await expect(listEngagementCampaigns(TENANT_A, { status: 'not_a_status' }))
      .rejects.toMatchObject({ statusCode: 400, code: 'ENGAGEMENT_BAD_LIST_FILTER' });
    await expect(listEngagementCampaigns(TENANT_A, { campaign_type: 'not_a_type' }))
      .rejects.toMatchObject({ statusCode: 400, code: 'ENGAGEMENT_BAD_LIST_FILTER' });
  });

  it('never returns another tenant\'s campaigns, by list or by id', async () => {
    const listA = await listEngagementCampaigns(TENANT_A, {});
    expect(listA.campaigns.map((row) => row.id)).not.toContain(seeded.campaignB);
    for (const row of listA.campaigns) expect(row.tenant_id).toBe(TENANT_A);

    await expect(getEngagementCampaign(TENANT_A, seeded.campaignB))
      .rejects.toMatchObject({ statusCode: 404, code: 'ENGAGEMENT_CAMPAIGN_NOT_FOUND' });

    const fromB = await getEngagementCampaign(TENANT_B, seeded.campaignB);
    expect(fromB.id).toBe(seeded.campaignB);
    expect(fromB.tenant_id).toBe(TENANT_B);
  });

  it('reads one campaign by id and rejects a non-numeric id', async () => {
    const campaign = await getEngagementCampaign(TENANT_A, seeded.campaigns[1]);
    expect(campaign.id).toBe(seeded.campaigns[1]);
    expect(campaign.status).toBe('pending_approval');
    expect(Array.isArray(campaign.channels)).toBe(true);

    await expect(getEngagementCampaign(TENANT_A, 'abc'))
      .rejects.toMatchObject({ statusCode: 400, code: 'ENGAGEMENT_BAD_CAMPAIGN_ID' });
  });

  it('hides retired templates unless asked, and scopes templates by tenant', async () => {
    const active = await listEngagementTemplates(TENANT_A, {});
    expect(active.templates.map((row) => row.id)).toEqual([seeded.templateA]);
    expect(active.pagination.total).toBe(1);

    const withRetired = await listEngagementTemplates(TENANT_A, { include_retired: 'true' });
    expect(withRetired.pagination.total).toBe(2);
    expect(withRetired.templates.map((row) => row.id).sort())
      .toEqual([seeded.templateA, seeded.templateARetired].sort());

    const byChannel = await listEngagementTemplates(TENANT_A, { channel: 'push', include_retired: 'true' });
    expect(byChannel.templates.map((row) => row.id)).toEqual([seeded.templateARetired]);

    const tenantB = await listEngagementTemplates(TENANT_B, {});
    expect(tenantB.templates.map((row) => row.id)).toEqual([seeded.templateB]);
  });

  it('requires a tenant context', async () => {
    await expect(listEngagementCampaigns(null, {}))
      .rejects.toMatchObject({ statusCode: 400, code: 'ENGAGEMENT_TENANT_REQUIRED' });
    await expect(listEngagementTemplates('not-a-uuid', {}))
      .rejects.toMatchObject({ statusCode: 400, code: 'ENGAGEMENT_TENANT_REQUIRED' });
  });
});
