import { authClient } from './testClient.js';
import {
  createPlan4DialysisFixture, describeWithDatabase, prisma, setTenantTx,
} from './helpers/plan4DialysisFixtures.js';

describeWithDatabase('Plan 4 PR 3 standalone coherence', () => {
  let fixture;
  let client;
  beforeEach(async () => {
    fixture = await createPlan4DialysisFixture({ activePolicy: false });
    client = authClient(fixture.actor.role, {
      uid: fixture.actor.uid, tenant_id: fixture.tenantId,
    });
  });
  afterEach(async () => { await fixture?.cleanup(); }, 30000);
  afterAll(async () => { await prisma.$disconnect(); });

  test('existingDialysisRouteIsReachableButFuturePlatformMountsAreAbsent', async () => {
    const session = await fixture.schedule();
    const deferred = [
      ['post', `/api/v1/dialysis/sessions/${session.id}/dialyser`],
      ['get', `/api/v1/dialysis/sessions/${session.id}/dialyser`],
      ['post', `/api/v1/dialysis/sessions/${session.id}/dialyser/retrospective-use`],
      ['post', '/api/v1/dialysis/dialysers/1/reprocessing-attempts'],
      ['post', '/api/v1/dialysis/isolation-emergency-authorizations'],
      ['patch', `/api/v1/dialysis/sessions/${session.id}/machine`],
      ['get', '/api/v1/dialysis/machines'],
      ['post', '/api/v1/dialysis/machines'],
      ['patch', '/api/v1/dialysis/machines/1'],
      ['get', '/api/v1/reprocessing/domains'],
      ['post', '/api/v1/reprocessing/domains/dialysis/protocol-revisions'],
      ['post', '/api/v1/reprocessing/domains/dialysis/isolation-setting-revisions'],
      ['post', '/api/v1/reprocessing/exposure-outbox/drain'],
      ['get', '/api/v1/reprocessing/holds/1/evidence'],
      ['get', '/api/v1/cssd/reprocessable-devices'],
      ['post', '/api/v1/cssd/reprocessable-devices/1/receive'],
      ['get', '/api/v1/theatre/1/reprocessable-sets'],
    ];
    expect(deferred).toHaveLength(17);
    const roster = await client.get('/api/v1/dialysis/patients');
    expect(roster.status).toBe(200);
    expect(roster.body.data).toHaveLength(1);
    expect(roster.body.data[0].id).toBe(fixture.patientId);
    const before = await fixture.lifecycle(session.id);
    for (const [method, url] of deferred) {
      const response = await client[method](url).send({});
      expect({ method, url, status: response.status, body: response.body }).toEqual({
        method, url, status: 404,
        body: {
          success: false, code: 'NOT_FOUND',
          message: 'The requested resource was not found.', requestId: expect.any(String),
        },
      });
    }
    expect(await fixture.lifecycle(session.id)).toEqual(before);
  });

  test('existingStartRouteAllowsDarkTenantButEnabledPolicyRequiresCapturedUsage', async () => {
    const population = await setTenantTx(fixture.tenantId, async tx => ({
      policies: await tx.$queryRawUnsafe(
        `SELECT category FROM reprocessing_domain_policies
          WHERE tenant_id = $1::uuid AND domain = 'dialysis' AND category = 'dialyser'`, fixture.tenantId,
      ),
      devices: await tx.$queryRawUnsafe(
        `SELECT id FROM reprocessable_devices
          WHERE tenant_id = $1::uuid AND domain = 'dialysis' AND category = 'dialyser'`, fixture.tenantId,
      ),
    }));
    expect(population.policies).toHaveLength(0);
    expect(population.devices).toHaveLength(0);
    const legacy = await fixture.schedule();
    const started = await client.post(`/api/v1/dialysis/sessions/${legacy.id}/start`).send({});
    expect(started.status).toBe(200);
    expect(started.body.data.status).toBe('in_progress');
    const legacyState = await fixture.lifecycle(legacy.id);
    expect(legacyState.usages).toHaveLength(0);
    expect(legacyState.devices).toHaveLength(0);

    const inserted = await setTenantTx(fixture.tenantId, tx => tx.$queryRawUnsafe(
      `INSERT INTO reprocessing_domain_policies
         (tenant_id,domain,category,reprocessable,max_cycles,allowed_cycle_types,tcv_min_pct,protocol_id,updated_by)
       VALUES ($1::uuid,'dialysis','dialyser',TRUE,3,ARRAY['chemical'],80,$2::int,$3::uuid)
       RETURNING category, reprocessable`,
      fixture.tenantId, fixture.protocol.id, fixture.infectionControlActor.uid,
    ));
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toEqual({ category: 'dialyser', reprocessable: true });
    const enabled = await fixture.schedule();
    const before = await fixture.lifecycle(enabled.id);
    expect(before.usages).toHaveLength(0);
    const refused = await client.post(`/api/v1/dialysis/sessions/${enabled.id}/start`).send({});
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('RPD_DIALYSIS_USAGE_REQUIRED');
    expect(await fixture.lifecycle(enabled.id)).toEqual(before);
  });
});
