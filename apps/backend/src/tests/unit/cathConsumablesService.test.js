import { jest } from '@jest/globals';

const queryRawUnsafeMock = jest.fn();
const executeRawUnsafeMock = jest.fn();
const txMock = {
  $queryRawUnsafe: queryRawUnsafeMock,
  $executeRawUnsafe: executeRawUnsafeMock,
};
const setTenantTxMock = jest.fn(async (_tenantId, callback) => callback(txMock));
const recordMovementMock = jest.fn();
const addInvoiceItemMock = jest.fn();
const createDraftInvoiceMock = jest.fn();
const startWorkflowSlaMock = jest.fn();
const createCathInventoryShortfallTaskTxMock = jest.fn();
const queueNotificationMock = jest.fn();
const assertFacilityGrantMock = jest.fn();
const loggerMock = {
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: txMock,
  setTenantTx: setTenantTxMock,
  // The quick-wins merge widened cathLabService's import graph (follow-up
  // rails → reliabilityMetrics → lib/prisma named exports); an ESM mock must
  // satisfy every named import in the loaded graph, so provide the full
  // standard surface.
  setTenant: setTenantTxMock,
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(txMock),
  pickTenantClient: () => txMock,
  isTenantTransactionClient: value => value === txMock,
  prismaReadOnly: txMock,
  circuitBreakerStatus: () => ({ open: false, consecutiveFailures: 0 }),
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({ default: loggerMock }));

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  requireTenantId: (tenantId) => tenantId,
  // P1e's tenantSettingsService (in cathLabService's import graph since the
  // quick-wins merge) imports getTenantById — an ESM mock must satisfy every
  // named import of the module or the whole suite fails to load.
  getTenantById: jest.fn(async () => null),
}));

// The quick-wins merge gave cathLabService a completion-fact seam into the
// follow-up rails, whose transitive graph (tenant settings, reliability
// metrics, IPD support, engagement) is irrelevant to consumables units —
// mock the seam at its source instead of chasing its imports.
jest.unstable_mockModule('../../services/clinical/cathQuickWinsService.js', () => ({
  emitCathProcedureCompletionFollowUps: jest.fn(async () => ({ emitted: 0 })),
}));

jest.unstable_mockModule('../../services/billing/billingV2Service.js', () => ({
  addInvoiceItem: addInvoiceItemMock,
  createDraftInvoice: createDraftInvoiceMock,
}));

jest.unstable_mockModule('../../services/pharmacy/inventoryV2Service.js', () => ({
  recordMovementTx: recordMovementMock,
}));

jest.unstable_mockModule('../../services/pharmacy/pharmacyFacilityAuthorityService.js', () => ({
  assertPharmacyFacilityGrant: assertFacilityGrantMock,
}));

jest.unstable_mockModule('../../services/workflow/taskService.js', () => ({
  claimInboxTask: jest.fn(),
  completeTaskFromDomainEvidence: jest.fn(),
  createCathInventoryShortfallTaskTx: createCathInventoryShortfallTaskTxMock,
  recoverCathInventoryShortfallTaskAssignmentTx: jest.fn(),
}));

jest.unstable_mockModule('../../utils/notifications/notificationOutbox.js', () => ({
  notificationOutbox: { queue: queueNotificationMock },
}));

jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  cancelWorkflowSla: jest.fn(),
  completeWorkflowSla: jest.fn(),
  recordCanonicalClinicalEvent: jest.fn(),
  startWorkflowSla: startWorkflowSlaMock,
}));

// P1f's complication-registry seam joined cathLabService's import graph the
// same way P1e's follow-up seam did — mock it at the source so its subtree
// (canonical audit writes, cockpit, BI registration) stays out of these units.
jest.unstable_mockModule('../../services/clinical/cathSchedulingRegistryService.js', () => ({
  deriveComplicationRegistryRows: jest.fn(async () => []),
}));

// Device reuse widened cathLabService's import graph again: the reuse service
// pulls cdsEngine (which needs canonical exports this mock does not carry) and
// bloodborneMarkerService needs setTenant. Both are covered end to end by
// cath-device-reuse.deep.test.js, so stub the boundary here.
jest.unstable_mockModule('../../services/clinical/cathDeviceReuseService.js', () => ({
  captureReusedDeviceTx: jest.fn(),
  markDeviceInCaseTx: jest.fn(),
}));
jest.unstable_mockModule('../../services/clinical/bloodborneMarkerService.js', () => ({
  resolveReuseStatus: jest.fn(async () => ({
    status: 'unknown', reasons: ['HIV not on record'], markers: [], validity_days: 90,
  })),
}));

jest.unstable_mockModule('../../services/staff/credentialingService.js', () => ({
  assertPrivilegeForGate: jest.fn(),
  isGateEnabled: jest.fn(() => false),
  privilegeKey: jest.fn((value) => value),
}));

const {
  __testing__,
  getCathConsumableInventoryReconciliation,
  listCatalogBatches,
  listCaseConsumableUsage,
  listConsumableCatalog,
  listUnbilledConsumableUsage,
  maybeEmitCathBillingLines,
  upsertCathConsumablesBillingSettings,
  upsertConsumableCatalogItem,
} = await import('../../services/clinical/cathLabService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const ACTOR = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  queryRawUnsafeMock.mockReset();
  executeRawUnsafeMock.mockReset();
  executeRawUnsafeMock.mockResolvedValue(0);
  setTenantTxMock.mockClear();
  recordMovementMock.mockReset();
  addInvoiceItemMock.mockReset();
  createDraftInvoiceMock.mockReset();
  startWorkflowSlaMock.mockReset();
  startWorkflowSlaMock.mockResolvedValue({ id: 501 });
  createCathInventoryShortfallTaskTxMock.mockReset();
  createCathInventoryShortfallTaskTxMock.mockResolvedValue({
    id: 601,
    workflow_sla_instance_id: 501,
  });
  queueNotificationMock.mockReset();
  queueNotificationMock.mockResolvedValue({ id: 701 });
  assertFacilityGrantMock.mockReset();
  assertFacilityGrantMock.mockResolvedValue({ grant_id: 81 });
  loggerMock.error.mockClear();
  loggerMock.info.mockClear();
  loggerMock.warn.mockClear();
});

describe('cath consumable inventory integration', () => {
  test('denies reconciliation GET when the exact case facility grant is absent', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([{ uid: ACTOR, role: 'PHARMACIST' }])
      .mockResolvedValueOnce([{
        usage_id: 73,
        case_id: 19,
        facility_id: 4,
        patient_uid: ACTOR,
      }]);
    assertFacilityGrantMock.mockRejectedValueOnce(Object.assign(
      new Error('facility grant required'),
      { code: 'PHARMACY_FACILITY_GRANT_REQUIRED', statusCode: 403 },
    ));

    await expect(getCathConsumableInventoryReconciliation(19, 73, {
      tenantId: TENANT,
      actorUid: ACTOR,
      actorRole: 'PHARMACIST',
      actorRoles: ['PHARMACIST'],
    })).rejects.toMatchObject({
      code: 'PHARMACY_FACILITY_GRANT_REQUIRED',
      statusCode: 403,
    });
    expect(assertFacilityGrantMock).toHaveBeenCalledWith(txMock, expect.objectContaining({
      tenantId: TENANT,
      facilityId: 4,
      actorUid: ACTOR,
      actorRole: 'PHARMACIST',
      forUpdate: false,
    }));
  });

  test('rejects an incomplete canonical event so the usage transaction rolls back', () => {
    expect(() => __testing__.requireCanonicalEvent({
      timeline: { id: '11111111-1111-4111-8111-111111111111' },
      audit: null,
    })).toThrow(expect.objectContaining({
      statusCode: 500,
      code: 'CATH_CONSUMABLE_CANONICAL_EVENT_REQUIRED',
    }));

    expect(() => __testing__.requireCanonicalEvent({
      timeline: null,
      audit: { id: 31 },
    })).toThrow(expect.objectContaining({
      statusCode: 500,
      code: 'CATH_CONSUMABLE_CANONICAL_EVENT_REQUIRED',
    }));
  });

  test('limits use and wastage capture to clinically valid case states', () => {
    expect(__testing__.canRecordConsumableForCaseStatus('in_progress', false)).toBe(true);
    expect(__testing__.canRecordConsumableForCaseStatus('completed', false)).toBe(true);
    expect(__testing__.canRecordConsumableForCaseStatus('ready', false)).toBe(false);
    expect(__testing__.canRecordConsumableForCaseStatus('cancelled', false)).toBe(false);
    expect(__testing__.canRecordConsumableForCaseStatus('ready', true)).toBe(true);
    expect(__testing__.canRecordConsumableForCaseStatus('cancelled', true)).toBe(true);
    expect(__testing__.canRecordConsumableForCaseStatus('scheduled', true)).toBe(false);
  });

  test('cannot disable implant tracking for an always-implant category', async () => {
    await expect(upsertConsumableCatalogItem({
      tenantId: TENANT,
      item_name: 'Coronary stent',
      category: 'stent',
      is_implant: false,
      batch_tracked: true,
    })).rejects.toMatchObject({
      statusCode: 400,
      code: 'CATH_CONSUMABLE_IMPLANT_TRACKING_REQUIRED',
    });
    expect(queryRawUnsafeMock).not.toHaveBeenCalled();
  });

  test('validates linked inventory with its tenant field, not a nonexistent case field', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([{
        id: 17,
        tenant_id: TENANT,
        facility_id: 4,
        inventory_item_status: 'active',
        facility_status: 'active',
      }])
      .mockResolvedValueOnce([{ uid: ACTOR, role: 'ADMIN', name: 'Cath Admin' }])
      .mockResolvedValueOnce([{ id: 5 }])
      .mockResolvedValueOnce([{
        id: 5,
        tenant_id: TENANT,
        facility_id: 4,
        inventory_item_id: 17,
        item_name: 'Guidewire',
        category: 'guidewire',
        is_implant: false,
        batch_tracked: false,
        status: 'active',
      }]);

    await expect(upsertConsumableCatalogItem({
      tenantId: TENANT,
      item_name: 'Guidewire',
      category: 'guidewire',
      inventory_item_id: 17,
    }, { actorUid: ACTOR })).resolves.toMatchObject({
      id: 5,
      facility_id: 4,
      inventory_item_id: 17,
    });

    expect(queryRawUnsafeMock.mock.calls[0][0]).toContain('SELECT item.id, item.tenant_id');
    expect(queryRawUnsafeMock.mock.calls[0][0]).toContain("facility.status = 'active'");
    expect(queryRawUnsafeMock.mock.calls[0][0]).not.toContain('case_id');
    expect(queryRawUnsafeMock.mock.calls[0].slice(1)).toEqual([17, TENANT]);
  });

  test.each([
    ['relink', 18],
    ['removal', null],
  ])('blocks inventory link %s once catalog authority is pinned', async (_label, nextInventoryId) => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([{
        id: 5,
        tenant_id: TENANT,
        inventory_item_id: 17,
        item_name: 'Guidewire',
        category: 'guidewire',
        manufacturer: null,
        model: null,
        is_implant: false,
        batch_tracked: false,
        status: 'active',
        metadata: {},
      }])
      .mockResolvedValueOnce([]); // no governed recovery command is open

    await expect(upsertConsumableCatalogItem({
      tenantId: TENANT,
      id: 5,
      inventory_item_id: nextInventoryId,
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'CATH_CONSUMABLE_INVENTORY_LINK_IMMUTABLE',
    });

    expect(queryRawUnsafeMock.mock.calls[1][0]).toContain(
      'FROM pharmacy_inventory_authority_recovery_worklist',
    );
    // Call 1 is now the MED-03 governed-recovery guard, not the usage lookup
    // this assertion was originally written against, and it spells its
    // predicate in the compact house style of the 753 authority lane. Pin the
    // whole tenant/entity/status predicate rather than the tenant clause
    // alone, so a guard that stopped scoping by entity or stopped restricting
    // to OPEN recoveries fails here too.
    expect(queryRawUnsafeMock.mock.calls[1][0]).toContain('tenant_id=$1::uuid');
    expect(queryRawUnsafeMock.mock.calls[1][0]).toContain(
      "entity_type='cath_consumable_catalog'",
    );
    expect(queryRawUnsafeMock.mock.calls[1][0]).toContain('entity_id=$2::bigint');
    expect(queryRawUnsafeMock.mock.calls[1][0]).toContain("status='OPEN'");
    expect(queryRawUnsafeMock.mock.calls[1].slice(1)).toEqual([TENANT, 5]);
    expect(queryRawUnsafeMock).toHaveBeenCalledTimes(2);
  });

  test('lets an owner clear catalog billing, cost, manufacturer, and model fields', async () => {
    const existing = {
      id: 5,
      tenant_id: TENANT,
      facility_id: 4,
      inventory_item_id: 17,
      item_name: 'Guidewire',
      category: 'guidewire',
      manufacturer: 'Old maker',
      model: 'Old model',
      is_implant: false,
      batch_tracked: false,
      default_unit_cost_reference: 1200,
      billing_item_code: 'OLD-BILLING',
      status: 'active',
      metadata: {},
    };
    queryRawUnsafeMock
      .mockResolvedValueOnce([existing])
      .mockResolvedValueOnce([]) // no governed recovery command is open
      .mockResolvedValueOnce([{
        id: 17,
        tenant_id: TENANT,
        facility_id: 4,
        inventory_item_status: 'active',
        facility_status: 'active',
      }])
      .mockResolvedValueOnce([{ uid: ACTOR, role: 'ADMIN', name: 'Cath Admin' }])
      .mockResolvedValueOnce([{ id: 5 }])
      .mockResolvedValueOnce([{
        ...existing,
        manufacturer: null,
        model: null,
        default_unit_cost_reference: null,
        billing_item_code: null,
      }]);

    await upsertConsumableCatalogItem({
      tenantId: TENANT,
      id: 5,
      manufacturer: null,
      model: null,
      default_unit_cost_reference: null,
      billing_item_code: null,
    }, { actorUid: ACTOR });

    const updateArgs = queryRawUnsafeMock.mock.calls[4].slice(1);
    expect(updateArgs[6]).toBeNull();
    expect(updateArgs[7]).toBeNull();
    expect(updateArgs[10]).toBeNull();
    expect(updateArgs[11]).toBeNull();
  });

  test.each([
    [
      { status: 'recalled', is_expired: false, remaining_quantity: 5 },
      'error',
      /recalled/i,
    ],
    [
      { status: 'in_stock', is_expired: true, remaining_quantity: 5 },
      'error',
      /expired/i,
    ],
    [
      { status: 'in_stock', is_expired: false, remaining_quantity: 0.5 },
      'pending',
      /reconciliation will be materialized/i,
    ],
  ])('preflights exact batch availability without blocking documentation', (
    batch,
    status,
    warning,
  ) => {
    expect(__testing__.evaluateCathInventoryBatch(batch, 1)).toEqual({
      status,
      warning: expect.stringMatching(warning),
    });
  });

  test('detects caller batch lineage that differs from the selected inventory row', () => {
    expect(__testing__.batchLineageMismatch({
      batch_number: 'BATCH-29',
      lot_number: 'LOT-29',
      expiry_date: new Date('2028-12-31T00:00:00.000Z'),
    }, {
      batchNumber: 'BATCH-29',
      lotNumber: 'LOT-X',
      expiryDate: '2028-12-31',
    })).toBe(true);
  });
});

describe('cath consumable reporting and wire shaping', () => {
  test('lets an owner clear the paired procedure billing mapping', async () => {
    const reviewedAt = new Date('2027-01-01T00:00:00.000Z');
    queryRawUnsafeMock
      .mockResolvedValueOnce([{
        tenant_id: TENANT,
        charge_enabled: true,
        procedure_billing_code: 'OLD-PROCEDURE',
        procedure_unit_price: 15000,
        gst_rate: 0,
        finance_reviewed_at: reviewedAt,
        finance_reviewed_by: ACTOR,
        acceptance_snapshot: {},
      }])
      .mockResolvedValueOnce([{
        tenant_id: TENANT,
        charge_enabled: true,
        procedure_billing_code: null,
        procedure_unit_price: null,
        gst_rate: 0,
        finance_reviewed_at: reviewedAt,
        finance_reviewed_by: ACTOR,
        acceptance_snapshot: {},
      }]);

    const result = await upsertCathConsumablesBillingSettings({
      tenantId: TENANT,
      procedure_billing_code: null,
      procedure_unit_price: null,
    }, { actorUid: ACTOR });

    expect(result).toMatchObject({
      procedure_billing_code: null,
      procedure_unit_price: null,
    });
    expect(queryRawUnsafeMock.mock.calls[1].slice(1, 5)).toEqual([
      TENANT,
      true,
      null,
      null,
    ]);
  });

  test('uses the Asia/Kolkata clinical date when offering usable batches', async () => {
    const batchQuery = jest.fn()
      .mockResolvedValueOnce([{ id: 19, patient_uid: ACTOR, facility_id: 4 }])
      .mockResolvedValueOnce([{
        id: 5,
        facility_id: 4,
        inventory_item_id: 17,
        status: 'active',
        inventory_facility_id: 4,
        inventory_item_status: 'active',
        inventory_facility_status: 'active',
      }])
      .mockResolvedValueOnce([]);

    await listCatalogBatches(5, {
      tenantId: TENANT,
      caseId: 19,
      db: { $queryRawUnsafe: batchQuery },
    });

    expect(batchQuery.mock.calls[2][0]).toContain(
      "expiry_date >= (NOW() AT TIME ZONE 'Asia/Kolkata')::date",
    );
    expect(batchQuery.mock.calls[2].slice(1)).toEqual([TENANT, 17, 4]);
  });

  test('catalog search covers billing mappings and inventory display names', async () => {
    const catalogQuery = jest.fn().mockResolvedValueOnce([]);

    await listConsumableCatalog({
      tenantId: TENANT,
      q: 'owner code',
      facilityId: 4,
      db: { $queryRawUnsafe: catalogQuery },
    });

    expect(catalogQuery.mock.calls[0][0]).toContain("LOWER(COALESCE(c.billing_item_code, ''))");
    expect(catalogQuery.mock.calls[0][0]).toContain("LOWER(COALESCE(i.display_name, ''))");
    expect(catalogQuery.mock.calls[0].slice(1, 3)).toEqual([TENANT, 4]);
  });

  test('case-scoped catalog reads exclude stale or cross-facility inventory mappings', async () => {
    const catalogQuery = jest.fn()
      .mockResolvedValueOnce([{ id: 19, patient_uid: ACTOR, facility_id: 4 }])
      .mockResolvedValueOnce([]);

    await listConsumableCatalog({
      tenantId: TENANT,
      caseId: 19,
      db: { $queryRawUnsafe: catalogQuery },
    });

    const sql = catalogQuery.mock.calls[1][0];
    expect(sql).toContain('c.facility_id = $2::int');
    expect(sql).toContain("c.status = 'active'");
    expect(sql).toContain("i.status = 'active'");
    expect(sql).toContain('i.facility_id = c.facility_id');
    expect(sql).toContain("f.status = 'active'");
    expect(catalogQuery.mock.calls[1].slice(1, 3)).toEqual([TENANT, 4]);
  });

  test('returns tenant-scoped clinician attribution with case usage', async () => {
    const usageQuery = jest.fn().mockResolvedValueOnce([{
      id: 73,
      used_by: ACTOR,
      used_by_name: 'Dr Cath',
    }]);

    const rows = await listCaseConsumableUsage(19, {
      tenantId: TENANT,
      db: { $queryRawUnsafe: usageQuery },
    });

    expect(rows[0]).toMatchObject({ used_by: ACTOR, used_by_name: 'Dr Cath' });
    expect(usageQuery.mock.calls[0][0]).toContain('clinician.uid = u.used_by');
    expect(usageQuery.mock.calls[0][0]).toContain('clinician.tenant_id = u.tenant_id');
  });

  test('normalizes database Date objects and rejects impossible calendar dates', () => {
    expect(__testing__.optionalDate(new Date('2027-03-15T00:00:00.000Z'), 'expiry_date'))
      .toBe('2027-03-15');
    expect(__testing__.optionalDate('2027-03-15T08:30:00.000Z', 'expiry_date'))
      .toBe('2027-03-15');
    expect(() => __testing__.optionalDate('2027-02-30', 'expiry_date'))
      .toThrow('expiry_date must be a valid date');
    expect(() => __testing__.optionalDate(new Date('invalid'), 'expiry_date'))
      .toThrow('expiry_date must be a valid date');
  });

  test('preserves unmapped usage in the unbilled report', async () => {
    const reportQuery = jest.fn()
      .mockResolvedValueOnce([{ total: 1 }])
      .mockResolvedValueOnce([{
        usage_id: 73,
        case_id: 19,
        item_name: 'Drug-eluting stent',
        category: 'stent',
        quantity: 1,
        billing_item_code: null,
        billing_gap_reason: 'billing_code_not_mapped',
      }]);

    const result = await listUnbilledConsumableUsage({
      tenantId: TENANT,
      page: 2,
      limit: 25,
      db: { $queryRawUnsafe: reportQuery },
    });

    expect(result).toMatchObject({
      count: 1,
      total: 1,
      page: 2,
      limit: 25,
    });
    expect(result.items).toEqual([
      expect.objectContaining({
        usage_id: 73,
        item_name: 'Drug-eluting stent',
        billing_item_code: null,
        billing_gap_reason: 'billing_code_not_mapped',
      }),
    ]);
    expect(reportQuery.mock.calls[1][0]).toContain("c.billing_item_code IS NULL");
    expect(reportQuery.mock.calls[1][0]).toContain("'billing_code_not_mapped'");
    expect(reportQuery.mock.calls[1][0]).toContain('bsm.tenant_id = u.tenant_id');
    expect(reportQuery.mock.calls[1][0]).toContain('bii.tenant_id = u.tenant_id');
    expect(reportQuery.mock.calls[1][0]).toContain('bii.source_ref_active = TRUE');
    expect(reportQuery.mock.calls[1].slice(-2)).toEqual([25, 25]);
  });

  test('applies unbilled report date boundaries to the Asia/Kolkata calendar day', async () => {
    const reportQuery = jest.fn()
      .mockResolvedValueOnce([{ total: 0 }])
      .mockResolvedValueOnce([]);

    await listUnbilledConsumableUsage({
      tenantId: TENANT,
      date_from: '2026-07-11',
      date_to: '2026-07-12',
      db: { $queryRawUnsafe: reportQuery },
    });

    for (const [sql, tenantId, dateFrom, dateTo] of reportQuery.mock.calls) {
      expect(sql).toContain(
        "DATE(u.used_at AT TIME ZONE 'Asia/Kolkata') >= $2::date",
      );
      expect(sql).toContain(
        "DATE(u.used_at AT TIME ZONE 'Asia/Kolkata') <= $3::date",
      );
      expect([tenantId, dateFrom, dateTo]).toEqual([
        TENANT,
        '2026-07-11',
        '2026-07-12',
      ]);
    }
  });

  test('does not bill service codes that are inactive or belong to another tenant', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([{
        tenant_id: TENANT,
        charge_enabled: true,
        procedure_billing_code: 'CATH-PROCEDURE',
        procedure_unit_price: 5000,
        gst_rate: 0,
        finance_reviewed_at: new Date('2027-01-01T00:00:00.000Z'),
      }])
      .mockResolvedValueOnce([{
        id: 19,
        patient_uid: '22222222-2222-4222-8222-222222222222',
        patient_name: 'Patient',
        patient_phone: null,
        admission_id: null,
        requested_procedure: 'PTCA',
        case_status: 'completed',
        procedure_log_id: 41,
        procedure_type: 'PTCA',
      }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ uid: '22222222-2222-4222-8222-222222222222' }])
      .mockResolvedValueOnce([{ id: 88 }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        id: 73,
        quantity: 1,
        wasted: false,
        unit_cost_snapshot: 12000,
        is_implant: true,
        item_name: 'Drug-eluting stent',
        billing_item_code: 'OTHER-TENANT-CODE',
        billing_service_id: null,
        default_unit_cost_reference: 12000,
      }]);

    const result = await maybeEmitCathBillingLines({
      tenantId: TENANT,
      caseId: 19,
      actorUid: ACTOR,
    });

    expect(result).toMatchObject({ emitted: 0, unmapped: 2, failed: 0 });
    expect(result.unmapped_items).toEqual([
      expect.objectContaining({ type: 'procedure', reason: 'billing_code_invalid' }),
      expect.objectContaining({ type: 'consumable', reason: 'billing_code_invalid' }),
    ]);
    expect(addInvoiceItemMock).not.toHaveBeenCalled();
    expect(queryRawUnsafeMock.mock.calls[2][0]).toContain('tenant_id = $1::uuid');
    expect(queryRawUnsafeMock.mock.calls[5][0]).toContain('tenant_id = $2::uuid');
    expect(queryRawUnsafeMock.mock.calls[6][0]).toContain('bsm.tenant_id = u.tenant_id');
  });

  test('uses the active billing tariff instead of the catalog cost reference', async () => {
    const catalogCostReference = 12000;
    const activeBillingTariff = 47000;
    queryRawUnsafeMock
      .mockResolvedValueOnce([{
        tenant_id: TENANT,
        charge_enabled: true,
        procedure_billing_code: null,
        procedure_unit_price: null,
        gst_rate: 0,
        finance_reviewed_at: new Date('2027-01-01T00:00:00.000Z'),
      }])
      .mockResolvedValueOnce([{
        id: 19,
        patient_uid: '22222222-2222-4222-8222-222222222222',
        patient_name: 'Patient',
        patient_phone: null,
        admission_id: null,
        requested_procedure: 'PTCA',
        case_status: 'completed',
        procedure_log_id: 41,
        procedure_type: 'PTCA',
      }])
      .mockResolvedValueOnce([{ uid: '22222222-2222-4222-8222-222222222222' }])
      .mockResolvedValueOnce([{ id: 88 }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        id: 73,
        quantity: 1,
        wasted: false,
        unit_cost_snapshot: catalogCostReference,
        is_implant: true,
        item_name: 'Drug-eluting stent',
        billing_item_code: 'CATH-STENT',
        billing_service_id: 501,
        default_unit_cost_reference: catalogCostReference,
      }]);
    addInvoiceItemMock.mockImplementationOnce(async (_invoiceId, item) => ({
      id: 901,
      unit_price: item.unit_price ?? activeBillingTariff,
    }));

    const result = await maybeEmitCathBillingLines({
      tenantId: TENANT,
      caseId: 19,
      actorUid: ACTOR,
    });

    expect(result).toMatchObject({ emitted: 1, unmapped: 1, failed: 0 });
    expect(addInvoiceItemMock).toHaveBeenCalledWith(88, expect.objectContaining({
      service_code: 'CATH-STENT',
      unit_price: null,
    }));
    const billedLine = await addInvoiceItemMock.mock.results[0].value;
    expect(billedLine.unit_price).toBe(activeBillingTariff);
    expect(billedLine.unit_price).not.toBe(catalogCostReference);
  });

  test('converts NUMERIC values and preserves unsafe BIGINT identifiers for JSON', () => {
    const shaped = __testing__.normalizeDbValue({
      id: 73n,
      quantity: { toNumber: () => 2.5 },
      catalog: {
        id: 9_007_199_254_740_993n,
        default_unit_cost_reference: { toNumber: () => 12500.75 },
      },
      rows: [
        { usage_id: 99n, remaining_quantity: { toNumber: () => 8 } },
        { usage_id: 9_223_372_036_854_775_807n },
      ],
    });

    expect(shaped).toEqual({
      id: 73,
      quantity: 2.5,
      catalog: { id: '9007199254740993', default_unit_cost_reference: 12500.75 },
      rows: [
        { usage_id: 99, remaining_quantity: 8 },
        { usage_id: '9223372036854775807' },
      ],
    });
    expect(() => JSON.stringify(shaped)).not.toThrow();
  });

  test('preserves validated BIGINT request identifiers without numeric rounding', () => {
    expect(__testing__.normalizeId('9007199254740993', 'catalog_item_id'))
      .toBe('9007199254740993');
    expect(__testing__.normalizeId(73, 'catalog_item_id')).toBe(73);
    expect(() => __testing__.normalizeId(9007199254740992, 'catalog_item_id'))
      .toThrow('catalog_item_id must be a positive integer');
    expect(() => __testing__.normalizeId('9223372036854775808', 'catalog_item_id'))
      .toThrow('catalog_item_id must be a positive integer');
  });
});
