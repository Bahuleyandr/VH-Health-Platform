import { readFileSync } from 'node:fs';

function source(relativePath) {
  return readFileSync(new URL(`../../${relativePath}`, import.meta.url), 'utf8');
}

function between(text, start, end) {
  const from = text.indexOf(start);
  const to = text.indexOf(end, from + start.length);
  if (from < 0 || to < 0) throw new Error(`Unable to isolate ${start}`);
  return text.slice(from, to);
}

describe('MAR route closure contracts', () => {
  const routes = source('routes/clinical/clinicalRoutes.js');

  test('manual MAR scheduling is readiness-only and points to governed CPOE', () => {
    const schedule = between(routes, "router.post('/mar/schedule'", '/**\n * POST /clinical/mar/:id/administer');
    expect(schedule).toContain('MAR_SCHEDULE_REQUIRES_CLINICAL_ORDER_WORKFLOW');
    expect(schedule).toContain('/api/v1/emr/orders');
    expect(schedule).not.toContain('scheduleMedications(');
  });

  test.each([
    ['miss', 'mar_miss', 'recordMissed'],
    ['hold', 'mar_hold', 'holdMedication'],
  ])('%s requires idempotency and passes the atomic claim', (path, scope, serviceMethod) => {
    const route = between(
      routes,
      `router.post('/mar/:id/${path}'`,
      path === 'miss'
        ? '/**\n * POST /clinical/mar/:id/hold'
        : '/**\n * GET /clinical/mar/patient/:patientUid',
    );
    expect(route).toContain(`requireIdempotencyKey({ required: true, scope: '${scope}' })`);
    expect(route).toContain(`marService.${serviceMethod}(`);
    expect(route).toContain('httpIdempotencyClaimId: req.idempotencyClaim?.id');
    expect(route).toContain('requestFingerprint: req.idempotencyClaim?.requestBodyHash');
  });

  test('ER-to-ICU carryover preserves order, tenant, and supply identity', () => {
    const icu = source('services/clinical/icuService.js');
    const carry = between(icu, 'async function carryErMedicationsToMar', '// "Admit from ER"');
    expect(carry).toContain('tenant_id: tenantOr(tenantId)');
    expect(carry).toContain('clinical_order_id: order.id');
    expect(carry).toContain('supply_quantity_per_dose: supplyQuantityPerDose');
    expect(carry).toContain('tenantId: tenantOr(tenantId)');
  });
});
