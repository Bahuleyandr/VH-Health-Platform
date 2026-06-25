// OpenAPI Phase 5 — billing-masters contract coverage.
// Upserts the full master chain over HTTP and validates every response against
// the canonical spec via assertResponse. Uses unique codes per run (upserts are
// keyed by tenant+code, so fresh codes avoid collisions — no cleanup needed).
import { authClient } from './testClient.js';
import prisma from '../lib/prisma.js';
import { assertResponse } from './helpers/assertSchema.js';

describe('billing-masters contract', () => {
  const admin = authClient('ADMIN');
  const R = Date.now();
  const base = '/api/v1/admin/billing-masters';
  const svcCode = `P5SVC-${R}`;

  let payerId;
  let planId;
  let packageId;

  afterAll(async () => {
    await prisma.$disconnect().catch(() => {});
  });

  it('upserts + lists a payer', async () => {
    const up = await admin.put(`${base}/payers`).send({
      payer_code: `P5PAYER-${R}`, display_name: 'P5 Payer', payer_kind: 'private_insurance',
    });
    expect(up.statusCode).toBe(200);
    assertResponse('PUT', `${base}/payers`, up.body);
    payerId = up.body.data.id;

    const list = await admin.get(`${base}/payers?limit=5`);
    expect(list.statusCode).toBe(200);
    assertResponse('GET', `${base}/payers`, list.body);
  });

  it('upserts + lists a TPA', async () => {
    const up = await admin.put(`${base}/tpas`).send({
      tpa_code: `P5TPA-${R}`, display_name: 'P5 TPA', parent_payer_id: payerId,
    });
    expect(up.statusCode).toBe(200);
    assertResponse('PUT', `${base}/tpas`, up.body);

    const list = await admin.get(`${base}/tpas?limit=5`);
    expect(list.statusCode).toBe(200);
    assertResponse('GET', `${base}/tpas`, list.body);
  });

  it('upserts + lists a tariff plan, then a tariff item', async () => {
    const plan = await admin.put(`${base}/tariff-plans`).send({
      plan_code: `P5PLAN-${R}`, display_name: 'P5 Plan', is_default: false, currency: 'INR', status: 'active',
    });
    expect(plan.statusCode).toBe(200);
    assertResponse('PUT', `${base}/tariff-plans`, plan.body);
    planId = plan.body.data.id;

    const plans = await admin.get(`${base}/tariff-plans?limit=5`);
    expect(plans.statusCode).toBe(200);
    assertResponse('GET', `${base}/tariff-plans`, plans.body);

    const item = await admin.put(`${base}/tariff-items`).send({
      tariff_plan_id: planId, service_code: svcCode, service_kind: 'service',
      display_name: 'P5 Service', unit_price_minor: 50000, taxable: true, tax_rate_pct: 18,
    });
    expect(item.statusCode).toBe(200);
    assertResponse('PUT', `${base}/tariff-items`, item.body);

    const items = await admin.get(`${base}/tariff-plans/${planId}/items?limit=5`);
    expect(items.statusCode).toBe(200);
    assertResponse('GET', `${base}/tariff-plans/{planId}/items`, items.body);
  });

  it('upserts + lists a package, then a package item', async () => {
    const pkg = await admin.put(`${base}/packages`).send({
      package_code: `P5PKG-${R}`, display_name: 'P5 Package', duration_days: 3, fixed_price_minor: 200000, currency: 'INR', status: 'active',
    });
    expect(pkg.statusCode).toBe(200);
    assertResponse('PUT', `${base}/packages`, pkg.body);
    packageId = pkg.body.data.id;

    const pkgs = await admin.get(`${base}/packages?limit=5`);
    expect(pkgs.statusCode).toBe(200);
    assertResponse('GET', `${base}/packages`, pkgs.body);

    const pitem = await admin.post(`${base}/packages/${packageId}/items`).send({
      service_code: svcCode, service_kind: 'service', display_name: 'P5 Pkg Item', quantity: 2, unit_price_minor: 25000, is_included: true,
    });
    expect([200, 201]).toContain(pitem.statusCode);
    assertResponse('POST', `${base}/packages/{packageId}/items`, pitem.body);

    const pitems = await admin.get(`${base}/packages/${packageId}/items?limit=5`);
    expect(pitems.statusCode).toBe(200);
    assertResponse('GET', `${base}/packages/{packageId}/items`, pitems.body);
  });

  it('links a payer↔tariff plan, lists links, then resolves a price', async () => {
    const link = await admin.post(`${base}/payer-tariff-links`).send({
      payer_id: payerId, tariff_plan_id: planId, is_primary: true, status: 'active',
    });
    expect([200, 201]).toContain(link.statusCode);
    assertResponse('POST', `${base}/payer-tariff-links`, link.body);

    const links = await admin.get(`${base}/payer-tariff-links?payer_id=${payerId}`);
    expect(links.statusCode).toBe(200);
    assertResponse('GET', `${base}/payer-tariff-links`, links.body);

    const price = await admin.get(`${base}/resolve-price?service_code=${svcCode}&payer_id=${payerId}`);
    expect(price.statusCode).toBe(200);
    assertResponse('GET', `${base}/resolve-price`, price.body);
    expect(price.body.data).not.toBeNull(); // chain set up above should resolve
  });
});
