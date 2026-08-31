// Deep integration test for the pharmacist dispense-substitution controller
// (POST /pharmacy-orders/dispense-substitution).
//
// Proves the transactional contract directly at the controller boundary:
//   - an EQUIVALENT substitute (same composition + strength_key + form + release +
//     route + per-ingredient split) is dispensed: the chosen batch is decremented and
//     a 'dispense_substitution' stock movement is written, atomically with the canonical
//     clinical timeline + audit pair (a 200 + decrement proves the hard-fail pair
//     committed — otherwise the tx rolls back);
//   - a NON-equivalent substitute (different strength) is rejected 400 and stock is
//     untouched (the server-side equivalence gate, not client-trusted);
//   - insufficient stock is rejected 400 (FOR UPDATE + balance check), stock untouched.
//
// Controlled-substitution coverage (STAFF F1 fix): a Schedule X / narcotic
// substitute can never decrement stock without the statutory
// pharmacy_schedule_register row and an independently approved, consumed
// witness (SUBSTITUTION_WITNESS_REQUIRED fails closed); H1 routes through the
// register without a witness; the plain (non-controlled) path is unchanged.
//
// Tests seed/connect as the postgres superuser (jest.setup default DATABASE_URL), which
// bypasses RLS; the controller's own tenant scoping + explicit tenant filters still apply.
import { createHash } from 'node:crypto';
import prisma from '../lib/prisma.js';
import {
  dispenseSubstitution,
  markCounterDispensed,
  markDelivered,
  requestSubstitutionWitnessApproval,
  approveSubstitutionWitnessApproval,
} from '../controllers/pharmacy/pharmacyOrderController.js';
import { grantPharmacyFacilityAuthority } from '../services/pharmacy/pharmacyFacilityAuthorityService.js';
import { verifyOrder } from '../services/pharmacy/pharmacistVerificationService.js';

const TENANT = '00000000-0000-4000-8000-0000d15e0001';
const PATIENT = 'a1111111-1111-4111-8111-111111111d15';
const ACTOR = 'a2222222-2222-4222-8222-222222222d15';
const WITNESS = 'a3333333-3333-4333-8333-333333333d15';
const CLERK = 'a4444444-4444-4444-8444-444444444d15';
const GRANT_ADMIN = 'a5555555-5555-4555-8555-555555555d15';
const FACILITY_CODE = 'DSUB-MAIN';
const COMP_KEY = 'dsubtest+amoxicillin+clavulanic_acid';
const combo = JSON.stringify([
  { ingredient: 'amoxicillin', amount: 500, unit: 'mg' },
  { ingredient: 'clavulanic_acid', amount: 125, unit: 'mg' },
]);

function mockRes() {
  return {
    statusCode: null,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}
function bodyCode(res) {
  return res.body?.code ?? res.body?.details?.code ?? null;
}

// ─── The substitution funding gate: this endpoint is INERT BY DESIGN ─────────────
//
// pharmacyOrderInventoryService.js:35 defines requireSubstitutionFundingReauthorisation(),
// which takes NO condition and ALWAYS throws SUBSTITUTION_FUNDING_REAUTHORISATION_REQUIRED
// (409). Its single call site, pharmacyOrderInventoryService.js:2420, runs BEFORE funding
// resolution, before the pharmacy cap probe and before every stock mutation, so nothing
// downstream of it can execute in the shipped code: no batch decrement, no
// pharmacy_stock_movements row, no statutory pharmacy_schedule_register row, no
// dispense_substitution command receipt, no canonical timeline/audit pair, no order or eRx
// projection. The only route past the gate is a stub that throws
// SUBSTITUTION_FUNDING_ORDER_MUTATION_UNWIRED, and that inertness is pinned deliberately by
// the substitution-funding source-contract unit tests.
//
// The tests that used to assert the success path therefore assert what the endpoint really
// guarantees today — refusal at the funding gate with NO stock movement — and they assert it
// by exact code and exact payload. A bare rejects.toThrow() would still pass if the endpoint
// broke for an unrelated reason; that is the hole this helper exists to close.
//
// WHEN THE FUNDING LANE IS WIRED, EVERY ONE OF THESE ASSERTIONS WILL FAIL. That failure is
// the intended signal: restore the success-path assertions recorded in each test's own
// comment, do not loosen anything here.
async function batchRemaining(id) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT remaining_quantity FROM pharmacy_inventory_batches WHERE id=$1`, id,
  );
  return Number(rows[0].remaining_quantity);
}
async function orderAuthorityVersion(id) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT inventory_authority_version FROM pharmacy_orders
      WHERE id=$1::int AND tenant_id=$2::uuid`,
    id, TENANT,
  );
  return Number(rows[0].inventory_authority_version);
}
// Every durable trace the substitution lane would leave if any of it ran. Scoped to the
// batch/item/order under attempt so a count is evidence about THIS attempt, not the suite.
async function substitutionEvidence({ orderId: id, batchId: bId, inventoryItemId }) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT
       (SELECT COUNT(*)::int FROM pharmacy_stock_movements
         WHERE tenant_id=$1::uuid AND inventory_batch_id=$2
           AND reference_type IN ('dispense_substitution','controlled_dispense')) AS movements,
       (SELECT COUNT(*)::int FROM pharmacy_schedule_register
         WHERE tenant_id=$1::uuid AND inventory_item_id=$3::int) AS register_rows,
       (SELECT COUNT(*)::int FROM pharmacy_order_command_receipts
         WHERE tenant_id=$1::uuid AND pharmacy_order_id=$4::int
           AND action='dispense_substitution') AS command_receipts,
       (SELECT COUNT(*)::int FROM clinical_timeline_events
         WHERE tenant_id=$1::uuid AND event_type='pharmacy.dispense_substitution') AS timeline_events,
       (SELECT COUNT(*)::int FROM clinical_audit_events
         WHERE tenant_id=$1::uuid AND action='pharmacy.dispense_substitution') AS audit_events`,
    TENANT, bId, inventoryItemId, id,
  );
  return {
    movements: rows[0].movements,
    register_rows: rows[0].register_rows,
    command_receipts: rows[0].command_receipts,
    timeline_events: rows[0].timeline_events,
    audit_events: rows[0].audit_events,
  };
}
async function expectRefusedAtFundingGate(res, {
  orderId: gatedOrderId,
  orderVersion,
  proposedAmount,
  batchId: gatedBatchId,
  inventoryItemId,
  remainingBefore,
}) {
  expect(res.statusCode).toBe(409);
  expect(bodyCode(res)).toBe('SUBSTITUTION_FUNDING_REAUTHORISATION_REQUIRED');
  // toEqual, not objectContaining: the thrower's whole detail payload is the contract a
  // client needs to raise the governed funding proposal, and an extra leaked field is a
  // defect too.
  expect(res.body?.details).toEqual({
    pharmacy_order_id: gatedOrderId,
    current_order_version: orderVersion,
    proposed_authoritative_amount: proposedAmount,
    next_action: 'create_governed_substitution_funding_proposal',
  });
  expect(await batchRemaining(gatedBatchId)).toBe(remainingBefore);
  expect(await substitutionEvidence({
    orderId: gatedOrderId, batchId: gatedBatchId, inventoryItemId,
  })).toEqual({
    movements: 0,
    register_rows: 0,
    command_receipts: 0,
    timeline_events: 0,
    audit_events: 0,
  });
  // The refused command rolled back whole: the order's own authority version — the value
  // the gate just quoted back — is untouched, so nothing bumped it on the way out.
  expect(await orderAuthorityVersion(gatedOrderId)).toBe(orderVersion);
}

async function callDelivery(orderId, body = {}) {
  const req = {
    tenantId: TENANT,
    user: { uid: ACTOR, role: 'PHARMACY_INCHARGE' },
    id: 'req-dsub-delivery',
    params: { id: String(orderId) },
    idempotencyClaim: { requestKey: `dsub-delivery-${orderId}` },
    body,
  };
  const res = mockRes();
  await markDelivered(req, res);
  return res;
}
async function callCounter(orderId, body = {}) {
  const req = {
    tenantId: TENANT,
    user: { id: null, uid: ACTOR, role: 'PHARMACY_INCHARGE' },
    id: 'req-dsub-counter',
    params: { id: String(orderId) },
    idempotencyClaim: { requestKey: `dsub-counter-${orderId}` },
    body,
  };
  const res = mockRes();
  await markCounterDispensed(req, res);
  return res;
}
// mig 753's chk_pharmacy_orders_verification_provenance_753 forbids a hand-stamped
// clinical_verification_status='verified': a verified order must carry the whole
// provenance set (order version, items/catalog/active-therapy sha256, kb + ruleset
// version, verifier identity, safety version). The fixture therefore earns
// verification through the real pharmacist command instead of writing the column,
// and re-earns it whenever a test amends items_list — assertVerificationClearedTx
// recomputes every one of those digests on each dispense.
// The dispatch custody contract stores sha256(tenant:order:token); the fixture keeps
// the same one-time token so a delivery call can present it.
const DELIVERY_HANDOFF_TOKEN = 'dsub-delivery-handoff-token-000001';
function deliveryHandoffSha256(id) {
  return createHash('sha256')
    .update(`${TENANT}:${id}:${DELIVERY_HANDOFF_TOKEN}`)
    .digest('hex');
}
let verificationSequence = 0;
async function verifyOrderFixture(id) {
  const seed = `dsub-verify-${id}-${++verificationSequence}`;
  return verifyOrder(id, {
    tenantId: TENANT,
    decision: 'verified',
    actorUid: ACTOR,
    actorRole: 'PHARMACY_INCHARGE',
    commandKeySha256: createHash('sha256').update(`${seed}:command`).digest('hex'),
    requestSha256: createHash('sha256').update(`${seed}:request`).digest('hex'),
  });
}
let commandSequence = 0;
let currentOrderId;
let currentPrescriptionId;
let currentFacilityId;
// The dispense command asserts the pharmacist's facility grant from the CALLER-
// NAMED facility (dispenseSubstitutionCommand → assertPharmacyFacilityGrant with
// `body.facility_id`), and resolveSubstitutionPhase0 demands the prescription-bound
// line identity (order_line_index / prescription_line_index). Both are part of the
// wire contract (dispenseSubstitutionValidator pins the two indices), so the fixture
// sends them on every call rather than relying on a default that no longer exists.
async function callController(body, { idempotencyKey = `dsub-command-${++commandSequence}` } = {}) {
  const req = {
    tenantId: TENANT,
    user: { uid: ACTOR, role: 'PHARMACY_INCHARGE' },
    id: 'req-dsub',
    idempotencyClaim: { requestKey: idempotencyKey },
    body: {
      order_id: currentOrderId,
      prescription_id: currentPrescriptionId,
      facility_id: currentFacilityId,
      order_line_index: 0,
      prescription_line_index: 0,
      ...body,
    },
  };
  const res = mockRes();
  await dispenseSubstitution(req, res);
  return res;
}

describe('dispenseSubstitution — atomic decrement + canonical events + equivalence gate', () => {
  let compId; let origId; let subId; let diffId; let itemId; let batchId;
  let facilityId; let storageLocationId; let patientId;
  let xItemId; let xBatchId; let h1ItemId; let h1BatchId;
  let orderId; let prescriptionId;

  // pharmacy_order_command_receipts is append-only (migration 753's
  // reject_pharmacy_order_command_receipt_mutation_753) and pharmacy_orders cascades
  // onto it, so every order teardown drops the receipts under
  // session_replication_role='replica' first — the append-only guard stays live
  // everywhere else. The clinical verification command below writes one of those
  // receipts per order, so beforeEach needs this too, not just afterAll.
  async function purgeSuiteOrders() {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'replica'");
      await tx.$executeRawUnsafe(
        `DELETE FROM pharmacy_order_command_receipts WHERE tenant_id=$1::uuid`, TENANT,
      );
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'origin'");
      await tx.$executeRawUnsafe(
        `DELETE FROM e_prescriptions WHERE tenant_id=$1::uuid`, TENANT,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM pharmacy_order_history WHERE tenant_id=$1::uuid`, TENANT,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM pharmacy_orders WHERE tenant_id=$1::uuid`, TENANT,
      );
    }, { maxWait: 15000, timeout: 120000 });
  }

  async function cleanup() {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'replica'");
      await tx.$executeRawUnsafe(
        `DELETE FROM pharmacy_schedule_register WHERE tenant_id=$1::uuid`, TENANT,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM pharmacy_stock_movements WHERE tenant_id=$1::uuid AND reference_type IN ('dispense_substitution', 'controlled_dispense')`,
        TENANT,
      );
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'origin'");
    }, { maxWait: 15000, timeout: 120000 });
    await prisma.$executeRawUnsafe(
      `DELETE FROM approvals WHERE tenant_id=$1::uuid AND approval_kind='controlled_dispense_witness'`,
      TENANT,
    ).catch(() => {});
    await purgeSuiteOrders();
    for (const sql of [
      `DELETE FROM pharmacy_patient_safety_versions WHERE tenant_id=$1::uuid`,
      `DELETE FROM pharmacy_inventory_batches WHERE tenant_id=$1::uuid AND batch_number LIKE 'DSUB-%'`,
      `DELETE FROM pharmacy_inventory_items WHERE tenant_id=$1::uuid AND sku_code LIKE 'DSUB-%'`,
      `DELETE FROM clinical_timeline_events WHERE tenant_id=$1::uuid`,
      `DELETE FROM clinical_audit_events WHERE tenant_id=$1::uuid`,
    ]) await prisma.$executeRawUnsafe(sql, TENANT).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM pharmacy_catalog WHERE name LIKE 'DSUBTEST %'`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM drug_compositions WHERE composition_key=$1`, COMP_KEY).catch(() => {});
    // Deliberate single array binds for ANY($1::uuid[]) — hoisted per house style.
    const staffFixtureUids = [ACTOR, WITNESS, CLERK, GRANT_ADMIN];
    const userFixtureUids = [ACTOR, WITNESS, CLERK, GRANT_ADMIN, PATIENT];
    const facilityCodes = [FACILITY_CODE];
    // Custody teardown, after everything that references the facility is gone.
    // pharmacy_staff_facility_grant_events is append-only (migration 753's
    // trg_pharmacy_staff_facility_grant_events_append_only_753), so the fixture drops
    // its own rows under session_replication_role='replica' exactly the way
    // pharmacy-dispensable-context.deep.test.js does — the guard stays live elsewhere.
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'replica'");
      await tx.$executeRawUnsafe(
        `DELETE FROM pharmacy_staff_facility_grant_events
          WHERE grant_id IN (SELECT id FROM pharmacy_staff_facility_grants
                              WHERE staff_uid = ANY($1::uuid[]))`,
        staffFixtureUids,
      );
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'origin'");
      await tx.$executeRawUnsafe(
        `DELETE FROM pharmacy_staff_facility_grants WHERE staff_uid = ANY($1::uuid[])`,
        staffFixtureUids,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM staff WHERE user_id = ANY($1::uuid[])`, staffFixtureUids,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM facility_locations
          WHERE facility_id IN (SELECT id FROM facilities WHERE facility_code = ANY($1::text[]))`,
        facilityCodes,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM facilities WHERE facility_code = ANY($1::text[])`, facilityCodes,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM users WHERE uid = ANY($1::uuid[])`, userFixtureUids,
      );
    }, { maxWait: 15000, timeout: 120000 });
  }

  async function seedCatalog(name, {
    strengthKey, strengthComponents, manufacturer, unitPrice,
  }) {
    const r = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_catalog
         (name, generic_name, manufacturer, is_active, tenant_id, composition_id, strength,
          strength_key, strength_components, form, form_key, release_key, route,
          composition_confidence, unit_price, updated_at)
       VALUES ($1,'Amoxicillin + Clavulanic acid',$2,TRUE,$3::uuid,$4,$5,$5,$6::jsonb,
               'tablet','tablet',NULL,NULL,'high',$7,NOW())
       RETURNING id`,
      name, manufacturer, TENANT, compId, strengthKey, strengthComponents, unitPrice,
    );
    return Number(r[0].id);
  }

  beforeAll(async () => {
    await cleanup();
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name, region, status, created_at, updated_at)
       VALUES ($1::uuid,'dsub-test','DSUB','IN','active',NOW(),NOW()) ON CONFLICT (id) DO NOTHING`,
      TENANT,
    );
    // Roster: the dispenser + patient + an eligible independent witness + an
    // ineligible clerk (role gate probe) + the admin that issues facility custody.
    // Seeded first because the order/prescription/grant rows below all bind to
    // these identities by id.
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, name, phone, role, is_active, status, is_deleted, tenant_id, updated_at)
       VALUES
         ($1::uuid, 'Substitution Patient', '9812345699', 'PATIENT', TRUE,'active',FALSE, $6::uuid, NOW()),
         ($2::uuid, 'Substitution Pharmacist', NULL, 'PHARMACY_INCHARGE', TRUE,'active',FALSE, $6::uuid, NOW()),
         ($3::uuid, 'Substitution Witness', NULL, 'PHARMACY_STAFF', TRUE,'active',FALSE, $6::uuid, NOW()),
         ($4::uuid, 'Substitution Clerk', NULL, 'RECEPTIONIST', TRUE,'active',FALSE, $6::uuid, NOW()),
         ($5::uuid, 'Substitution Grant Admin', NULL, 'ADMIN', TRUE,'active',FALSE, $6::uuid, NOW())
       ON CONFLICT (uid) DO NOTHING`,
      PATIENT, ACTOR, WITNESS, CLERK, GRANT_ADMIN, TENANT,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO staff (user_id, employee_id, name, is_active, archived, tenant_id, updated_at)
       VALUES
         ($1::uuid, 'DSUB-ACTOR', 'Roster Substitution Pharmacist', true, false, $4::uuid, NOW()),
         ($2::uuid, 'DSUB-WITNESS', 'Roster Substitution Witness', true, false, $4::uuid, NOW()),
         ($3::uuid, 'DSUB-CLERK', 'Roster Substitution Clerk', true, false, $4::uuid, NOW())`,
      ACTOR, WITNESS, CLERK, TENANT,
    );
    patientId = Number((await prisma.$queryRawUnsafe(
      `SELECT id FROM users WHERE tenant_id=$1::uuid AND uid=$2::uuid`, TENANT, PATIENT,
    ))[0].id);
    // mig 753 (chk_pharmacy_inventory_items_active_authority_753): an ACTIVE
    // inventory item must name both the facility that holds custody of it and
    // the catalog identity it stocks. Give this tenant its own facility rather
    // than borrowing the platform default — the suite is tenant-isolated.
    const fr = await prisma.$queryRawUnsafe(
      `INSERT INTO facilities (tenant_id, facility_code, display_name, status, is_default)
       VALUES ($1::uuid,$2,'DSUB Main Pharmacy','active',TRUE)
       RETURNING id`,
      TENANT, FACILITY_CODE,
    );
    facilityId = Number(fr[0].id);
    currentFacilityId = facilityId;
    // chk_pharmacy_batches_usable_authority_753 + the
    // enforce_pharmacy_batch_storage_authority_supply_753 trigger: in-stock stock
    // must name its facility AND an ACTIVE storage location inside that exact
    // facility, so the suite owns a real pharmacy store location.
    storageLocationId = Number((await prisma.$queryRawUnsafe(
      `INSERT INTO facility_locations
         (tenant_id, facility_id, location_code, display_name, location_kind, status)
       VALUES ($1::uuid,$2::int,'DSUB-STORE','DSUB pharmacy store','pharmacy','active')
       RETURNING id`,
      TENANT, facilityId,
    ))[0].id);
    // assertPharmacyFacilityGrant has NO admin bypass: the dispenser needs exactly
    // one ACTIVE pharmacy_staff_facility_grants row. Issue it through the real
    // admin-authorised command so the fixture exercises the product's own path.
    await grantPharmacyFacilityAuthority({
      tenantId: TENANT,
      facilityId,
      staffUid: ACTOR,
      actorUid: GRANT_ADMIN,
      actorRole: 'ADMIN',
      reason: 'Dispense-substitution deep test pharmacy facility custody',
      commandKey: 'dsub-facility-grant-actor',
    });
    const cr = await prisma.$queryRawUnsafe(
      `INSERT INTO drug_compositions (composition_key, display_label, active_ingredients, source)
       VALUES ($1,'Amox+Clav',ARRAY['amoxicillin','clavulanic_acid'],'curated') RETURNING id`,
      COMP_KEY,
    );
    compId = Number(cr[0].id);
    origId = await seedCatalog('DSUBTEST Augmentin 625', {
      strengthKey: '625mg', strengthComponents: combo, manufacturer: 'GSK', unitPrice: 10,
    });
    subId = await seedCatalog('DSUBTEST Clavam 625', {
      strengthKey: '625mg', strengthComponents: combo, manufacturer: 'Alkem', unitPrice: 12,
    });
    diffId = await seedCatalog('DSUBTEST Clavam 375', {
      strengthKey: '375mg',
      strengthComponents: JSON.stringify([
        { ingredient: 'amoxicillin', amount: 250, unit: 'mg' },
        { ingredient: 'clavulanic_acid', amount: 125, unit: 'mg' },
      ]),
      manufacturer: 'Alkem',
      unitPrice: 8,
    });
    const it = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_inventory_items
         (tenant_id, facility_id, sku_code, display_name, catalog_id, composition_id)
       VALUES ($1::uuid,$4::int,'DSUB-SKU-1','Clavam 625',$2,$3) RETURNING id`,
      TENANT, subId, compId, facilityId,
    );
    itemId = Number(it[0].id);
    const b = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_inventory_batches
         (tenant_id, inventory_item_id, facility_id, storage_location_id,
          batch_number, expiry_date, received_quantity, remaining_quantity, status)
       VALUES ($1::uuid,$2,$3::int,$4::int,'DSUB-B1',(NOW() + INTERVAL '365 days')::date,100,100,'in_stock') RETURNING id`,
      TENANT, itemId, facilityId, storageLocationId,
    );
    batchId = Number(b[0].id);

    // Controlled fixtures: a Schedule X narcotic brand and a Schedule H1 brand
    // of the SAME composition (so the equivalence gate passes and the schedule
    // gate is the only variable under test).
    const xi = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_inventory_items
         (tenant_id, facility_id, sku_code, display_name, catalog_id, composition_id,
          schedule_class, is_narcotic)
       VALUES ($1::uuid,$4::int,'DSUB-SKU-X','Clavam 625 CX',$2,$3,'X',true) RETURNING id`,
      TENANT, subId, compId, facilityId,
    );
    xItemId = Number(xi[0].id);
    const xb = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_inventory_batches
         (tenant_id, inventory_item_id, facility_id, storage_location_id,
          batch_number, expiry_date, received_quantity, remaining_quantity, status)
       VALUES ($1::uuid,$2,$3::int,$4::int,'DSUB-BX',(NOW() + INTERVAL '365 days')::date,40,40,'in_stock') RETURNING id`,
      TENANT, xItemId, facilityId, storageLocationId,
    );
    xBatchId = Number(xb[0].id);
    const h1i = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_inventory_items
         (tenant_id, facility_id, sku_code, display_name, catalog_id, composition_id,
          schedule_class, is_narcotic)
       VALUES ($1::uuid,$4::int,'DSUB-SKU-H1','Clavam 625 CH1',$2,$3,'H1',false) RETURNING id`,
      TENANT, subId, compId, facilityId,
    );
    h1ItemId = Number(h1i[0].id);
    const h1b = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_inventory_batches
         (tenant_id, inventory_item_id, facility_id, storage_location_id,
          batch_number, expiry_date, received_quantity, remaining_quantity, status)
       VALUES ($1::uuid,$2,$3::int,$4::int,'DSUB-BH1',(NOW() + INTERVAL '365 days')::date,40,40,'in_stock') RETURNING id`,
      TENANT, h1ItemId, facilityId, storageLocationId,
    );
    h1BatchId = Number(h1b[0].id);
    // Deep custody fixture: facility + storage location + real admin-issued grant +
    // a real pharmacist verification command all run here, so the hook needs more
    // than jest's 5s default. This is a harness budget, not a relaxed assertion.
  }, 120000);

  beforeEach(async () => {
    await purgeSuiteOrders();
    // mig 753: chk_pharmacy_orders_facility_progression_753 (a non-terminal order
    // must name its facility) + fk_e_prescriptions_pharmacy_order_patient_753 /
    // chk_e_prescriptions_link_identity_753 (an order-linked Rx carries the order's
    // own patient_id AND patient_uid). Both rows therefore bind to the real patient
    // identity and the suite's own facility.
    // `dispensed_medications` is seeded '[]' rather than left NULL for the same
    // reason bcma-closed-loop.deep.test.js seeds it: on UPDATE, mig 753's
    // bump_pharmacy_patient_safety_version_753 projects to_jsonb(NEW), where a NULL
    // column arrives as the jsonb scalar `null` — COALESCE cannot see it and
    // pharmacy_erx_clinical_projection_753 raises 22023 "cannot extract elements
    // from a scalar" on the first update of such a row.
    const orderRows = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_orders
         (tenant_id, facility_id, patient_id, authority_origin, phone, patient_name,
          patient_phone, order_note, delivery_type,
          status, items_list, dispensed_medications, total_amount,
          clinical_verification_status, updated_at)
        VALUES ($1::uuid, $3::int, $4::int, 'e_prescription', '9812345699',
          'Substitution Patient', '9812345699',
          'dsub-origin', 'delivery', 'CONFIRMED', $2::jsonb, '[]'::jsonb, 2000000,
          'pending', NOW())
       RETURNING id`,
      TENANT,
      JSON.stringify([{
        order_line_index: 0,
        prescription_line_index: 0,
        catalog_id: origId,
        name: 'DSUBTEST Augmentin 625',
        quantity: 200000,
        qty: 200000,
        price: 10,
        line_total: 2000000,
      }]),
      facilityId,
      patientId,
    );
    orderId = Number(orderRows[0].id);
    const prescriptionRows = await prisma.$queryRawUnsafe(
      `INSERT INTO e_prescriptions
         (tenant_id, pharmacy_order_id, patient_id, patient_uid, medications, status,
          prescription_number, created_at, updated_at)
       VALUES ($1::uuid, $2::int, $6::int, $3::uuid, $4::jsonb, 'pharmacy_linked',
          $5, NOW(), NOW())
       RETURNING id`,
      TENANT,
      orderId,
      PATIENT,
      JSON.stringify([{
        catalog_id: origId,
        name: 'DSUBTEST Augmentin 625',
        quantity: 200000,
      }]),
      `DSUB-RX-${orderId}`,
      patientId,
    );
    prescriptionId = Number(prescriptionRows[0].id);
    await verifyOrderFixture(orderId);
    currentOrderId = orderId;
    currentPrescriptionId = prescriptionId;
  }, 120000);

  afterAll(async () => {
    await cleanup();
    if (typeof prisma.$disconnect === 'function') await prisma.$disconnect();
  }, 120000);

  // Original success-path assertions, to restore when the funding lane is wired:
  //   200 + success:true; batch 100 → 90 with status still 'in_stock'; exactly one
  //   'dispense_substitution' movement, quantity_delta -10, metadata containing
  //   { order_id, prescription_id, fulfilment_status:'partial', remaining_quantity:199990,
  //   billable_subtotal:120 }; res.body.data containing those same five plus
  //   batch_evidence.inventory_batch_id === batchId; the order projection
  //   (partial_dispense true, total_amount 120, items_list[0] catalog_id=subId,
  //   inventory_item_id=itemId, price 12, inventory_billable_total 120, line_total 120,
  //   dispensed_qty 10, inventory_dispensed_quantity 10); the eRx projection
  //   (status 'pharmacy_linked', medications[0] dispensed_quantity 10,
  //   remaining_quantity 199990, fulfilment_status 'partial'); and at least one
  //   clinical_timeline_events + clinical_audit_events row.
  test('dispenses an equivalent substitute: decrements batch + movement + canonical pair — currently refused at the funding gate', async () => {
    const remainingBefore = await batchRemaining(batchId);
    const orderVersion = await orderAuthorityVersion(orderId);
    const res = await callController({
      patient_uid: PATIENT, inventory_item_id: itemId, inventory_batch_id: batchId,
      quantity: 10, original_catalog_id: origId, final_catalog_id: subId,
      reason: 'prescribed brand out of stock',
    });
    await expectRefusedAtFundingGate(res, {
      orderId,
      orderVersion,
      proposedAmount: 120, // 10 units × the substitute's authoritative unit price of 12
      batchId,
      inventoryItemId: itemId,
      remainingBefore,
    });
    // The order and its eRx are projected inside the same refused transaction, so the
    // refusal must leave both exactly as the fixture seeded them.
    const projection = await prisma.$queryRawUnsafe(
      `SELECT po.partial_dispense, po.total_amount, po.items_list,
              ep.status AS prescription_status, ep.medications
         FROM pharmacy_orders po
         JOIN e_prescriptions ep ON ep.pharmacy_order_id=po.id AND ep.tenant_id=po.tenant_id
        WHERE po.id=$1::int AND ep.id=$2::int`,
      orderId,
      prescriptionId,
    );
    expect(Number(projection[0].total_amount)).toBe(2000000);
    expect(projection[0].prescription_status).toBe('pharmacy_linked');
    expect(projection[0].items_list[0].catalog_id).toBe(origId);
    expect(projection[0].items_list[0].inventory_dispensed_quantity).toBeUndefined();
    expect(projection[0].medications[0].dispensed_quantity).toBeUndefined();
  });

  test('rejects a non-equivalent substitute (different strength) and leaves stock untouched', async () => {
    const before = await prisma.$queryRawUnsafe(`SELECT remaining_quantity FROM pharmacy_inventory_batches WHERE id=$1`, batchId);
    const res = await callController({
      patient_uid: PATIENT, inventory_item_id: itemId, inventory_batch_id: batchId,
      quantity: 5, original_catalog_id: origId, final_catalog_id: diffId, reason: 'x',
    });
    expect(res.statusCode).toBe(400);
    const after = await prisma.$queryRawUnsafe(`SELECT remaining_quantity FROM pharmacy_inventory_batches WHERE id=$1`, batchId);
    expect(Number(after[0].remaining_quantity)).toBe(Number(before[0].remaining_quantity));
  });

  // Original assertions, to restore when the funding lane is wired: 400 from the
  // FOR UPDATE + balance check, with the batch untouched. That balance check lives
  // downstream of the funding gate, so today the refusal arrives one gate earlier —
  // the stock probe is never even reached. The invariant the test exists for (an
  // over-quantity substitution never moves stock) is still proven, and proven harder:
  // the batch, the movement ledger and the register are all pinned empty.
  test('rejects insufficient stock atomically — currently refused at the funding gate, before the stock probe', async () => {
    const remainingBefore = await batchRemaining(batchId);
    const orderVersion = await orderAuthorityVersion(orderId);
    const res = await callController({
      patient_uid: PATIENT, inventory_item_id: itemId, inventory_batch_id: batchId,
      quantity: 100000, original_catalog_id: origId, final_catalog_id: subId,
    });
    await expectRefusedAtFundingGate(res, {
      orderId,
      orderVersion,
      proposedAmount: 1200000, // 100000 units × 12, priced before the balance check runs
      batchId,
      inventoryItemId: itemId,
      remainingBefore,
    });
  });

  // NOT the funding gate — this one is a permanent tightening of the delivery lane.
  // markDelivered no longer accepts caller-named lines at all: the forbidden-field gate at
  // pharmacyOrderController.js:2246-2256 refuses any body carrying dispensed_items /
  // payment_mode / amount_collected / tpa_reference / cap_override* with
  // PHARMACY_DELIVERY_CALLER_AUTHORITY_FORBIDDEN, because delivery completion consumes only
  // the staged custody package and the patient handoff proof. That gate now stands in front
  // of the two guards this test used to pin — PHARMACY_ORDER_DELIVERY_LINE_MUTATION_FORBIDDEN
  // (caller-supplied quantity, 400) and PHARMACY_ORDER_DELIVERY_LINE_UNRESOLVED (unmatched
  // catalog line, 409) — so neither is reachable from '/delivered' any more; see the note at
  // pharmacyOrderInventoryService.js:1583-1587, where the recovery deep link was repointed at
  // '/dispatch' for exactly this reason. Pinning the outer gate by exact code AND exact
  // forbidden_fields is strictly stronger than the pair it replaces: it proves the whole
  // class of caller-authored dispense payloads is refused rather than two particular shapes.
  test('delivery rejects caller line quantities and unmatched catalog lines', async () => {
    await prisma.$executeRawUnsafe(
      // mig 753: guard_pharmacy_order_delivery_custody_753 +
      // chk_pharmacy_orders_delivery_handoff_lifecycle_753 — a DISPATCHED delivery
      // order must carry the whole custody contract (assignee, one-time handoff
      // token hash, expiry, generation, dispatch notice evidence, in_transit
      // custody), so the fixture stamps the real shape instead of the status alone.
      `UPDATE pharmacy_orders
          SET status='DISPATCHED',
              delivery_custody_contract_version=1,
              delivery_custody_status='in_transit',
              delivery_assignee_uid=$3::uuid,
              delivery_handoff_token_sha256=$4,
              delivery_handoff_expires_at=NOW() + INTERVAL '1 day',
              delivery_handoff_generation=1,
              delivery_handoff_notice_outbox_ids=ARRAY[1]::int4[],
              delivery_handoff_consumed_at=NULL,
              delivery_handoff_completed_by=NULL
        WHERE id=$1::int AND tenant_id=$2::uuid`,
      orderId,
      TENANT,
      ACTOR,
      deliveryHandoffSha256(orderId),
    );
    const before = await prisma.$queryRawUnsafe(
      `SELECT remaining_quantity FROM pharmacy_inventory_batches WHERE id=$1`,
      batchId,
    );
    const quantityMutation = await callDelivery(orderId, {
      dispensed_items: [{
        order_line_index: 0,
        catalog_id: origId,
        inventory_item_id: itemId,
        quantity: 1,
        inventory_allocations: [{ inventory_batch_id: batchId, quantity: 1 }],
      }],
    });
    expect(quantityMutation.statusCode).toBe(400);
    expect(bodyCode(quantityMutation)).toBe('PHARMACY_DELIVERY_CALLER_AUTHORITY_FORBIDDEN');
    expect(quantityMutation.body?.details).toEqual({ forbidden_fields: ['dispensed_items'] });

    const unmatched = await callDelivery(orderId, {
      dispensed_items: [{
        order_line_index: 0,
        catalog_id: diffId,
        inventory_item_id: itemId,
        inventory_allocations: [{ inventory_batch_id: batchId, quantity: 1 }],
      }],
    });
    expect(unmatched.statusCode).toBe(400);
    expect(bodyCode(unmatched)).toBe('PHARMACY_DELIVERY_CALLER_AUTHORITY_FORBIDDEN');
    expect(unmatched.body?.details).toEqual({ forbidden_fields: ['dispensed_items'] });
    const after = await prisma.$queryRawUnsafe(
      `SELECT remaining_quantity FROM pharmacy_inventory_batches WHERE id=$1`,
      batchId,
    );
    expect(Number(after[0].remaining_quantity)).toBe(Number(before[0].remaining_quantity));
    const orderRows = await prisma.$queryRawUnsafe(
      `SELECT status FROM pharmacy_orders WHERE id=$1::int AND tenant_id=$2::uuid`,
      orderId,
      TENANT,
    );
    expect(orderRows[0].status).toBe('DISPATCHED');
  });

  test('counter rejects unmatched and caller-priced lines before billing or stock movement', async () => {
    await prisma.$executeRawUnsafe(
      `UPDATE pharmacy_orders SET delivery_type='counter'
        WHERE id=$1::int AND tenant_id=$2::uuid`,
      orderId,
      TENANT,
    );
    const before = await prisma.$queryRawUnsafe(
      `SELECT remaining_quantity FROM pharmacy_inventory_batches WHERE id=$1`,
      batchId,
    );
    const priced = await callCounter(orderId, {
      dispensed_items: [{ order_line_index: 0, catalog_id: origId, quantity: 1, price: 0 }],
      payment_mode: 'none',
    });
    expect(priced.statusCode).toBe(400);
    expect(bodyCode(priced)).toBe('PHARMACY_ORDER_PRICE_MUTATION_FORBIDDEN');
    const unmatched = await callCounter(orderId, {
      dispensed_items: [{ order_line_index: 0, catalog_id: diffId, quantity: 1 }],
      payment_mode: 'none',
    });
    expect(unmatched.statusCode).toBe(409);
    expect(bodyCode(unmatched)).toBe('PHARMACY_ORDER_DISPENSE_LINE_UNRESOLVED');
    const after = await prisma.$queryRawUnsafe(
      `SELECT remaining_quantity FROM pharmacy_inventory_batches WHERE id=$1`,
      batchId,
    );
    expect(Number(after[0].remaining_quantity)).toBe(Number(before[0].remaining_quantity));
  });

  // Original success-path assertions, to restore when the funding lane is wired: the qty-2
  // substitution returns 200 with data { fulfilment_status:'partial', remaining_quantity:3 };
  // the order is then stamped DISPATCHED with the full mig-753 custody contract and
  // callDelivery(orderId) returns 200; the batch falls by 5 in total (2 substituted + the
  // 3-unit remainder allocated at delivery); and the projection reads status 'DELIVERED',
  // total_amount 60, items_list[0] { catalog_id: subId, ordered_qty 5, dispensed_qty 5,
  // remaining_qty 0, inventory_dispensed_quantity 5, inventory_remaining_quantity 0,
  // price 12, line_total 60 }, prescription_status 'fulfilled' and medications[0]
  // { ordered_quantity 5, dispensed_quantity 5, remaining_quantity 0,
  // fulfilment_status: 'fulfilled' }.
  test('partial substitution then delivery allocates only the remainder and closes billing + eRx evidence — currently refused at the funding gate', async () => {
    await prisma.$executeRawUnsafe(
      `UPDATE e_prescriptions SET medications=$3::jsonb
        WHERE id=$1::int AND tenant_id=$2::uuid`,
      prescriptionId,
      TENANT,
      JSON.stringify([{ catalog_id: origId, name: 'DSUBTEST Augmentin 625', quantity: 5 }]),
    );
    await prisma.$executeRawUnsafe(
      `UPDATE pharmacy_orders SET items_list=$3::jsonb, total_amount=50
        WHERE id=$1::int AND tenant_id=$2::uuid`,
      orderId,
      TENANT,
      JSON.stringify([{
        order_line_index: 0,
        prescription_line_index: 0,
        catalog_id: origId,
        name: 'DSUBTEST Augmentin 625',
        quantity: 5,
        qty: 5,
        price: 10,
        line_total: 50,
      }]),
    );
    // items_list just changed, so the recorded verification digests are stale by
    // construction; re-earn verification through the real command before dispensing.
    await verifyOrderFixture(orderId);
    const remainingBefore = await batchRemaining(batchId);
    const orderVersion = await orderAuthorityVersion(orderId);
    const partial = await callController({
      patient_uid: PATIENT,
      inventory_item_id: itemId,
      inventory_batch_id: batchId,
      quantity: 2,
      original_catalog_id: origId,
      final_catalog_id: subId,
    });
    await expectRefusedAtFundingGate(partial, {
      orderId,
      orderVersion,
      proposedAmount: 24, // 2 units × 12; the ordered 5 stay unbilled and unallocated
      batchId,
      inventoryItemId: itemId,
      remainingBefore,
    });
    // The delivery half of this scenario is predicated on the partial dispense that the
    // gate just refused, so it cannot run at all: the order is still CONFIRMED, its
    // billing is still the pre-substitution total and the eRx is still open.
    const projection = await prisma.$queryRawUnsafe(
      `SELECT po.status, po.total_amount, po.items_list,
              ep.status AS prescription_status, ep.medications
         FROM pharmacy_orders po
         JOIN e_prescriptions ep ON ep.pharmacy_order_id=po.id AND ep.tenant_id=po.tenant_id
        WHERE po.id=$1::int AND ep.id=$2::int`,
      orderId,
      prescriptionId,
    );
    expect(projection[0].status).toBe('CONFIRMED');
    expect(Number(projection[0].total_amount)).toBe(50);
    expect(projection[0].items_list[0].catalog_id).toBe(origId);
    expect(projection[0].prescription_status).toBe('pharmacy_linked');
    expect(projection[0].medications[0].dispensed_quantity).toBeUndefined();
  });

  // Original success-path assertions, to restore when the funding lane is wired: both calls
  // return 200; after the second the order reads total_amount 39 with items_list[0]
  // { dispensed_qty 3, inventory_dispensed_quantity 3, inventory_billable_total 39,
  // line_total 39 } and substitution_history === [ { quantity 2, unit_price 12,
  // line_total 24 }, { quantity 1, unit_price 15, line_total 15 } ] — each movement keeps
  // the price it was dispensed at, and the catalog re-price never re-prices history.
  test('repeated partial substitutions preserve each movement price without repricing history — currently refused at the funding gate', async () => {
    await prisma.$executeRawUnsafe(
      `UPDATE e_prescriptions SET medications=$3::jsonb
        WHERE id=$1::int AND tenant_id=$2::uuid`,
      prescriptionId,
      TENANT,
      JSON.stringify([{ catalog_id: origId, name: 'DSUBTEST Augmentin 625', quantity: 5 }]),
    );
    await prisma.$executeRawUnsafe(
      `UPDATE pharmacy_orders SET items_list=$3::jsonb, total_amount=50
        WHERE id=$1::int AND tenant_id=$2::uuid`,
      orderId,
      TENANT,
      JSON.stringify([{
        order_line_index: 0,
        prescription_line_index: 0,
        catalog_id: origId,
        name: 'DSUBTEST Augmentin 625',
        quantity: 5,
        qty: 5,
        price: 10,
        line_total: 50,
      }]),
    );
    // items_list just changed, so the recorded verification digests are stale by
    // construction; re-earn verification through the real command before dispensing.
    await verifyOrderFixture(orderId);
    const remainingBefore = await batchRemaining(batchId);
    const firstVersion = await orderAuthorityVersion(orderId);
    const first = await callController({
      patient_uid: PATIENT,
      inventory_item_id: itemId,
      inventory_batch_id: batchId,
      quantity: 2,
      original_catalog_id: origId,
      final_catalog_id: subId,
    });
    await expectRefusedAtFundingGate(first, {
      orderId,
      orderVersion: firstVersion,
      proposedAmount: 24, // 2 × 12, the substitute's authoritative price at this point
      batchId,
      inventoryItemId: itemId,
      remainingBefore,
    });

    await prisma.$executeRawUnsafe(
      `UPDATE pharmacy_catalog SET unit_price=15, updated_at=NOW() WHERE id=$1::int`,
      subId,
    );
    try {
      const secondVersion = await orderAuthorityVersion(orderId);
      const second = await callController({
        patient_uid: PATIENT,
        inventory_item_id: itemId,
        inventory_batch_id: batchId,
        quantity: 1,
        original_catalog_id: origId,
        final_catalog_id: subId,
      });
      // The re-priced attempt is quoted at the NEW authoritative price and carries no
      // memory of the refused one: 1 × 15, not 24 + 15. That is the repricing invariant
      // this test exists for, asserted on the only value the gate still exposes.
      await expectRefusedAtFundingGate(second, {
        orderId,
        orderVersion: secondVersion,
        proposedAmount: 15,
        batchId,
        inventoryItemId: itemId,
        remainingBefore,
      });
      const rows = await prisma.$queryRawUnsafe(
        `SELECT total_amount, items_list FROM pharmacy_orders
          WHERE id=$1::int AND tenant_id=$2::uuid`,
        orderId,
        TENANT,
      );
      expect(Number(rows[0].total_amount)).toBe(50);
      expect(rows[0].items_list[0].inventory_dispensed_quantity).toBeUndefined();
      expect(rows[0].items_list[0].substitution_history).toBeUndefined();
    } finally {
      await prisma.$executeRawUnsafe(
        `UPDATE pharmacy_catalog SET unit_price=12, updated_at=NOW() WHERE id=$1::int`,
        subId,
      );
    }
  });

  // Original success-path assertions, to restore when the funding lane is wired: the qty-1
  // substitution returns 200; callCounter(orderId, { payment_mode:'cash',
  // amount_collected: 48 }) returns 200; the batch falls by 4 in total (1 substituted + the
  // 3-unit remainder allocated at the counter); and the projection reads status 'DISPENSED',
  // total_amount 48, items_list[0] { catalog_id: subId, ordered_qty 4, dispensed_qty 4,
  // inventory_dispensed_quantity 4, inventory_remaining_quantity 0, price 12, line_total 48 },
  // prescription_status 'fulfilled' and medications[0] { dispensed_quantity 4,
  // remaining_quantity 0, fulfilment_status: 'fulfilled' }.
  test('partial substitution then counter finalization preserves substituted price and allocates the remainder — currently refused at the funding gate', async () => {
    await prisma.$executeRawUnsafe(
      `UPDATE e_prescriptions SET medications=$3::jsonb
        WHERE id=$1::int AND tenant_id=$2::uuid`,
      prescriptionId,
      TENANT,
      JSON.stringify([{ catalog_id: origId, name: 'DSUBTEST Augmentin 625', quantity: 4 }]),
    );
    await prisma.$executeRawUnsafe(
      `UPDATE pharmacy_orders
          SET delivery_type='counter', items_list=$3::jsonb, total_amount=40
        WHERE id=$1::int AND tenant_id=$2::uuid`,
      orderId,
      TENANT,
      JSON.stringify([{
        order_line_index: 0,
        prescription_line_index: 0,
        catalog_id: origId,
        name: 'DSUBTEST Augmentin 625',
        quantity: 4,
        qty: 4,
        price: 10,
        line_total: 40,
      }]),
    );
    // items_list just changed, so the recorded verification digests are stale by
    // construction; re-earn verification through the real command before dispensing.
    await verifyOrderFixture(orderId);
    const remainingBefore = await batchRemaining(batchId);
    const orderVersion = await orderAuthorityVersion(orderId);
    const partial = await callController({
      patient_uid: PATIENT,
      inventory_item_id: itemId,
      inventory_batch_id: batchId,
      quantity: 1,
      original_catalog_id: origId,
      final_catalog_id: subId,
    });
    await expectRefusedAtFundingGate(partial, {
      orderId,
      orderVersion,
      proposedAmount: 12, // 1 × 12; the other 3 ordered units stay unbilled
      batchId,
      inventoryItemId: itemId,
      remainingBefore,
    });
    // The counter finalisation this test then measured only means anything on top of a
    // committed substitution, so the order is still CONFIRMED at its pre-substitution
    // billing with the ORIGINAL catalog line — no substituted price to preserve, and no
    // remainder to allocate.
    const projection = await prisma.$queryRawUnsafe(
      `SELECT po.status, po.total_amount, po.items_list,
              ep.status AS prescription_status, ep.medications
         FROM pharmacy_orders po
         JOIN e_prescriptions ep ON ep.pharmacy_order_id=po.id AND ep.tenant_id=po.tenant_id
        WHERE po.id=$1::int AND ep.id=$2::int`,
      orderId,
      prescriptionId,
    );
    expect(projection[0].status).toBe('CONFIRMED');
    expect(Number(projection[0].total_amount)).toBe(40);
    expect(projection[0].items_list[0].catalog_id).toBe(origId);
    expect(projection[0].items_list[0].inventory_dispensed_quantity).toBeUndefined();
    expect(projection[0].prescription_status).toBe('pharmacy_linked');
    expect(projection[0].medications[0].dispensed_quantity).toBeUndefined();
  });

  test('cancelled prescription is rejected before stock or order mutation', async () => {
    await prisma.$executeRawUnsafe(
      `UPDATE e_prescriptions SET status='cancelled'
        WHERE id=$1::int AND tenant_id=$2::uuid`,
      prescriptionId,
      TENANT,
    );
    const before = await prisma.$queryRawUnsafe(
      `SELECT remaining_quantity FROM pharmacy_inventory_batches WHERE id=$1`,
      batchId,
    );

    const response = await callController({
      patient_uid: PATIENT,
      inventory_item_id: itemId,
      inventory_batch_id: batchId,
      quantity: 1,
      original_catalog_id: origId,
      final_catalog_id: subId,
    });

    expect(response.statusCode).toBe(409);
    expect(response.body?.code ?? response.body?.details?.code)
      .toBe('SUBSTITUTION_PRESCRIPTION_STATUS_INVALID');
    const after = await prisma.$queryRawUnsafe(
      `SELECT remaining_quantity FROM pharmacy_inventory_batches WHERE id=$1`,
      batchId,
    );
    expect(Number(after[0].remaining_quantity)).toBe(Number(before[0].remaining_quantity));
  });

  test('pending pharmacy verification blocks substitution before stock mutation', async () => {
    await prisma.$executeRawUnsafe(
      `UPDATE pharmacy_orders SET clinical_verification_status='pending'
        WHERE id=$1::int AND tenant_id=$2::uuid`,
      orderId,
      TENANT,
    );
    const before = await prisma.$queryRawUnsafe(
      `SELECT remaining_quantity FROM pharmacy_inventory_batches WHERE id=$1`,
      batchId,
    );

    const response = await callController({
      patient_uid: PATIENT,
      inventory_item_id: itemId,
      inventory_batch_id: batchId,
      quantity: 1,
      original_catalog_id: origId,
      final_catalog_id: subId,
    });

    expect(response.statusCode).toBe(409);
    expect(response.body?.code ?? response.body?.details?.code)
      .toBe('PHARMACY_VERIFICATION_REQUIRED');
    const after = await prisma.$queryRawUnsafe(
      `SELECT remaining_quantity FROM pharmacy_inventory_batches WHERE id=$1`,
      batchId,
    );
    expect(Number(after[0].remaining_quantity)).toBe(Number(before[0].remaining_quantity));
  });

  // Original success-path assertions, to restore when the funding lane is wired: the first
  // call returns 200; the identical replay returns 200 with data.idempotent_replay === true;
  // the same command key with quantity 2 returns 422; and the batch has fallen by exactly 1,
  // i.e. the replay did not dispense a second time.
  test('same command key replays once and conflicts when the linked body changes — currently refused at the funding gate', async () => {
    const remainingBefore = await batchRemaining(batchId);
    const orderVersion = await orderAuthorityVersion(orderId);
    const commandKey = `dsub-replay-${orderId}`;
    const body = {
      patient_uid: PATIENT,
      inventory_item_id: itemId,
      inventory_batch_id: batchId,
      quantity: 1,
      original_catalog_id: origId,
      final_catalog_id: subId,
    };
    const first = await callController(body, { idempotencyKey: commandKey });
    const replay = await callController(body, { idempotencyKey: commandKey });
    const mismatch = await callController(
      { ...body, quantity: 2 },
      { idempotencyKey: commandKey },
    );

    // A refusal rolls back its own command receipt (the helper pins that count at 0), so
    // the second call is not a replay of anything — it is a fresh attempt meeting the same
    // gate — and the changed-body call has no stored request digest to conflict with.
    // All three are refused identically apart from the amount each one proposed.
    for (const [res, proposedAmount] of [[first, 12], [replay, 12], [mismatch, 24]]) {
      await expectRefusedAtFundingGate(res, {
        orderId,
        orderVersion,
        proposedAmount,
        batchId,
        inventoryItemId: itemId,
        remainingBefore,
      });
    }
  });

  // Original success-path assertions, to restore when the funding lane is wired: the first
  // call returns 200 with data.fulfilment_status 'fulfilled' and data.remaining_quantity 0
  // (the fixture's single ordered unit), and the identical replay returns 200 with
  // data.idempotent_replay === true even though the prescription is now fully fulfilled —
  // the replay reads back durable movement evidence rather than re-running the dispense.
  test('a fully fulfilled prescription still replays from durable movement evidence — currently refused at the funding gate', async () => {
    await prisma.$executeRawUnsafe(
      `UPDATE e_prescriptions SET medications=$3::jsonb
        WHERE id=$1::int AND tenant_id=$2::uuid`,
      prescriptionId,
      TENANT,
      JSON.stringify([{ catalog_id: origId, name: 'DSUBTEST Augmentin 625', quantity: 1 }]),
    );
    await prisma.$executeRawUnsafe(
      `UPDATE pharmacy_orders SET items_list=$3::jsonb, total_amount=10
        WHERE id=$1::int AND tenant_id=$2::uuid`,
      orderId,
      TENANT,
      JSON.stringify([{
        order_line_index: 0,
        prescription_line_index: 0,
        catalog_id: origId,
        name: 'DSUBTEST Augmentin 625',
        quantity: 1,
        qty: 1,
        price: 10,
        line_total: 10,
      }]),
    );
    // items_list just changed, so the recorded verification digests are stale by
    // construction; re-earn verification through the real command before dispensing.
    await verifyOrderFixture(orderId);
    const remainingBefore = await batchRemaining(batchId);
    const orderVersion = await orderAuthorityVersion(orderId);
    const commandKey = `dsub-fulfilled-replay-${orderId}`;
    const body = {
      patient_uid: PATIENT,
      inventory_item_id: itemId,
      inventory_batch_id: batchId,
      quantity: 1,
      original_catalog_id: origId,
      final_catalog_id: subId,
    };
    const first = await callController(body, { idempotencyKey: commandKey });
    const replay = await callController(body, { idempotencyKey: commandKey });

    // The durable movement evidence the replay was meant to read back is never written,
    // so both calls are the same fresh, refused attempt.
    for (const res of [first, replay]) {
      await expectRefusedAtFundingGate(res, {
        orderId,
        orderVersion,
        proposedAmount: 12, // 1 × 12 — the whole ordered quantity on this fixture
        batchId,
        inventoryItemId: itemId,
        remainingBefore,
      });
    }
  });

  describe('controlled substitutes route through the statutory register (STAFF F1)', () => {
    // The witness helpers are invoked directly (no controller default), so the
    // prescription-bound line identity travels on the body itself. It is also part
    // of the approval fingerprint (substitutionWitnessPayload), so request, approve
    // and dispense must all carry the same pair.
    const xBody = (overrides = {}) => ({
      order_id: orderId,
      prescription_id: prescriptionId,
      order_line_index: 0,
      prescription_line_index: 0,
      patient_uid: PATIENT,
      inventory_item_id: xItemId,
      inventory_batch_id: xBatchId,
      quantity: 4,
      original_catalog_id: origId,
      final_catalog_id: subId,
      reason: 'x substitute',
      ...overrides,
    });

    test('Schedule X substitute WITHOUT a witness approval fails closed: no decrement, no movement, no register row', async () => {
      const before = await prisma.$queryRawUnsafe(`SELECT remaining_quantity FROM pharmacy_inventory_batches WHERE id=$1`, xBatchId);
      const res = await callController(xBody());
      expect(res.statusCode).toBe(400);
      expect(bodyCode(res)).toBe('SUBSTITUTION_WITNESS_REQUIRED');
      const after = await prisma.$queryRawUnsafe(`SELECT remaining_quantity FROM pharmacy_inventory_batches WHERE id=$1`, xBatchId);
      expect(Number(after[0].remaining_quantity)).toBe(Number(before[0].remaining_quantity));
      const mv = await prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS n FROM pharmacy_stock_movements WHERE tenant_id=$1::uuid AND inventory_item_id=$2::int`,
        TENANT, xItemId,
      );
      expect(mv[0].n).toBe(0);
      const reg = await prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS n FROM pharmacy_schedule_register WHERE tenant_id=$1::uuid AND inventory_item_id=$2::int`,
        TENANT, xItemId,
      );
      expect(reg[0].n).toBe(0);
    });

    // Original assertions, to restore when the funding lane is wired: 404, because the
    // approval id resolves to nothing. The witness approval is CONSUMED at
    // pharmacyOrderInventoryService.js:2502, downstream of the funding gate at :2420, so
    // today the bogus id is never even looked up — SUBSTITUTION_WITNESS_REQUIRED (which
    // fires at :2352, upstream of the gate) still 400s a missing witness, but a *supplied*
    // one is refused at the gate first. Stock untouched either way, and now also proven
    // against the movement ledger and the statutory register.
    test('a bogus witness_approval_id also fails closed with stock untouched — currently refused at the funding gate', async () => {
      const remainingBefore = await batchRemaining(xBatchId);
      const orderVersion = await orderAuthorityVersion(orderId);
      const res = await callController(xBody({ witness_approval_id: '999999999' }));
      await expectRefusedAtFundingGate(res, {
        orderId,
        orderVersion,
        proposedAmount: 48, // 4 units × 12
        batchId: xBatchId,
        inventoryItemId: xItemId,
        remainingBefore,
      });
    });

    test('witness request endpoint: only X/narcotic items, and a preselected approval id is rejected', async () => {
      await expect(requestSubstitutionWitnessApproval({
        tenantId: TENANT,
        requested_by: ACTOR,
        ...xBody({ inventory_item_id: h1ItemId, inventory_batch_id: h1BatchId }),
      })).rejects.toMatchObject({ code: 'CONTROLLED_DISPENSE_WITNESS_NOT_REQUIRED' });

      await expect(requestSubstitutionWitnessApproval({
        tenantId: TENANT,
        requested_by: ACTOR,
        ...xBody({ witness_approval_id: '17' }),
      })).rejects.toMatchObject({ code: 'CONTROLLED_DISPENSE_WITNESS_APPROVAL_PRESELECTED' });
    });

    test('ineligible-role and self witnesses are rejected at approval time', async () => {
      const approval = await requestSubstitutionWitnessApproval({
        tenantId: TENANT, requested_by: ACTOR, ...xBody(),
      });
      await expect(approveSubstitutionWitnessApproval({
        approvalId: approval.id,
        actorUid: CLERK,
        substitution: { tenantId: TENANT, ...xBody() },
      })).rejects.toMatchObject({ code: 'CONTROLLED_DISPENSE_WITNESS_ROLE_INELIGIBLE' });
      await expect(approveSubstitutionWitnessApproval({
        approvalId: approval.id,
        actorUid: ACTOR,
        substitution: { tenantId: TENANT, ...xBody() },
      })).rejects.toMatchObject({ code: 'CONTROLLED_DISPENSE_WITNESS_SELF' });
    });

    // Original success-path assertions, to restore when the funding lane is wired: the
    // witnessed call returns 200 with data.schedule_class 'X' and a numeric
    // data.register_entry_id; the batch falls 40 → 36; exactly one stock movement
    // (movement_kind 'issue', quantity_delta -4, reference_type 'controlled_dispense',
    // reference_id matching /^dispense-substitution:/); exactly one
    // pharmacy_schedule_register row (schedule_class 'X', movement_kind 'dispense',
    // quantity 4, running_balance 36, patient_uid PATIENT, patient_name
    // 'Substitution Patient', performed_by ACTOR, performed_by_name
    // 'Roster Substitution Pharmacist', witness_uid WITNESS, witness_name
    // 'Roster Substitution Witness'); the identical command replays 200 with
    // data.idempotent_replay === true and the batch still at 36 (the witness is not
    // consumed twice); and at least one clinical_timeline_events row of type
    // 'pharmacy.dispense_substitution'.
    test('witnessed Schedule X substitute: decrement + movement + register row + consumed approval + canonical pair in ONE tx — currently refused at the funding gate', async () => {
      const body = xBody();
      const approval = await requestSubstitutionWitnessApproval({
        tenantId: TENANT, requested_by: ACTOR, ...body,
      });
      await approveSubstitutionWitnessApproval({
        approvalId: approval.id,
        actorUid: WITNESS,
        substitution: { tenantId: TENANT, ...body },
      });

      const commandKey = `dsub-x-${orderId}`;
      const forged = await callController(
        { ...body, witness_approval_id: approval.id, performed_by_name: 'Forged Performer' },
        { idempotencyKey: commandKey },
      );
      expect(forged.statusCode).toBe(400);
      expect(bodyCode(forged)).toBe('SUBSTITUTION_PERFORMER_NAME_FORBIDDEN');
      const beforeValid = await prisma.$queryRawUnsafe(
        `SELECT remaining_quantity FROM pharmacy_inventory_batches WHERE id=$1`,
        xBatchId,
      );
      expect(Number(beforeValid[0].remaining_quantity)).toBe(40);

      const orderVersion = await orderAuthorityVersion(orderId);
      const res = await callController(
        { ...body, witness_approval_id: approval.id },
        { idempotencyKey: commandKey },
      );
      await expectRefusedAtFundingGate(res, {
        orderId,
        orderVersion,
        proposedAmount: 48, // 4 units × 12
        batchId: xBatchId,
        inventoryItemId: xItemId,
        remainingBefore: 40,
      });

      // Fail-closed means the statutory witness is not spent either: the approval this
      // test earned through the real request/approve commands is still unconsumed and
      // therefore still usable once the funding lane exists.
      const approvalRows = await prisma.$queryRawUnsafe(
        `SELECT metadata FROM approvals WHERE tenant_id=$1::uuid AND id=$2::bigint`,
        TENANT, Number(approval.id),
      );
      expect(approvalRows).toHaveLength(1);
      expect(approvalRows[0].metadata).toBeTruthy();
      expect(approvalRows[0].metadata.consumed_at).toBeUndefined();
    });

    // Original success-path assertions, to restore when the funding lane is wired: 200 with
    // data.schedule_class 'H1'; the batch falls 40 → 37; and exactly one
    // pharmacy_schedule_register row with schedule_class 'H1', witness_uid NULL (H1 needs
    // no witness) and patient_name 'Substitution Patient'.
    test('Schedule H1 substitute needs no witness but still lands on the register — currently refused at the funding gate', async () => {
      const body = xBody({
        inventory_item_id: h1ItemId, inventory_batch_id: h1BatchId, quantity: 3,
      });
      const remainingBefore = await batchRemaining(h1BatchId);
      const orderVersion = await orderAuthorityVersion(orderId);
      const res = await callController(body);
      await expectRefusedAtFundingGate(res, {
        orderId,
        orderVersion,
        proposedAmount: 36, // 3 units × 12
        batchId: h1BatchId,
        inventoryItemId: h1ItemId,
        remainingBefore,
      });
    });

    // Two independent roster gates now stand in front of the decrement, and this
    // test pins BOTH by exact code rather than the single one it used to pin.
    //
    // Migration 753 moved the roster check earlier: assertPharmacyFacilityGrant
    // (pharmacyFacilityAuthorityService.js:279-288) LEFT JOINs staff with
    // is_active=TRUE AND archived=FALSE and refuses when no staff row survives, so
    // an inactive dispenser is now refused by the facility-custody gate before
    // resolveAuthenticatedPerformerNameTx is ever reached. Asserting only the old
    // code would have silently stopped exercising the inactive-roster path; keeping
    // both cases is strictly stronger than the single assertion it replaces —
    // the inactive roster is still proven fatal (case 1, at an EARLIER gate) and the
    // performer-identity gate is still proven fatal on its own (case 2, reached with
    // the grant intact), and each still proves the batch was never decremented.
    test('controlled substitution rejects an inactive dispenser roster before decrement', async () => {
      const before = await prisma.$queryRawUnsafe(
        `SELECT remaining_quantity FROM pharmacy_inventory_batches WHERE id=$1`,
        h1BatchId,
      );
      const controlledBody = () => xBody({
        inventory_item_id: h1ItemId,
        inventory_batch_id: h1BatchId,
        quantity: 1,
      });
      const remaining = async () => Number((await prisma.$queryRawUnsafe(
        `SELECT remaining_quantity FROM pharmacy_inventory_batches WHERE id=$1`,
        h1BatchId,
      ))[0].remaining_quantity);

      await prisma.$executeRawUnsafe(
        `UPDATE staff SET is_active=false WHERE tenant_id=$1::uuid AND user_id=$2::uuid`,
        TENANT,
        ACTOR,
      );
      try {
        const inactiveRoster = await callController(controlledBody());
        expect(inactiveRoster.statusCode).toBe(403);
        expect(bodyCode(inactiveRoster)).toBe('PHARMACY_FACILITY_GRANT_REQUIRED');
        expect(await remaining()).toBe(Number(before[0].remaining_quantity));
      } finally {
        await prisma.$executeRawUnsafe(
          `UPDATE staff SET is_active=true WHERE tenant_id=$1::uuid AND user_id=$2::uuid`,
          TENANT,
          ACTOR,
        );
      }

      // Grant intact (active, unarchived staff row + one ACTIVE grant), but the
      // roster carries no usable performer name, which is exactly what
      // resolveAuthenticatedPerformerNameTx fails closed on.
      await prisma.$executeRawUnsafe(
        `UPDATE staff SET name='   ' WHERE tenant_id=$1::uuid AND user_id=$2::uuid`,
        TENANT,
        ACTOR,
      );
      try {
        const namelessRoster = await callController(controlledBody());
        expect(namelessRoster.statusCode).toBe(403);
        expect(bodyCode(namelessRoster)).toBe('SUBSTITUTION_PERFORMER_IDENTITY_REQUIRED');
        expect(await remaining()).toBe(Number(before[0].remaining_quantity));
      } finally {
        await prisma.$executeRawUnsafe(
          `UPDATE staff SET name=$3 WHERE tenant_id=$1::uuid AND user_id=$2::uuid`,
          TENANT,
          ACTOR,
          'Roster Substitution Pharmacist',
        );
      }
    });
  });
});
