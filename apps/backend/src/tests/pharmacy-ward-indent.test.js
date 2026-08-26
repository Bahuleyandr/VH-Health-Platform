// Regression test for the IPD pharmacy ward-indent REST surface.
//
// Finding: 2026-05-08-inpatient-admission-pharmacy-no-ipd-ward-indent.
// The service layer already existed in ipdSupportService.js; this suite
// asserts the routes are mounted and the requested → approved → issued →
// received workflow round-trips through HTTP.

import request from 'supertest';
import app from '../app.js';
import prisma from '../lib/prisma.js';
import { DEFAULT_TENANT_ID } from '../services/tenant/tenantService.js';
import { API_KEY, generateTestToken } from './testClient.js';

const STAFF_UID = 'a6666666-6666-4666-8666-66666666fd02';
const RUN_SUFFIX = String(Date.now() % 100000).padStart(5, '0');
const WARD_NAME = `Pharm-Indent-Ward-${RUN_SUFFIX}`;
const CATALOG_NAME_PREFIX = `Pharm-Indent-Catalog-${RUN_SUFFIX}`;
const INVENTORY_SKU_PREFIX = `PHARM-INDENT-${RUN_SUFFIX}`;

let staffToken;
let wardId;
let paracetamolCatalogId;
let salineCatalogId;
const createdIndentIds = [];

async function seedClassifiedCatalog({ name, sku, scheduleClass = null }) {
  const catalogRows = await prisma.$queryRawUnsafe(
    `INSERT INTO pharmacy_catalog (name, is_active, tenant_id, stock_quantity, updated_at)
     VALUES ($1, TRUE, $2::uuid, 100, NOW()) RETURNING id`,
    name, DEFAULT_TENANT_ID,
  );
  const catalogId = Number(catalogRows[0].id);
  await prisma.$executeRawUnsafe(
    `INSERT INTO pharmacy_inventory_items
       (tenant_id, sku_code, display_name, catalog_id, schedule_class, is_narcotic)
     VALUES ($1::uuid, $2, $3, $4, $5, FALSE)`,
    DEFAULT_TENANT_ID, sku, name, catalogId, scheduleClass,
  );
  return catalogId;
}

async function cleanup() {
  if (createdIndentIds.length) {
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
    `DELETE FROM users WHERE uid = $1::uuid`,
    STAFF_UID,
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

    // Seed a ward so the indent has a real FK target.
    const wardRows = await prisma.$queryRawUnsafe(
      `INSERT INTO wards (name, total_beds, created_at, updated_at)
       VALUES ($1, 10, NOW(), NOW())
       RETURNING id`,
      WARD_NAME,
    );
    wardId = wardRows[0].id;

    paracetamolCatalogId = await seedClassifiedCatalog({
      name: `${CATALOG_NAME_PREFIX} Paracetamol 500mg`,
      sku: `${INVENTORY_SKU_PREFIX}-PARACETAMOL`,
      scheduleClass: 'OTC',
    });
    salineCatalogId = await seedClassifiedCatalog({
      name: `${CATALOG_NAME_PREFIX} Normal Saline 500ml`,
      sku: `${INVENTORY_SKU_PREFIX}-SALINE`,
    });

    staffToken = generateTestToken('PHARMACY_STAFF', { uid: STAFF_UID });
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  it('round-trips a ward indent through requested → approved → issued → received', async () => {
    // 1. Create
    const createRes = await request(app)
      .post('/api/v1/pharmacy/ward-indents')
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${staffToken}`)
      .send({
        ward_id: wardId,
        indent_type: 'pharmacy',
        notes: 'Routine ward stock replenishment',
        items: [
          {
            pharmacy_catalog_id: paracetamolCatalogId,
            item_name: 'Paracetamol 500mg',
            quantity_requested: 50,
            unit: 'tablets',
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
      indent_type: 'pharmacy',
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

    // 4. Approve
    const approveRes = await request(app)
      .post(`/api/v1/pharmacy/ward-indents/${indentId}/approve`)
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${staffToken}`)
      .send({});
    expect(approveRes.statusCode).toBe(200);
    expect(approveRes.body.data.status).toBe('approved');
    expect(approveRes.body.data.approved_by).toBe(STAFF_UID);

    // 5. Issue (no per-item quantities → default to quantity_requested)
    const issueRes = await request(app)
      .post(`/api/v1/pharmacy/ward-indents/${indentId}/issue`)
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${staffToken}`)
      .send({});
    expect(issueRes.statusCode).toBe(200);
    expect(issueRes.body.data.status).toBe('issued');
    expect(issueRes.body.data.issued_by).toBe(STAFF_UID);
    // Each item should now have quantity_issued = quantity_requested.
    issueRes.body.data.items.forEach((it) => {
      expect(Number(it.quantity_issued)).toBe(Number(it.quantity_requested));
    });

    // 6. Receive
    const receiveRes = await request(app)
      .post(`/api/v1/pharmacy/ward-indents/${indentId}/receive`)
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${staffToken}`)
      .send({});
    expect(receiveRes.statusCode).toBe(200);
    expect(receiveRes.body.data.status).toBe('received');
    expect(receiveRes.body.data.received_by).toBe(STAFF_UID);
  });

  it('rejects an indent with a reason and refuses to issue it afterwards', async () => {
    const createRes = await request(app)
      .post('/api/v1/pharmacy/ward-indents')
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${staffToken}`)
      .send({
        ward_id: wardId,
        items: [{ item_name: 'Ibuprofen 400mg', quantity_requested: 100 }],
      });
    expect(createRes.statusCode).toBe(201);
    const indentId = createRes.body.data.id;
    createdIndentIds.push(indentId);

    const rejectRes = await request(app)
      .post(`/api/v1/pharmacy/ward-indents/${indentId}/reject`)
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ reason: 'Out of stock — see PO #2026-04' });
    expect(rejectRes.statusCode).toBe(200);
    expect(rejectRes.body.data.status).toBe('rejected');
    expect(rejectRes.body.data.rejection_reason).toMatch(/Out of stock/);

    // Issue after reject must fail (state-machine guard).
    const issueRes = await request(app)
      .post(`/api/v1/pharmacy/ward-indents/${indentId}/issue`)
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${staffToken}`)
      .send({});
    expect(issueRes.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('validates input — non-empty items array required', async () => {
    const res = await request(app)
      .post('/api/v1/pharmacy/ward-indents')
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ ward_id: wardId, items: [] });
    expect(res.statusCode).toBe(400);
  });
});
