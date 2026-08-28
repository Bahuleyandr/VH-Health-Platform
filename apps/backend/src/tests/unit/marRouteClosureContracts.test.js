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
    expect(route).toContain(`scope: '${scope}'`);
    expect(route).toContain('requestBodyForIdempotency: marTransitionIdempotencyBody');
    expect(route).toContain(`marService.${serviceMethod}(`);
    expect(route).toContain('httpIdempotencyClaimId: req.idempotencyClaim?.id');
    expect(route).toContain('requestFingerprint: req.idempotencyClaim?.requestBodyHash');
  });

  test('MAR supply reconciliation is desktop/tablet-only before request validation or mutation', () => {
    const route = between(
      routes,
      "'/mar/:id/supply-overrides/:consumptionId/reconcile'",
      '/**\n * POST /clinical/mar/:id/miss',
    );
    expect(routes).toContain(
      "import { enforceStaffClinicalWriteDevicePosture } from '../../middleware/rejectMobileClinicalWriteMiddleware.js';",
    );
    expect(route).toContain('enforceStaffClinicalWriteDevicePosture');
    expect(route.indexOf('enforceStaffClinicalWriteDevicePosture')).toBeLessThan(
      route.indexOf("canonicalMedicationAdministrationIdParam('id')"),
    );
    expect(route.indexOf('enforceStaffClinicalWriteDevicePosture')).toBeLessThan(
      route.indexOf('requireMarSupplyReconciliationRole'),
    );
    expect(route.indexOf('enforceStaffClinicalWriteDevicePosture')).toBeLessThan(
      route.indexOf('reconcileMarSupplyOverride'),
    );
  });

  test('ER-to-ICU carryover uses the canonical order scheduler and leaves an actionable recovery path', () => {
    const icu = source('services/clinical/icuService.js');
    const carry = between(icu, 'export async function carryMedicationOrdersToMar', 'async function carryErMedicationsToMar');
    const query = between(icu, 'async function carryErMedicationsToMar', 'const ORDER_MAR_CARRYOVER_SELECT');
    expect(query).toContain('tenant_id: tenantOr(tenantId)');
    expect(query).toContain("status: { in: ['ordered', 'verified', 'in_progress'] }");
    expect(carry).toContain('scheduleMedicationOrderOnMar');
    expect(carry).toContain("stage: 'mar_carryover'");
    expect(carry).toContain('recovery_endpoint: `/api/v1/emr/orders/${order.id}/retry-mar-scheduling`');
    expect(carry).toContain('requires_doctor_authority: true');
  });

  test('clinical-order MAR recovery is doctor-gated, patient-guarded, and replay-safe', () => {
    const orderRoutes = source('routes/emr/orderRoutes.js');
    const retry = between(
      orderRoutes,
      "'/orders/:id/retry-mar-scheduling'",
      '// ===================================================================\n// PUT /emr/orders/:id/verify',
    );
    expect(retry).toContain("requireIdempotencyKey({ required: true, scope: 'clinical_order_mar_retry' })");
    expect(retry).toContain('guardClinicalOrderMarRecovery');
    expect(retry).toContain('requireMedicationOrderWriteRole');
    expect(retry).toContain('requireMedicationOrderMarRecoveryAuthority');
    expect(retry).toContain('retryMedicationOrderMarScheduling');
    expect(retry.indexOf('requireMedicationOrderWriteRole')).toBeLessThan(
      retry.indexOf('guardClinicalOrderMarRecovery'),
    );
    expect(retry.indexOf('guardClinicalOrderMarRecovery')).toBeLessThan(
      retry.indexOf('requireMedicationOrderMarRecoveryAuthority'),
    );
    expect(retry.indexOf('requireMedicationOrderMarRecoveryAuthority')).toBeLessThan(
      retry.indexOf("requireIdempotencyKey({ required: true, scope: 'clinical_order_mar_retry' })"),
    );

    const service = source('services/emr/orderEntryService.js');
    const recover = between(
      service,
      'export async function retryMedicationOrderMarScheduling',
      'async function dispatchOrderIntegrations',
    );
    expect(recover).toContain('scheduleMedicationOrderOnMar(currentOrder');
    expect(recover).toContain("eventType: 'mar.scheduling_recovered'");
    expect(recover).toContain('clinical_orders:${currentOrder.id}:mar_scheduling_recovered');
  });
});
