// Deep integration test for the controlled-stock guard on the generic pharmacy
// movements path (2026-08-25 reaudit BC-H1 / BC-M1).
//
// The generic POST /pharmacy/inventory/v2/movements → inventoryV2Service
// .recordMovement used to decrement Schedule X / narcotic stock with no
// statutory pharmacy_schedule_register row and no witness — the last open
// controlled-dispense register bypass. These tests prove, against a real DB:
//   - a controlled ISSUE is refused (409) and steered to /controlled-dispense;
//     stock is untouched and no register row is written;
//   - a Schedule X decrement WITHOUT a witness is refused (400); stock untouched;
//   - a Schedule X dispose WITH a witness decrements the batch AND writes one
//     pharmacy_schedule_register 'dispose' row in the same tx;
//   - a Schedule H1 receipt writes a 'receive' register row (no witness) — BC-M1;
//   - a non-controlled issue decrements with NO register row (unchanged).
//
// Seeds/connects as the jest.setup superuser (RLS bypassed); the service's own
// explicit tenant filters still apply.
import prisma from '../lib/prisma.js';
import { recordMovement } from '../services/pharmacy/inventoryV2Service.js';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

const TENANT = '00000000-0000-4000-8000-0000c07701e1';
const ACTOR = 'c0770000-0000-4000-8000-0000000000a1';
const WITNESS = 'c0770000-0000-4000-8000-0000000000a2';

describeIfDb('recordMovement controlled-stock register guard', () => {
  let xItemId; let xBatchId;
  let h1ItemId; let h1BatchId;
  let otcItemId; let otcBatchId;

  async function cleanup() {
    for (const sql of [
      `DELETE FROM pharmacy_schedule_register WHERE tenant_id=$1::uuid`,
      `DELETE FROM pharmacy_stock_movements WHERE tenant_id=$1::uuid`,
      `DELETE FROM pharmacy_inventory_batches WHERE tenant_id=$1::uuid AND batch_number LIKE 'CMOV-%'`,
      `DELETE FROM pharmacy_inventory_items WHERE tenant_id=$1::uuid AND sku_code LIKE 'CMOV-%'`,
    ]) await prisma.$executeRawUnsafe(sql, TENANT).catch(() => {});
  }

  async function seedItem(sku, name, { schedule_class = null, is_narcotic = false }) {
    const it = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_inventory_items
         (tenant_id, sku_code, display_name, unit_label, schedule_class, is_narcotic)
       VALUES ($1::uuid,$2,$3,'unit',$4,$5) RETURNING id`,
      TENANT, sku, name, schedule_class, is_narcotic,
    );
    const id = Number(it[0].id);
    const b = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_inventory_batches
         (tenant_id, inventory_item_id, batch_number, expiry_date, received_quantity, remaining_quantity, status)
       VALUES ($1::uuid,$2,$3,(NOW() + INTERVAL '365 days')::date,100,100,'in_stock') RETURNING id`,
      TENANT, id, `CMOV-B-${sku}`,
    );
    return { id, batchId: Number(b[0].id) };
  }

  beforeAll(async () => {
    await cleanup();
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name, region, status, created_at, updated_at)
       VALUES ($1::uuid,'cmov-test','CMOV','IN','active',NOW(),NOW()) ON CONFLICT (id) DO NOTHING`,
      TENANT,
    );
    ({ id: xItemId, batchId: xBatchId } = await seedItem('CMOV-X', 'Morphine 10mg', { schedule_class: 'X', is_narcotic: true }));
    ({ id: h1ItemId, batchId: h1BatchId } = await seedItem('CMOV-H1', 'Alprazolam 0.5mg', { schedule_class: 'H1' }));
    ({ id: otcItemId, batchId: otcBatchId } = await seedItem('CMOV-OTC', 'Paracetamol 500mg', { schedule_class: 'OTC' }));
  });

  afterAll(async () => {
    await cleanup();
    if (typeof prisma.$disconnect === 'function') await prisma.$disconnect();
  });

  const remaining = async (batchId) => {
    const r = await prisma.$queryRawUnsafe(`SELECT remaining_quantity FROM pharmacy_inventory_batches WHERE id=$1`, batchId);
    return Number(r[0].remaining_quantity);
  };
  const registerRows = async (itemId) => prisma.$queryRawUnsafe(
    `SELECT movement_kind, quantity, schedule_class, witness_uid FROM pharmacy_schedule_register WHERE tenant_id=$1::uuid AND inventory_item_id=$2 ORDER BY id`,
    TENANT, itemId,
  );

  test('controlled ISSUE is refused and steered to /controlled-dispense; stock + register untouched', async () => {
    await expect(recordMovement({
      tenantId: TENANT, inventory_item_id: xItemId, inventory_batch_id: xBatchId,
      movement_kind: 'issue', quantity: 10, performed_by: ACTOR,
    })).rejects.toMatchObject({ code: 'CONTROLLED_MOVEMENT_REQUIRES_DISPENSE_PATH' });
    expect(await remaining(xBatchId)).toBe(100);
    expect(await registerRows(xItemId)).toHaveLength(0);
  });

  test('Schedule X decrement without a witness is refused; stock untouched', async () => {
    await expect(recordMovement({
      tenantId: TENANT, inventory_item_id: xItemId, inventory_batch_id: xBatchId,
      movement_kind: 'adjust_decrease', quantity: 5, performed_by: ACTOR,
    })).rejects.toMatchObject({ code: 'CONTROLLED_MOVEMENT_WITNESS_REQUIRED' });
    expect(await remaining(xBatchId)).toBe(100);
    expect(await registerRows(xItemId)).toHaveLength(0);
  });

  test('Schedule X dispose WITH a witness decrements and writes one register dispose row (same tx)', async () => {
    const res = await recordMovement({
      tenantId: TENANT, inventory_item_id: xItemId, inventory_batch_id: xBatchId,
      movement_kind: 'dispose', quantity: 4, performed_by: ACTOR,
      witness_uid: WITNESS, witness_name: 'Witness Nurse',
    });
    expect(res.register_entry).toBeTruthy();
    expect(await remaining(xBatchId)).toBe(96);
    const reg = await registerRows(xItemId);
    expect(reg).toHaveLength(1);
    expect(reg[0].movement_kind).toBe('dispose');
    expect(reg[0].witness_uid).toBe(WITNESS);
  });

  test('Schedule H1 receipt writes a receive register row without a witness (BC-M1)', async () => {
    await recordMovement({
      tenantId: TENANT, inventory_item_id: h1ItemId, inventory_batch_id: h1BatchId,
      movement_kind: 'receive', quantity: 20, performed_by: ACTOR,
    });
    expect(await remaining(h1BatchId)).toBe(120);
    const reg = await registerRows(h1ItemId);
    expect(reg).toHaveLength(1);
    expect(reg[0].movement_kind).toBe('receive');
  });

  test('non-controlled issue decrements with no register row (unchanged behaviour)', async () => {
    await recordMovement({
      tenantId: TENANT, inventory_item_id: otcItemId, inventory_batch_id: otcBatchId,
      movement_kind: 'issue', quantity: 10, performed_by: ACTOR,
    });
    expect(await remaining(otcBatchId)).toBe(90);
    expect(await registerRows(otcItemId)).toHaveLength(0);
  });
});
