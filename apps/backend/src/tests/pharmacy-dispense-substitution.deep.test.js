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
import prisma from '../lib/prisma.js';
import {
  dispenseSubstitution,
  requestSubstitutionWitnessApproval,
  approveSubstitutionWitnessApproval,
} from '../controllers/pharmacy/pharmacyOrderController.js';

const TENANT = '00000000-0000-4000-8000-0000d15e0001';
const PATIENT = 'a1111111-1111-4111-8111-111111111d15';
const ACTOR = 'a2222222-2222-4222-8222-222222222d15';
const WITNESS = 'a3333333-3333-4333-8333-333333333d15';
const CLERK = 'a4444444-4444-4444-8444-444444444d15';
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
async function callController(body) {
  const req = { tenantId: TENANT, user: { uid: ACTOR, role: 'PHARMACY_INCHARGE' }, id: 'req-dsub', body };
  const res = mockRes();
  await dispenseSubstitution(req, res);
  return res;
}

describe('dispenseSubstitution — atomic decrement + canonical events + equivalence gate', () => {
  let compId; let origId; let subId; let diffId; let itemId; let batchId;
  let xItemId; let xBatchId; let h1ItemId; let h1BatchId;

  async function cleanup() {
    for (const sql of [
      `DELETE FROM pharmacy_schedule_register WHERE tenant_id=$1::uuid`,
      `DELETE FROM pharmacy_stock_movements WHERE tenant_id=$1::uuid AND reference_type IN ('dispense_substitution', 'controlled_dispense')`,
      `DELETE FROM approvals WHERE tenant_id=$1::uuid AND approval_kind='controlled_dispense_witness'`,
      `DELETE FROM pharmacy_inventory_batches WHERE tenant_id=$1::uuid AND batch_number LIKE 'DSUB-%'`,
      `DELETE FROM pharmacy_inventory_items WHERE tenant_id=$1::uuid AND sku_code LIKE 'DSUB-%'`,
      `DELETE FROM clinical_timeline_events WHERE tenant_id=$1::uuid`,
      `DELETE FROM clinical_audit_events WHERE tenant_id=$1::uuid`,
    ]) await prisma.$executeRawUnsafe(sql, TENANT).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM pharmacy_catalog WHERE name LIKE 'DSUBTEST %'`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM drug_compositions WHERE composition_key=$1`, COMP_KEY).catch(() => {});
    // Deliberate single array binds for ANY($1::uuid[]) — hoisted per house style.
    const staffFixtureUids = [ACTOR, WITNESS, CLERK];
    const userFixtureUids = [ACTOR, WITNESS, CLERK, PATIENT];
    await prisma.$executeRawUnsafe(
      `DELETE FROM staff WHERE user_id = ANY($1::uuid[])`, staffFixtureUids,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM users WHERE uid = ANY($1::uuid[])`, userFixtureUids,
    ).catch(() => {});
  }

  async function seedCatalog(name, { strengthKey, strengthComponents, manufacturer }) {
    const r = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_catalog
         (name, generic_name, manufacturer, is_active, tenant_id, composition_id, strength,
          strength_key, strength_components, form, form_key, release_key, route,
          composition_confidence, updated_at)
       VALUES ($1,'Amoxicillin + Clavulanic acid',$2,TRUE,$3::uuid,$4,$5,$5,$6::jsonb,
               'tablet','tablet',NULL,NULL,'high',NOW())
       RETURNING id`,
      name, manufacturer, TENANT, compId, strengthKey, strengthComponents,
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
    const cr = await prisma.$queryRawUnsafe(
      `INSERT INTO drug_compositions (composition_key, display_label, active_ingredients, source)
       VALUES ($1,'Amox+Clav',ARRAY['amoxicillin','clavulanic_acid'],'curated') RETURNING id`,
      COMP_KEY,
    );
    compId = Number(cr[0].id);
    origId = await seedCatalog('DSUBTEST Augmentin 625', { strengthKey: '625mg', strengthComponents: combo, manufacturer: 'GSK' });
    subId = await seedCatalog('DSUBTEST Clavam 625', { strengthKey: '625mg', strengthComponents: combo, manufacturer: 'Alkem' });
    diffId = await seedCatalog('DSUBTEST Clavam 375', {
      strengthKey: '375mg',
      strengthComponents: JSON.stringify([
        { ingredient: 'amoxicillin', amount: 250, unit: 'mg' },
        { ingredient: 'clavulanic_acid', amount: 125, unit: 'mg' },
      ]),
      manufacturer: 'Alkem',
    });
    const it = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_inventory_items (tenant_id, sku_code, display_name, catalog_id, composition_id)
       VALUES ($1::uuid,'DSUB-SKU-1','Clavam 625',$2,$3) RETURNING id`,
      TENANT, subId, compId,
    );
    itemId = Number(it[0].id);
    const b = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_inventory_batches
         (tenant_id, inventory_item_id, batch_number, expiry_date, received_quantity, remaining_quantity, status)
       VALUES ($1::uuid,$2,'DSUB-B1',(NOW() + INTERVAL '365 days')::date,100,100,'in_stock') RETURNING id`,
      TENANT, itemId,
    );
    batchId = Number(b[0].id);

    // Controlled fixtures: a Schedule X narcotic brand and a Schedule H1 brand
    // of the SAME composition (so the equivalence gate passes and the schedule
    // gate is the only variable under test).
    const xi = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_inventory_items
         (tenant_id, sku_code, display_name, catalog_id, composition_id, schedule_class, is_narcotic)
       VALUES ($1::uuid,'DSUB-SKU-X','Clavam 625 CX',$2,$3,'X',true) RETURNING id`,
      TENANT, subId, compId,
    );
    xItemId = Number(xi[0].id);
    const xb = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_inventory_batches
         (tenant_id, inventory_item_id, batch_number, expiry_date, received_quantity, remaining_quantity, status)
       VALUES ($1::uuid,$2,'DSUB-BX',(NOW() + INTERVAL '365 days')::date,40,40,'in_stock') RETURNING id`,
      TENANT, xItemId,
    );
    xBatchId = Number(xb[0].id);
    const h1i = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_inventory_items
         (tenant_id, sku_code, display_name, catalog_id, composition_id, schedule_class, is_narcotic)
       VALUES ($1::uuid,'DSUB-SKU-H1','Clavam 625 CH1',$2,$3,'H1',false) RETURNING id`,
      TENANT, subId, compId,
    );
    h1ItemId = Number(h1i[0].id);
    const h1b = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_inventory_batches
         (tenant_id, inventory_item_id, batch_number, expiry_date, received_quantity, remaining_quantity, status)
       VALUES ($1::uuid,$2,'DSUB-BH1',(NOW() + INTERVAL '365 days')::date,40,40,'in_stock') RETURNING id`,
      TENANT, h1ItemId,
    );
    h1BatchId = Number(h1b[0].id);

    // Roster: the dispenser + patient + an eligible independent witness + an
    // ineligible clerk (role gate probe).
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, name, phone, role, tenant_id, updated_at)
       VALUES
         ($1::uuid, 'Substitution Patient', '9812345699', 'PATIENT', $5::uuid, NOW()),
         ($2::uuid, 'Substitution Pharmacist', NULL, 'PHARMACY_INCHARGE', $5::uuid, NOW()),
         ($3::uuid, 'Substitution Witness', NULL, 'PHARMACY_STAFF', $5::uuid, NOW()),
         ($4::uuid, 'Substitution Clerk', NULL, 'RECEPTIONIST', $5::uuid, NOW())
       ON CONFLICT (uid) DO NOTHING`,
      PATIENT, ACTOR, WITNESS, CLERK, TENANT,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO staff (user_id, employee_id, name, is_active, archived, tenant_id, updated_at)
       VALUES
         ($1::uuid, 'DSUB-ACTOR', 'Roster Substitution Pharmacist', true, false, $4::uuid, NOW()),
         ($2::uuid, 'DSUB-WITNESS', 'Roster Substitution Witness', true, false, $4::uuid, NOW()),
         ($3::uuid, 'DSUB-CLERK', 'Roster Substitution Clerk', true, false, $4::uuid, NOW())`,
      ACTOR, WITNESS, CLERK, TENANT,
    );
  });

  afterAll(async () => {
    await cleanup();
    if (typeof prisma.$disconnect === 'function') await prisma.$disconnect();
  });

  test('dispenses an equivalent substitute: decrements batch + movement + canonical pair', async () => {
    const res = await callController({
      patient_uid: PATIENT, inventory_item_id: itemId, inventory_batch_id: batchId,
      quantity: 10, original_catalog_id: origId, final_catalog_id: subId,
      reason: 'prescribed brand out of stock',
    });
    expect(res.statusCode).toBe(200);
    expect(res.body?.success).toBe(true);

    const bat = await prisma.$queryRawUnsafe(`SELECT remaining_quantity, status FROM pharmacy_inventory_batches WHERE id=$1`, batchId);
    expect(Number(bat[0].remaining_quantity)).toBe(90);           // 100 - 10, atomic
    expect(bat[0].status).toBe('in_stock');

    const mv = await prisma.$queryRawUnsafe(
      `SELECT * FROM pharmacy_stock_movements WHERE tenant_id=$1::uuid AND inventory_batch_id=$2 AND reference_type='dispense_substitution'`,
      TENANT, batchId,
    );
    expect(mv.length).toBe(1);
    expect(Number(mv[0].quantity_delta)).toBe(-10);

    // canonical pair committed in the same tx (a 200 + decrement already implies it, but assert explicitly)
    const tl = await prisma.$queryRawUnsafe(`SELECT COUNT(*)::int AS n FROM clinical_timeline_events WHERE tenant_id=$1::uuid`, TENANT);
    const au = await prisma.$queryRawUnsafe(`SELECT COUNT(*)::int AS n FROM clinical_audit_events WHERE tenant_id=$1::uuid`, TENANT);
    expect(tl[0].n).toBeGreaterThanOrEqual(1);
    expect(au[0].n).toBeGreaterThanOrEqual(1);
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

  test('rejects insufficient stock atomically', async () => {
    const before = await prisma.$queryRawUnsafe(`SELECT remaining_quantity FROM pharmacy_inventory_batches WHERE id=$1`, batchId);
    const res = await callController({
      patient_uid: PATIENT, inventory_item_id: itemId, inventory_batch_id: batchId,
      quantity: 100000, original_catalog_id: origId, final_catalog_id: subId,
    });
    expect(res.statusCode).toBe(400);
    const after = await prisma.$queryRawUnsafe(`SELECT remaining_quantity FROM pharmacy_inventory_batches WHERE id=$1`, batchId);
    expect(Number(after[0].remaining_quantity)).toBe(Number(before[0].remaining_quantity));
  });

  describe('controlled substitutes route through the statutory register (STAFF F1)', () => {
    const xBody = (overrides = {}) => ({
      patient_uid: PATIENT,
      inventory_item_id: xItemId,
      inventory_batch_id: xBatchId,
      quantity: 4,
      original_catalog_id: origId,
      final_catalog_id: subId,
      reason: 'x substitute',
      ...overrides,
    });

    const bodyCode = (res) => res.body?.code ?? res.body?.details?.code ?? null;

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

    test('a bogus witness_approval_id also fails closed with stock untouched', async () => {
      const before = await prisma.$queryRawUnsafe(`SELECT remaining_quantity FROM pharmacy_inventory_batches WHERE id=$1`, xBatchId);
      const res = await callController(xBody({ witness_approval_id: '999999999' }));
      expect(res.statusCode).toBe(404);
      const after = await prisma.$queryRawUnsafe(`SELECT remaining_quantity FROM pharmacy_inventory_batches WHERE id=$1`, xBatchId);
      expect(Number(after[0].remaining_quantity)).toBe(Number(before[0].remaining_quantity));
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

    test('witnessed Schedule X substitute: decrement + movement + register row + consumed approval + canonical pair in ONE tx', async () => {
      const body = xBody();
      const approval = await requestSubstitutionWitnessApproval({
        tenantId: TENANT, requested_by: ACTOR, ...body,
      });
      await approveSubstitutionWitnessApproval({
        approvalId: approval.id,
        actorUid: WITNESS,
        substitution: { tenantId: TENANT, ...body },
      });

      const res = await callController({ ...body, witness_approval_id: approval.id });
      expect(res.statusCode).toBe(200);
      expect(res.body?.success).toBe(true);
      expect(res.body?.data?.schedule_class).toBe('X');
      expect(res.body?.data?.register_entry_id).toEqual(expect.any(Number));

      const bat = await prisma.$queryRawUnsafe(`SELECT remaining_quantity FROM pharmacy_inventory_batches WHERE id=$1`, xBatchId);
      expect(Number(bat[0].remaining_quantity)).toBe(36); // 40 - 4, atomic

      const mv = await prisma.$queryRawUnsafe(
        `SELECT movement_kind, quantity_delta, reference_type, reference_id
           FROM pharmacy_stock_movements
          WHERE tenant_id=$1::uuid AND inventory_item_id=$2::int`,
        TENANT, xItemId,
      );
      expect(mv).toHaveLength(1);
      expect(mv[0].movement_kind).toBe('issue');
      expect(Number(mv[0].quantity_delta)).toBe(-4);
      expect(mv[0].reference_type).toBe('controlled_dispense');
      expect(mv[0].reference_id).toBe(`dispense-substitution-${subId}`);

      // The statutory register row: schedule, quantities, patient identity
      // snapshot, dispenser + CANONICAL roster witness — same contract as the
      // controlled-dispense and counter-sale paths.
      const reg = await prisma.$queryRawUnsafe(
        `SELECT schedule_class, movement_kind, quantity, running_balance,
                patient_uid, patient_name, performed_by, performed_by_name,
                witness_uid, witness_name
           FROM pharmacy_schedule_register
          WHERE tenant_id=$1::uuid AND inventory_item_id=$2::int`,
        TENANT, xItemId,
      );
      expect(reg).toHaveLength(1);
      expect(reg[0].schedule_class).toBe('X');
      expect(reg[0].movement_kind).toBe('dispense');
      expect(Number(reg[0].quantity)).toBe(4);
      expect(Number(reg[0].running_balance)).toBe(36);
      expect(String(reg[0].patient_uid)).toBe(PATIENT);
      expect(reg[0].patient_name).toBe('Substitution Patient');
      expect(String(reg[0].performed_by)).toBe(ACTOR);
      expect(reg[0].performed_by_name).toBe('Roster Substitution Pharmacist');
      expect(String(reg[0].witness_uid)).toBe(WITNESS);
      expect(reg[0].witness_name).toBe('Roster Substitution Witness');

      // The approval is consumed in the same tx — a replay fails closed with
      // stock untouched.
      const replay = await callController({ ...body, witness_approval_id: approval.id });
      expect(replay.statusCode).toBe(409);
      expect(bodyCode(replay)).toBe('CONTROLLED_DISPENSE_WITNESS_APPROVAL_CONSUMED');
      const batAfterReplay = await prisma.$queryRawUnsafe(`SELECT remaining_quantity FROM pharmacy_inventory_batches WHERE id=$1`, xBatchId);
      expect(Number(batAfterReplay[0].remaining_quantity)).toBe(36);

      // Canonical pair for the substitution movement committed in the tx.
      const tl = await prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS n FROM clinical_timeline_events
          WHERE tenant_id=$1::uuid AND event_type='pharmacy.dispense_substitution'`,
        TENANT,
      );
      expect(tl[0].n).toBeGreaterThanOrEqual(1);
    });

    test('Schedule H1 substitute needs no witness but still lands on the register', async () => {
      const body = xBody({
        inventory_item_id: h1ItemId, inventory_batch_id: h1BatchId, quantity: 3,
      });
      const res = await callController(body);
      expect(res.statusCode).toBe(200);
      expect(res.body?.data?.schedule_class).toBe('H1');

      const bat = await prisma.$queryRawUnsafe(`SELECT remaining_quantity FROM pharmacy_inventory_batches WHERE id=$1`, h1BatchId);
      expect(Number(bat[0].remaining_quantity)).toBe(37); // 40 - 3

      const reg = await prisma.$queryRawUnsafe(
        `SELECT schedule_class, witness_uid, witness_name, patient_name
           FROM pharmacy_schedule_register
          WHERE tenant_id=$1::uuid AND inventory_item_id=$2::int`,
        TENANT, h1ItemId,
      );
      expect(reg).toHaveLength(1);
      expect(reg[0].schedule_class).toBe('H1');
      expect(reg[0].witness_uid).toBeNull();
      expect(reg[0].patient_name).toBe('Substitution Patient');
    });
  });
});
