// Deep integration test for the ward-indent controlled-stock block
// (2026-08-25 reaudit BC-M3).
//
// issueWardIndent decrements the schedule-blind legacy pharmacy_catalog ledger,
// which has no schedule/narcotic/witness/batch modelling. A Schedule H1 / X or
// narcotic drug stocked there would otherwise issue to a ward with no statutory
// register entry. The guard detects controlled items through the inventory-v2
// items that link back to the catalog row (catalog_id) and blocks the whole
// issue before any decrement, steering the controlled lines to the witnessed
// inventory-v2 flow. Schedule H is left issuable (register-recommended, not
// mandatory) when it has a same-tenant inventory classification. Positive
// free-text and unlinked catalog lines fail closed as unresolved.
import prisma from '../lib/prisma.js';
import { issueWardIndent } from '../services/ipd/ipdSupportService.js';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

const TENANT = '00000000-0000-4000-8000-0000c07b10c3';
const ACTOR = 'c07b0000-0000-4000-8000-0000000000b1';

describeIfDb('issueWardIndent controlled-item block', () => {
  let ctrlCatalogId; let plainCatalogId; let unlinkedCatalogId;
  let ctrlIndentId; let plainIndentId; let unlinkedIndentId; let freeTextIndentId;

  async function cleanup() {
    await prisma.$executeRawUnsafe(`DELETE FROM ward_indent_items WHERE tenant_id=$1::uuid`, TENANT).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM ward_indents WHERE tenant_id=$1::uuid`, TENANT).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM pharmacy_inventory_items WHERE tenant_id=$1::uuid AND sku_code LIKE 'WIND-%'`, TENANT).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM pharmacy_catalog WHERE tenant_id=$1::uuid AND name LIKE 'WINDTEST %'`, TENANT).catch(() => {});
  }

  async function seedCatalog(name) {
    const r = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_catalog (name, is_active, tenant_id, stock_quantity, updated_at)
       VALUES ($1, TRUE, $2::uuid, 100, NOW()) RETURNING id`,
      name, TENANT,
    );
    return Number(r[0].id);
  }

  async function linkInventoryItem(sku, catalogId, { schedule_class = null, is_narcotic = false }) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO pharmacy_inventory_items
         (tenant_id, sku_code, display_name, catalog_id, schedule_class, is_narcotic)
       VALUES ($1::uuid, $2, $2, $3, $4, $5)`,
      TENANT, sku, catalogId, schedule_class, is_narcotic,
    );
  }

  async function seedApprovedIndent(number, catalogId) {
    const ind = await prisma.$queryRawUnsafe(
      `INSERT INTO ward_indents (tenant_id, indent_number, requested_by, approved_by, status, created_at, updated_at)
       VALUES ($1::uuid, $2, $3::uuid, $3::uuid, 'approved', NOW(), NOW()) RETURNING id`,
      TENANT, number, ACTOR,
    );
    const indentId = Number(ind[0].id);
    const item = await prisma.$queryRawUnsafe(
      `INSERT INTO ward_indent_items (tenant_id, ward_indent_id, pharmacy_catalog_id, item_name, quantity_requested)
       VALUES ($1::uuid, $2, $3, 'Test item', 5) RETURNING id`,
      TENANT, indentId, catalogId,
    );
    return { indentId, itemId: Number(item[0].id) };
  }

  beforeAll(async () => {
    await cleanup();
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name, region, status, created_at, updated_at)
       VALUES ($1::uuid,'wind-test','WIND','IN','active',NOW(),NOW()) ON CONFLICT (id) DO NOTHING`,
      TENANT,
    );
    ctrlCatalogId = await seedCatalog('WINDTEST Morphine');
    plainCatalogId = await seedCatalog('WINDTEST Paracetamol');
    unlinkedCatalogId = await seedCatalog('WINDTEST Unclassified');
    await linkInventoryItem('WIND-X', ctrlCatalogId, { schedule_class: 'X', is_narcotic: true });
    await linkInventoryItem('WIND-OTC', plainCatalogId, { schedule_class: 'OTC' });
    ({ indentId: ctrlIndentId } = await seedApprovedIndent('WIND-CTRL-1', ctrlCatalogId));
    ({ indentId: plainIndentId } = await seedApprovedIndent('WIND-PLAIN-1', plainCatalogId));
    ({ indentId: unlinkedIndentId } = await seedApprovedIndent(
      'WIND-UNLINKED-1',
      unlinkedCatalogId,
    ));
    ({ indentId: freeTextIndentId } = await seedApprovedIndent('WIND-FREE-1', null));
  });

  afterAll(async () => {
    await cleanup();
    if (typeof prisma.$disconnect === 'function') await prisma.$disconnect();
  });

  const catalogStock = async (id) => {
    const r = await prisma.$queryRawUnsafe(`SELECT stock_quantity FROM pharmacy_catalog WHERE id=$1`, id);
    return Number(r[0].stock_quantity);
  };
  const indentStatus = async (id) => {
    const r = await prisma.$queryRawUnsafe(`SELECT status FROM ward_indents WHERE id=$1`, id);
    return r[0].status;
  };

  test('a controlled (Schedule X) catalog item blocks the whole issue; stock + status unchanged', async () => {
    await expect(issueWardIndent({ indentId: ctrlIndentId, issuedBy: ACTOR, tenantId: TENANT }))
      .rejects.toMatchObject({ code: 'WARD_INDENT_CONTROLLED_ITEM_BLOCKED' });
    expect(await catalogStock(ctrlCatalogId)).toBe(100); // never decremented
    expect(await indentStatus(ctrlIndentId)).toBe('approved'); // rolled back
  });

  test('a non-controlled catalog item issues normally (decrement + issued)', async () => {
    const issued = await issueWardIndent({ indentId: plainIndentId, issuedBy: ACTOR, tenantId: TENANT });
    expect(issued.status).toBe('issued');
    expect(await catalogStock(plainCatalogId)).toBe(95); // 100 - 5
    expect(await indentStatus(plainIndentId)).toBe('issued');
  });

  test('an unclassified catalog item fails closed; stock + status remain unchanged', async () => {
    await expect(issueWardIndent({
      indentId: unlinkedIndentId,
      issuedBy: ACTOR,
      tenantId: TENANT,
    })).rejects.toMatchObject({
      code: 'WARD_INDENT_CONTROLLED_CLASSIFICATION_UNRESOLVED',
    });
    expect(await catalogStock(unlinkedCatalogId)).toBe(100);
    expect(await indentStatus(unlinkedIndentId)).toBe('approved');
  });

  test('a positive free-text line fails closed before the indent is mutated', async () => {
    await expect(issueWardIndent({
      indentId: freeTextIndentId,
      issuedBy: ACTOR,
      tenantId: TENANT,
    })).rejects.toMatchObject({
      code: 'WARD_INDENT_CONTROLLED_CLASSIFICATION_UNRESOLVED',
    });
    expect(await indentStatus(freeTextIndentId)).toBe('approved');
  });
});
