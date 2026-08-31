// Deep tests for the pharmacist dispense-substitution READ endpoints:
//   GET /pharmacy-orders/orders/:id/dispensable          (patient + prescribed catalog lines)
//   GET /pharmacy-orders/catalog/:id/dispensable-batches (in-stock FEFO batches for a brand)
// Controller-level against the seeded QA DB (postgres superuser; explicit tenant filters).
//
// Both endpoints resolve pharmacy facility custody BEFORE they read anything, so the
// fixture seeds the real authority chain rather than bare rows — the same shape
// ipd-support-money-authz.deep.test.js seeds through helpers/medicationEvidenceFixture.js:
//   * one active default facility per tenant (resolvePharmacyFacility demands exactly one);
//   * an actor with a users row in a FACILITY_OPERATION_ROLES role, an active staff row and
//     exactly one ACTIVE pharmacy_staff_facility_grants row — assertPharmacyFacilityGrant
//     has no admin bypass, so the grant is issued through the real service command;
//   * facility custody on every stock row, plus an active storage location, because
//     migration 753 fails closed on rows without it:
//       chk_pharmacy_orders_facility_progression_753   (non-terminal order ⇒ facility_id)
//       chk_pharmacy_inventory_items_active_authority_753 (active item ⇒ facility + catalog)
//       chk_pharmacy_batches_usable_authority_753      (in_stock batch ⇒ facility)
//       enforce_pharmacy_batch_storage_authority_supply_753 (in_stock batch ⇒ active location)
//   * a real patient identity on both the order and the prescription, because
//     chk_e_prescriptions_link_identity_753 and fk_e_prescriptions_pharmacy_order_patient_753
//     bind an order-linked Rx to the order's own patient_id.
import prisma from '../lib/prisma.js';
import {
  getOrderDispensableContext, getCatalogDispensableBatches,
} from '../controllers/pharmacy/pharmacyOrderController.js';
import { grantPharmacyFacilityAuthority } from '../services/pharmacy/pharmacyFacilityAuthorityService.js';

const TENANT = '00000000-0000-4000-8000-0000d15e0002';
const OTHER = '00000000-0000-4000-8000-0000d15e0999';
const PATIENT = 'b1111111-1111-4111-8111-111111111d15';
const PHARMACIST = 'b1111111-1111-4111-8111-111111111d16';
const GRANT_ADMIN = 'b1111111-1111-4111-8111-111111111d17';
const OTHER_PHARMACIST = 'b1111111-1111-4111-8111-111111111d18';
const OTHER_GRANT_ADMIN = 'b1111111-1111-4111-8111-111111111d19';
const FIXTURE_UIDS = [PATIENT, PHARMACIST, GRANT_ADMIN, OTHER_PHARMACIST, OTHER_GRANT_ADMIN];
const FACILITY_CODE = 'DCTX-FACILITY';
const OTHER_FACILITY_CODE = 'DCTX-OTHER-FACILITY';
const FACILITY_CODES = [FACILITY_CODE, OTHER_FACILITY_CODE];
const COMP_KEY = 'dctxtest+amoxicillin+clavulanic_acid';

function mockRes() {
  return {
    statusCode: null, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}
async function call(fn, tenantId, params, actorUid) {
  const req = { tenantId, params, user: { uid: actorUid, role: 'PHARMACY_INCHARGE' } };
  const res = mockRes();
  await fn(req, res);
  return res;
}

async function seedUser(tenantId, uid, role, name, phone) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO users (uid,phone,name,role,is_active,status,is_deleted,tenant_id,updated_at) VALUES ($1::uuid,$2,$3,$4,TRUE,'active',FALSE,$5::uuid,NOW())`,
    uid, phone, name, role, tenantId,
  );
}

// One tenant's complete pharmacy custody chain: active default facility, staff
// identity for the pharmacist, and the ACTIVE grant that binds the two. The grant
// is created through grantPharmacyFacilityAuthority rather than a direct INSERT so
// the fixture exercises the same admin-authorised command the product uses.
async function seedFacilityAuthority({ tenantId, facilityCode, pharmacistUid, adminUid, label }) {
  const facilityId = Number((await prisma.$queryRawUnsafe(
    `INSERT INTO facilities (tenant_id,facility_code,display_name,status,is_default) VALUES ($1::uuid,$2,$3,'active',TRUE) RETURNING id`,
    tenantId, facilityCode, `DCTX ${label} facility`,
  ))[0].id);
  await prisma.$executeRawUnsafe(
    `INSERT INTO staff (tenant_id,user_id,employee_id,name,designation,skills,certifications,is_active,archived,created_at,updated_at) VALUES ($1::uuid,$2::uuid,$3,$4,'Pharmacist','{}'::text[],'{}'::text[],TRUE,FALSE,NOW(),NOW())`,
    tenantId, pharmacistUid, `DCTX-PHARM-${label}`, `DCTX ${label} pharmacist`,
  );
  await grantPharmacyFacilityAuthority({
    tenantId,
    facilityId,
    staffUid: pharmacistUid,
    actorUid: adminUid,
    actorRole: 'ADMIN',
    reason: 'Dispensable-context deep test pharmacy facility custody',
    commandKey: `dctx-facility-grant-${label}`,
  });
  return facilityId;
}

describe('pharmacist dispense-substitution read endpoints', () => {
  let compId; let catalogId; let orderId; let prescriptionId; let itemId; let batchNear; let batchFar;
  let facilityId; let otherFacilityId; let storageLocationId; let patientId;

  async function cleanup() {
    await prisma.$executeRawUnsafe(`DELETE FROM e_prescriptions WHERE tenant_id=$1::uuid AND patient_uid=$2::uuid`, TENANT, PATIENT).catch(() => {});
    for (const sql of [
      `DELETE FROM pharmacy_inventory_batches WHERE tenant_id=$1::uuid AND batch_number LIKE 'DCTX-%'`,
      `DELETE FROM pharmacy_inventory_items WHERE tenant_id=$1::uuid AND sku_code LIKE 'DCTX-%'`,
      `DELETE FROM pharmacy_orders WHERE tenant_id=$1::uuid AND order_note='dctx-test'`,
    ]) await prisma.$executeRawUnsafe(sql, TENANT).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM pharmacy_catalog WHERE name LIKE 'DCTXTEST %'`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM drug_compositions WHERE composition_key=$1`, COMP_KEY).catch(() => {});
    // Custody teardown, after everything that references a facility is gone.
    // pharmacy_staff_facility_grant_events is append-only (migration 753's
    // trg_pharmacy_staff_facility_grant_events_append_only_753), so the fixture
    // drops its own rows under session_replication_role='replica' exactly the way
    // ipd-support-money-authz.deep.test.js does — the guard stays live everywhere else.
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'replica'");
      await tx.$executeRawUnsafe(
        `DELETE FROM pharmacy_staff_facility_grant_events WHERE grant_id IN (SELECT id FROM pharmacy_staff_facility_grants WHERE staff_uid = ANY($1::uuid[]))`,
        FIXTURE_UIDS,
      );
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'origin'");
      await tx.$executeRawUnsafe(`DELETE FROM pharmacy_staff_facility_grants WHERE staff_uid = ANY($1::uuid[])`, FIXTURE_UIDS);
      await tx.$executeRawUnsafe(`DELETE FROM staff WHERE user_id = ANY($1::uuid[])`, FIXTURE_UIDS);
      await tx.$executeRawUnsafe(`DELETE FROM facility_locations WHERE facility_id IN (SELECT id FROM facilities WHERE facility_code = ANY($1::text[]))`, FACILITY_CODES);
      await tx.$executeRawUnsafe(`DELETE FROM facilities WHERE facility_code = ANY($1::text[])`, FACILITY_CODES);
      await tx.$executeRawUnsafe(`DELETE FROM users WHERE uid = ANY($1::uuid[])`, FIXTURE_UIDS);
    });
  }

  beforeAll(async () => {
    await cleanup();
    await prisma.$executeRawUnsafe(`INSERT INTO tenants (id,slug,name,region,status,created_at,updated_at) VALUES ($1::uuid,'dctx-test','DCTX','IN','active',NOW(),NOW()) ON CONFLICT (id) DO NOTHING`, TENANT);
    await prisma.$executeRawUnsafe(`INSERT INTO tenants (id,slug,name,region,status,created_at,updated_at) VALUES ($1::uuid,'dctx-other','DCTX Other','IN','active',NOW(),NOW()) ON CONFLICT (id) DO NOTHING`, OTHER);
    await seedUser(TENANT, PATIENT, 'PATIENT', 'DCTX Patient', '9000000015');
    await seedUser(TENANT, PHARMACIST, 'PHARMACY_INCHARGE', 'DCTX Pharmacist', '9000000016');
    await seedUser(TENANT, GRANT_ADMIN, 'ADMIN', 'DCTX Grant Admin', '9000000017');
    await seedUser(OTHER, OTHER_PHARMACIST, 'PHARMACY_INCHARGE', 'DCTX Other Pharmacist', '9000000018');
    await seedUser(OTHER, OTHER_GRANT_ADMIN, 'ADMIN', 'DCTX Other Grant Admin', '9000000019');
    patientId = Number((await prisma.$queryRawUnsafe(`SELECT id FROM users WHERE tenant_id=$1::uuid AND uid=$2::uuid`, TENANT, PATIENT))[0].id);
    facilityId = await seedFacilityAuthority({
      tenantId: TENANT, facilityCode: FACILITY_CODE, pharmacistUid: PHARMACIST, adminUid: GRANT_ADMIN, label: 'primary',
    });
    // The foreign tenant gets the identical chain so the isolation test below
    // exercises the tenant predicates instead of bouncing off missing custody.
    otherFacilityId = await seedFacilityAuthority({
      tenantId: OTHER, facilityCode: OTHER_FACILITY_CODE, pharmacistUid: OTHER_PHARMACIST, adminUid: OTHER_GRANT_ADMIN, label: 'foreign',
    });
    storageLocationId = Number((await prisma.$queryRawUnsafe(`INSERT INTO facility_locations (tenant_id,facility_id,location_code,display_name,location_kind,status) VALUES ($1::uuid,$2::int,'DCTX-STORE','DCTX pharmacy store','pharmacy','active') RETURNING id`, TENANT, facilityId))[0].id);
    compId = Number((await prisma.$queryRawUnsafe(`INSERT INTO drug_compositions (composition_key,display_label,active_ingredients,source) VALUES ($1,'Amox+Clav',ARRAY['amoxicillin','clavulanic_acid'],'curated') RETURNING id`, COMP_KEY))[0].id);
    catalogId = Number((await prisma.$queryRawUnsafe(`INSERT INTO pharmacy_catalog (name,generic_name,manufacturer,is_active,tenant_id,composition_id,strength,strength_key,form,form_key,composition_confidence,updated_at) VALUES ('DCTXTEST Clavam 625','Amoxicillin + Clavulanic acid','Alkem',TRUE,$1::uuid,$2,'625 mg','625mg','tablet','tablet','high',NOW()) RETURNING id`, TENANT, compId))[0].id);
    // items_list carries the prescription-bound line identity the controller
    // demands (order_line_index / prescription_line_index / catalog_id); an order
    // whose lines cannot be traced back to the Rx is answered 409, not 200.
    orderId = Number((await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_orders (phone,order_note,status,tenant_id,facility_id,patient_id,authority_origin,items_list,updated_at) VALUES ('9999999999','dctx-test','CONFIRMED',$1::uuid,$2::int,$3::int,'e_prescription',$4::jsonb,NOW()) RETURNING id`,
      TENANT, facilityId, patientId,
      JSON.stringify([{
        order_line_index: 0, prescription_line_index: 0, catalog_id: catalogId, name: 'Clavam 625',
      }]),
    ))[0].id);
    const prescriptionRows = await prisma.$queryRawUnsafe(
      `INSERT INTO e_prescriptions (pharmacy_order_id,patient_id,patient_uid,medications,status,tenant_id,created_at,updated_at) VALUES ($1::int,$2::int,$3::uuid,$4::jsonb,'active',$5::uuid,NOW(),NOW()) RETURNING id`,
      orderId, patientId, PATIENT, JSON.stringify([{ catalog_id: catalogId, name: 'Clavam 625', quantity: 10 }]), TENANT,
    );
    prescriptionId = Number(prescriptionRows[0].id);
    itemId = Number((await prisma.$queryRawUnsafe(`INSERT INTO pharmacy_inventory_items (tenant_id,facility_id,sku_code,display_name,catalog_id,composition_id) VALUES ($1::uuid,$2::int,'DCTX-SKU-1','Clavam 625',$3,$4) RETURNING id`, TENANT, facilityId, catalogId, compId))[0].id);
    batchNear = Number((await prisma.$queryRawUnsafe(`INSERT INTO pharmacy_inventory_batches (tenant_id,inventory_item_id,facility_id,storage_location_id,batch_number,expiry_date,received_quantity,remaining_quantity,status) VALUES ($1::uuid,$2,$3::int,$4::int,'DCTX-NEAR',(NOW()+INTERVAL '30 days')::date,50,50,'in_stock') RETURNING id`, TENANT, itemId, facilityId, storageLocationId))[0].id);
    batchFar = Number((await prisma.$queryRawUnsafe(`INSERT INTO pharmacy_inventory_batches (tenant_id,inventory_item_id,facility_id,storage_location_id,batch_number,expiry_date,received_quantity,remaining_quantity,status) VALUES ($1::uuid,$2,$3::int,$4::int,'DCTX-FAR',(NOW()+INTERVAL '365 days')::date,100,100,'in_stock') RETURNING id`, TENANT, itemId, facilityId, storageLocationId))[0].id);
    // excluded: expired (past date) + depleted (remaining 0)
    await prisma.$executeRawUnsafe(`INSERT INTO pharmacy_inventory_batches (tenant_id,inventory_item_id,facility_id,storage_location_id,batch_number,expiry_date,received_quantity,remaining_quantity,status) VALUES ($1::uuid,$2,$3::int,$4::int,'DCTX-EXPIRED',(NOW()-INTERVAL '1 day')::date,20,20,'in_stock')`, TENANT, itemId, facilityId, storageLocationId);
    await prisma.$executeRawUnsafe(`INSERT INTO pharmacy_inventory_batches (tenant_id,inventory_item_id,facility_id,storage_location_id,batch_number,expiry_date,received_quantity,remaining_quantity,status) VALUES ($1::uuid,$2,$3::int,$4::int,'DCTX-DEPLETED',(NOW()+INTERVAL '90 days')::date,10,0,'in_stock')`, TENANT, itemId, facilityId, storageLocationId);
    // cleanup() sweeps this fixture out of a shared database. On an isolated
    // clone it finds nothing and returns instantly, but a whole shard of suites
    // runs sequentially against ONE database, so by the time this one starts the
    // sweep has real work to do. CI survives that only because run-ci-jest passes
    // --testTimeout=60000, which jest applies to hooks as well; a plain local
    // `jest` run gets the 5s default and fails the suite with every test still
    // passing. Budget the hook explicitly so it does not depend on the runner.
  }, 120_000);

  afterAll(async () => {
    await cleanup();
    if (typeof prisma.$disconnect === 'function') await prisma.$disconnect();
    // Budgeted for the same reason as beforeAll below.
  }, 120_000);

  test('orders/:id/dispensable → patient_uid + prescribed catalog lines', async () => {
    const res = await call(getOrderDispensableContext, TENANT, { id: String(orderId) }, PHARMACIST);
    expect(res.statusCode).toBe(200);
    expect(res.body.data.patient_uid).toBe(PATIENT);
    expect(res.body.data.prescription_id).toBe(prescriptionId);
    expect(res.body.data.facility_id).toBe(facilityId);
    expect(res.body.data.lines).toHaveLength(1);
    expect(res.body.data.lines[0].prescription_id).toBe(prescriptionId);
    expect(res.body.data.lines[0].catalog_id).toBe(catalogId);
    expect(res.body.data.lines[0].quantity).toBe(10);
  });

  test('catalog/:id/dispensable-batches → in-stock, non-expired, non-empty batches, FEFO', async () => {
    const res = await call(getCatalogDispensableBatches, TENANT, { id: String(catalogId) }, PHARMACIST);
    expect(res.statusCode).toBe(200);
    const { batches } = res.body.data;
    expect(res.body.data.facility_id).toBe(facilityId);
    expect(batches).toHaveLength(2);                          // expired + depleted excluded
    expect(batches[0].inventory_batch_id).toBe(batchNear);   // FEFO: nearest expiry first
    expect(batches[1].inventory_batch_id).toBe(batchFar);
    expect(batches[0].inventory_item_id).toBe(itemId);
    expect(batches.every((b) => !['DCTX-EXPIRED', 'DCTX-DEPLETED'].includes(b.batch_number))).toBe(true);
  });

  test('a foreign tenant sees no context and no batches', async () => {
    // The foreign pharmacist holds full custody of their OWN facility, so both
    // calls get past the authority gate and are decided by the tenant predicates.
    //
    // The order read now REFUSES with 404 rather than answering an empty envelope:
    // resolveOrderPharmacyFacility probes for the order under the caller's tenant
    // only, so a foreign order id is indistinguishable from an unknown one. That is
    // strictly stronger than the old `lines: []` expectation — it proves the
    // endpoint emits no payload at all, not merely an empty one, and pins the
    // refusal to the non-disclosing 404 instead of a shape that would also be
    // satisfied by a 409 leaking the order's existence.
    const ctx = await call(getOrderDispensableContext, OTHER, { id: String(orderId) }, OTHER_PHARMACIST);
    expect(ctx.statusCode).toBe(404);
    expect(ctx.body.success).toBe(false);
    expect(ctx.body.code).toBe('NOT_FOUND');
    expect(ctx.body.data).toBeUndefined();
    const bat = await call(getCatalogDispensableBatches, OTHER, { id: String(catalogId) }, OTHER_PHARMACIST);
    expect(bat.statusCode).toBe(200);
    expect(bat.body.data.facility_id).toBe(otherFacilityId);
    expect(bat.body.data.batches).toHaveLength(0);
  });
});
