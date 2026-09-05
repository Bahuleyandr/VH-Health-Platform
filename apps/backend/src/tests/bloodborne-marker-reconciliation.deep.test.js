// apps/backend/src/tests/bloodborne-marker-reconciliation.deep.test.js
//
// The reconciliation sweep (spec 2026-09-04 §18) against a real database.
//
// The unit suite pins the candidate query's SHAPE; only Postgres can say
// whether the anti-join actually answers the question. Two of these cases —
// "an active marker excludes the result" and "a voided one does not" — differ
// by a single `voided_at IS NULL` predicate, which a stubbed client would
// report as passing either way. They are the calibration for the mutation
// check recorded with this change.
//
// This file owns its own tenants (…bc001 / …bc002) and never touches the
// blood-borne marker suite's (…bb001 / …bb002), so the two can run in the same
// shard without sharing rows.

import prisma, {
  ensureTenantRlsRuntimeRoleGrants,
  setTenantTx,
} from '../lib/prisma.js';
// Exactly what scripts/reconcile-bloodborne-markers.mjs imports FIRST, and for
// the same reason: it registers quarantineDevicesExposedToPatient, so the
// exposure fan-out in this process is the production one and not an empty set.
// The count is asserted before the fan-out cases run.
import { exposureHandlerCount } from '../services/clinical/exposureHandlerBootstrap.js';
import {
  SUPERSESSION_VOID_REASON,
  clinicalDate,
  isoDate,
  recordMarkersFromSignedResults,
  registerExposureHandler,
  voidMarker,
} from '../services/clinical/bloodborneMarkerService.js';
import {
  findUnreconciledSerologyResults,
  reconcileTenant,
} from '../services/clinical/bloodborneMarkerReconciliationService.js';

const DB_CONFIGURED = Boolean(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TENANT = '00000000-0000-4000-8000-0000000bc001';
const OTHER_TENANT = '00000000-0000-4000-8000-0000000bc002';
const PATIENT = '00000000-0000-4000-8000-0000000bc011';
const OTHER_PATIENT = '00000000-0000-4000-8000-0000000bc012';
const SIGNER = '00000000-0000-4000-8000-0000000bc0aa';
const OTHER_SIGNER = '00000000-0000-4000-8000-0000000bc0ab';

const RUNTIME_ROLES = ['vhhealth_app', 'vhhealth_runtime'];
const RLS_ROLE = 'vhhealth_runtime';
let previousRuntimeRole;
// The bootstrap's own return value decides whether the RLS case may skip:
// `skipped: true` means it declined to run at all, the one rig this file
// cannot assert on. Anything else means provisioning ran, so a missing grant
// is a defect and must fail rather than skip.
const runtimeRoleProvisioning = new Map();

const resultIds = [];

// Captured at MODULE LOAD, before this file registers a probe of its own: this
// number is exactly what the exposureHandlerBootstrap import at the top
// contributed to this process. Zero here is the defect the reviews found — a
// sweep repairing reactive markers with nobody listening.
const HANDLERS_FROM_BOOTSTRAP = exposureHandlerCount();

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// A lab result in the state the sign-off hook leaves behind — signed, with the
// marker write missing. `daysBack` is negative for a future-dated instant,
// which is what an analyzer with a skewed clock produces.
async function seedSignedResult({
  testCode = 'HBSAG',
  valueText = 'Reactive',
  status = 'final',
  tenantId = TENANT,
  patientUid = PATIENT,
  signedBy = SIGNER,
  daysBack = 3,
  signedDaysBack = 0,
} = {}) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO lab_results
       (tenant_id, patient_uid, test_code, test_name, value_text, status,
        signed_off_at, signed_off_by, performed_at, received_at)
     VALUES ($1::uuid, $2::uuid, $3, $3, $4, $5,
             NOW() - ($8::int * INTERVAL '1 day'), $6::uuid,
             NOW() - ($7::int * INTERVAL '1 day'),
             NOW() - ($7::int * INTERVAL '1 day'))
     RETURNING id`,
    tenantId, patientUid, testCode, valueText, status, signedBy, daysBack, signedDaysBack,
  );
  const id = Number(rows[0].id);
  resultIds.push(id);
  return id;
}

async function seedUnsignedResult({ testCode = 'HIV', valueText = 'Reactive' } = {}) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO lab_results
       (tenant_id, patient_uid, test_code, test_name, value_text, status,
        performed_at, received_at)
     VALUES ($1::uuid, $2::uuid, $3, $3, $4, 'preliminary', NOW(), NOW())
     RETURNING id`,
    TENANT, PATIENT, testCode, valueText,
  );
  const id = Number(rows[0].id);
  resultIds.push(id);
  return id;
}

// The device-exposure fixture chain: the only thing this file needs from the
// cath side is a reprocessable device the register can see as "used on this
// patient", because quarantineDevicesExposedToPatient joins
// cath_reprocessable_devices to cath_case_consumable_usage on patient_uid and
// used_at and reads nothing else.
//
// WHY IT IS SEEDED WITH TRIGGERS OFF. Migration 753 governs how a usage row may
// claim inventory authority, and its BEFORE trigger demands a matching
// pharmacy_stock_movements receipt (or, on the terminal arm, a RESOLVED row in
// the authority-recovery worklist with its own signed event) before it will
// accept the row at all. Reproducing that governance here would be a fixture
// several times the size of the case it supports, and NONE of it is what is
// under test: the assertion is that the sweep's REACTIVE repair reaches the
// exposure handler and the handler quarantines the device. So the seed runs
// with session_replication_role='replica' for that one transaction — CHECK
// constraints still apply (the row still carries a real facility, inventory
// item and batch, per chk_cath_usage_exact_inventory_authority_753); only the
// 753 authority TRIGGER and the FK triggers are skipped, on a disposable deep
// test database, the same lever this file's own teardown already pulls.
// cath-device-reuse.deep.test.js owns the governed path.
async function seedExposedDevice() {
  return setTenantTx(TENANT, async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
    await tx.$executeRawUnsafe("SELECT set_config('app.audit_bypass', 'on', true)");
    const facility = await tx.$queryRawUnsafe(
      `INSERT INTO facilities (tenant_id, facility_code, display_name, status, is_default)
       VALUES ($1::uuid, 'BBM-SWEEP-FAC', 'BBM Sweep Facility', 'active', FALSE)
       RETURNING id`,
      TENANT,
    );
    const facilityId = Number(facility[0].id);
    const location = await tx.$queryRawUnsafe(
      `INSERT INTO facility_locations
         (tenant_id, facility_id, location_code, display_name, location_kind, status)
       VALUES ($1::uuid, $2::int, 'BBM-SWEEP-STORE', 'BBM Sweep Store', 'pharmacy', 'active')
       RETURNING id`,
      TENANT, facilityId,
    );
    const pharmacyCatalog = await tx.$queryRawUnsafe(
      `INSERT INTO pharmacy_catalog (tenant_id, name)
       VALUES ($1::uuid, 'BBM sweep consumable')
       RETURNING id`,
      TENANT,
    );
    const inventoryItem = await tx.$queryRawUnsafe(
      `INSERT INTO pharmacy_inventory_items
         (tenant_id, sku_code, display_name, facility_id, catalog_id, status)
       VALUES ($1::uuid, 'BBM-SWEEP-SKU', 'BBM sweep consumable', $2::int, $3::int, 'active')
       RETURNING id`,
      TENANT, facilityId, Number(pharmacyCatalog[0].id),
    );
    const inventoryItemId = Number(inventoryItem[0].id);
    const batch = await tx.$queryRawUnsafe(
      `INSERT INTO pharmacy_inventory_batches
         (tenant_id, inventory_item_id, batch_number, expiry_date, received_quantity,
          remaining_quantity, facility_id, storage_location_id, status)
       VALUES ($1::uuid, $2::int, 'BBM-SWEEP-B1', CURRENT_DATE + 365, 10, 10,
               $3::int, $4::int, 'in_stock')
       RETURNING id`,
      TENANT, inventoryItemId, facilityId, Number(location[0].id),
    );
    const catalog = await tx.$queryRawUnsafe(
      `INSERT INTO cath_consumable_catalog
         (tenant_id, item_name, category, is_implant, batch_tracked, status,
          facility_id, inventory_item_id)
       VALUES ($1::uuid, 'BBM sweep reusable catheter', 'catheter', FALSE, FALSE,
               'active', $2::int, $3::int)
       RETURNING id`,
      TENANT, facilityId, inventoryItemId,
    );
    const catalogItemId = Number(catalog[0].id);
    const kase = await tx.$queryRawUnsafe(
      `INSERT INTO cath_lab_cases
         (tenant_id, patient_uid, facility_id, requested_procedure, status,
          created_by, updated_by)
       VALUES ($1::uuid, $2::uuid, $3::int, 'Diagnostic coronary angiogram', 'in_progress',
               $4::uuid, $4::uuid)
       RETURNING id`,
      TENANT, PATIENT, facilityId, SIGNER,
    );
    const usage = await tx.$queryRawUnsafe(
      `INSERT INTO cath_case_consumable_usage
         (tenant_id, case_id, catalog_item_id, patient_uid, quantity, batch_tracked,
          is_implant, used_at, facility_id, inventory_item_id, inventory_batch_id,
          inventory_decrement_status)
       VALUES ($1::uuid, $2::bigint, $3::bigint, $4::uuid, 1, FALSE, FALSE, NOW(),
               $5::int, $6::int, $7::int, 'decremented')
       RETURNING id`,
      TENANT, Number(kase[0].id), catalogItemId, PATIENT, facilityId, inventoryItemId,
      Number(batch[0].id),
    );
    const usageId = Number(usage[0].id);
    const device = await tx.$queryRawUnsafe(
      `INSERT INTO cath_reprocessable_devices
         (tenant_id, facility_id, catalog_item_id, origin_usage_id, max_cycles_snapshot,
          status, created_by)
       VALUES ($1::uuid, $2::int, $3::bigint, $4::bigint, 5, 'available', $5::uuid)
       RETURNING id, device_tag`,
      TENANT, facilityId, catalogItemId, usageId, SIGNER,
    );
    return { deviceId: Number(device[0].id), usageId, catalogItemId, facilityId };
  });
}

async function deviceRow(deviceId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, status, exposure_flag, exposure_markers, quarantine_reason
       FROM cath_reprocessable_devices
      WHERE tenant_id = $1::uuid AND id = $2::bigint`,
    TENANT, deviceId,
  );
  return rows[0];
}

async function markerRowsFor(labResultId, tenantId = TENANT) {
  return prisma.$queryRawUnsafe(
    `SELECT id, patient_uid, marker, result, tested_on, source, lab_result_id,
            evidence, recorded_by, voided_at, void_reason
       FROM patient_bloodborne_markers
      WHERE tenant_id = $1::uuid AND lab_result_id = $2::int
      ORDER BY id`,
    tenantId, labResultId,
  );
}

async function activeMarkerFor(labResultId, tenantId = TENANT) {
  const rows = await markerRowsFor(labResultId, tenantId);
  return rows.filter((row) => row.voided_at === null);
}

async function candidateIds(tenantId = TENANT, args = {}) {
  const rows = await findUnreconciledSerologyResults({ tenantId, ...args });
  return rows.map((row) => row.lab_result_id);
}

// FK order: markers -> lab_results -> users -> tenants. Explicit IN-lists
// rather than `= ANY($n::uuid[])`, matching the sibling suite: the repo lint
// reads an array literal in a $queryRawUnsafe argument list as a missed spread.
async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM patient_bloodborne_markers WHERE tenant_id IN ($1::uuid, $2::uuid)`,
    TENANT, OTHER_TENANT,
  ).catch(() => {});
  // The exposure fan-out below writes through the REAL cath handler, so its
  // rows and its fixture chain are this file's to clear. Devices before usage
  // (fk_cath_consumable_usage_device and fk_cath_reprocessable_devices_origin_usage
  // are both RESTRICT), and the audit/alert sinks the handler appends to before
  // the users delete takes the patient out from under them.
  await setTenantTx(TENANT, async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
    await tx.$executeRawUnsafe("SELECT set_config('app.audit_bypass', 'on', true)");
    for (const table of [
      'notification_outbox',
      'cds_alerts',
      'audit_logs',
      'cath_reprocessable_devices',
      'cath_case_consumable_usage',
      'cath_lab_cases',
      'cath_consumable_catalog',
      'cath_reprocessing_settings',
      'pharmacy_inventory_batches',
      'pharmacy_inventory_items',
      'pharmacy_catalog',
      'facility_locations',
      'facilities',
    ]) {
      await tx.$executeRawUnsafe(
        `DELETE FROM ${table} WHERE tenant_id IN ($1::uuid, $2::uuid)`,
        TENANT, OTHER_TENANT,
      );
    }
  }).catch((err) => {
    console.warn(`bloodborne-marker-reconciliation teardown: cath residue delete failed: ${err?.message}`);
  });
  // A lab_results write fans out beyond lab_results itself: migration 753's
  // BEFORE-trigger bumps pharmacy_patient_safety_versions on every insert, and
  // the pathway projector inbox takes clinical events. Neither is FK-bound to
  // the rows below, so they would survive this file and drift the next run's
  // fixtures; both are cleared here even when this file leaves them empty.
  await setTenantTx(TENANT, async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
    for (const table of [
      'pharmacy_patient_safety_versions',
      'pathway_projector_inbox',
      'clinical_timeline_events',
      'clinical_audit_events',
      'event_outbox',
    ]) {
      await tx.$executeRawUnsafe(
        `DELETE FROM ${table} WHERE tenant_id IN ($1::uuid, $2::uuid)`,
        TENANT, OTHER_TENANT,
      );
    }
  }).catch((err) => {
    console.warn(`bloodborne-marker-reconciliation teardown: residue delete failed: ${err?.message}`);
  });
  if (resultIds.length) {
    await prisma.$executeRawUnsafe(
      `DELETE FROM lab_results WHERE tenant_id IN ($1::uuid, $2::uuid) AND id = ANY($3::int[])`,
      TENANT, OTHER_TENANT, resultIds,
    ).catch(() => {});
  }
  await prisma.$executeRawUnsafe(
    `DELETE FROM lab_results
      WHERE tenant_id IN ($1::uuid, $2::uuid)
        AND patient_uid IN ($3::uuid, $4::uuid)`,
    TENANT, OTHER_TENANT, PATIENT, OTHER_PATIENT,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid, $3::uuid, $4::uuid)`,
    PATIENT, OTHER_PATIENT, SIGNER, OTHER_SIGNER,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM tenants WHERE id IN ($1::uuid, $2::uuid)`,
    TENANT, OTHER_TENANT,
  ).catch(() => {});
}

d('blood-borne marker reconciliation sweep (deep)', () => {
  beforeAll(async () => {
    previousRuntimeRole = process.env.AUTH_TENANT_RLS_RUNTIME_ROLE;
    try {
      for (const role of RUNTIME_ROLES) {
        process.env.AUTH_TENANT_RLS_RUNTIME_ROLE = role;
        runtimeRoleProvisioning.set(role, await ensureTenantRlsRuntimeRoleGrants());
      }
    } finally {
      if (previousRuntimeRole === undefined) delete process.env.AUTH_TENANT_RLS_RUNTIME_ROLE;
      else process.env.AUTH_TENANT_RLS_RUNTIME_ROLE = previousRuntimeRole;
    }

    await cleanup();
    for (const [id, slug] of [[TENANT, 'bbm-sweep'], [OTHER_TENANT, 'bbm-sweep-other']]) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO tenants (id, slug, name) VALUES ($1::uuid, $2, $2) ON CONFLICT (id) DO NOTHING`,
        id, slug,
      );
    }
    for (const [uid, tenant, role, phone] of [
      [PATIENT, TENANT, 'PATIENT', '+919000012011'],
      [OTHER_PATIENT, OTHER_TENANT, 'PATIENT', '+919000012012'],
      [SIGNER, TENANT, 'PATHOLOGIST', '+919000012099'],
      [OTHER_SIGNER, OTHER_TENANT, 'PATHOLOGIST', '+919000012098'],
    ]) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO users (uid, tenant_id, phone, name, role, is_active, status, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, 'BBM Sweep Test', $4, true, 'active', NOW())
         ON CONFLICT (uid) DO NOTHING`,
        uid, tenant, phone, role,
      );
    }
  }, 60000);

  afterAll(async () => {
    await cleanup();
  }, 60000);

  // -------------------------------------------------------------------------

  test('a signed reactive result with no marker is repaired into one linked row', async () => {
    const resultId = await seedSignedResult({ testCode: 'HBSAG', valueText: 'Reactive' });

    await expect(candidateIds()).resolves.toContain(resultId);

    const summary = await reconcileTenant({ tenantId: TENANT });
    expect(summary).toMatchObject({ recorded: 1, voided: 0, failed: 0, would_fail: 0 });
    expect(summary.candidate_examples).toContain(resultId);
    // repaired_examples names what actually got a row, which is the number an
    // operator reading the summary is looking for.
    expect(summary.repaired_examples).toContain(resultId);

    const rows = await markerRowsFor(resultId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      patient_uid: PATIENT,
      marker: 'hbsag',
      result: 'reactive',
      // The value the sign-off hook writes — the sweep re-drives that writer
      // rather than inventing a provenance of its own.
      source: 'lab_result',
      lab_result_id: resultId,
      recorded_by: SIGNER,
      voided_at: null,
    });
    // evidence.decision carries the result's own status, not a flat 'verified'.
    expect(rows[0].evidence).toMatchObject({ decision: 'verified', test_code: 'HBSAG' });
  }, 60000);

  test('a second sweep is a no-op: the repaired result is no longer a candidate', async () => {
    const resultId = await seedSignedResult({ testCode: 'HIV', valueText: 'Non-reactive' });

    const first = await reconcileTenant({ tenantId: TENANT });
    expect(first.recorded).toBeGreaterThanOrEqual(1);
    await expect(activeMarkerFor(resultId)).resolves.toHaveLength(1);

    const second = await reconcileTenant({ tenantId: TENANT });
    expect(second).toMatchObject({ candidates: 0, recorded: 0, voided: 0, failed: 0 });
    await expect(candidateIds()).resolves.not.toContain(resultId);
    // Still exactly one row: the sweep did not void-and-reinsert an identical
    // finding on its second pass.
    await expect(markerRowsFor(resultId)).resolves.toHaveLength(1);
  }, 60000);

  test('the writer itself reports skipped if it is re-driven over a repaired result', async () => {
    // The sweep's own idempotence is the anti-join; this is the second layer,
    // which is what protects two sweeps that read their candidate lists before
    // either committed. Same call shape the sweep uses.
    const resultId = await seedSignedResult({ testCode: 'HCV', valueText: 'Non reactive' });
    await reconcileTenant({ tenantId: TENANT });
    const [active] = await activeMarkerFor(resultId);

    const replay = await recordMarkersFromSignedResults({
      tenantId: TENANT,
      resultIds: [resultId],
      decision: 'verified',
      actorUid: SIGNER,
    });
    expect(replay.recorded).toHaveLength(0);
    expect(replay.skipped).toEqual([resultId]);
    expect(replay.voided).toBe(0);
    const rows = await markerRowsFor(resultId);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].id)).toBe(Number(active.id));
  }, 60000);

  // -------------------------------------------------------------------------
  // Voided markers: who voided it decides whether the sweep may re-mark.
  //
  // Owner-vetoable decision, 2026-09-05. The sweep used to treat ANY voided row
  // as an absent one and re-mark the lab result on the very next run, which
  // silently undid a deliberate clinical act and would have done so every run
  // forever. A row a PERSON voided is now a tombstone; a row the WRITER
  // superseded is not.
  // -------------------------------------------------------------------------

  test('a marker a person VOIDED is a tombstone: the result is never re-marked', async () => {
    const resultId = await seedSignedResult({ testCode: 'HBSAG', valueText: 'Reactive' });
    await reconcileTenant({ tenantId: TENANT });
    const [recorded] = await activeMarkerFor(resultId);
    expect(recorded).toBeTruthy();

    // With an ACTIVE row it is excluded...
    await expect(candidateIds()).resolves.not.toContain(resultId);

    await voidMarker({
      tenantId: TENANT,
      patientUid: PATIENT,
      markerId: Number(recorded.id),
      actorUid: SIGNER,
      reason: 'voided by the reconciliation deep suite',
    });

    // ...and it STAYS excluded. voidMarker is how a clinician says "this marker
    // does not belong on this patient"; the operator running a sweep is not
    // that clinician, and re-marking would overrule them on a schedule.
    // Deleting the tombstone predicate from the candidate query is the mutation
    // this case is calibrated against.
    await expect(candidateIds()).resolves.not.toContain(resultId);

    const summary = await reconcileTenant({ tenantId: TENANT });
    expect(summary.candidate_examples).not.toContain(resultId);

    // Still exactly the one voided row: nothing was resurrected.
    const rows = await markerRowsFor(resultId);
    expect(rows).toHaveLength(1);
    expect(rows[0].voided_at).not.toBeNull();
    expect(rows[0].void_reason).toBe('voided by the reconciliation deep suite');
  }, 60000);

  test('a marker the WRITER superseded is repairable again', async () => {
    const resultId = await seedSignedResult({ testCode: 'HIV', valueText: 'Reactive' });
    await reconcileTenant({ tenantId: TENANT });
    const [recorded] = await activeMarkerFor(resultId);
    expect(recorded).toBeTruthy();

    // The writer's own supersession, written the way upsertMarkerForLabResult
    // writes it. Seeded rather than driven because the writer voids and
    // re-inserts in ONE transaction, so "superseded, with no active row" is a
    // state only a partial write leaves behind — which is the very state this
    // sweep exists to find.
    await prisma.$executeRawUnsafe(
      `UPDATE patient_bloodborne_markers
          SET voided_at = NOW(), voided_by = $3::uuid, void_reason = $4
        WHERE tenant_id = $1::uuid AND id = $2::bigint`,
      TENANT, Number(recorded.id), SIGNER, SUPERSESSION_VOID_REASON,
    );

    // The writer saying "the result changed" is not a person saying "this is
    // wrong", so the lab result is unrepresented and the sweep must offer it.
    await expect(candidateIds()).resolves.toContain(resultId);

    const summary = await reconcileTenant({ tenantId: TENANT });
    expect(summary.recorded).toBeGreaterThanOrEqual(1);

    const rows = await markerRowsFor(resultId);
    expect(rows).toHaveLength(2);
    expect(rows[0].voided_at).not.toBeNull();
    expect(rows[1].voided_at).toBeNull();
    // A fresh row, not a resurrection of the voided one.
    expect(Number(rows[1].id)).toBeGreaterThan(Number(recorded.id));
    expect(rows[1]).toMatchObject({ result: 'reactive', source: 'lab_result', lab_result_id: resultId });
  }, 60000);

  test('one person-void tombstones a result even beside a writer supersession', async () => {
    const resultId = await seedSignedResult({ testCode: 'HCV', valueText: 'Reactive' });
    await reconcileTenant({ tenantId: TENANT });
    const [first] = await activeMarkerFor(resultId);

    await prisma.$executeRawUnsafe(
      `UPDATE patient_bloodborne_markers
          SET voided_at = NOW(), voided_by = $3::uuid, void_reason = $4
        WHERE tenant_id = $1::uuid AND id = $2::bigint`,
      TENANT, Number(first.id), SIGNER, SUPERSESSION_VOID_REASON,
    );
    await reconcileTenant({ tenantId: TENANT });
    const [second] = await activeMarkerFor(resultId);
    expect(Number(second.id)).toBeGreaterThan(Number(first.id));

    await voidMarker({
      tenantId: TENANT,
      patientUid: PATIENT,
      markerId: Number(second.id),
      actorUid: SIGNER,
      reason: 'clinician says this serology is not this patient',
    });

    // Two voided rows now, one of each kind. The tombstone wins: NOT EXISTS
    // over the person-voided row is enough on its own.
    await expect(candidateIds()).resolves.not.toContain(resultId);
    await expect(markerRowsFor(resultId)).resolves.toHaveLength(2);
  }, 60000);

  test('unsigned and non-serology results are never candidates', async () => {
    const unsigned = await seedUnsignedResult({ testCode: 'HIV' });
    const quantitative = await seedSignedResult({ testCode: 'HGB', valueText: '12.4' });
    const ids = await candidateIds();
    expect(ids).not.toContain(unsigned);
    expect(ids).not.toContain(quantitative);

    await reconcileTenant({ tenantId: TENANT });
    await expect(markerRowsFor(unsigned)).resolves.toHaveLength(0);
    await expect(markerRowsFor(quantitative)).resolves.toHaveLength(0);
  }, 60000);

  test('an aliased, unnormalised analyte code still reaches the sweep', async () => {
    // 'Anti-HCV' only matches the map after normalizeCode; the SQL pre-filter
    // has to normalise the column the same way or this result is invisible.
    const resultId = await seedSignedResult({ testCode: 'Anti-HCV', valueText: 'Reactive' });
    await expect(candidateIds()).resolves.toContain(resultId);
    await reconcileTenant({ tenantId: TENANT });
    await expect(activeMarkerFor(resultId)).resolves.toMatchObject([{ marker: 'hcv', result: 'reactive' }]);
  }, 60000);

  test('a dry run reports the candidates and writes nothing', async () => {
    const resultId = await seedSignedResult({ testCode: 'HBSAG', valueText: 'Reactive' });
    const summary = await reconcileTenant({ tenantId: TENANT, dryRun: true });
    expect(summary.candidates).toBeGreaterThanOrEqual(1);
    expect(summary).toMatchObject({ recorded: 0, voided: 0, skipped: 0, failed: 0 });
    expect(summary.candidate_examples).toContain(resultId);
    expect(summary.repaired_examples).toEqual([]);
    await expect(markerRowsFor(resultId)).resolves.toHaveLength(0);
    // Still there to be repaired afterwards.
    await expect(candidateIds()).resolves.toContain(resultId);
  }, 60000);

  test('the since window bounds which signed results the sweep offers', async () => {
    const old = await seedSignedResult({ testCode: 'HIV', valueText: 'Reactive', signedDaysBack: 30 });
    const recent = await seedSignedResult({ testCode: 'HCV', valueText: 'Reactive', signedDaysBack: 1 });
    const since = new Date(Date.now() - 7 * 86400000);
    const windowed = await candidateIds(TENANT, { since });
    expect(windowed).toContain(recent);
    expect(windowed).not.toContain(old);
    // Without a window both are offered.
    const all = await candidateIds();
    expect(all).toEqual(expect.arrayContaining([old, recent]));
  }, 60000);

  // -------------------------------------------------------------------------
  // Spec §7.1: the sweep must apply the same clamp-don't-drop rule.
  // -------------------------------------------------------------------------

  test('a future-dated REACTIVE result is clamped and recorded, never dropped', async () => {
    const resultId = await seedSignedResult({
      testCode: 'HBSAG', valueText: 'Reactive', daysBack: -5,
    });
    const summary = await reconcileTenant({ tenantId: TENANT });
    expect(summary.recorded).toBeGreaterThanOrEqual(1);

    const [row] = await activeMarkerFor(resultId);
    expect(row).toMatchObject({ marker: 'hbsag', result: 'reactive' });
    // Clamped to today's clinical date, with the skew kept as evidence — the
    // sweep inherits this by re-driving the writer rather than inserting.
    // isoDate, not String(...).slice: the driver materialises a DATE column as
    // a JS Date, whose default stringification is 'Sat Sep 05 2026' and would
    // make this assertion compare two things that are never equal.
    expect(isoDate(row.tested_on)).toBe(clinicalDate(new Date()));
    expect(row.evidence).toMatchObject({
      tested_on_clamped: true,
      tested_on_problem: 'future_dated',
    });
  }, 60000);

  test('a future-dated NON-reactive result is still dropped, and counted as failed', async () => {
    const resultId = await seedSignedResult({
      testCode: 'HIV', valueText: 'Non-reactive', daysBack: -5,
    });
    const summary = await reconcileTenant({ tenantId: TENANT });
    expect(summary.failed).toBeGreaterThanOrEqual(1);
    await expect(markerRowsFor(resultId)).resolves.toHaveLength(0);
    // It stays a candidate — an unusable date is a real gap, and the sweep
    // reports it every run rather than pretending it was repaired.
    await expect(candidateIds()).resolves.toContain(resultId);
  }, 60000);

  // -------------------------------------------------------------------------
  // Isolation
  // -------------------------------------------------------------------------

  test('sweeping one tenant leaves another tenant\'s gap untouched', async () => {
    const mine = await seedSignedResult({ testCode: 'HBSAG', valueText: 'Reactive' });
    const theirs = await seedSignedResult({
      testCode: 'HBSAG',
      valueText: 'Reactive',
      tenantId: OTHER_TENANT,
      patientUid: OTHER_PATIENT,
      signedBy: OTHER_SIGNER,
    });

    const summary = await reconcileTenant({ tenantId: TENANT });
    expect(summary.candidate_examples).not.toContain(theirs);
    await expect(activeMarkerFor(mine)).resolves.toHaveLength(1);
    // The other tenant's result is untouched...
    await expect(markerRowsFor(theirs, OTHER_TENANT)).resolves.toHaveLength(0);
    // ...and still its own tenant's candidate, so it is repairable there.
    await expect(candidateIds(OTHER_TENANT)).resolves.toContain(theirs);
    await expect(candidateIds(TENANT)).resolves.not.toContain(theirs);

    const theirSummary = await reconcileTenant({ tenantId: OTHER_TENANT });
    expect(theirSummary.recorded).toBe(1);
    await expect(activeMarkerFor(theirs, OTHER_TENANT)).resolves.toHaveLength(1);
  }, 60000);

  test('the candidate query works under the runtime RLS role, not just as owner', async () => {
    if (runtimeRoleProvisioning.get(RLS_ROLE)?.skipped === true) return;

    const probe = await prisma.$queryRawUnsafe(
      `SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1::name) AS role_exists,
              COALESCE((SELECT has_table_privilege($1::name, 'public.lab_results', 'SELECT')
                          FROM pg_roles WHERE rolname = $1::name), false) AS can_read_results,
              COALESCE((SELECT has_table_privilege($1::name, 'public.patient_bloodborne_markers', 'SELECT')
                          FROM pg_roles WHERE rolname = $1::name), false) AS can_read_markers`,
      RLS_ROLE,
    );
    expect(probe[0].role_exists).toBe(true);
    expect(probe[0].can_read_results).toBe(true);
    expect(probe[0].can_read_markers).toBe(true);

    const resultId = await seedSignedResult({ testCode: 'HCV', valueText: 'Reactive' });

    // Drive the PRODUCTION query under the production role rather than
    // re-typing its SQL here: setTenant reads AUTH_TENANT_RLS_RUNTIME_ROLE at
    // call time and issues SET LOCAL ROLE, so this is the same statement the
    // sweep runs in a deployment where RLS is actually enforced.
    const before = process.env.AUTH_TENANT_RLS_RUNTIME_ROLE;
    let underRole;
    let crossTenant;
    try {
      process.env.AUTH_TENANT_RLS_RUNTIME_ROLE = RLS_ROLE;
      underRole = await candidateIds(TENANT);
      crossTenant = await candidateIds(OTHER_TENANT);
    } finally {
      if (before === undefined) delete process.env.AUTH_TENANT_RLS_RUNTIME_ROLE;
      else process.env.AUTH_TENANT_RLS_RUNTIME_ROLE = before;
    }
    expect(underRole).toContain(resultId);
    // RLS is doing the scoping, not just the WHERE clause: the same query run
    // in the other tenant's context cannot see this tenant's result.
    expect(crossTenant).not.toContain(resultId);
  }, 60000);

  // -------------------------------------------------------------------------
  // Head-of-line blocking, and the gaps no sweep can close.
  // -------------------------------------------------------------------------

  test('a result with no signing actor is excluded from the window and counted', async () => {
    // recorded_by is NOT NULL behind an FK to users, so this gap is permanent.
    // Excluding it in SQL is what stops it consuming a slot in every window
    // forever; counting it is what stops the exclusion being silent, because
    // "0 candidates" and "0 candidates, 1 unrepairable" are different answers
    // to whether the serology record is whole.
    const orphan = await seedSignedResult({
      testCode: 'HBSAG', valueText: 'Reactive', signedBy: null,
    });
    await expect(candidateIds()).resolves.not.toContain(orphan);

    const summary = await reconcileTenant({ tenantId: TENANT, dryRun: true });
    expect(summary.candidate_examples).not.toContain(orphan);
    expect(summary.unrepairable_excluded).toBeGreaterThanOrEqual(1);
    expect(summary.unrepairable_missing_actor).toBeGreaterThanOrEqual(1);
  }, 60000);

  test('two permanently failing rows do not pin the window within one run', async () => {
    // The two future-dated NON-reactive results below fail in the writer every
    // time they are driven and keep their place at the head of
    // ORDER BY result.id; with a page size of two they fill the first page
    // exactly. A sweep that re-issued the same LIMIT would hand itself the same
    // two rows forever and never reach the third. OTHER_TENANT, so the residue
    // the cases above leave in TENANT cannot change which rows land in which
    // page.
    const firstFailure = await seedSignedResult({
      testCode: 'HIV', valueText: 'Non-reactive', daysBack: -5,
      tenantId: OTHER_TENANT, patientUid: OTHER_PATIENT, signedBy: OTHER_SIGNER,
    });
    const secondFailure = await seedSignedResult({
      testCode: 'HCV', valueText: 'Non-reactive', daysBack: -5,
      tenantId: OTHER_TENANT, patientUid: OTHER_PATIENT, signedBy: OTHER_SIGNER,
    });
    const repairable = await seedSignedResult({
      testCode: 'HBSAG', valueText: 'Reactive',
      tenantId: OTHER_TENANT, patientUid: OTHER_PATIENT, signedBy: OTHER_SIGNER,
    });
    expect(secondFailure).toBeGreaterThan(firstFailure);
    expect(repairable).toBeGreaterThan(secondFailure);

    const summary = await reconcileTenant({ tenantId: OTHER_TENANT, pageSize: 2 });
    expect(summary.candidates).toBe(3);
    expect(summary.failed).toBe(2);
    expect(summary.repaired_examples).toEqual([repairable]);
    await expect(activeMarkerFor(repairable, OTHER_TENANT)).resolves.toHaveLength(1);

    // The two failures are still candidates: an unusable date is a real gap and
    // the sweep reports it every run rather than pretending it was repaired.
    const remaining = await candidateIds(OTHER_TENANT);
    expect(remaining).toEqual(expect.arrayContaining([firstFailure, secondFailure]));
    expect(remaining).not.toContain(repairable);
  }, 60000);

  // -------------------------------------------------------------------------
  // Spec §5.1 / §7: repairing a REACTIVE marker must reach the exposure
  // handlers, because that is what quarantines the devices used on the patient.
  // -------------------------------------------------------------------------

  describe('exposure fan-out', () => {
    let offProbe = null;
    const seen = [];

    beforeAll(() => {
      offProbe = registerExposureHandler(async (event) => { seen.push(event); });
    });

    afterAll(() => {
      if (offProbe) offProbe();
    });

    beforeEach(() => {
      seen.length = 0;
    });

    test('the production handler is registered in the sweep process', () => {
      // The bootstrap import at the top of this file is the only thing that
      // makes this true here, exactly as it is in the operator script, and the
      // count was taken before this suite's own probe so it cannot be the
      // probe being counted.
      expect(HANDLERS_FROM_BOOTSTRAP).toBeGreaterThanOrEqual(1);
      expect(exposureHandlerCount()).toBe(HANDLERS_FROM_BOOTSTRAP + 1);
    });

    test('a reactive repair notifies handlers with the patient and the marker row', async () => {
      const resultId = await seedSignedResult({ testCode: 'HBSAG', valueText: 'Reactive' });
      const summary = await reconcileTenant({ tenantId: TENANT });
      expect(summary.recorded).toBeGreaterThanOrEqual(1);
      const [marker] = await activeMarkerFor(resultId);

      const event = seen.find((row) => Number(row.markerRowId) === Number(marker.id));
      expect(event).toBeTruthy();
      expect(event).toMatchObject({
        tenantId: TENANT,
        patientUid: PATIENT,
        marker: 'hbsag',
        result: 'reactive',
        labResultId: resultId,
      });
    }, 60000);

    test('a device used on that patient is quarantined by the REAL handler', async () => {
      const { deviceId } = await seedExposedDevice();
      await expect(deviceRow(deviceId)).resolves.toMatchObject({
        status: 'available', exposure_flag: false,
      });

      const resultId = await seedSignedResult({ testCode: 'HIV', valueText: 'Reactive' });
      const summary = await reconcileTenant({ tenantId: TENANT });
      expect(summary.recorded).toBeGreaterThanOrEqual(1);
      await expect(activeMarkerFor(resultId)).resolves.toHaveLength(1);

      // This is the assertion the bootstrap exists for. Without that import the
      // marker still lands and the sweep still reports a clean repair, and this
      // device stays 'available' — a reprocessable device that touched a
      // patient with a reactive HIV result, released back into the register.
      const device = await deviceRow(deviceId);
      expect(device.status).toBe('quarantined');
      expect(device.exposure_flag).toBe(true);
      expect(device.exposure_markers).toContain('hiv');
    }, 120000);

    test('a NON-reactive repair notifies nobody', async () => {
      const resultId = await seedSignedResult({ testCode: 'HCV', valueText: 'Non reactive' });
      await reconcileTenant({ tenantId: TENANT });
      const [marker] = await activeMarkerFor(resultId);
      expect(marker.result).toBe('non_reactive');
      expect(seen.find((row) => Number(row.markerRowId) === Number(marker.id))).toBeUndefined();
    }, 60000);
  });
});
