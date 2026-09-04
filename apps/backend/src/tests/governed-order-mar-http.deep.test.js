// src/tests/governed-order-mar-http.deep.test.js
//
// The MAR five-rights contract OVER HTTP.
//
// PR #940 retired POST /api/v1/clinical/mar/schedule: a MAR dose is now
// materialised ONLY as a post-commit side effect of the governed clinical-order
// workflow.
//
// WHAT THIS SUITE OWNS, and what it deliberately does not. The genuinely
// uncovered seam is the one #940 created: POST /emr/orders -> the post-commit
// ward-indent hook -> MAR materialisation, driven entirely over HTTP. Nothing
// else covers it. cpoe-order-idempotency.deep.test.js builds a ward with no
// facility_id, so createWardIndentForClinicalMedicationOrder returns null,
// medicationWardSupplyReady stays false and no dose is ever charted;
// med03-ward-medication-route-journey.deep.test.js raw-SQL-inserts its
// clinical_orders row and so never runs the create hook at all.
//
// The neighbouring contracts belong to other files, and this suite defers to
// them rather than re-proving them:
//   - clinical-safety.test.js owns the five rights at the SERVICE layer,
//     including the wrong-patient non-overridable hard stop.
//   - bcma-closed-loop.deep.test.js (B4.2, line ~1309) owns that same hard stop
//     over HTTP. Test 2 below re-asserts it ON A DOSE THIS SUITE CHARTED THROUGH
//     THE GOVERNED PATH, which is the part bcma-closed-loop cannot see; if you
//     are changing the MAR_PATIENT_MISMATCH shape, that file is the primary.
//   - unit/marRouteClosureContracts.test.js owns the retired route's 409, and
//     scripts/smoke-staff-clinical-safety.ps1 re-probes it against a running
//     server. Neither is repeated here.
//
// So: four requirements, proven on the governed path.
//
//   1. route / auth / middleware wiring on the MAR five-rights surface
//   2. one valid end-to-end flow: governed order -> MAR doses -> verify ->
//      administer
//   3. wrong-patient rejection over HTTP
//   4. duplicate-schedule prevention
//
// The four tests are ORDERED and share fixture state. Test 1 creates the order
// and its two doses over HTTP and administers dose 1. Tests 2 and 3 exercise
// the still-scheduled dose 2 — every request they make is expected to be
// REFUSED, so they leave it scheduled, and each asserts that afterwards. Test 4
// replays the governed scheduler across the whole order.

import { randomUUID } from 'node:crypto';

import { jest } from '@jest/globals';
import request from 'supertest';

import app from '../app.js';
import prisma from '../lib/prisma.js';
import { seedMedicationFacilityAuthority } from './helpers/medicationEvidenceFixture.js';
import { API_KEY, generateTestToken } from './testClient.js';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;
jest.setTimeout(60_000);

describeIfDb('governed clinical order -> MAR five rights over HTTP', () => {
  const tenantId = randomUUID();
  const patientUid = randomUUID();
  const otherPatientUid = randomUUID();
  const doctorUid = randomUUID();
  const pharmacistUid = randomUUID();
  const nurseUid = randomUUID();
  const adminUid = randomUUID();
  const run = `${process.pid}-${Date.now()}`;
  // Suite-private composition key: `drug_compositions` has no tenant_id, so the
  // teardown below can only delete this row safely because the key embeds this
  // suite's random tenant. (The shared `mar_medication_evidence_fixture_v1` row
  // used by medicationEvidenceFixture is cross-suite and must never be deleted.)
  const compositionKey = `governed-mar-http-${tenantId}`;
  const catalogName = `GOVMAR Paracetamol ${run}`;
  const batchBarcode = `GOVMAR-BATCH-${run}`;
  const marBase = '/api/v1/clinical/mar';
  const wardBase = '/api/v1/pharmacy-orders/ward-indents';
  const orderBase = '/api/v1/emr/orders';

  // THE START-DATE ANCHOR. buildMarEntryFromOrderDetails falls back to
  // `new Date().toISOString()` when clinical_orders.start_date is NULL
  // (orderEntryService.js), and it re-evaluates that fallback on EVERY call —
  // the initial post-commit dispatch and every retry-mar-scheduling replay. The
  // only thing that would then collapse the two schedules is findScheduledSibling's
  // +/-1 minute window (marService.js), i.e. wall-clock luck: a run slower than
  // 60s between create and retry would silently DOUBLE the schedule and the
  // dedup assertion would still be green. Pinning start_date makes both paths
  // compute byte-identical slot instants, so test 4 proves dedup rather than
  // proving the test finished quickly. Test 1 asserts the pin actually persisted.
  const scheduleAnchor = new Date().toISOString();
  const secondDoseAt = new Date(
    new Date(scheduleAnchor).getTime() + 12 * 60 * 60 * 1000,
  ).toISOString();

  const actorIds = {};
  let facilityId;
  let storageLocationId;
  let wardId;
  let admissionId;
  let encounterId;
  let catalog;
  let catalogId;
  let inventoryItemId;
  let inventoryBatchId;
  let clinicalOrderId;
  let indentId;
  let indentItemId;
  let doseIds = [];

  // Same client helper as med03-ward-medication-route-journey.deep.test.js, plus
  // a keyless POST: /mar/verify carries no requireIdempotencyKey at all, and the
  // wiring test needs to send administer-with-scan WITHOUT the header to prove
  // the idempotency gate is actually mounted.
  function client(role, uid) {
    const token = generateTestToken(role, {
      uid,
      id: actorIds[uid],
      tenant_id: tenantId,
      deviceType: 'desktop',
    });
    return {
      get: (path) => request(app)
        .get(path)
        .set('x-api-key', API_KEY)
        .set('Authorization', `Bearer ${token}`),
      post: (path, idempotencyKey) => request(app)
        .post(path)
        .set('x-api-key', API_KEY)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', idempotencyKey),
      postWithoutKey: (path) => request(app)
        .post(path)
        .set('x-api-key', API_KEY)
        .set('Authorization', `Bearer ${token}`),
      put: (path, idempotencyKey) => request(app)
        .put(path)
        .set('x-api-key', API_KEY)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', idempotencyKey),
    };
  }

  function expectState(response, status, stateVersion) {
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      status,
      state_version: stateVersion,
    });
    return response.body.data;
  }

  // Every dose this order owns, newest slot last. `status <> 'cancelled'` mirrors
  // the predicate findScheduledSibling and the /orders/patient projection use, so
  // the count here is the same count the dedup logic reasons about.
  async function orderDoses() {
    return prisma.$queryRawUnsafe(
      `SELECT id, medication_name, dose, route, scheduled_time, status,
              clinical_order_id, supply_quantity_per_dose,
              administered_at, administered_by::text AS administered_by,
              all_rights_passed, override_reason
         FROM medication_administrations
        WHERE tenant_id = $1::uuid
          AND clinical_order_id = $2::int
          AND status <> 'cancelled'
        ORDER BY scheduled_time, id`,
      tenantId,
      clinicalOrderId,
    );
  }

  beforeAll(async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name, region, status, created_at, updated_at)
       VALUES ($1::uuid, $2::text, 'Governed order MAR HTTP', 'IN',
               'active', NOW(), NOW())`,
      tenantId,
      `governed-mar-http-${run}`,
    );
    const users = await prisma.$queryRawUnsafe(
      `INSERT INTO users
         (tenant_id, uid, phone, name, role, is_active, status, updated_at)
       VALUES
         ($1::uuid, $2::uuid, $8::text, 'GOVMAR charted patient',
          'PATIENT', TRUE, 'active', NOW()),
         ($1::uuid, $3::uuid, $9::text, 'GOVMAR neighbouring patient',
          'PATIENT', TRUE, 'active', NOW()),
         ($1::uuid, $4::uuid, $10::text, 'GOVMAR prescriber',
          'DOCTOR', TRUE, 'active', NOW()),
         ($1::uuid, $5::uuid, $11::text, 'GOVMAR pharmacy incharge',
          'PHARMACY_INCHARGE', TRUE, 'active', NOW()),
         ($1::uuid, $6::uuid, $12::text, 'GOVMAR ward nurse',
          'NURSING_INCHARGE', TRUE, 'active', NOW()),
         ($1::uuid, $7::uuid, $13::text, 'GOVMAR grant admin',
          'ADMIN', TRUE, 'active', NOW())
       RETURNING id, uid::text, role`,
      tenantId,
      patientUid,
      otherPatientUid,
      doctorUid,
      pharmacistUid,
      nurseUid,
      adminUid,
      `+91931${String(Date.now()).slice(-7)}`,
      `+91932${String(Date.now()).slice(-7)}`,
      `+91933${String(Date.now()).slice(-7)}`,
      `+91934${String(Date.now()).slice(-7)}`,
      `+91935${String(Date.now()).slice(-7)}`,
      `+91936${String(Date.now()).slice(-7)}`,
    );
    for (const user of users) actorIds[user.uid] = Number(user.id);

    // Authentication fails CLOSED when a token's subject does not resolve to a
    // live `users` row (isUserTokensRevoked): the request 401s with
    // TOKEN_REVOKED before the route's own authz gate runs, which would silently
    // turn every 403 assertion below into an authentication assertion.
    //
    // (No ensureTestIdentity pass here: the rows above are inserted
    // is_active/active in this suite's own tenant, so re-livening them would be
    // six no-op UPDATEs dressed as a safety net.)

    const authority = await seedMedicationFacilityAuthority({
      prisma,
      tenantId,
      pharmacistUid,
      grantAdminUid: adminUid,
      run: `govmar-${run}`,
    });
    facilityId = authority.facilityId;
    storageLocationId = authority.storageLocationId;

    // The ward MUST be bound to an ACTIVE facility. createWardIndentForClinicalMedicationOrder
    // inner-joins `facilities ... status='active'`; with no match it returns null,
    // the post-commit hook withholds MAR scheduling (MAR_SCHEDULE_WARD_SUPPLY_REQUIRED),
    // and POST /orders still answers 201 with ZERO doses — a 0-dose result would
    // read exactly like "dedup working" in test 4.
    wardId = Number((await prisma.$queryRawUnsafe(
      `INSERT INTO wards
         (tenant_id, name, facility_id, total_beds, created_at, updated_at)
       VALUES ($1::uuid, $2::text, $3::int, 12, NOW(), NOW())
       RETURNING id`,
      tenantId,
      `GOVMAR Ward ${run}`,
      facilityId,
    ))[0].id);

    const bedNumber = `GMH-${run.slice(-16)}`;
    const bedId = Number((await prisma.$queryRawUnsafe(
      `INSERT INTO beds
         (tenant_id, ward_id, ward_name, bed_number, status, patient_uid,
          created_at, updated_at)
       VALUES ($1::uuid, $2::int, $3::text, $4::text, 'occupied', $5::uuid,
               NOW(), NOW())
       RETURNING id`,
      tenantId,
      wardId,
      `GOVMAR Ward ${run}`,
      bedNumber,
      patientUid,
    ))[0].id);

    // The ACTIVE admission is what carries patient authorization on both mounts:
    // /api/v1/clinical is a legacy (non-careTeamModeGoverned) ENFORCE site, and
    // findAdmissionRelationship grants an IP nursing role on an 'admitted' row
    // with no care-team fixture at all. `attending_doctor` is what lets the
    // prescriber through guardClinicalOrderWrite on POST /emr/orders.
    const admissions = await prisma.$queryRawUnsafe(
      `INSERT INTO admissions
         (tenant_id, patient_uid, bed_id, status, admitted_at, ward, bed_number,
          created_by, attending_doctor, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::int, 'admitted', NOW(), $4::text, $5::text,
               $6::uuid, $7::uuid, NOW(), NOW())
       RETURNING id, encounter_id`,
      tenantId,
      patientUid,
      bedId,
      `GOVMAR Ward ${run}`,
      bedNumber,
      nurseUid,
      doctorUid,
    );
    admissionId = Number(admissions[0].id);
    encounterId = String(admissions[0].encounter_id);

    const compositionId = Number((await prisma.$queryRawUnsafe(
      `INSERT INTO drug_compositions
         (composition_key, display_label, active_ingredients, source)
       VALUES ($1::text, 'GOVMAR fixture paracetamol',
               ARRAY['paracetamol']::text[], 'curated')
       RETURNING id`,
      compositionKey,
    ))[0].id);

    // High-confidence clinical identity on every dimension: without it
    // bindMedicationOrderCatalogAuthority 409s the order at
    // CLINICAL_ORDER_MEDICATION_CATALOG_CLINICAL_IDENTITY_INCOMPLETE.
    catalog = (await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_catalog
         (tenant_id, name, generic_name, is_active, stock_quantity,
          unit_price, price, composition_id, composition_confidence,
          composition_source, strength, strength_key, strength_components,
          form, form_key, release_key, route, updated_at)
       VALUES ($1::uuid, $2::text, 'Paracetamol', TRUE, 20,
               12.50, 12.50, $3::int, 'high', 'test_fixture',
               '500 mg', '500mg', $4::jsonb,
               'tablet', 'tablet', 'ir', 'oral', NOW())
       RETURNING id, name, generic_name, composition_id,
                 composition_confidence, composition_source,
                 strength, strength_key, strength_components,
                 form, form_key, release_key, route`,
      tenantId,
      catalogName,
      compositionId,
      JSON.stringify([{ ingredient: 'paracetamol', value: '500', unit: 'mg' }]),
    ))[0];
    catalogId = Number(catalog.id);

    inventoryItemId = Number((await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_inventory_items
         (tenant_id, sku_code, display_name, catalog_id, strength, form,
          unit_label, schedule_class, is_narcotic, status, facility_id)
       VALUES ($1::uuid, $2::text, $3::text, $4::int, '500 mg', 'tablet',
               'tablet', 'OTC', FALSE, 'active', $5::int)
       RETURNING id`,
      tenantId,
      `GOVMAR-${run}`.slice(0, 80),
      catalogName,
      catalogId,
      facilityId,
    ))[0].id);

    // No batch metadata, so `batch_number` is the ONLY authoritative identifier
    // the scan can resolve to (batchBarcodeCandidates in marSupplyService) — the
    // drug right therefore comes back with drugMatchMode 'inventory_batch_number'.
    inventoryBatchId = Number((await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_inventory_batches
         (tenant_id, inventory_item_id, batch_number, expiry_date,
          received_quantity, remaining_quantity, status, facility_id,
          storage_location_id)
       VALUES ($1::uuid, $2::int, $3::text,
               (NOW() + INTERVAL '365 days')::date, 20, 20, 'in_stock',
               $4::int, $5::int)
       RETURNING id`,
      tenantId,
      inventoryItemId,
      batchBarcode,
      facilityId,
      storageLocationId,
    ))[0].id);
  });

  afterAll(async () => {
    await prisma.$transaction(async (tx) => {
      // `users` carries the RESTRICTIVE explicit_tenant_context_753 policy, so
      // without app.current_tenant_id the deletes below silently match zero rows.
      await tx.$executeRawUnsafe(
        `SELECT set_config('app.current_tenant_id', $1::text, TRUE),
                set_config('app.current_user_role', 'SUPER_ADMIN', TRUE),
                set_config('app.current_user_uid', $2::text, TRUE)`,
        tenantId,
        adminUid,
      );
      // MANDATORY, not an optimisation: the MAR path writes clinical_timeline_events,
      // whose BEFORE UPDATE OR DELETE trigger raises '<table> is append-only'.
      // Replica role disables user AND FK triggers, which is also what makes the
      // order-free sweep below safe.
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
      await tx.$executeRawUnsafe(
        `DO $cleanup$
         DECLARE
           relation_record RECORD;
         BEGIN
           FOR relation_record IN
             SELECT table_info.table_name
               FROM information_schema.tables table_info
               JOIN information_schema.columns column_info
                 ON column_info.table_schema = table_info.table_schema
                AND column_info.table_name = table_info.table_name
              WHERE table_info.table_schema = 'public'
                AND table_info.table_type = 'BASE TABLE'
                AND column_info.column_name = 'tenant_id'
              ORDER BY table_info.table_name
           LOOP
             EXECUTE format(
               'DELETE FROM public.%I WHERE tenant_id::text = $1',
               relation_record.table_name
             ) USING current_setting('app.current_tenant_id');
           END LOOP;
         END
         $cleanup$`,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM drug_compositions WHERE composition_key = $1::text`,
        compositionKey,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id = $1::uuid`,
        tenantId,
      );
      // 30s: Prisma's interactive-transaction default is 5s, and FK
      // revalidation on the users/tenants deletes blows that budget — the
      // symptom is a run reporting "Suites failed" next to "Tests passed".
    }, { timeout: 30_000 });
    await prisma.$disconnect().catch(() => {});
  }, 60_000);

  test('materialises MAR doses only through the governed clinical-order workflow, then verifies and administers over HTTP', async () => {
    const doctor = client('DOCTOR', doctorUid);
    const pharmacist = client('PHARMACY_INCHARGE', pharmacistUid);
    const nurse = client('NURSING_INCHARGE', nurseUid);

    // BD x 1 day = ceil(24/12) = 2 doses, 12h apart. Two slots that far apart
    // cannot fall inside each other's +/-1 minute dedup window, so a real
    // duplicate in test 4 cannot be masked by the order self-matching.
    const created = await doctor
      .post(orderBase, `govmar-order-${run}`)
      .send({
        patient_uid: patientUid,
        encounter_id: encounterId,
        order_type: 'medication',
        priority: 'routine',
        start_date: scheduleAnchor,
        details: {
          catalog_id: catalogId,
          dose: '500 mg',
          route: 'oral',
          frequency: 'BD',
          duration_days: 1,
          quantity_requested: 2,
          unit: 'tablet',
          supply_quantity_per_dose: 1,
        },
      });
    expect(created.status).toBe(201);
    expect(created.body.data.order).toMatchObject({
      patient_uid: patientUid,
      encounter_id: encounterId,
      order_type: 'medication',
      status: 'ordered',
      ordered_by: doctorUid,
      verified_by: null,
      verified_at: null,
    });
    clinicalOrderId = Number(created.body.data.order.id);
    // The pin actually persisted. Without this the dedup assertion in test 4
    // would still pass on the NULL-start_date fallback whenever the run happens
    // to finish inside 60 seconds.
    expect(new Date(created.body.data.order.start_date).getTime())
      .toBe(new Date(scheduleAnchor).getTime());

    // The order's clinical identity was bound to the catalog by the server.
    // Assert what the seal COVERS, literally. Recomputing it here with the same
    // binder on the same inputs would be a tautology: the two hashes would move
    // together under any change to the sealed shape, so the assertion could
    // never fail for the reason it appears to guard.
    const persistedOrder = (await prisma.$queryRawUnsafe(
      `SELECT details, route, status
         FROM clinical_orders
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      tenantId,
      clinicalOrderId,
    ))[0];
    expect(persistedOrder.details.medication_name).toBe(catalogName);
    // Note `route: 'PO'`, not the 'oral' that was ordered: the seal records the
    // CANONICAL route, so a later administration claiming a different route
    // cannot match a seal that was bound under its colloquial spelling. The
    // recompute-and-compare version of this assertion hid that entirely.
    expect(persistedOrder.details.catalog_authority.prescribed).toEqual({
      medication_name: catalogName,
      dose: '500 mg',
      route: 'PO',
      quantity_requested: 2,
      unit: 'tablet',
    });
    expect(persistedOrder.details.catalog_authority_sha256)
      .toMatch(/^[0-9a-f]{64}$/);

    // MAR scheduling is AWAITED inside the create request
    // (orderEntryService: `await integrationDispatch` for medication orders), so
    // the doses exist by the time the 201 lands — no polling, no sleep.
    const doses = await orderDoses();
    expect(doses).toHaveLength(2);
    doseIds = doses.map((dose) => Number(dose.id));
    expect(doses[0]).toMatchObject({
      medication_name: catalogName,
      dose: '500 mg',
      route: 'oral',
      status: 'scheduled',
      clinical_order_id: clinicalOrderId,
    });
    expect(Number(doses[0].supply_quantity_per_dose)).toBe(1);
    expect(new Date(doses[0].scheduled_time).getTime())
      .toBe(new Date(scheduleAnchor).getTime());
    expect(new Date(doses[1].scheduled_time).getTime())
      .toBe(new Date(secondDoseAt).getTime());

    // The ward indent is auto-created post-commit from the clinical order — the
    // nurse never raises it by hand on this path, so look up what the workflow
    // materialised rather than posting one.
    const custody = await prisma.$queryRawUnsafe(
      `SELECT indent.id AS indent_id, indent.status, indent.state_version,
              indent.admission_id, indent.facility_id,
              item.id AS item_id, item.quantity_requested, item.unit
         FROM ward_indents indent
         JOIN ward_indent_items item
           ON item.tenant_id = indent.tenant_id
          AND item.ward_indent_id = indent.id
        WHERE indent.tenant_id = $1::uuid
          AND item.clinical_order_id = $2::int
        ORDER BY indent.id`,
      tenantId,
      clinicalOrderId,
    );
    expect(custody).toHaveLength(1);
    expect(custody[0]).toMatchObject({
      status: 'requested',
      state_version: 1,
      admission_id: admissionId,
      facility_id: facilityId,
      unit: 'tablet',
    });
    expect(Number(custody[0].quantity_requested)).toBe(2);
    indentId = Number(custody[0].indent_id);
    indentItemId = Number(custody[0].item_id);

    // VERIFY BEFORE ISSUE, and verify FIRST. Two constraints bracket this step:
    // verifyOrder refuses an order that has left 'ordered', and the issue
    // transition re-reads the order and 409s MEDICATION_ORDER_VERIFICATION_REQUIRED
    // (then ..._EVIDENCE_REQUIRED) unless it is verified with verified_by +
    // verified_at. So verification cannot be deferred past issue, and cannot be
    // done late either.
    const verified = await pharmacist
      .put(`${orderBase}/${clinicalOrderId}/verify`, `govmar-verify-${run}`)
      .send({});
    expect(verified.status).toBe(200);
    expect(verified.body.data).toMatchObject({
      id: clinicalOrderId,
      status: 'verified',
      verified_by: pharmacistUid,
    });
    expect(verified.body.data.verified_at).not.toBeNull();

    const reserved = expectState(
      await pharmacist
        .post(`${wardBase}/${indentId}/reserve`, `govmar-reserve-${run}`)
        .send({ expected_version: 1 }),
      'reserved',
      2,
    );
    const approved = expectState(
      await pharmacist
        .post(`${wardBase}/${indentId}/approve`, `govmar-approve-${run}`)
        .send({ expected_version: reserved.state_version }),
      'approved',
      3,
    );
    const issued = expectState(
      await pharmacist
        .post(`${wardBase}/${indentId}/issue`, `govmar-issue-${run}`)
        .send({ expected_version: approved.state_version }),
      'issued',
      4,
    );
    expectState(
      await nurse
        .post(`${wardBase}/${indentId}/receive`, `govmar-receive-${run}`)
        .send({
          expected_version: issued.state_version,
          item_quantities_received: [{
            item_id: indentItemId,
            quantity_received: 2,
          }],
        }),
      'received',
      5,
    );

    // Dry run: no idempotency key, no write. All five rights must pass, and the
    // drug right must have resolved through the authoritative batch number
    // rather than any free-text name.
    const dryRun = await nurse.postWithoutKey(`${marBase}/verify`).send({
      ma_id: doseIds[0],
      scanned_patient_uid: patientUid,
      scanned_barcode: batchBarcode,
    });
    expect(dryRun.status).toBe(200);
    expect(dryRun.body.data.rights).toEqual({
      patient: true,
      drug: true,
      dose: true,
      route: true,
      time: true,
    });
    expect(dryRun.body.data.allPassed).toBe(true);
    expect(dryRun.body.data.context).toMatchObject({
      drugMatchMode: 'inventory_batch_number',
      identityFailure: null,
      inventoryBatchId,
      batchNumber: batchBarcode,
      wardIndentItemId: indentItemId,
    });
    // The dry run wrote nothing.
    expect((await orderDoses())[0].status).toBe('scheduled');

    const administered = await nurse
      .post(`${marBase}/${doseIds[0]}/administer-with-scan`, `govmar-administer-${run}`)
      .send({
        scanned_patient_uid: patientUid,
        scanned_barcode: batchBarcode,
      });
    expect(administered.status).toBe(200);
    expect(administered.body.data).toMatchObject({
      id: doseIds[0],
      status: 'administered',
      all_rights_passed: true,
      override_reason: null,
      supply_state: { status: 'matched', quantity: 1 },
    });

    const afterAdministration = await orderDoses();
    expect(afterAdministration.map((dose) => dose.status))
      .toEqual(['administered', 'scheduled']);
    expect(afterAdministration[0].administered_by).toBe(nurseUid);
    expect(afterAdministration[0].administered_at).not.toBeNull();

    // Ward custody was consumed by exactly one matched dose against the exact
    // batch that was scanned.
    const consumptions = await prisma.$queryRawUnsafe(
      `SELECT medication_administration_id, clinical_order_id,
              ward_indent_item_id, inventory_batch_id, quantity,
              evidence_status, administration_mode, recorded_by::text AS recorded_by
         FROM mar_supply_consumptions
        WHERE tenant_id = $1::uuid
          AND medication_administration_id = $2::int
        ORDER BY id`,
      tenantId,
      doseIds[0],
    );
    expect(consumptions).toHaveLength(1);
    expect(consumptions[0]).toMatchObject({
      medication_administration_id: doseIds[0],
      clinical_order_id: clinicalOrderId,
      ward_indent_item_id: indentItemId,
      inventory_batch_id: inventoryBatchId,
      evidence_status: 'matched',
      administration_mode: 'online_barcode_scan',
      recorded_by: nurseUid,
    });
    expect(Number(consumptions[0].quantity)).toBe(1);
  });

  test('rejects a wrong-patient scan as a non-overridable hard stop and leaves the dose scheduled', async () => {
    const nurse = client('NURSING_INCHARGE', nurseUid);
    const scheduledDoseId = doseIds[1];

    // The read-only path REPORTS a mismatched wristband as data (200 + a failed
    // right); only the write path refuses. Asserting both pins the asymmetry, so
    // the 409 below cannot be confused with a generic read failure.
    const dryRun = await nurse.postWithoutKey(`${marBase}/verify`).send({
      ma_id: scheduledDoseId,
      scanned_patient_uid: otherPatientUid,
      scanned_barcode: batchBarcode,
    });
    expect(dryRun.status).toBe(200);
    // Assert every right, not `allPassed`. This dose sits at anchor + 12h and
    // DEFAULT_WINDOW_MINUTES is 60, so `time` is false regardless of the
    // wristband — `allPassed` alone would still read false with the patient
    // check deleted entirely. Pinning the whole object makes the patient
    // failure the discriminator and keeps the time fact visible instead of
    // hiding it behind a single boolean.
    expect(dryRun.body.data.rights).toEqual({
      patient: false,
      drug: true,
      dose: true,
      route: true,
      time: false,
    });

    const mismatch = await nurse
      .post(
        `${marBase}/${scheduledDoseId}/administer-with-scan`,
        `govmar-wrong-patient-${run}`,
      )
      .send({
        scanned_patient_uid: otherPatientUid,
        scanned_barcode: batchBarcode,
      });
    expect(mismatch.status).toBe(409);
    // Pin the REASON: a bare 409 on this route is also produced by a dozen
    // unrelated conditions (state conflict, hold release, batch unavailable).
    expect(mismatch.body.code).toBe('MAR_PATIENT_MISMATCH');
    expect(mismatch.body.details).toMatchObject({
      hardStop: true,
      failedRight: 'patient',
    });
    expect(mismatch.body.details.rights.patient).toBe(false);

    // Wrong patient is checked BEFORE override_reason is ever read
    // (assertEvaluationAllowsAdministration), so an override cannot buy through
    // it. A fresh key is required — the idempotency middleware caches 4xx
    // outcomes, so replaying the first key would return the first 409 and prove
    // nothing about the override.
    const overridden = await nurse
      .post(
        `${marBase}/${scheduledDoseId}/administer-with-scan`,
        `govmar-wrong-patient-override-${run}`,
      )
      .send({
        scanned_patient_uid: otherPatientUid,
        scanned_barcode: batchBarcode,
        override_reason: 'Wristband unreadable, nurse confirmed identity verbally',
      });
    expect(overridden.status).toBe(409);
    expect(overridden.body.code).toBe('MAR_PATIENT_MISMATCH');
    expect(overridden.body.details).toMatchObject({
      hardStop: true,
      failedRight: 'patient',
    });

    // The refusals changed nothing: the dose is still awaiting administration
    // and no ward custody was consumed against it.
    const doses = await orderDoses();
    const stillScheduled = doses.find((dose) => Number(dose.id) === scheduledDoseId);
    expect(stillScheduled).toMatchObject({
      status: 'scheduled',
      administered_at: null,
      administered_by: null,
      all_rights_passed: null,
      override_reason: null,
    });
    const consumptions = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS consumption_count
         FROM mar_supply_consumptions
        WHERE tenant_id = $1::uuid
          AND medication_administration_id = $2::int`,
      tenantId,
      scheduledDoseId,
    );
    expect(consumptions[0].consumption_count).toBe(0);
  });

  test('guards the MAR five-rights routes at every hop of the middleware chain', async () => {
    const scheduledDoseId = doseIds[1];
    const scanBody = {
      scanned_patient_uid: patientUid,
      scanned_barcode: batchBarcode,
    };

    // 1. Authentication. No Authorization header -> refused before any route.
    const anonymous = await request(app)
      .post(`${marBase}/${scheduledDoseId}/administer-with-scan`)
      .set('x-api-key', API_KEY)
      .set('Idempotency-Key', `govmar-anon-${run}`)
      .send(scanBody);
    expect(anonymous.status).toBe(401);
    expect(anonymous.body.error).toBe('Authorization header missing or invalid');

    // 2. Mount RBAC. A patient is outside CLINICAL_STAFF_ROLES, so requireRole on
    // /api/v1/clinical refuses before the router is reached.
    const asPatient = await client('PATIENT', patientUid)
      .post(`${marBase}/${scheduledDoseId}/administer-with-scan`, `govmar-patient-${run}`)
      .send(scanBody);
    expect(asPatient.status).toBe(403);
    expect(asPatient.body.error).toBe('Forbidden');

    // 3. Route role fence. The prescriber clears the mount and holds a real
    // admission relationship with this patient, so only
    // requireMedicationAdministrationRole can be refusing here.
    const asDoctor = await client('DOCTOR', doctorUid)
      .post(`${marBase}/${scheduledDoseId}/administer-with-scan`, `govmar-doctor-${run}`)
      .send(scanBody);
    expect(asDoctor.status).toBe(403);
    expect(asDoctor.body.message)
      .toBe('Only nursing roles can record inpatient medication administration');

    const nurse = client('NURSING_INCHARGE', nurseUid);

    // 4. Idempotency gate. Same nurse, same body, same dose that administers
    // successfully in test 1 — the ONLY difference is the missing header.
    const keyless = await nurse
      .postWithoutKey(`${marBase}/${scheduledDoseId}/administer-with-scan`)
      .send(scanBody);
    expect(keyless.status).toBe(400);
    expect(keyless.body.message)
      .toBe('Idempotency-Key header is required for this endpoint');
    expect(keyless.body.details).toEqual({ scope: 'mar_administer_scan' });

    // 5. Body validation. administered_at is reserved for the governed paper
    // reconciliation workflow and must never be client-supplied here.
    const backdated = await nurse
      .post(
        `${marBase}/${scheduledDoseId}/administer-with-scan`,
        `govmar-backdated-${run}`,
      )
      .send({ ...scanBody, administered_at: '2026-01-01T00:00:00.000Z' });
    expect(backdated.status).toBe(400);
    expect(backdated.body.errors.map((entry) => entry.msg)).toContain(
      'administered_at is accepted only by the governed paper reconciliation workflow',
    );

    // 6. Alias mount. /api/v1/emr/mar/* rewrites onto the canonical clinical
    // handlers, so the same dry run must resolve to the same MAR row.
    const aliasDryRun = await nurse
      .postWithoutKey('/api/v1/emr/mar/verify')
      .send({
        ma_id: scheduledDoseId,
        scanned_patient_uid: patientUid,
        scanned_barcode: batchBarcode,
      });
    expect(aliasDryRun.status).toBe(200);
    expect(Number(aliasDryRun.body.data.ma.id)).toBe(scheduledDoseId);
    expect(aliasDryRun.body.data.rights).toMatchObject({
      patient: true,
      drug: true,
    });

    // Every refusal above left the dose exactly where it was.
    const doses = await orderDoses();
    expect(doses.map((dose) => dose.status)).toEqual(['administered', 'scheduled']);
    expect(doses.find((dose) => Number(dose.id) === scheduledDoseId).administered_at)
      .toBeNull();
  });

  test('prevents duplicate MAR scheduling on the governed recovery route', async () => {
    const doctor = client('DOCTOR', doctorUid);

    // (The retired route's 409 is not re-proven here — unit/
    // marRouteClosureContracts.test.js owns it, and the staff clinical-safety
    // smoke re-probes it against a running server. Asserting it under this
    // title would also be mislabelled: it never reaches findScheduledSibling,
    // so it guards nothing about double-dosing.)

    // The governed recovery route is the reachable duplicate-schedule attempt.
    // It MUST carry an Idempotency-Key it has never used: replaying the create's
    // key would return a cached response without ever entering the handler, which
    // would prove HTTP idempotency and say nothing about MAR slot dedup.
    const replay = await doctor
      .post(
        `${orderBase}/${clinicalOrderId}/retry-mar-scheduling`,
        `govmar-retry-${run}`,
      )
      .send({});
    expect(replay.status).toBe(200);
    expect(replay.body.data).toMatchObject({
      order_id: clinicalOrderId,
      patient_uid: patientUid,
      status: 'scheduled',
      scheduled_dose_count: 2,
    });
    // The SAME two rows came back — the replay resolved the existing slots
    // instead of charting a second day's worth of doses.
    expect([...replay.body.data.scheduled_dose_ids].map(Number).sort((a, b) => a - b))
      .toEqual([...doseIds].sort((a, b) => a - b));

    const doses = await orderDoses();
    expect(doses).toHaveLength(2);
    expect(doses.map((dose) => Number(dose.id))).toEqual(doseIds);
    expect(doses.map((dose) => dose.status)).toEqual(['administered', 'scheduled']);
    expect(doses.map((dose) => new Date(dose.scheduled_time).getTime()))
      .toEqual([
        new Date(scheduleAnchor).getTime(),
        new Date(secondDoseAt).getTime(),
      ]);

    // And the ward saw no second consumption: the administered dose still owns
    // exactly one supply-consumption receipt.
    const consumptions = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS consumption_count
         FROM mar_supply_consumptions
        WHERE tenant_id = $1::uuid
          AND clinical_order_id = $2::int`,
      tenantId,
      clinicalOrderId,
    );
    expect(consumptions[0].consumption_count).toBe(1);

    // Everything above exercises only the PREFLIGHT short-circuit: with a
    // sibling found for every prepared dose, scheduleMedications returns before
    // persistSchedule ever runs, so the advisory lock, the in-transaction
    // sibling lookup and the uniq_mar_scheduled_dose recovery stay untouched.
    // Cancel one slot so the next replay has real work to do, and the replay
    // has to fill exactly that gap without disturbing the dose already given.
    await prisma.$executeRawUnsafe(
      `UPDATE medication_administrations
          SET status = 'cancelled', updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      tenantId,
      doseIds[1],
    );

    const refill = await doctor
      .post(
        `${orderBase}/${clinicalOrderId}/retry-mar-scheduling`,
        `govmar-retry-gap-${run}`,
      )
      .send({});
    expect(refill.status).toBe(200);
    expect(refill.body.data.scheduled_dose_count).toBe(2);

    const refilled = await orderDoses();
    const live = refilled.filter((dose) => dose.status !== 'cancelled');
    // The administered dose kept its identity — a re-insert here would mean the
    // ward could chart the same dose twice.
    expect(live.map((dose) => Number(dose.id))).toContain(doseIds[0]);
    // Exactly one row filled the cancelled slot: not zero (the gap would stay
    // open and the patient would miss a dose) and not two.
    const refreshed = live.filter((dose) => !doseIds.includes(Number(dose.id)));
    expect(refreshed).toHaveLength(1);
    expect(new Date(refreshed[0].scheduled_time).getTime())
      .toBe(new Date(secondDoseAt).getTime());
    expect(live).toHaveLength(2);
  });
});
