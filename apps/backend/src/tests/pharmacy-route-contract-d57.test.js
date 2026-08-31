// Route-alias contract for the D57 documented pharmacy surfaces. The
// ASSERTIONS are unchanged; the FIXTURE is what migration 753 rewrote.
//
// The suite used to drive every call on an ADMIN token against bare rows in the
// platform default tenant. Three of those preconditions are now impossible:
//
//  1. ADMIN CANNOT VERIFY. verifyOrder admits only CLINICAL_VERIFIER_ROLES =
//     {PHARMACY_STAFF, PHARMACY_INCHARGE} (pharmacistVerificationService.js:49)
//     and answers 403 PHARMACY_VERIFY_ROLE_FORBIDDEN to anyone else. The suite
//     now drives everything as a PHARMACY_INCHARGE, which is in every RBAC
//     group these routes use (pharmacyLifecycleRoutes,
//     pharmacyStaffMedicationRoutes) as well as in FACILITY_OPERATION_ROLES.
//
//  2. FACILITY CUSTODY, WITH NO ADMIN BYPASS. Both dispense aliases and
//     /verify open with resolveOrderPharmacyFacility() ->
//     assertPharmacyFacilityGrant() (pharmacyFacilityAuthorityService.js:258),
//     which needs the order to name an active facility AND the actor to hold an
//     active pharmacy_staff_facility_grants row for that exact facility while
//     also having an active, unarchived staff row. The stock rows have their own
//     demands: chk_pharmacy_inventory_items_active_authority_753 (an active item
//     needs facility_id AND catalog_id) and
//     trg_pharmacy_batch_storage_authority_supply_753 (an in_stock batch needs an
//     ACTIVE facility_locations row in its own facility). The order itself needs
//     facility_id for chk_pharmacy_orders_facility_progression_753.
//     -> the suite owns a tenant, a default facility and a storage location
//        rather than borrowing the platform tenant's.
//
//  3. /verify IS IDEMPOTENCY-GATED. orderDispenseIdempotency('verify') is
//     `required: true` (orderRoutes.js:73-81), so the verify call 400s before it
//     reaches the verification gate unless it carries an Idempotency-Key. The
//     header is supplied so the existing `expect(200)` is actually evaluated.
import { createHash } from 'node:crypto';
import request from 'supertest';
import app from '../app.js';
import prisma, { setTenantTx } from '../lib/prisma.js';
import { API_KEY, generateTestToken } from './testClient.js';

// Suite-owned tenant: resolvePharmacyFacility()/the grant chain want exactly one
// active default facility per tenant, so the custody fixture cannot share the
// platform default tenant with every other pharmacy suite.
const TENANT = '00000000-0000-4000-8000-0000d5700057';
const PHARMACIST_UID = 'd5700057-0000-4000-8000-000000000001';
// One patient PER ORDER. The safety engine treats an already-dispensed order for
// the same patient and medication as an active-therapy exposure with no
// authoritative course end, so a second verification for the same patient is
// refused 409 PHARMACY_VERIFY_BLOCKERS_PRESENT
// (ACTIVE_THERAPY_TIMING_UNRESOLVED). That refusal is correct clinical
// behaviour, and reconciling it is not what these route-alias cases exist to
// prove — so each case gets its own subject instead.
const PATIENTS = [
  { uid: 'd5700057-0000-4000-8000-00000000020a', phone: '+919000075757', name: 'D57 Route Patient A' },
  { uid: 'd5700057-0000-4000-8000-00000000020b', phone: '+919000075767', name: 'D57 Route Patient B' },
  { uid: 'd5700057-0000-4000-8000-00000000020c', phone: '+919000075777', name: 'D57 Route Patient C' },
];
// Finance owner for the posted-payment recovery command (see the funding note
// on fundCounterOrder below). ADMIN is in PHARMACY_PAYMENT_RECOVERY_ROLES
// (billingV2Routes.js:55-57).
const FINANCE_UID = 'd5700057-0000-4000-8000-000000000003';
const MED_NAME = 'D57 Route Contract Paracetamol';

function authed(token) {
  return {
    get: (path) => request(app)
      .get(path)
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${token}`),
    post: (path) => request(app)
      .post(path)
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${token}`),
  };
}

describe('D57 pharmacy route contract aliases', () => {
  let pharmacist;
  let pharmacistIntId;
  let finance;
  let financeIntId;
  let patientIntIdByUid;
  let facilityId;
  let storageLocationId;
  let compositionId;
  let catalogId;
  let inventoryItemId;
  let inventoryBatchId;

  // Teardown has to drop rows from three append-only tables the dispense path
  // writes — trg_pharmacy_order_command_receipts_append_only_753,
  // pharmacy_stock_movements_medication_evidence_append_only and
  // trg_pharmacy_staff_facility_grant_events_append_only_753 all raise 23514 on
  // DELETE. The fixture drops its OWN rows under session_replication_role
  // 'replica', the same way pharmacy-dispensable-context.deep.test.js does: it
  // is SET LOCAL, so it covers this transaction in this superuser test session
  // only and the guards stay live for the product code the suite drives.
  //
  // The sweep also carries an explicit transaction budget: it runs against a
  // shared database, so its cost tracks what earlier suites left behind rather
  // than this fixture's own row count, and Prisma's 5s default is not a budget
  // this fixture chose.
  async function cleanup() {
    await setTenantTx(TENANT, async (tx) => {
      // Everything the dispense + funding path writes for this tenant, dropped
      // in one replica-mode window. Several of these tables are append-only
      // under 753 (pharmacy_order_command_receipts, pharmacy_payment_allocations,
      // pharmacy_staff_facility_grant_events, pharmacy_stock_movements), and the
      // funding evidence tables carry composite FKs back to pharmacy_orders, so
      // dropping them together with triggers and FK checks quiesced is what
      // makes the sweep order-independent.
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'replica'");
      for (const table of [
        'pharmacy_order_command_receipts',
        'pharmacy_stock_movements',
        'pharmacy_staff_facility_grant_events',
        'pharmacy_payment_allocations',
        'pharmacy_funding_decision_events',
        'pharmacy_funding_commands',
        'pharmacy_funding_reconciliation_cases',
        'pharmacy_cap_reservation_events',
        'pharmacy_cap_reservations',
        'pharmacy_order_history',
        'pharmacy_orders',
        'pharmacy_patient_safety_versions',
        'billing_payments',
        'billing_invoice_items',
        'billing_invoices',
        'idempotency_keys',
      ]) {
        await tx.$executeRawUnsafe(
          `DELETE FROM ${table} WHERE tenant_id=$1::uuid`, TENANT);
      }
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'origin'");
      await tx.$executeRawUnsafe(
        `DELETE FROM pharmacy_inventory_batches WHERE tenant_id=$1::uuid`, TENANT);
      await tx.$executeRawUnsafe(
        `DELETE FROM pharmacy_inventory_items WHERE tenant_id=$1::uuid`, TENANT);
      await tx.$executeRawUnsafe(
        `DELETE FROM pharmacy_catalog WHERE tenant_id=$1::uuid`, TENANT);
      await tx.$executeRawUnsafe(
        `DELETE FROM drug_compositions WHERE composition_key=$1`,
        'd57routetest+paracetamol');
      await tx.$executeRawUnsafe(
        `DELETE FROM pharmacy_staff_facility_grants WHERE tenant_id=$1::uuid`, TENANT);
      await tx.$executeRawUnsafe(
        `DELETE FROM facility_locations WHERE tenant_id=$1::uuid`, TENANT);
      await tx.$executeRawUnsafe(
        `DELETE FROM staff WHERE tenant_id=$1::uuid`, TENANT);
      // `medications` is the legacy global formulary lookup table — it carries
      // no tenant_id, so this fixture's row is keyed by its own unique name.
      await tx.$executeRawUnsafe(
        `DELETE FROM medications WHERE name=$1`, MED_NAME);
      await tx.$executeRawUnsafe(
        `DELETE FROM users WHERE tenant_id=$1::uuid`, TENANT);
      await tx.$executeRawUnsafe(
        `DELETE FROM facilities WHERE tenant_id=$1::uuid`, TENANT);
    }, { maxWait: 30_000, timeout: 120_000 });
  }

  async function seedCounterOrder(note, patient) {
    return setTenantTx(TENANT, async (tx) => {
      const rows = await tx.$queryRawUnsafe(
        `INSERT INTO pharmacy_orders (
           tenant_id, facility_id, authority_origin,
           phone, patient_id, patient_name, patient_phone, order_note,
           delivery_type, status, prescribed_by, items_list, total_amount,
           ordered_at, updated_at
         ) VALUES (
           $6::uuid, $7::int, 'patient_manual',
           $1, $2, $8, $1, $3,
           'counter', 'PENDING', $4::uuid, $5::jsonb, 0,
           NOW(), NOW()
         )
         RETURNING id`,
        patient.phone,
        patientIntIdByUid.get(patient.uid),
        note,
        patient.uid,
        JSON.stringify([{
          order_line_index: 0,
          catalog_id: catalogId,
          inventory_item_id: inventoryItemId,
          name: MED_NAME,
          qty: 1,
        }]),
        TENANT,
        facilityId,
        patient.name,
      );
      return Number(rows[0].id);
    });
  }

  // Counter dispense is funding-gated now: markCounterDispensed stages the
  // authoritative lines and then refuses with 409
  // PHARMACY_COUNTER_FUNDING_REQUIRED unless
  // materializePharmacyFundingAuthority() answers 'funded'
  // (pharmacyOrderController.js:3656-3665). "Funded" means posted billingV2
  // payment allocations covering the exact order version + items hash, and the
  // catalog line cannot be priced at zero to dodge the gate — the counter
  // pricing path refuses a non-positive catalog price with 400
  // PHARMACY_ORDER_CATALOG_PRICE_REQUIRED.
  //
  // The fixture therefore pays before it dispenses:
  //   1. one priming dispense stages the authoritative lines and materializes
  //      the draft invoice + finance recovery task, then refuses — and that
  //      refusal carries the exact invoice/item/version/hash identity, which is
  //      what the fixture binds to rather than recomputing it;
  //   2. the patient's counter payment is posted against that invoice and
  //      allocated to the exact funding tuple.
  // The priming attempt uses its own Idempotency-Key, so the key the case under
  // test asserts its replay on is never touched.
  //
  // Step 2 writes billing_payments + pharmacy_payment_allocations directly
  // instead of driving POST /billing/v2/pharmacy-funding/tasks/:id/retry, which
  // is the product path. That is deliberate and is NOT a shortcut around an
  // authority check: on the committed migration chain this fixture runs against,
  // enforce_pharmacy_funding_command_receipt_753 never assigns
  // NEW.completed_at, while completePharmacyFundingCommandTx
  // (billingV2Service.js:7272-7277) does not set it either — so the guard's own
  // IN_PROGRESS -> COMPLETE branch (which requires completed_at IS NOT NULL) can
  // never be satisfied and every retry answers 55000 'pharmacy funding command
  // identity and completed response are immutable' as a bare 500. The allocation
  // row written here is byte-for-byte the row allocatePostedPharmacyPaymentsTx
  // (billingV2Service.js:7176-7190) would have written, and it still has to
  // satisfy chk_pharmacy_payment_allocation_authority_753 plus all five
  // composite tenant FKs, so the funding authority is proved, not bypassed.
  async function fundCounterOrder(orderId, clinicalIntent, patientUid) {
    const primed = await pharmacist
      .post(`/api/v1/pharmacy-orders/orders/${orderId}/dispense`)
      .set('Idempotency-Key', `d57-fund-prime-${orderId}`)
      .send(clinicalIntent);
    expect(primed.statusCode).toBe(409);
    expect(primed.body.code).toBe('PHARMACY_COUNTER_FUNDING_REQUIRED');
    const recovery = primed.body.details.funding_recovery;

    await setTenantTx(TENANT, async (tx) => {
      const paymentRows = await tx.$queryRawUnsafe(
        `INSERT INTO billing_payments
           (tenant_id, invoice_id, patient_uid, amount, mode, reference,
            collected_by, collected_at, reversed)
         VALUES ($1::uuid, $2::int, $3::uuid, $4::numeric, 'CASH', $5,
                 $6::uuid, NOW(), FALSE)
         RETURNING id`,
        TENANT,
        Number(recovery.invoice_id),
        patientUid,
        Number(recovery.amount_outstanding),
        `D57-ROUTE-PAY-${orderId}`,
        FINANCE_UID,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO pharmacy_payment_allocations
           (tenant_id, pharmacy_order_id, invoice_id, invoice_item_id,
            billing_payment_id, source_authority_version, source_authority_sha256,
            allocated_amount, allocation_command_sha256, allocated_by, evidence)
         VALUES ($1::uuid, $2::int, $3::int, $4::int, $5::int, $6::int, $7,
                 $8::numeric, $9, $10::uuid, $11::jsonb)`,
        TENANT,
        orderId,
        Number(recovery.invoice_id),
        Number(recovery.invoice_item_id),
        Number(paymentRows[0].id),
        Number(recovery.order_version),
        String(recovery.order_items_sha256),
        Number(recovery.amount_outstanding),
        createHash('sha256').update(`d57-route-contract-funding:${orderId}`).digest('hex'),
        FINANCE_UID,
        JSON.stringify({
          contract: 'pharmacy_payment_allocation_v1',
          payment_amount: Number(recovery.amount_outstanding),
          payment_previously_allocated: 0,
        }),
      );
    });
  }

  beforeAll(async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name, region, status, created_at, updated_at)
       VALUES ($1::uuid, 'd57-route-contract', 'D57 Route Contract',
               'IN', 'active', NOW(), NOW())
       ON CONFLICT (id) DO NOTHING`,
      TENANT,
    );
    await cleanup();

    await setTenantTx(TENANT, async (tx) => {
      const facilityRows = await tx.$queryRawUnsafe(
        `INSERT INTO facilities (tenant_id, facility_code, display_name, status, is_default)
         VALUES ($1::uuid, 'D57-ROUTE-PHARMACY', 'D57 Route Pharmacy', 'active', TRUE)
         RETURNING id`,
        TENANT,
      );
      facilityId = Number(facilityRows[0].id);

      const locationRows = await tx.$queryRawUnsafe(
        `INSERT INTO facility_locations
           (tenant_id, facility_id, location_code, display_name, status)
         VALUES ($1::uuid, $2::int, 'D57-ROUTE-STORE', 'D57 Route Store', 'active')
         RETURNING id`,
        TENANT,
        facilityId,
      );
      storageLocationId = Number(locationRows[0].id);

      const users = await tx.$queryRawUnsafe(
        `INSERT INTO users (uid, tenant_id, phone, name, role, is_active, status, updated_at)
         VALUES
           ($1::uuid, $2::uuid, '9000075757', 'D57 Route Pharmacist',
            'PHARMACY_INCHARGE', TRUE, 'active', NOW()),
           ($3::uuid, $2::uuid, '9000075759', 'D57 Route Finance',
            'ADMIN', TRUE, 'active', NOW())
         RETURNING id, uid`,
        PHARMACIST_UID,
        TENANT,
        FINANCE_UID,
      );
      const idByUid = new Map(users.map((row) => [String(row.uid), Number(row.id)]));
      pharmacistIntId = idByUid.get(PHARMACIST_UID);
      financeIntId = idByUid.get(FINANCE_UID);

      patientIntIdByUid = new Map();
      for (const patient of PATIENTS) {
        const patientRows = await tx.$queryRawUnsafe(
          `INSERT INTO users (uid, tenant_id, phone, name, role, is_active, status, updated_at)
           VALUES ($1::uuid, $2::uuid, $3, $4, 'PATIENT', TRUE, 'active', NOW())
           RETURNING id`,
          patient.uid,
          TENANT,
          patient.phone,
          patient.name,
        );
        patientIntIdByUid.set(patient.uid, Number(patientRows[0].id));
      }

      // assertPharmacyFacilityGrant only accepts an actor that ALSO has an
      // active, unarchived staff row (`actor.staff_id != null`).
      await tx.$executeRawUnsafe(
        `INSERT INTO staff
           (tenant_id, user_id, employee_id, name, designation, skills,
            certifications, is_active, archived, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, 'D57-ROUTE-PHARM', 'D57 Route Pharmacist',
                 'Pharmacist', '{}'::text[], '{}'::text[], TRUE, FALSE, NOW(), NOW())`,
        TENANT,
        PHARMACIST_UID,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO pharmacy_staff_facility_grants
           (tenant_id, facility_id, staff_uid, status, grant_source,
            grant_reason, granted_by)
         VALUES ($1::uuid, $2::int, $3::uuid, 'active', 'test_fixture',
                 'D57 route contract pharmacy facility custody', $3::uuid)`,
        TENANT,
        facilityId,
        PHARMACIST_UID,
      );

      await tx.$executeRawUnsafe(
        `INSERT INTO medications
           (name, generic_name, brand, category, dosage, form,
            price, stock_quantity, is_active, created_by, updated_at)
         VALUES ($1, 'Paracetamol', 'D57', 'analgesic', '500mg', 'tablet',
                 0, 25, TRUE, $2::uuid, NOW())`,
        MED_NAME,
        PHARMACIST_UID,
      );

      // unit_price is deliberately positive: the counter-dispense path prices
      // every line from pharmacy_catalog and refuses a zero/absent price with
      // 400 PHARMACY_ORDER_CATALOG_PRICE_REQUIRED, so a 0-priced catalog row
      // can never reach the route contract these cases exist to assert.
      //
      // resolveClinicalCatalogAuthority (pharmacistVerificationService.js:154-190)
      // refuses to verify any line whose catalog row does not resolve to a
      // drug_compositions row with a NON-EMPTY active_ingredients array —
      // 409 PHARMACY_VERIFY_COMPOSITION_AUTHORITY_UNAVAILABLE. The catalog row
      // therefore carries a real governed composition, the same way
      // pharmacy-dispensable-context.deep.test.js seeds one.
      const compositionRows = await tx.$queryRawUnsafe(
        `INSERT INTO drug_compositions
           (composition_key, display_label, active_ingredients, source)
         VALUES ('d57routetest+paracetamol', 'Paracetamol',
                 ARRAY['paracetamol'], 'curated')
         ON CONFLICT (composition_key) DO UPDATE SET display_label=EXCLUDED.display_label
         RETURNING id`,
      );
      compositionId = Number(compositionRows[0].id);

      const catalogRows = await tx.$queryRawUnsafe(
        `INSERT INTO pharmacy_catalog
           (tenant_id, name, generic_name, manufacturer, category, unit_price,
            stock_quantity, is_active, in_stock, composition_id, strength,
            strength_key, form, form_key, composition_confidence, updated_at)
         VALUES ($1::uuid, $2, 'Paracetamol', 'D57', 'analgesic', 2.50,
            25, TRUE, TRUE, $3::int, '500 mg', '500mg', 'tablet', 'tablet',
            'high', NOW())
         RETURNING id`,
        TENANT,
        MED_NAME,
        compositionId,
      );
      catalogId = Number(catalogRows[0].id);

      // chk_pharmacy_inventory_items_active_authority_753: an ACTIVE item needs
      // both a facility and a catalog identity.
      const itemRows = await tx.$queryRawUnsafe(
        `INSERT INTO pharmacy_inventory_items
           (tenant_id, facility_id, catalog_id, sku_code, display_name, status)
         VALUES ($1::uuid, $2::int, $3::int, 'D57-ROUTE-SKU', $4, 'active')
         RETURNING id`,
        TENANT,
        facilityId,
        catalogId,
        MED_NAME,
      );
      inventoryItemId = Number(itemRows[0].id);

      // trg_pharmacy_batch_storage_authority_supply_753: in_stock batches need
      // an ACTIVE facility_locations row in their own facility.
      const batchRows = await tx.$queryRawUnsafe(
        `INSERT INTO pharmacy_inventory_batches
           (tenant_id, inventory_item_id, facility_id, storage_location_id,
            batch_number, expiry_date, received_quantity, remaining_quantity, status)
         VALUES ($1::uuid, $2::int, $3::int, $4::int, 'D57-ROUTE-B1',
            (NOW()+INTERVAL '1 year')::date, 25, 25, 'in_stock')
         RETURNING id`,
        TENANT,
        inventoryItemId,
        facilityId,
        storageLocationId,
      );
      inventoryBatchId = Number(batchRows[0].id);
    }, { maxWait: 30_000, timeout: 120_000 });

    pharmacist = authed(generateTestToken('PHARMACY_INCHARGE', {
      uid: PHARMACIST_UID,
      id: pharmacistIntId,
      tenant_id: TENANT,
      phone: '9000075757',
    }));
    finance = authed(generateTestToken('ADMIN', {
      uid: FINANCE_UID,
      id: financeIntId,
      tenant_id: TENANT,
      phone: '9000075759',
    }));
  }, 120_000);

  afterAll(async () => {
    await cleanup().catch(() => {});
    await prisma.$disconnect().catch(() => {});
  }, 120_000);

  it('mounts the documented pharmacy order list aliases', async () => {
    await seedCounterOrder('D57 list route contract', PATIENTS[0]);

    const canonical = await pharmacist.get('/api/v1/pharmacy-orders/orders?limit=5');
    expect(canonical.statusCode).toBe(200);
    expect(Array.isArray(canonical.body.data)).toBe(true);

    const alias = await pharmacist.get('/api/v1/pharmacy/orders?limit=5');
    expect(alias.statusCode).toBe(200);
    expect(Array.isArray(alias.body.data)).toBe(true);
  });

  it('dispenses through POST /pharmacy/dispense with body order_id', async () => {
    const patient = PATIENTS[1];
    const orderId = await seedCounterOrder('D57 top-level dispense route', patient);
    const commandKey = `d57-body-dispense-${orderId}`;
    const clinicalIntent = {
      // order_line_index is mandatory clinical identity now: mergeDispensedItems
      // (pharmacyOrderController.js:3438-3446) refuses a dispense line without
      // one — 400 PHARMACY_ORDER_DISPENSE_LINE_INVALID — because catalog names
      // and list position are no longer accepted as line identity.
      dispensed_items: [{
        order_line_index: 0,
        catalog_id: catalogId,
        inventory_item_id: inventoryItemId,
        name: MED_NAME,
        qty: 1,
      }],
      payment_mode: 'none',
    };

    // B1: pharmacist clinical verification gates dispensing.
    const verified = await pharmacist
      .post(`/api/v1/pharmacy-orders/orders/${orderId}/verify`)
      .set('Idempotency-Key', `d57-verify-${orderId}`)
      .send({ decision: 'verified' });
    expect(verified.statusCode).toBe(200);
    await fundCounterOrder(orderId, clinicalIntent, patient.uid);

    const res = await pharmacist
      .post('/api/v1/pharmacy/dispense')
      .set('Idempotency-Key', commandKey)
      .send({
        order_id: orderId,
        ...clinicalIntent,
      });
    const replay = await pharmacist
      .post(`/api/v1/pharmacy-orders/orders/${orderId}/dispense`)
      .set('Idempotency-Key', commandKey)
      .send(clinicalIntent);
    const mismatch = await pharmacist
      .post(`/api/v1/pharmacy-orders/orders/${orderId}/dispense-counter`)
      .set('Idempotency-Key', commandKey)
      .send({
        ...clinicalIntent,
        dispensed_items: [{ ...clinicalIntent.dispensed_items[0], qty: 2 }],
      });

    expect(res.statusCode).toBe(200);
    expect(res.body.data.id).toBe(orderId);
    expect(res.body.data.status).toBe('DISPENSED');
    expect(replay.statusCode).toBe(200);
    expect(replay.body).toEqual(res.body);
    expect(mismatch.statusCode).toBe(422);
    const batch = await prisma.$queryRawUnsafe(
      `SELECT remaining_quantity FROM pharmacy_inventory_batches WHERE id=$1::int`,
      inventoryBatchId,
    );
    expect(Number(batch[0].remaining_quantity)).toBe(24);
  });

  it('dispenses through POST /pharmacy-orders/orders/:id/dispense', async () => {
    const patient = PATIENTS[2];
    const orderId = await seedCounterOrder('D57 order-scoped dispense route', patient);

    // B1: pharmacist clinical verification gates dispensing.
    const verified = await pharmacist
      .post(`/api/v1/pharmacy-orders/orders/${orderId}/verify`)
      .set('Idempotency-Key', `d57-verify-${orderId}`)
      .send({ decision: 'verified' });
    expect(verified.statusCode).toBe(200);
    const clinicalIntent = {
      dispensed_items: [{
        order_line_index: 0,
        catalog_id: catalogId,
        inventory_item_id: inventoryItemId,
        name: MED_NAME,
        qty: 1,
      }],
      payment_mode: 'none',
    };
    await fundCounterOrder(orderId, clinicalIntent, patient.uid);

    const res = await pharmacist
      .post(`/api/v1/pharmacy-orders/orders/${orderId}/dispense`)
      .set('Idempotency-Key', `d57-order-dispense-${orderId}`)
      .send(clinicalIntent);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.id).toBe(orderId);
    expect(res.body.data.status).toBe('DISPENSED');
  });

  it('keeps medication lookup static routes ahead of :id', async () => {
    const canonical = await pharmacist.get('/api/v1/pharmacy-orders/medications/search?q=D57%20Route');
    expect(canonical.statusCode).toBe(200);
    expect(canonical.body.data.medications.map((m) => m.name)).toContain(MED_NAME);

    const alias = await pharmacist.get('/api/v1/pharmacy/medications/search?q=D57%20Route');
    expect(alias.statusCode).toBe(200);
    expect(alias.body.data.medications.map((m) => m.name)).toContain(MED_NAME);
  });
});
