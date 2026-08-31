// Regression test for the IPD pharmacy ward-indent REST surface.
//
// Finding: 2026-05-08-inpatient-admission-pharmacy-no-ipd-ward-indent.
// The service layer already existed in ipdSupportService.js; this suite
// asserts the authoritative requested → reserved → approved → issued →
// received → closed workflow round-trips through HTTP.

import request from 'supertest';
import app from '../app.js';
import prisma from '../lib/prisma.js';
import { DEFAULT_TENANT_ID } from '../services/tenant/tenantService.js';
import { API_KEY, generateTestToken } from './testClient.js';
import { deleteWithAuditBypass } from './helpers/auditBypass.js';

const STAFF_UID = 'a6666666-6666-4666-8666-66666666fd02';
const NURSE_UID = 'a6666666-6666-4666-8666-66666666fd03';
const RUN_SUFFIX = String(Date.now() % 100000).padStart(5, '0');
const WARD_NAME = `Pharm-Indent-Ward-${RUN_SUFFIX}`;
const CATALOG_NAME_PREFIX = `Pharm-Indent-Catalog-${RUN_SUFFIX}`;
const INVENTORY_SKU_PREFIX = `PHARM-INDENT-${RUN_SUFFIX}`;
const STORAGE_LOCATION_CODE = `PHARM-INDENT-STORE-${RUN_SUFFIX}`;

let staffToken;
let nurseToken;
let wardId;
let facilityId;
let storageLocationId;
let paracetamolCatalogId;
let salineCatalogId;
let medicationCatalogId;
const createdIndentIds = [];

async function seedClassifiedCatalog({
  name,
  sku,
  scheduleClass = null,
  medication = false,
}) {
  // Migration 753 binds every ACTIVE inventory item to a tenant facility
  // (chk_pharmacy_inventory_items_active_authority_753), so the fixture must
  // stock the tenant's own facility rather than leaving the row unbound.
  if (!facilityId || !storageLocationId) {
    throw new Error('seedClassifiedCatalog called before facility custody was resolved');
  }
  const catalogRows = await prisma.$queryRawUnsafe(
    `INSERT INTO pharmacy_catalog
       (name, category, requires_prescription, is_active, tenant_id,
        stock_quantity, updated_at)
     VALUES ($1, $3::text, $4::boolean, TRUE, $2::uuid, 100, NOW())
     RETURNING id`,
    name,
    DEFAULT_TENANT_ID,
    medication ? 'medication' : 'ward_supply',
    medication,
  );
  const catalogId = Number(catalogRows[0].id);
  const inventoryRows = await prisma.$queryRawUnsafe(
    `INSERT INTO pharmacy_inventory_items
       (tenant_id, facility_id, sku_code, display_name, catalog_id,
        schedule_class, is_narcotic)
     VALUES ($1::uuid, $6::int, $2, $3, $4, $5, FALSE)
     RETURNING id`,
    DEFAULT_TENANT_ID, sku, name, catalogId, scheduleClass, facilityId,
  );
  const inventoryItemId = Number(inventoryRows[0].id);
  // Reservation allocates against exact in-stock batches, and migration 753
  // requires every usable batch to name both its facility and an active
  // storage location, so stock the item where the ward can actually draw it.
  await prisma.$executeRawUnsafe(
    `INSERT INTO pharmacy_inventory_batches
       (tenant_id, inventory_item_id, facility_id, storage_location_id,
        batch_number, expiry_date, received_quantity, remaining_quantity, status)
     VALUES ($1::uuid, $2::int, $3::int, $4::int, $5::text,
             (CURRENT_DATE + INTERVAL '365 days')::date, 500, 500, 'in_stock')`,
    DEFAULT_TENANT_ID, inventoryItemId, facilityId, storageLocationId,
    `${sku}-BATCH`,
  );
  return catalogId;
}

async function cleanup() {
  if (createdIndentIds.length) {
    await prisma.$executeRawUnsafe(
      `DELETE FROM ward_indent_inventory_allocations
        WHERE ward_indent_id = ANY($1::int[])`,
      createdIndentIds,
    ).catch(() => {});
    await deleteWithAuditBypass(
      prisma,
      `DELETE FROM ward_indent_events WHERE ward_indent_id = ANY($1::int[])`,
      createdIndentIds,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM workflow_sla_instances
        WHERE source_table = 'ward_indents'
          AND source_id LIKE ANY($1::text[])`,
      createdIndentIds.map((id) => `ward-indent:${id}:%`),
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM ward_indents WHERE id = ANY($1::int[])`,
      createdIndentIds,
    ).catch(() => {});
  }
  if (wardId) {
    await prisma.$executeRawUnsafe(
      `DELETE FROM wards WHERE id = $1::int`,
      wardId,
    ).catch(() => {});
  }
  await prisma.$executeRawUnsafe(
    `DELETE FROM pharmacy_inventory_items
      WHERE tenant_id = $1::uuid AND sku_code LIKE $2`,
    DEFAULT_TENANT_ID, `${INVENTORY_SKU_PREFIX}-%`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM pharmacy_catalog
      WHERE tenant_id = $1::uuid AND name LIKE $2`,
    DEFAULT_TENANT_ID, `${CATALOG_NAME_PREFIX} %`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM facility_locations
      WHERE tenant_id = $1::uuid AND location_code = $2`,
    DEFAULT_TENANT_ID, STORAGE_LOCATION_CODE,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM pharmacy_staff_facility_grants
      WHERE tenant_id = $1::uuid AND staff_uid IN ($2::uuid, $3::uuid)`,
    DEFAULT_TENANT_ID, STAFF_UID, NURSE_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM staff
      WHERE tenant_id = $1::uuid AND user_id IN ($2::uuid, $3::uuid)`,
    DEFAULT_TENANT_ID, STAFF_UID, NURSE_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)`,
    STAFF_UID,
    NURSE_UID,
  ).catch(() => {});
}

describe('IPD pharmacy ward-indent REST surface', () => {
  beforeAll(async () => {
    await cleanup();

    // Seed a PHARMACY_STAFF user — the indent flow requires an
    // authenticated uid for requested_by / approved_by / issued_by.
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, $2, $3, 'PHARMACY_STAFF', true, NOW())
       ON CONFLICT (uid) DO UPDATE SET role = EXCLUDED.role, is_active = true`,
      STAFF_UID,
      `+9199998${RUN_SUFFIX}`,
      `Ward-Indent Pharmacy-${RUN_SUFFIX}`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, $2, $3, 'NURSING_INCHARGE', true, NOW())
       ON CONFLICT (uid) DO UPDATE SET role = EXCLUDED.role, is_active = true`,
      NURSE_UID,
      `+9199997${RUN_SUFFIX}`,
      `Ward-Indent Nurse-${RUN_SUFFIX}`,
    );

    // Resolve the tenant's own active facility; the inventory rows below are
    // facility-bound authority under migration 753 and a cross-tenant facility
    // would be refused by fk_pharmacy_inventory_items_facility_tenant_753.
    const facilityRows = await prisma.$queryRawUnsafe(
      `SELECT id FROM facilities
        WHERE tenant_id = $1::uuid AND status = 'active'
        ORDER BY is_default DESC, id ASC
        LIMIT 1`,
      DEFAULT_TENANT_ID,
    );
    if (!facilityRows.length) {
      throw new Error(`No active facility seeded for tenant ${DEFAULT_TENANT_ID}`);
    }
    facilityId = Number(facilityRows[0].id);

    const storageRows = await prisma.$queryRawUnsafe(
      `INSERT INTO facility_locations
         (tenant_id, facility_id, location_code, display_name, status)
       VALUES ($1::uuid, $2::int, $3::text, $4::text, 'active')
       RETURNING id`,
      DEFAULT_TENANT_ID,
      facilityId,
      STORAGE_LOCATION_CODE,
      `Ward-Indent Store ${RUN_SUFFIX}`,
    );
    storageLocationId = Number(storageRows[0].id);

    // The pharmacy-side transitions (reserve/approve/reject/issue) run through
    // assertPharmacyFacilityGrant, which demands a staff-backed actor holding
    // exactly one active grant for the indent's facility. There is no admin
    // bypass, so the fixture has to establish that custody explicitly.
    await prisma.$executeRawUnsafe(
      `INSERT INTO staff (tenant_id, user_id, employee_id, name, designation,
                          is_active, archived, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, $4, 'Pharmacy Staff', TRUE, FALSE,
               NOW(), NOW())
       ON CONFLICT (tenant_id, user_id) WHERE user_id IS NOT NULL
       DO UPDATE SET is_active = TRUE, archived = FALSE, updated_at = NOW()`,
      DEFAULT_TENANT_ID,
      STAFF_UID,
      `WI-PHARM-${RUN_SUFFIX}`,
      `Ward-Indent Pharmacy-${RUN_SUFFIX}`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO pharmacy_staff_facility_grants
         (tenant_id, facility_id, staff_uid, status, grant_source,
          grant_reason, granted_by)
       VALUES ($1::uuid, $2::int, $3::uuid, 'active', 'test_fixture',
               'Ward-indent REST suite pharmacy custody fixture', $3::uuid)
       ON CONFLICT (tenant_id, staff_uid, facility_id)
         WHERE status = 'active' DO NOTHING`,
      DEFAULT_TENANT_ID,
      facilityId,
      STAFF_UID,
    );

    // Seed a ward so the indent has a real FK target.
    // A ward-indent's facility authority is the ward's facility, so an
    // unassigned ward is refused with WARD_INDENT_FACILITY_REQUIRED.
    const wardRows = await prisma.$queryRawUnsafe(
      `INSERT INTO wards (name, total_beds, facility_id, created_at, updated_at)
       VALUES ($1, 10, $2::int, NOW(), NOW())
       RETURNING id`,
      WARD_NAME,
      facilityId,
    );
    wardId = wardRows[0].id;

    paracetamolCatalogId = await seedClassifiedCatalog({
      name: `${CATALOG_NAME_PREFIX} Sterile Gauze Pack`,
      sku: `${INVENTORY_SKU_PREFIX}-GAUZE`,
    });
    salineCatalogId = await seedClassifiedCatalog({
      name: `${CATALOG_NAME_PREFIX} Normal Saline 500ml`,
      sku: `${INVENTORY_SKU_PREFIX}-SALINE`,
    });
    medicationCatalogId = await seedClassifiedCatalog({
      name: `${CATALOG_NAME_PREFIX} Paracetamol 500mg`,
      sku: `${INVENTORY_SKU_PREFIX}-PARACETAMOL`,
      scheduleClass: 'OTC',
      medication: true,
    });

    staffToken = generateTestToken('PHARMACY_STAFF', { uid: STAFF_UID });
    nurseToken = generateTestToken('NURSING_INCHARGE', { uid: NURSE_UID });
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  it('round-trips requested → reserved → approved → issued → received → closed', async () => {
    // 1. Create
    const createRes = await request(app)
      .post('/api/v1/pharmacy/ward-indents')
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${staffToken}`)
      .set('idempotency-key', `ward-indent-create-${RUN_SUFFIX}`)
      .send({
        ward_id: wardId,
        indent_type: 'consumables',
        notes: 'Routine ward stock replenishment',
        items: [
          {
            pharmacy_catalog_id: paracetamolCatalogId,
            item_name: 'Sterile Gauze Pack',
            quantity_requested: 50,
            unit: 'packs',
          },
          {
            pharmacy_catalog_id: salineCatalogId,
            item_name: 'Normal Saline 500ml',
            quantity_requested: 10,
            unit: 'bottles',
          },
        ],
      });

    expect(createRes.statusCode).toBe(201);
    expect(createRes.body.success).toBe(true);
    const indent = createRes.body.data;
    createdIndentIds.push(indent.id);
    expect(indent).toMatchObject({
      ward_id: wardId,
      indent_type: 'consumables',
      status: 'requested',
    });
    expect(indent.items).toHaveLength(2);
    expect(indent.indent_number).toMatch(/^WI-/);

    const indentId = indent.id;

    // 2. List with status filter
    const listRes = await request(app)
      .get(`/api/v1/pharmacy/ward-indents?wardId=${wardId}&status=requested&limit=10`)
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${staffToken}`);
    expect(listRes.statusCode).toBe(200);
    expect(listRes.body.data.some((x) => x.id === indentId)).toBe(true);

    // 3. Get one
    const getRes = await request(app)
      .get(`/api/v1/pharmacy/ward-indents/${indentId}`)
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${staffToken}`);
    expect(getRes.statusCode).toBe(200);
    expect(getRes.body.data.id).toBe(indentId);

    // 4. Reserve
    const reserveRes = await request(app)
      .post(`/api/v1/pharmacy/ward-indents/${indentId}/reserve`)
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${staffToken}`)
      .set('idempotency-key', `ward-indent-reserve-${RUN_SUFFIX}`)
      .send({ expected_version: 1 });
    expect(reserveRes.statusCode).toBe(200);
    expect(reserveRes.body.data.status).toBe('reserved');

    // 5. Approve
    const approveRes = await request(app)
      .post(`/api/v1/pharmacy/ward-indents/${indentId}/approve`)
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${staffToken}`)
      .set('idempotency-key', `ward-indent-approve-${RUN_SUFFIX}`)
      .send({ expected_version: 2 });
    expect(approveRes.statusCode).toBe(200);
    expect(approveRes.body.data.status).toBe('approved');
    expect(approveRes.body.data.approved_by).toBe(STAFF_UID);

    // 6. Issue (no per-item quantities → default to approved quantity)
    const issueRes = await request(app)
      .post(`/api/v1/pharmacy/ward-indents/${indentId}/issue`)
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${staffToken}`)
      .set('idempotency-key', `ward-indent-issue-${RUN_SUFFIX}`)
      .send({ expected_version: 3 });
    expect(issueRes.statusCode).toBe(200);
    expect(issueRes.body.data.status).toBe('issued');
    expect(issueRes.body.data.issued_by).toBe(STAFF_UID);
    // Each item should now have quantity_issued = quantity_requested.
    issueRes.body.data.items.forEach((it) => {
      expect(Number(it.quantity_issued)).toBe(Number(it.quantity_requested));
    });

    // 7. Receive by the ward — the issuer cannot self-acknowledge custody.
    const receiveRes = await request(app)
      .post(`/api/v1/pharmacy/ward-indents/${indentId}/receive`)
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${nurseToken}`)
      .set('idempotency-key', `ward-indent-receive-${RUN_SUFFIX}`)
      .send({ expected_version: 4 });
    expect(receiveRes.statusCode).toBe(200);
    expect(receiveRes.body.data.status).toBe('received');
    expect(receiveRes.body.data.received_by).toBe(NURSE_UID);

    // 8. Close only after every issued unit is accounted for.
    const closeRes = await request(app)
      .post(`/api/v1/pharmacy/ward-indents/${indentId}/close`)
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${nurseToken}`)
      .set('idempotency-key', `ward-indent-close-${RUN_SUFFIX}`)
      .send({ expected_version: 5, reason: 'Ward receipt complete' });
    expect(closeRes.statusCode).toBe(200);
    expect(closeRes.body.data).toMatchObject({
      status: 'closed',
      closed_by: NURSE_UID,
      closure_outcome: 'fulfilled',
    });
    expect(closeRes.body.data.workflow.events).toHaveLength(6);
  });

  it('rejects a medication catalog masquerading as consumables without a CPOE order', async () => {
    const response = await request(app)
      .post('/api/v1/pharmacy/ward-indents')
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${staffToken}`)
      .set('idempotency-key', `ward-indent-medication-bypass-${RUN_SUFFIX}`)
      .send({
        ward_id: wardId,
        indent_type: 'consumables',
        items: [{
          pharmacy_catalog_id: medicationCatalogId,
          item_name: 'Caller supplied medication name',
          quantity_requested: 1,
          unit: 'tablet',
        }],
      });

    expect(response.statusCode).toBe(409);
    expect(JSON.stringify(response.body)).toContain('WARD_INDENT_CLINICAL_ORDER_REQUIRED');
  });

  it('rejects an indent with a reason and refuses to issue it afterwards', async () => {
    const createRes = await request(app)
      .post('/api/v1/pharmacy/ward-indents')
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${staffToken}`)
      .set('idempotency-key', `ward-indent-reject-create-${RUN_SUFFIX}`)
      .send({
        ward_id: wardId,
        indent_type: 'consumables',
        items: [{ item_name: 'Disposable ward drape', quantity_requested: 100 }],
      });
    expect(createRes.statusCode).toBe(201);
    const indentId = createRes.body.data.id;
    createdIndentIds.push(indentId);

    const rejectRes = await request(app)
      .post(`/api/v1/pharmacy/ward-indents/${indentId}/reject`)
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${staffToken}`)
      .set('idempotency-key', `ward-indent-reject-${RUN_SUFFIX}`)
      .send({ reason: 'Out of stock — see PO #2026-04' });
    expect(rejectRes.statusCode).toBe(200);
    expect(rejectRes.body.data.status).toBe('rejected');
    expect(rejectRes.body.data.rejection_reason).toMatch(/Out of stock/);

    // Issue after reject must fail (state-machine guard).
    const issueRes = await request(app)
      .post(`/api/v1/pharmacy/ward-indents/${indentId}/issue`)
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${staffToken}`)
      .set('idempotency-key', `ward-indent-rejected-issue-${RUN_SUFFIX}`)
      .send({});
    expect(issueRes.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('validates input — non-empty items array required', async () => {
    const res = await request(app)
      .post('/api/v1/pharmacy/ward-indents')
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${staffToken}`)
      .set('idempotency-key', `ward-indent-invalid-${RUN_SUFFIX}`)
      .send({ ward_id: wardId, items: [] });
    expect(res.statusCode).toBe(400);
  });
});
