// apps/backend/src/tests/cath-device-reuse.deep.test.js
//
// Deep integration for the cath reprocessable-device lifecycle: first use →
// post-use mint → CSSD cycle → reused capture → post-use again, plus the
// late-reactive blood-borne sweep. Runs against a real database; the fixture is
// the one cath-consumables.deep.test.js seeds, re-keyed onto the …c0de tenant so
// the two suites never share a row.
//
// Spec: docs/superpowers/specs/2026-09-04-cath-device-reuse-and-bloodborne-markers-design.md

import prisma, { setTenantTx } from '../lib/prisma.js';
import {
  getCase,
  listCaseConsumableUsage,
  recordConsumableUsage,
  upsertConsumableCatalogItem,
} from '../services/clinical/cathLabService.js';
import {
  decorateConsumablesWithReuse,
  deviceByTag,
  deviceHistory,
  discardDevice,
  listDevices,
  markDeviceReprocessed,
  quarantineDevice,
  quarantineDevicesExposedToPatient,
  receiveDevice,
  recordPostUse,
  releaseDevice,
  upsertCategoryPolicies,
  upsertReprocessingSettings,
} from '../services/clinical/cathDeviceReuseService.js';
import { clinicalDate, recordMarkers } from '../services/clinical/bloodborneMarkerService.js';

const hasDatabaseUrl = Boolean(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const describeIfDb = hasDatabaseUrl ? describe : describe.skip;

const TENANT = '00000000-0000-4000-8000-00000000c0de';
const PATIENT = 'cd000000-0000-4000-8000-00000000c0d1';
const ACTOR = 'cd000000-0000-4000-8000-00000000c0da';
const CSSD_ACTOR = 'cd000000-0000-4000-8000-00000000c0db';
const INFECTION_CONTROL = 'cd000000-0000-4000-8000-00000000c0dc';
const CATALOG_ADMIN = 'cd000000-0000-4000-8000-00000000c0dd';
const BATCH_NUMBER = 'CDR-C0DE-CATH-B1';
// A SECOND catalogue item, batch_tracked, mapped to its own inventory item and
// batch. Migration 765 relaxed cath_consumable_usage_batch_expiry_check so a
// reused row of a batch-tracked item may carry no batch/lot/expiry at all; this
// fixture is what proves it, and catheters are batch-tracked in practice.
const BATCH_TRACKED_BATCH_NUMBER = 'CDR-C0DE-CATH-B2';

// No calendar literals: a fixed expiry or tested_on date silently rots the suite
// the day it passes. Everything is relative to "now" in the clinical time zone.
const dateOffset = (days) => clinicalDate(new Date(Date.now() + days * 86400000));
const daysAgo = (days) => dateOffset(-days);

let facilityId;
let storageLocationId;
let inventoryItemId;
let caseId;
let catalogItemId;
let batchTrackedInventoryItemId;
let batchTrackedCatalogItemId;
let firstUse;
let reusedUsage;
let deviceTags;

const ctx = (actorUid = ACTOR, extra = {}) => ({
  actorUid,
  actorRole: actorUid === CSSD_ACTOR ? 'NURSING_STAFF' : 'DOCTOR',
  tenantId: TENANT,
  requestId: 'cath-device-reuse-deep',
  ...extra,
});

const captureNew = (idempotencyKey) => recordConsumableUsage(caseId, {
  tenantId: TENANT,
  catalog_item_id: catalogItemId,
  quantity: 2,
  batch_number: BATCH_NUMBER,
  expiry_date: dateOffset(700),
}, ctx(ACTOR, { idempotencyKey }));

async function cleanup() {
  await prisma.$transaction(async (tx) => {
    // Teardown runs only on the disposable deep-test database. Disabling user
    // and constraint triggers for this one transaction is what lets the
    // append-only cath usage/audit rows be deleted at all, and what keeps the
    // whole cleanup inside Prisma's interactive-transaction budget — the same
    // note as cath-consumables.deep.test.js. Production paths are untouched.
    await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
    await tx.$executeRawUnsafe("SELECT set_config('app.audit_bypass', 'on', true)");
    for (const sql of [
      `DELETE FROM notification_outbox WHERE tenant_id = $1::uuid`,
      `DELETE FROM cds_alerts WHERE tenant_id = $1::uuid`,
      `DELETE FROM medication_safety_reviews WHERE tenant_id = $1::uuid`,
      `DELETE FROM patient_bloodborne_markers WHERE tenant_id = $1::uuid`,
      `DELETE FROM audit_logs WHERE tenant_id = $1::uuid`,
      `DELETE FROM tasks WHERE tenant_id = $1::uuid`,
      `DELETE FROM workflow_sla_instances WHERE tenant_id = $1::uuid`,
      `DELETE FROM pharmacy_stock_movements WHERE tenant_id = $1::uuid`,
      `DELETE FROM surgical_implants WHERE tenant_id = $1::uuid`,
      // Devices before usage: fk_cath_consumable_usage_device and
      // fk_cath_reprocessable_devices_origin_usage are both RESTRICT.
      `DELETE FROM cath_reprocessable_devices WHERE tenant_id = $1::uuid`,
      `DELETE FROM cath_case_consumable_usage WHERE tenant_id = $1::uuid`,
      `DELETE FROM cath_procedure_logs WHERE tenant_id = $1::uuid`,
      `DELETE FROM cath_lab_cases WHERE tenant_id = $1::uuid`,
      `DELETE FROM cath_consumable_catalog WHERE tenant_id = $1::uuid`,
      `DELETE FROM cath_reprocessing_category_policies WHERE tenant_id = $1::uuid`,
      `DELETE FROM cath_reprocessing_settings WHERE tenant_id = $1::uuid`,
      `DELETE FROM cath_consumables_billing_settings WHERE tenant_id = $1::uuid`,
      `DELETE FROM clinical_audit_events WHERE tenant_id = $1::uuid`,
      `DELETE FROM clinical_timeline_events WHERE tenant_id = $1::uuid`,
      `DELETE FROM pharmacy_inventory_batches WHERE tenant_id = $1::uuid`,
      `DELETE FROM pharmacy_inventory_items WHERE tenant_id = $1::uuid`,
      `DELETE FROM pharmacy_catalog WHERE tenant_id = $1::uuid`,
      `DELETE FROM facility_locations WHERE tenant_id = $1::uuid`,
      `DELETE FROM pharmacy_staff_facility_grants WHERE tenant_id = $1::uuid`,
      `DELETE FROM staff WHERE tenant_id = $1::uuid`,
      `DELETE FROM users WHERE tenant_id = $1::uuid`,
      `DELETE FROM facilities WHERE tenant_id = $1::uuid`,
      `DELETE FROM tenants WHERE id = $1::uuid`,
    ]) {
      await tx.$executeRawUnsafe(sql, TENANT);
    }
  }, { timeout: 30000 });
}

async function seed() {
  await prisma.$executeRawUnsafe(
    `INSERT INTO tenants (id, slug, name) VALUES ($1::uuid, 'cdr-c0de-tenant', 'Cath Device Reuse Tenant')`,
    TENANT,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO users (tenant_id, uid, phone, name, role, is_active, status, updated_at)
     VALUES
       ($1::uuid, $2::uuid, '9011779201', 'Cath Reuse Patient', 'PATIENT', TRUE, 'active', NOW()),
       ($1::uuid, $3::uuid, '9011779202', 'Dr Cath Reuse', 'DOCTOR', TRUE, 'active', NOW()),
       ($1::uuid, $4::uuid, '9011779203', 'CSSD Technician', 'NURSING_STAFF', TRUE, 'active', NOW()),
       ($1::uuid, $5::uuid, '9011779204', 'Infection Control Officer', 'INFECTION_CONTROL_OFFICER', TRUE, 'active', NOW()),
       ($1::uuid, $6::uuid, '9011779205', 'Cath Catalog Admin', 'ADMIN', TRUE, 'active', NOW())`,
    TENANT, PATIENT, ACTOR, CSSD_ACTOR, INFECTION_CONTROL, CATALOG_ADMIN,
  );
  const facilities = await prisma.$queryRawUnsafe(
    `INSERT INTO facilities (tenant_id, facility_code, display_name, status, is_default)
     VALUES ($1::uuid, 'CDR-C0DE-CATH', 'Cath Device Reuse Facility', 'active', FALSE)
     RETURNING id`,
    TENANT,
  );
  facilityId = Number(facilities[0].id);
  const locations = await prisma.$queryRawUnsafe(
    `INSERT INTO facility_locations
       (tenant_id, facility_id, location_code, display_name, location_kind, status)
     VALUES ($1::uuid, $2::int, 'CDR-C0DE-PHARMACY', 'Cath Reuse Pharmacy Store', 'pharmacy', 'active')
     RETURNING id`,
    TENANT, facilityId,
  );
  storageLocationId = Number(locations[0].id);
  await prisma.$executeRawUnsafe(
    `INSERT INTO staff (tenant_id, user_id, employee_id, name, is_active, archived, updated_at)
     VALUES ($1::uuid, $2::uuid, 'CDR-C0DE-ADMIN', 'Cath Catalog Admin', TRUE, FALSE, NOW())`,
    TENANT, CATALOG_ADMIN,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO pharmacy_staff_facility_grants
       (tenant_id, facility_id, staff_uid, status, grant_source, grant_reason, granted_by)
     VALUES ($1::uuid, $2::int, $3::uuid, 'active', 'deep_test',
             'Cath device reuse deep-test facility authority', $3::uuid)`,
    TENANT, facilityId, CATALOG_ADMIN,
  );
  const pharmacyCatalog = await prisma.$queryRawUnsafe(
    `INSERT INTO pharmacy_catalog
       (tenant_id, name, generic_name, category, is_active, is_available, in_stock, stock_quantity, updated_at)
     VALUES ($1::uuid, 'CDR C0de Reusable Catheter', 'Synthetic diagnostic catheter',
             'implant', TRUE, TRUE, TRUE, 5, NOW())
     RETURNING id`,
    TENANT,
  );
  const inventoryItems = await prisma.$queryRawUnsafe(
    `INSERT INTO pharmacy_inventory_items
       (tenant_id, facility_id, catalog_id, sku_code, display_name, unit_label, status)
     VALUES ($1::uuid, $2::int, $3::int, 'CDR-C0DE-CATHETER', 'Deep test reusable catheter', 'each', 'active')
     RETURNING id`,
    TENANT, facilityId, Number(pharmacyCatalog[0].id),
  );
  inventoryItemId = Number(inventoryItems[0].id);
  await prisma.$executeRawUnsafe(
    `INSERT INTO pharmacy_inventory_batches
       (tenant_id, facility_id, inventory_item_id, batch_number, lot_number, expiry_date,
        received_quantity, remaining_quantity, storage_location_id, status)
     VALUES ($1::uuid, $2::int, $3::int, $4::text, 'CDR-C0DE-LOT-B1', $5::date,
             5, 5, $6::int, 'in_stock')`,
    TENANT, facilityId, inventoryItemId, BATCH_NUMBER, dateOffset(700), storageLocationId,
  );
  const cases = await prisma.$queryRawUnsafe(
    `INSERT INTO cath_lab_cases
       (tenant_id, patient_uid, facility_id, requested_procedure, status,
        actual_start_at, created_by, updated_by)
     VALUES ($1::uuid, $2::uuid, $3::int, 'Diagnostic coronary angiogram', 'in_progress',
             NOW() - INTERVAL '30 minutes', $4::uuid, $4::uuid)
     RETURNING id`,
    TENANT, PATIENT, facilityId, ACTOR,
  );
  caseId = Number(cases[0].id);
  const catalog = await upsertConsumableCatalogItem({
    tenantId: TENANT,
    item_name: 'Deep test reusable diagnostic catheter',
    category: 'catheter',
    manufacturer: 'Synthetic Devices',
    model: 'CATH-REUSE-TEST',
    is_implant: false,
    batch_tracked: false,
    inventory_item_id: inventoryItemId,
    default_unit_cost_reference: 1800,
    metadata: { test_scope: 'cath_device_reuse_deep' },
  }, { actorUid: CATALOG_ADMIN, actorRole: 'ADMIN', tenantId: TENANT });
  catalogItemId = Number(catalog.id);

  // Second lane: its own pharmacy catalogue row, inventory item and stock batch,
  // fronted by a batch_tracked cath catalogue item. Same facility, same
  // reprocessable category, so only the batch_tracked flag differs.
  const batchTrackedPharmacyCatalog = await prisma.$queryRawUnsafe(
    `INSERT INTO pharmacy_catalog
       (tenant_id, name, generic_name, category, is_active, is_available, in_stock, stock_quantity, updated_at)
     VALUES ($1::uuid, 'CDR C0de Batch Tracked Catheter', 'Synthetic batch-tracked catheter',
             'implant', TRUE, TRUE, TRUE, 5, NOW())
     RETURNING id`,
    TENANT,
  );
  const batchTrackedItems = await prisma.$queryRawUnsafe(
    `INSERT INTO pharmacy_inventory_items
       (tenant_id, facility_id, catalog_id, sku_code, display_name, unit_label, status)
     VALUES ($1::uuid, $2::int, $3::int, 'CDR-C0DE-CATHETER-BT', 'Deep test batch-tracked catheter', 'each', 'active')
     RETURNING id`,
    TENANT, facilityId, Number(batchTrackedPharmacyCatalog[0].id),
  );
  batchTrackedInventoryItemId = Number(batchTrackedItems[0].id);
  await prisma.$executeRawUnsafe(
    `INSERT INTO pharmacy_inventory_batches
       (tenant_id, facility_id, inventory_item_id, batch_number, lot_number, expiry_date,
        received_quantity, remaining_quantity, storage_location_id, status)
     VALUES ($1::uuid, $2::int, $3::int, $4::text, 'CDR-C0DE-LOT-B2', $5::date,
             5, 5, $6::int, 'in_stock')`,
    TENANT, facilityId, batchTrackedInventoryItemId, BATCH_TRACKED_BATCH_NUMBER, dateOffset(700), storageLocationId,
  );
  const batchTrackedCatalog = await upsertConsumableCatalogItem({
    tenantId: TENANT,
    item_name: 'Deep test batch-tracked diagnostic catheter',
    category: 'catheter',
    manufacturer: 'Synthetic Devices',
    model: 'CATH-REUSE-BT-TEST',
    is_implant: false,
    batch_tracked: true,
    inventory_item_id: batchTrackedInventoryItemId,
    default_unit_cost_reference: 2100,
    metadata: { test_scope: 'cath_device_reuse_deep_batch_tracked' },
  }, { actorUid: CATALOG_ADMIN, actorRole: 'ADMIN', tenantId: TENANT });
  batchTrackedCatalogItemId = Number(batchTrackedCatalog.id);
}

// Mints ONE available device from a fresh first use, so a test that consumes a
// device never has to borrow one the ordering-sensitive tests depend on. Every
// device it produces must be left discarded by its caller before the
// late-reactive sweep runs, or the sweep's exact affected list changes.
async function mintAvailableDevices({
  key,
  catalogId = catalogItemId,
  batchNumber = BATCH_NUMBER,
  quantity = 1,
  units = undefined,
  acknowledgement = 'Serology pending; device sent for reprocessing',
}) {
  const usage = await recordConsumableUsage(caseId, {
    tenantId: TENANT,
    catalog_item_id: catalogId,
    quantity,
    batch_number: batchNumber,
    expiry_date: dateOffset(700),
  }, ctx(ACTOR, { idempotencyKey: `cdr-mint-${key}` }));
  const postUse = await recordPostUse(caseId, usage.id, {
    tenantId: TENANT,
    disposition: 'reprocess',
    ...(units === undefined ? {} : { units }),
    acknowledgement: { reason: acknowledgement },
  }, ctx(ACTOR, { idempotencyKey: `cdr-mint-pu-${key}` }));
  const devices = [];
  for (const minted of postUse.devices) {
    await receiveDevice(minted.id, ctx(CSSD_ACTOR));
    devices.push(await markDeviceReprocessed(minted.id, { cycle_type: 'eto' }, ctx(CSSD_ACTOR)));
  }
  return { usage, postUse, devices };
}

describeIfDb('cath device reuse (deep)', () => {
  beforeAll(async () => {
    await cleanup();
    await seed();
    await upsertCategoryPolicies({
      tenantId: TENANT,
      policies: [{ category: 'catheter', reprocessable: true, max_cycles: 2, allowed_cycle_types: ['eto'] }],
    }, ctx());
    await upsertReprocessingSettings({ tenantId: TENANT }, ctx());
  }, 120000);

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  }, 60000);

  test('policy: implant categories refuse reprocessable', async () => {
    await expect(upsertCategoryPolicies({
      tenantId: TENANT,
      policies: [{ category: 'stent', reprocessable: true, max_cycles: 1, allowed_cycle_types: ['eto'] }],
    }, ctx())).rejects.toMatchObject({ code: 'CATH_REPROCESSING_IMPLANT_FORBIDDEN' });
  });

  test('first use is unchanged: shortfall obligation stands, reuse_screen stored', async () => {
    firstUse = await captureNew('cdr-first-1');
    expect(firstUse.inventory_decrement_status).toBe('insufficient_stock');
    expect(firstUse.device_id).toBeNull();
    expect(firstUse.reuse_cycle).toBeNull();
    const rows = await prisma.$queryRawUnsafe(
      `SELECT reuse_screen->>'status' AS s FROM cath_case_consumable_usage WHERE id = $1::bigint`,
      firstUse.id,
    );
    expect(rows[0].s).toBe('unknown');
    const tasks = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n FROM tasks
        WHERE tenant_id = $1::uuid
          AND related_resource_type = 'cath_case_consumable_usage'
          AND related_resource_id = $2
          AND metadata->>'task_contract' = 'cath_inventory_shortfall_v1'`,
      TENANT, String(firstUse.id),
    );
    expect(tasks[0].n).toBe(1);
  }, 60000);

  test('post-use with unknown serology requires acknowledgement, then mints one device per unit', async () => {
    await expect(recordPostUse(caseId, firstUse.id, { tenantId: TENANT, disposition: 'reprocess' }, ctx(ACTOR, { idempotencyKey: 'cdr-pu-1' })))
      .rejects.toMatchObject({ code: 'CATH_DEVICE_ACKNOWLEDGEMENT_REQUIRED' });
    const result = await recordPostUse(caseId, firstUse.id, {
      tenantId: TENANT,
      disposition: 'reprocess',
      acknowledgement: { reason: 'Emergency angiogram, serology pending' },
    }, ctx(ACTOR, { idempotencyKey: 'cdr-pu-1' }));
    expect(result.disposition).toBe('sent_for_reprocessing');
    expect(result.units).toBe(2);
    expect(result.devices).toHaveLength(2);
    deviceTags = result.devices.map((device) => device.device_tag);
    expect(deviceTags[0]).toMatch(/^RP\d{8}$/);
    expect(result.devices[0]).toMatchObject({ status: 'awaiting_reprocessing', cycle_count: 0, max_cycles_snapshot: 2 });

    const replay = await recordPostUse(caseId, firstUse.id, {
      tenantId: TENANT, disposition: 'reprocess', acknowledgement: { reason: 'replayed' },
    }, ctx(ACTOR, { idempotencyKey: 'cdr-pu-1' }));
    expect(replay.idempotent_replay).toBe(true);
    expect(replay.devices).toHaveLength(2);
    await expect(recordPostUse(caseId, firstUse.id, { tenantId: TENANT, disposition: 'discard' }, ctx(ACTOR, { idempotencyKey: 'cdr-pu-2' })))
      .rejects.toMatchObject({ code: 'CATH_POST_USE_ALREADY_RECORDED' });

    const reviews = await prisma.$queryRawUnsafe(
      `SELECT finding_code, status, override_reason FROM medication_safety_reviews
        WHERE tenant_id = $1::uuid AND review_type = 'cath_device_reuse'
        ORDER BY created_at DESC, id DESC LIMIT 1`,
      TENANT,
    );
    expect(reviews[0]).toMatchObject({ finding_code: 'SEROLOGY_UNKNOWN_ACKNOWLEDGED', status: 'overridden' });
  }, 60000);

  test('CSSD: receive, wrong cycle type refused, reprocessed increments the cycle', async () => {
    const device = await deviceByTag({ tenantId: TENANT, tag: deviceTags[0] });
    const received = await receiveDevice(device.id, ctx(CSSD_ACTOR));
    expect(received.status).toBe('in_cssd');
    await expect(markDeviceReprocessed(device.id, { cycle_type: 'steam' }, ctx(CSSD_ACTOR)))
      .rejects.toMatchObject({ code: 'CSSD_DEVICE_CYCLE_TYPE_NOT_ALLOWED' });
    const done = await markDeviceReprocessed(device.id, { cycle_type: 'eto' }, ctx(CSSD_ACTOR));
    expect(done).toMatchObject({ status: 'available', cycle_count: 1, last_cycle_type: 'eto' });
  }, 60000);

  test('an exposure-flagged device cannot be captured under the discard rule, and needs an acknowledgement under override', async () => {
    const device = await deviceByTag({ tenantId: TENANT, tag: deviceTags[0] });
    // The flag normally arrives from the late-reactive sweep; setting it by SQL
    // is the only way to reach an exposure-flagged AVAILABLE device, because the
    // sweep quarantines every device it can reach.
    await prisma.$executeRawUnsafe(
      `UPDATE cath_reprocessable_devices
          SET exposure_flag = TRUE, exposure_markers = ARRAY['hiv']::text[]
        WHERE tenant_id = $1::uuid AND id = $2::bigint`,
      TENANT, device.id,
    );
    await expect(recordConsumableUsage(caseId, {
      tenantId: TENANT, catalog_item_id: catalogItemId, quantity: 1, reused_device_tag: deviceTags[0],
    }, ctx(ACTOR, { idempotencyKey: 'cdr-exposed-1' })))
      .rejects.toMatchObject({ code: 'CATH_DEVICE_EXPOSURE_BLOCKED' });

    await upsertReprocessingSettings({ tenantId: TENANT, reactive_patient_rule: 'override_allowed' }, ctx());
    await expect(recordConsumableUsage(caseId, {
      tenantId: TENANT, catalog_item_id: catalogItemId, quantity: 1, reused_device_tag: deviceTags[0],
    }, ctx(ACTOR, { idempotencyKey: 'cdr-exposed-2' })))
      .rejects.toMatchObject({ code: 'CATH_DEVICE_ACKNOWLEDGEMENT_REQUIRED' });

    // Restore the fixture: rule back to discard, device back to clean.
    const restored = await upsertReprocessingSettings({ tenantId: TENANT }, ctx());
    expect(restored.reactive_patient_rule).toBe('discard');
    await prisma.$executeRawUnsafe(
      `UPDATE cath_reprocessable_devices
          SET exposure_flag = FALSE, exposure_markers = ARRAY[]::text[]
        WHERE tenant_id = $1::uuid AND id = $2::bigint`,
      TENANT, device.id,
    );
    const clean = await deviceByTag({ tenantId: TENANT, tag: deviceTags[0] });
    expect(clean).toMatchObject({ status: 'available', exposure_flag: false });
  }, 60000);

  test('reused capture: no shortfall obligation, no movement, device in_case', async () => {
    reusedUsage = await recordConsumableUsage(caseId, {
      tenantId: TENANT, catalog_item_id: catalogItemId, quantity: 1, reused_device_tag: deviceTags[0],
    }, ctx(ACTOR, { idempotencyKey: 'cdr-reuse-1' }));
    expect(reusedUsage.inventory_decrement_status).toBe('reused_device');
    expect(reusedUsage.reuse_cycle).toBe(1);
    expect(reusedUsage.inventory_batch_id).toBeNull();
    expect(reusedUsage.inventory_warning).toBeNull();
    // The 765 contract demands the same canonical provenance a new-unit row
    // carries: the events are emitted outside the batch branch, so they are here.
    const provenance = await prisma.$queryRawUnsafe(
      `SELECT timeline_event_id, audit_event_id, device_id FROM cath_case_consumable_usage WHERE id = $1::bigint`,
      reusedUsage.id,
    );
    expect(provenance[0].timeline_event_id).not.toBeNull();
    expect(provenance[0].audit_event_id).not.toBeNull();
    const artefacts = await prisma.$queryRawUnsafe(
      `SELECT
         (SELECT COUNT(*)::int FROM tasks
           WHERE tenant_id = $1::uuid AND related_resource_type = 'cath_case_consumable_usage'
             AND related_resource_id = $2 AND metadata->>'task_contract' = 'cath_inventory_shortfall_v1') AS tasks,
         (SELECT COUNT(*)::int FROM workflow_sla_instances
           WHERE tenant_id = $1::uuid AND rule_code = 'cath_consumable_inventory_reconciliation'
             AND source_table = 'cath_case_consumable_usage' AND source_id = $2) AS slas,
         (SELECT COUNT(*)::int FROM pharmacy_stock_movements
           WHERE tenant_id = $1::uuid AND reference_type = 'cath_consumable_usage'
             AND reference_id = $2) AS movements`,
      TENANT, String(reusedUsage.id),
    );
    expect(artefacts[0]).toMatchObject({ tasks: 0, slas: 0, movements: 0 });

    // Migration 765's reused branch of cath_inventory_authority_assert_contract_753,
    // called directly: the deferred trigger already ran this at COMMIT, and
    // asserting it here names the arm the row has to satisfy.
    // The assert returns void, which Prisma cannot deserialise — wrap it so the
    // outer column is an int and the raise (if any) still propagates.
    const contract = await prisma.$queryRawUnsafe(
      `SELECT 1::int AS ok
         FROM (SELECT cath_inventory_authority_assert_contract_753($1::uuid, $2::bigint)) AS probe`,
      TENANT, reusedUsage.id,
    );
    expect(contract[0].ok).toBe(1);

    const device = await deviceByTag({ tenantId: TENANT, tag: deviceTags[0] });
    expect(device).toMatchObject({ status: 'in_case', current_usage_id: reusedUsage.id });

    await expect(recordConsumableUsage(caseId, {
      tenantId: TENANT, catalog_item_id: catalogItemId, quantity: 1, reused_device_tag: deviceTags[0],
    }, ctx(ACTOR, { idempotencyKey: 'cdr-reuse-2' }))).rejects.toMatchObject({ code: 'CATH_DEVICE_NOT_AVAILABLE' });

    await expect(recordConsumableUsage(caseId, {
      tenantId: TENANT, catalog_item_id: catalogItemId, quantity: 1,
      reused_device_tag: deviceTags[1], batch_number: 'B1',
    }, ctx(ACTOR, { idempotencyKey: 'cdr-reuse-3' })))
      .rejects.toMatchObject({ code: 'CATH_CONSUMABLE_REUSE_FIELDS_CONFLICT' });
  }, 60000);

  test('replaying a reused capture returns the same usage row instead of 409ing on the device', async () => {
    // The retry of a request whose response was lost. The device is now in_case,
    // so the ON CONFLICT replay branch that runs AFTER captureReusedDeviceTx
    // could never be reached — capture would 409 CATH_DEVICE_NOT_AVAILABLE
    // first. The replay probe runs before the device is locked, which is the
    // whole point of this assertion.
    const before = await deviceByTag({ tenantId: TENANT, tag: deviceTags[0] });
    expect(before).toMatchObject({ status: 'in_case', current_usage_id: reusedUsage.id });

    const replay = await recordConsumableUsage(caseId, {
      tenantId: TENANT, catalog_item_id: catalogItemId, quantity: 1, reused_device_tag: deviceTags[0],
    }, ctx(ACTOR, { idempotencyKey: 'cdr-reuse-1' }));
    expect(replay.id).toBe(reusedUsage.id);
    expect(replay.idempotent_replay).toBe(true);
    expect(replay.inventory_decrement_status).toBe('reused_device');
    expect(replay.device_id).toBe(reusedUsage.device_id);
    expect(replay.reuse_cycle).toBe(1);

    // Nothing moved: no second row, and the device's cycle count is untouched.
    const rows = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n FROM cath_case_consumable_usage
        WHERE tenant_id = $1::uuid AND idempotency_key = 'cdr-reuse-1'`,
      TENANT,
    );
    expect(rows[0].n).toBe(1);
    const after = await deviceByTag({ tenantId: TENANT, tag: deviceTags[0] });
    expect(after).toMatchObject({ status: 'in_case', current_usage_id: reusedUsage.id, cycle_count: before.cycle_count });
  }, 60000);

  test('a device in a case cannot be discarded through the CSSD failed-check path', async () => {
    const device = await deviceByTag({ tenantId: TENANT, tag: deviceTags[0] });
    expect(device.status).toBe('in_case');
    await expect(markDeviceReprocessed(device.id, {
      cycle_type: 'eto', function_check_result: 'fail',
    }, ctx(CSSD_ACTOR))).rejects.toMatchObject({ code: 'CATH_DEVICE_INVALID_TRANSITION' });
    const after = await deviceByTag({ tenantId: TENANT, tag: deviceTags[0] });
    expect(after.status).toBe('in_case');
  }, 60000);

  test('the database refuses to attach a shortfall obligation to a reused row', async () => {
    // The rejection can come from migration 748's shortfall contract before
    // 765's reused branch is reached — both are 23514 and both are the point:
    // a reused device owes no pharmacy reconciliation, so no task can bind to it.
    await expect(setTenantTx(TENANT, async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO tasks
           (tenant_id, task_kind, title, description, status, priority, patient_uid,
            related_resource_type, related_resource_id, stage_occurrence_key, metadata)
         VALUES ($1::uuid, 'review', 'contract probe', 'contract probe', 'open', 'high', $2::uuid,
                 'cath_case_consumable_usage', $3, $4, $5::jsonb)`,
        TENANT, PATIENT, String(reusedUsage.id),
        `cath-inventory-shortfall:usage:${String(reusedUsage.id)}`,
        JSON.stringify({
          task_contract: 'cath_inventory_shortfall_v1',
          cath_consumable_usage_id: String(reusedUsage.id),
          cath_case_id: String(caseId),
          inventory_item_id: String(inventoryItemId),
          movement_kind: 'issue',
        }),
      );
    })).rejects.toMatchObject({ code: expect.stringMatching(/P2010|23514/) });
    const tasks = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n FROM tasks WHERE tenant_id = $1::uuid AND related_resource_id = $2`,
      TENANT, String(reusedUsage.id),
    );
    expect(tasks[0].n).toBe(0);
  }, 60000);

  test('decorateConsumablesWithReuse exposes tags and allowed post-use options', async () => {
    const usage = await listCaseConsumableUsage(caseId, { tenantId: TENANT });
    const decorated = await decorateConsumablesWithReuse(usage, { tenantId: TENANT, caseId });
    const reusedRow = decorated.usage.find((u) => u.inventory_decrement_status === 'reused_device');
    expect(reusedRow.device_tag).toBe(deviceTags[0]);
    expect(reusedRow.device_status).toBe('in_case');
    expect(reusedRow.allowed_post_use.dispositions).toEqual(['reprocess', 'discard']);
    expect(reusedRow.allowed_post_use.requires_acknowledgement).toBe(true);
    const firstRow = decorated.usage.find((u) => u.id === firstUse.id);
    expect(firstRow.device_tag).toBeNull();
    expect(firstRow.allowed_post_use.reason_codes).toEqual(['already_recorded']);
    expect(decorated.reprocessing.reprocessable_categories).toEqual(['catheter']);
    expect(decorated.reuse_restriction.status).toBe('unknown');
    const cathCase = await getCase(caseId, { tenantId: TENANT });
    expect(cathCase.reuse_restriction.status).toBe('unknown');
  }, 60000);

  test('device history lists both uses and the register audit trail', async () => {
    const device = await deviceByTag({ tenantId: TENANT, tag: deviceTags[0] });
    const history = await deviceHistory({ tenantId: TENANT, deviceId: device.id });
    expect(history.device.device_tag).toBe(deviceTags[0]);
    expect(history.uses.map((u) => u.kind)).toEqual(['first_use', 'reuse']);
    expect(history.uses.map((u) => u.usage_id)).toEqual([firstUse.id, reusedUsage.id]);
    expect(history.uses.every((u) => u.patient_uid === PATIENT)).toBe(true);
    expect(history.events.map((e) => e.action)).toEqual(expect.arrayContaining([
      'cath_device.created', 'cath_device.receive', 'cath_device.reprocessed', 'cath_device.capture',
    ]));
  }, 60000);

  test('a reused row is not a facility shutdown blocker', async () => {
    // loadFacilityShutdownBlockersTx is module-private, so this runs its
    // unreconciled_cath_usage predicate against the same row both ways: the
    // 'reused_device' entry is what keeps the count at zero.
    const rows = await prisma.$queryRawUnsafe(
      `SELECT
         (SELECT COUNT(*)::int FROM cath_case_consumable_usage usage
           WHERE usage.tenant_id = $1::uuid AND usage.facility_id = $2::int AND usage.id = $3::bigint
             AND usage.inventory_decrement_status
                   NOT IN ('decremented','not_applicable','reused_device')) AS with_fix,
         (SELECT COUNT(*)::int FROM cath_case_consumable_usage usage
           WHERE usage.tenant_id = $1::uuid AND usage.facility_id = $2::int AND usage.id = $3::bigint
             AND usage.inventory_decrement_status
                   NOT IN ('decremented','not_applicable')) AS without_fix`,
      TENANT, facilityId, reusedUsage.id,
    );
    expect(rows[0]).toMatchObject({ with_fix: 0, without_fix: 1 });
  }, 60000);

  test('a reused capture marked wasted discards the device instead of parking it in_case', async () => {
    // Spec §6.5. A wasted reused device was opened and destroyed in this case:
    // there is no post-use tap to return it through, so leaving it 'in_case'
    // would strand it with a current_usage_id pointing at a wasted row.
    const { devices } = await mintAvailableDevices({ key: 'wasted' });
    const tag = devices[0].device_tag;
    expect(devices[0]).toMatchObject({ status: 'available', cycle_count: 1 });

    const wastedUsage = await recordConsumableUsage(caseId, {
      tenantId: TENANT,
      catalog_item_id: catalogItemId,
      quantity: 1,
      reused_device_tag: tag,
      wasted: true,
      waste_reason: 'Shaft kinked during insertion; device destroyed',
    }, ctx(ACTOR, { idempotencyKey: 'cdr-reuse-wasted-1' }));
    expect(wastedUsage.inventory_decrement_status).toBe('reused_device');
    expect(wastedUsage.wasted).toBe(true);
    expect(wastedUsage.post_use_disposition).toBe('discarded_wasted');

    const device = await deviceByTag({ tenantId: TENANT, tag });
    expect(device).toMatchObject({
      status: 'discarded',
      discard_reason: 'wasted',
      current_usage_id: null,
    });
    expect(device.discard_note).toBe('Shaft kinked during insertion; device destroyed');
    expect(String(device.metadata.usage_id)).toBe(String(wastedUsage.id));
  }, 120000);

  test('a batch_tracked catalogue item can be reused with no batch, lot or expiry', async () => {
    // Migration 765's widened cath_consumable_usage_batch_expiry_check. Before
    // it, this INSERT was a 23514: the row is batch_tracked (the flag is copied
    // from the catalogue) but a reused device has no batch lineage of its own —
    // that lives on the origin usage row the register points back at.
    const { usage: originUsage, devices } = await mintAvailableDevices({
      key: 'bt',
      catalogId: batchTrackedCatalogItemId,
      batchNumber: BATCH_TRACKED_BATCH_NUMBER,
    });
    expect(originUsage).toMatchObject({ batch_tracked: true, batch_number: BATCH_TRACKED_BATCH_NUMBER });
    expect(originUsage.expiry_date).not.toBeNull();

    const tag = devices[0].device_tag;
    const reused = await recordConsumableUsage(caseId, {
      tenantId: TENANT,
      catalog_item_id: batchTrackedCatalogItemId,
      quantity: 1,
      reused_device_tag: tag,
    }, ctx(ACTOR, { idempotencyKey: 'cdr-reuse-bt-1' }));
    expect(reused).toMatchObject({
      inventory_decrement_status: 'reused_device',
      batch_tracked: true,
      batch_number: null,
      lot_number: null,
      expiry_date: null,
      inventory_batch_id: null,
      reuse_cycle: 1,
    });
    // The batch lineage is recoverable through the register, not lost.
    const history = await deviceHistory({ tenantId: TENANT, deviceId: devices[0].id });
    expect(history.uses.map((u) => u.usage_id)).toEqual([originUsage.id, reused.id]);

    // Leave the device discarded so the late-reactive sweep below still sees
    // exactly the two devices its assertions name.
    const out = await recordPostUse(caseId, reused.id, {
      tenantId: TENANT, disposition: 'discard', discard_reason: 'damaged', discard_note: 'deep-test teardown',
    }, ctx(ACTOR, { idempotencyKey: 'cdr-pu-bt-1' }));
    expect(out.disposition).toBe('discarded_other');
    expect(out.devices[0]).toMatchObject({ status: 'discarded', discard_reason: 'damaged' });
  }, 120000);

  test('reprocessing fewer units than were used records the shortfall on the row', async () => {
    // Spec §6.3 step 3: a quantity-2 first use reprocessed as one unit leaves
    // one unit unaccounted for. Counting the ABSENCE of a minted device is not
    // something a reader can do, so the number is written on the usage row.
    const { usage, postUse, devices } = await mintAvailableDevices({ key: 'units', quantity: 2, units: 1 });
    expect(postUse.units).toBe(1);
    expect(postUse.devices).toHaveLength(1);
    const rows = await prisma.$queryRawUnsafe(
      `SELECT metadata->>'units_not_reprocessed' AS shortfall FROM cath_case_consumable_usage WHERE id = $1::bigint`,
      usage.id,
    );
    expect(rows[0].shortfall).toBe('1');

    // The whole-quantity case writes nothing: firstUse was 2 units reprocessed
    // as 2, so the key must be absent rather than 0.
    const whole = await prisma.$queryRawUnsafe(
      `SELECT (metadata->'units_not_reprocessed') IS NOT NULL AS present
         FROM cath_case_consumable_usage WHERE id = $1::bigint`,
      firstUse.id,
    );
    expect(whole[0].present).toBe(false);

    await discardDevice(devices[0].id, { reason: 'damaged', note: 'deep-test teardown' }, ctx(CSSD_ACTOR));
  }, 120000);

  test('a reactive marker sweeps the register and forces discard at post-use', async () => {
    // ORDERING NOTE: registerExposureHandler(quarantineDevicesExposedToPatient)
    // is live, and notifyExposureHandlers awaits handlers right after
    // recordMarkers commits — so this single call BOTH restricts the patient and
    // sweeps the register. deviceTags[1] leaves awaiting_reprocessing here, which
    // is why the late-reactive test below calls the sweep directly instead of
    // expecting a fresh device.
    await recordMarkers({
      tenantId: TENANT,
      patientUid: PATIENT,
      actorUid: ACTOR,
      entries: [{ marker: 'hbsag', result: 'reactive', testedOn: daysAgo(1), source: 'clinical_declaration' }],
    });

    const sweptIdle = await deviceByTag({ tenantId: TENANT, tag: deviceTags[1] });
    expect(sweptIdle).toMatchObject({ status: 'quarantined', exposure_flag: true });
    expect(sweptIdle.exposure_markers).toContain('hbsag');
    const sweptInCase = await deviceByTag({ tenantId: TENANT, tag: deviceTags[0] });
    expect(sweptInCase).toMatchObject({ status: 'in_case', exposure_flag: true });
    expect(sweptInCase.exposure_markers).toContain('hbsag');
    const alerts = await prisma.$queryRawUnsafe(
      `SELECT alert_type FROM cds_alerts WHERE patient_uid = $1::uuid AND alert_type = 'bloodborne_reuse_exposure'`,
      PATIENT,
    );
    expect(alerts.length).toBeGreaterThan(0);
    const outbox = await prisma.$queryRawUnsafe(
      `SELECT recipient_id FROM notification_outbox
        WHERE tenant_id = $1::uuid AND type = 'bloodborne_reuse_exposure'`,
      TENANT,
    );
    expect(outbox.length).toBe(1);

    await expect(recordPostUse(caseId, reusedUsage.id, {
      tenantId: TENANT, disposition: 'reprocess', acknowledgement: { reason: 'clinician override attempt' },
    }, ctx(ACTOR, { idempotencyKey: 'cdr-pu-3' }))).rejects.toMatchObject({ code: 'CATH_DEVICE_EXPOSURE_BLOCKED' });

    const out = await recordPostUse(caseId, reusedUsage.id, {
      tenantId: TENANT, disposition: 'discard',
    }, ctx(ACTOR, { idempotencyKey: 'cdr-pu-4' }));
    expect(out.disposition).toBe('discarded_bloodborne_exposure');
    expect(out.restriction_status).toBe('restricted');
    expect(out.devices[0]).toMatchObject({ status: 'discarded', discard_reason: 'bloodborne_exposure' });
  }, 60000);

  test('a late reactive result adds its marker to an already-quarantined device', async () => {
    const before = await deviceByTag({ tenantId: TENANT, tag: deviceTags[1] });
    expect(before.status).toBe('quarantined');
    expect(before.exposure_markers).not.toContain('hcv');
    const result = await quarantineDevicesExposedToPatient({
      tenantId: TENANT,
      patientUid: PATIENT,
      marker: 'hcv',
      testedOn: daysAgo(0),
      markerRowId: 90001,
      source: 'lab_result',
    });
    expect(result.affected.map((device) => device.device_tag)).toEqual([deviceTags[1]]);
    const after = await deviceByTag({ tenantId: TENANT, tag: deviceTags[1] });
    expect(after).toMatchObject({ status: 'quarantined', exposure_flag: true });
    expect(after.exposure_markers).toEqual(expect.arrayContaining(['hbsag', 'hcv']));
    // The discarded device is out of scope for the sweep.
    const discarded = await deviceByTag({ tenantId: TENANT, tag: deviceTags[0] });
    expect(discarded.status).toBe('discarded');
  }, 60000);

  test('quarantine release goes back to awaiting_reprocessing; discard is terminal', async () => {
    const device = await deviceByTag({ tenantId: TENANT, tag: deviceTags[1] });
    const released = await releaseDevice(device.id, { note: 'reviewed by infection control' }, ctx(CSSD_ACTOR));
    expect(released).toMatchObject({ status: 'awaiting_reprocessing', quarantine_reason: null });
    await expect(quarantineDevice(device.id, {}, ctx(CSSD_ACTOR)))
      .rejects.toMatchObject({ code: 'CATH_DEVICE_REASON_REQUIRED' });
    const discarded = await discardDevice(device.id, { reason: 'damaged', note: 'kinked shaft' }, ctx(CSSD_ACTOR));
    expect(discarded.status).toBe('discarded');
    await expect(receiveDevice(device.id, ctx(CSSD_ACTOR)))
      .rejects.toMatchObject({ code: 'CATH_DEVICE_INVALID_TRANSITION' });
    const queue = await listDevices({ tenantId: TENANT, status: 'discarded' });
    expect(queue.map((entry) => entry.device_tag)).toEqual(expect.arrayContaining(deviceTags));
  }, 60000);

  test('under override_allowed an exposure-flagged device is captured and the override lands on the record', async () => {
    // The POSITIVE arm the earlier test only rejected. Runs last on purpose:
    // the patient is blood-borne restricted by now, so the device this mints is
    // exposure-flagged by the platform itself rather than by fixture SQL.
    await upsertReprocessingSettings({ tenantId: TENANT, reactive_patient_rule: 'override_allowed' }, ctx());
    const { devices } = await mintAvailableDevices({
      key: 'override',
      acknowledgement: 'Infection control cleared this device for a restricted-patient case',
    });
    const device = devices[0];
    expect(device).toMatchObject({ status: 'available', exposure_flag: true });
    expect(device.exposure_markers).toEqual(expect.arrayContaining(['hbsag']));

    // The patient is restricted by now, which is why the minted device carries
    // the flag at all — the capture below is an override, not a clean reuse.
    const cathCase = await getCase(caseId, { tenantId: TENANT });
    expect(cathCase.reuse_restriction.status).toBe('restricted');

    const overridden = await recordConsumableUsage(caseId, {
      tenantId: TENANT,
      catalog_item_id: catalogItemId,
      quantity: 1,
      reused_device_tag: device.device_tag,
      exposure_acknowledgement: { reason: 'Consultant accepts reuse; patient already positive for the same marker' },
    }, ctx(ACTOR, { idempotencyKey: 'cdr-reuse-override-1' }));
    expect(overridden.inventory_decrement_status).toBe('reused_device');
    expect(overridden.metadata.reused_device.acknowledgement)
      .toBe('Consultant accepts reuse; patient already positive for the same marker');
    const captured = await deviceByTag({ tenantId: TENANT, tag: device.device_tag });
    expect(captured).toMatchObject({ status: 'in_case', current_usage_id: Number(overridden.id) });

    const reviews = await prisma.$queryRawUnsafe(
      `SELECT finding_code, status, override_reason FROM medication_safety_reviews
        WHERE tenant_id = $1::uuid AND review_type = 'cath_device_reuse'
          AND finding_code = 'EXPOSED_DEVICE_REUSED'`,
      TENANT,
    );
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ status: 'overridden' });
    expect(reviews[0].override_reason)
      .toContain('Consultant accepts reuse');

    // Under the discard rule the same in-case device is discard-only at
    // post-use, refused on the DEVICE's own exposure flag — computePostUseOptions'
    // device_exposure_flagged rule — rather than on the patient's status.
    const restored = await upsertReprocessingSettings({ tenantId: TENANT }, ctx());
    expect(restored.reactive_patient_rule).toBe('discard');
    await expect(recordPostUse(caseId, overridden.id, {
      tenantId: TENANT, disposition: 'reprocess', acknowledgement: { reason: 'second override attempt' },
    }, ctx(ACTOR, { idempotencyKey: 'cdr-pu-override-1' })))
      .rejects.toMatchObject({
        code: 'CATH_DEVICE_EXPOSURE_BLOCKED',
        details: { exposure_markers: expect.arrayContaining(['hbsag']) },
      });
  }, 120000);

  test('a wasted reused capture under override_allowed with an acknowledgement discards the device and records EXPOSED_DEVICE_REUSED', async () => {
    // The wasted branch takes the DISCARD tap, not the capture tap, so it never
    // passes through markDeviceInCaseTx. captureReusedDeviceTx demands
    // exposure_acknowledgement.reason all the same, so the override owes the
    // clinical record the identical EXPOSED_DEVICE_REUSED review — before
    // markDeviceWastedTx existed it was silently dropped on this path.
    // Runs after the override test on purpose: that one counts the tenant's
    // EXPOSED_DEVICE_REUSED reviews exactly.
    await upsertReprocessingSettings({ tenantId: TENANT, reactive_patient_rule: 'override_allowed' }, ctx());
    const { devices } = await mintAvailableDevices({
      key: 'wasted-ack',
      acknowledgement: 'Infection control cleared this device for a restricted-patient case',
    });
    const device = devices[0];
    // The patient is blood-borne restricted by now, so the mint above already
    // flags the device. Setting the flag by SQL anyway keeps the precondition
    // explicit instead of leaning on suite ordering for it.
    await prisma.$executeRawUnsafe(
      `UPDATE cath_reprocessable_devices
          SET exposure_flag = TRUE,
              exposure_markers = ARRAY(SELECT DISTINCT m FROM unnest(exposure_markers || ARRAY['hbsag']::text[]) AS m ORDER BY m)
        WHERE tenant_id = $1::uuid AND id = $2::bigint`,
      TENANT, device.id,
    );
    const flagged = await deviceByTag({ tenantId: TENANT, tag: device.device_tag });
    expect(flagged).toMatchObject({ status: 'available', exposure_flag: true });

    const wasted = await recordConsumableUsage(caseId, {
      tenantId: TENANT,
      catalog_item_id: catalogItemId,
      quantity: 1,
      reused_device_tag: device.device_tag,
      wasted: true,
      waste_reason: 'Balloon ruptured on the table; device destroyed',
      exposure_acknowledgement: { reason: 'Consultant accepts the exposure risk; device was opened and destroyed' },
    }, ctx(ACTOR, { idempotencyKey: 'cdr-reuse-wasted-ack-1' }));
    expect(wasted).toMatchObject({
      inventory_decrement_status: 'reused_device',
      wasted: true,
      post_use_disposition: 'discarded_wasted',
    });

    const discarded = await deviceByTag({ tenantId: TENANT, tag: device.device_tag });
    expect(discarded).toMatchObject({ status: 'discarded', discard_reason: 'wasted', current_usage_id: null });
    expect(discarded.discard_note).toBe('Balloon ruptured on the table; device destroyed');
    expect(discarded.metadata.last_exposure_acknowledgement)
      .toBe('Consultant accepts the exposure risk; device was opened and destroyed');

    const reviews = await prisma.$queryRawUnsafe(
      `SELECT status, override_reason, payload FROM medication_safety_reviews
        WHERE tenant_id = $1::uuid
          AND review_type = 'cath_device_reuse'
          AND finding_code = 'EXPOSED_DEVICE_REUSED'
          AND payload->>'usage_id' = $2`,
      TENANT, String(wasted.id),
    );
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ status: 'overridden' });
    expect(reviews[0].override_reason).toContain('Consultant accepts the exposure risk');
    expect(reviews[0].payload).toMatchObject({ device_tag: device.device_tag, wasted: true });

    const restored = await upsertReprocessingSettings({ tenantId: TENANT }, ctx());
    expect(restored.reactive_patient_rule).toBe('discard');
  }, 120000);
});
