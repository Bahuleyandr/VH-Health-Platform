// Phase-3 deep-review fixes — IPD support money/authz/canonical paths,
// proven against a real DB:
//
//   1. (B-M3) refundAdvanceDeposit locks the parent deposit FOR UPDATE and
//      recomputes the refunded total in-tx: an over-refund — including the
//      one produced by two concurrent refunds racing the same balance —
//      is rejected 409 DEPOSIT_REFUND_EXCEEDS_BALANCE, never double-paid
//      and never a generic 500.
//   2. (B-M4) /api/v1/ipd operations carry per-route requireRole guards:
//      refund payout is finance/cashier-only, ward-indent issue is
//      pharmacy-only, pass revoke is admission/ward-leadership-only.
//   3. (B-M5) issuing a patient-linked ward indent writes exactly one
//      clinical_timeline_events row + one clinical_audit_events row in the
//      same transaction as the clinical_orders 'verified' flip.

import { randomUUID } from 'crypto';
import request from 'supertest';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const app = (await import('../app.js')).default;
const prisma = (await import('../lib/prisma.js')).default;
const ipdSupportService = (await import('../services/ipd/ipdSupportService.js')).default;
const { API_KEY, generateTestToken } = await import('./testClient.js');
const { deleteWithAuditBypass } = await import('./helpers/auditBypass.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const SUFFIX = String(Date.now() % 100000).padStart(5, '0');

const PATIENT_UID = randomUUID();
const BILLING_UID = randomUUID();
const RECEPTIONIST_UID = randomUUID();
const NURSE_UID = randomUUID();
const PHARMACY_UID = randomUUID();
const ADMISSION_OFFICER_UID = randomUUID();

const WARD_NAME = `BM-WARD-${SUFFIX}`;

let wardId;
let admissionId;
let stockCatalogId;

function phone() {
  return `9${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;
}

function client(role, uid) {
  const token = generateTestToken(role, { uid, tenant_id: TENANT });
  const auth = (req) => req
    .set('x-api-key', API_KEY)
    .set('Authorization', `Bearer ${token}`);
  return {
    get: (path) => auth(request(app).get(path)),
    post: (path) => auth(request(app).post(path)),
  };
}

async function seedUser({ uid, role, name }) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
     VALUES ($1::uuid, $2, $3, $4, true, $5::uuid, NOW())`,
    uid, phone(), name, role, TENANT,
  );
}

async function seedDeposit(amount) {
  return ipdSupportService.collectAdvanceDeposit({
    admissionId,
    amount,
    paymentMethod: 'cash',
    collectedBy: BILLING_UID,
    tenantId: TENANT,
  });
}

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_timeline_events WHERE patient_uid = $1::uuid`, PATIENT_UID,
  ).catch(() => {});
  await deleteWithAuditBypass(
    prisma,
    `DELETE FROM clinical_audit_events WHERE patient_uid = $1::uuid`,
    PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM ward_indent_items WHERE ward_indent_id IN (
       SELECT id FROM ward_indents WHERE patient_uid = $1::uuid OR ward_name = $2)`,
    PATIENT_UID, WARD_NAME,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM ward_indents WHERE patient_uid = $1::uuid OR ward_name = $2`,
    PATIENT_UID, WARD_NAME,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_orders WHERE patient_uid = $1::uuid`, PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM billing_advances WHERE patient_uid = $1::uuid`, PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM advance_deposits WHERE patient_uid = $1::uuid`, PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM attendant_passes WHERE patient_uid = $1::uuid`, PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM admissions WHERE patient_uid = $1::uuid`, PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM wards WHERE name = $1`, WARD_NAME,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM pharmacy_inventory_items WHERE tenant_id = $1::uuid AND sku_code = $2`,
    TENANT, `BM-INV-${SUFFIX}`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM pharmacy_catalog WHERE tenant_id = $1::uuid AND name = $2`,
    TENANT, `BM-CATALOG-${SUFFIX}`,
  ).catch(() => {});
  for (const uid of [
    PATIENT_UID, BILLING_UID, RECEPTIONIST_UID, NURSE_UID, PHARMACY_UID, ADMISSION_OFFICER_UID,
  ]) {
    await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid = $1::uuid`, uid).catch(() => {});
  }
}

d('Phase-3 IPD support fixes: refund race, per-route authz, ward-indent canonicals (deep)', () => {
  beforeAll(async () => {
    await cleanup();
    await seedUser({ uid: PATIENT_UID, role: 'PATIENT', name: 'BM Patient' });
    await seedUser({ uid: BILLING_UID, role: 'BILLING_STAFF', name: 'BM Billing' });
    await seedUser({ uid: RECEPTIONIST_UID, role: 'RECEPTIONIST', name: 'BM Receptionist' });
    await seedUser({ uid: NURSE_UID, role: 'IP_STAFF_NURSE', name: 'BM Nurse' });
    await seedUser({ uid: PHARMACY_UID, role: 'PHARMACY_STAFF', name: 'BM Pharmacist' });
    await seedUser({ uid: ADMISSION_OFFICER_UID, role: 'ADMISSION_OFFICER', name: 'BM Admission Officer' });

    const wardRows = await prisma.$queryRawUnsafe(
      `INSERT INTO wards (name, floor, total_beds) VALUES ($1, 1, 2) RETURNING id`,
      WARD_NAME,
    );
    wardId = wardRows[0].id;

    const admissionRows = await prisma.$queryRawUnsafe(
      `INSERT INTO admissions (tenant_id, patient_uid, status, ward, admitted_at, updated_at)
       VALUES ($1::uuid, $2::uuid, 'admitted', $3, NOW(), NOW())
       RETURNING id`,
      TENANT, PATIENT_UID, WARD_NAME,
    );
    admissionId = admissionRows[0].id;

    // Post-BC-M3 (commit b5640292 / 0b628e64) issueWardIndent fails closed on
    // any positive indent line whose controlled-drug classification it cannot
    // resolve: free-text lines, and catalog lines with no same-facility
    // inventory-v2 item, are rejected 409. Seed one non-controlled catalog row
    // linked to a same-tenant inventory-v2 item so the ward-indent issues below
    // classify cleanly (OTC, non-narcotic) and reach the 'issued' path.
    const catalogRows = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_catalog (name, is_active, tenant_id, stock_quantity, updated_at)
       VALUES ($1, TRUE, $2::uuid, 500, NOW()) RETURNING id`,
      `BM-CATALOG-${SUFFIX}`, TENANT,
    );
    stockCatalogId = Number(catalogRows[0].id);
    await prisma.$executeRawUnsafe(
      `INSERT INTO pharmacy_inventory_items
         (tenant_id, sku_code, display_name, catalog_id, schedule_class, is_narcotic)
       VALUES ($1::uuid, $2, $2, $3, 'OTC', FALSE)`,
      TENANT, `BM-INV-${SUFFIX}`, stockCatalogId,
    );
  }, 120_000);

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  }, 120_000);

  // ── B-M3: over-refund guard is race-safe and 409s ─────────────────────────

  it('rejects a sequential over-refund with 409 DEPOSIT_REFUND_EXCEEDS_BALANCE', async () => {
    const deposit = await seedDeposit(100);

    const first = await ipdSupportService.refundAdvanceDeposit({
      parentDepositId: deposit.id,
      refundAmount: 60,
      paymentMethod: 'cash',
      refundedBy: BILLING_UID,
      tenantId: TENANT,
    });
    expect(Number(first.amount)).toBe(-60);
    expect(first.is_refund).toBe(true);

    await expect(
      ipdSupportService.refundAdvanceDeposit({
        parentDepositId: deposit.id,
        refundAmount: 50,
        paymentMethod: 'cash',
        refundedBy: BILLING_UID,
        tenantId: TENANT,
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'DEPOSIT_REFUND_EXCEEDS_BALANCE',
    });

    // Only the one refund row exists.
    const refunds = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n FROM advance_deposits
        WHERE parent_deposit_id = $1::int AND is_refund = true`,
      deposit.id,
    );
    expect(refunds[0].n).toBe(1);
  }, 60_000);

  it('serializes two concurrent refunds on the same deposit — one pays, one 409s, never both', async () => {
    const deposit = await seedDeposit(100);

    const results = await Promise.allSettled([
      ipdSupportService.refundAdvanceDeposit({
        parentDepositId: deposit.id,
        refundAmount: 80,
        paymentMethod: 'cash',
        refundedBy: BILLING_UID,
        tenantId: TENANT,
      }),
      ipdSupportService.refundAdvanceDeposit({
        parentDepositId: deposit.id,
        refundAmount: 80,
        paymentMethod: 'cash',
        refundedBy: BILLING_UID,
        tenantId: TENANT,
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({
      statusCode: 409,
      code: 'DEPOSIT_REFUND_EXCEEDS_BALANCE',
    });

    // Exactly one payout committed — the deposit was not double-refunded.
    const agg = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n, COALESCE(SUM(amount), 0)::numeric AS total
         FROM advance_deposits
        WHERE parent_deposit_id = $1::int AND is_refund = true`,
      deposit.id,
    );
    expect(agg[0].n).toBe(1);
    expect(Number(agg[0].total)).toBe(-80);
  }, 60_000);

  // ── B-M4: per-route authz on the /api/v1/ipd surface ──────────────────────

  it('refund payout: RECEPTIONIST (mount union, non-finance) gets 403; BILLING_STAFF passes and refunds', async () => {
    const deposit = await seedDeposit(40);

    const denied = await client('RECEPTIONIST', RECEPTIONIST_UID)
      .post(`/api/v1/ipd/advance-deposits/${deposit.id}/refund`)
      .send({ refund_amount: 10, payment_method: 'cash' });
    expect(denied.statusCode).toBe(403);

    const allowed = await client('BILLING_STAFF', BILLING_UID)
      .post(`/api/v1/ipd/advance-deposits/${deposit.id}/refund`)
      .send({ refund_amount: 10, payment_method: 'cash' });
    expect(allowed.statusCode).toBe(201);
    expect(Number(allowed.body.data.refund.amount)).toBe(-10);
  }, 60_000);

  it('deposit collection: IP_STAFF_NURSE gets 403; RECEPTIONIST passes', async () => {
    const denied = await client('IP_STAFF_NURSE', NURSE_UID)
      .post(`/api/v1/ipd/admissions/${admissionId}/advance-deposits`)
      .send({ amount: 10, payment_method: 'cash' });
    expect(denied.statusCode).toBe(403);

    const allowed = await client('RECEPTIONIST', RECEPTIONIST_UID)
      .post(`/api/v1/ipd/admissions/${admissionId}/advance-deposits`)
      .send({ amount: 10, payment_method: 'cash' });
    expect(allowed.statusCode).toBe(201);
  }, 60_000);

  it('ward-indent issue: RECEPTIONIST and IP_STAFF_NURSE get 403; PHARMACY_STAFF passes', async () => {
    const indent = await ipdSupportService.createWardIndent({
      wardId,
      indentType: 'pharmacy',
      items: [{ item_name: 'Gauze roll', quantity_requested: 5, pharmacy_catalog_id: stockCatalogId }],
      requestedBy: NURSE_UID,
      tenantId: TENANT,
    });
    await ipdSupportService.approveWardIndent({
      indentId: indent.id, approvedBy: PHARMACY_UID, tenantId: TENANT,
    });

    const deniedReception = await client('RECEPTIONIST', RECEPTIONIST_UID)
      .post(`/api/v1/ipd/ward-indents/${indent.id}/issue`)
      .send({});
    expect(deniedReception.statusCode).toBe(403);

    const deniedNurse = await client('IP_STAFF_NURSE', NURSE_UID)
      .post(`/api/v1/ipd/ward-indents/${indent.id}/issue`)
      .send({});
    expect(deniedNurse.statusCode).toBe(403);

    const allowed = await client('PHARMACY_STAFF', PHARMACY_UID)
      .post(`/api/v1/ipd/ward-indents/${indent.id}/issue`)
      .send({});
    expect(allowed.statusCode).toBe(200);
    expect(allowed.body.data.indent.status).toBe('issued');
  }, 60_000);

  it('attendant-pass revoke: PHARMACY_STAFF gets 403; ADMISSION_OFFICER passes', async () => {
    const passRows = await prisma.$queryRawUnsafe(
      `INSERT INTO attendant_passes
         (admission_id, patient_uid, pass_number, pass_index, issued_by, tenant_id)
       VALUES ($1::int, $2::uuid, $3, 99, $4::uuid, $5::uuid)
       RETURNING id`,
      admissionId, PATIENT_UID, `AP-TEST-${SUFFIX}`, ADMISSION_OFFICER_UID, TENANT,
    );
    const passId = passRows[0].id;

    const denied = await client('PHARMACY_STAFF', PHARMACY_UID)
      .post(`/api/v1/ipd/attendant-passes/${passId}/revoke`)
      .send({ reason: 'should not be allowed' });
    expect(denied.statusCode).toBe(403);

    const allowed = await client('ADMISSION_OFFICER', ADMISSION_OFFICER_UID)
      .post(`/api/v1/ipd/attendant-passes/${passId}/revoke`)
      .send({ reason: 'lost pass' });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.body.data.pass.status).toBe('revoked');
  }, 60_000);

  // ── B-M5: ward-indent issue writes canonical timeline + audit rows ────────

  it('issuing a patient-linked indent flips clinical_orders to verified AND writes one timeline + one audit row', async () => {
    const orderRows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_orders
         (order_number, encounter_id, patient_uid, order_type, status, ordered_by, details, tenant_id)
       VALUES ($1, NULL, $2::uuid, 'medication', 'ordered', $3::uuid,
               '{"medication_name":"Ceftriaxone 1g"}'::jsonb, $4::uuid)
       RETURNING id`,
      `ORD-BM5-${SUFFIX}`, PATIENT_UID, NURSE_UID, TENANT,
    );
    const clinicalOrderId = orderRows[0].id;

    const indent = await ipdSupportService.createWardIndent({
      wardId,
      admissionId,
      patientUid: PATIENT_UID,
      indentType: 'pharmacy',
      items: [{
        item_name: 'Ceftriaxone 1g',
        quantity_requested: 2,
        pharmacy_catalog_id: stockCatalogId,
        notes: `clinical_order_id:${clinicalOrderId}; order_number:ORD-BM5-${SUFFIX}`,
      }],
      requestedBy: NURSE_UID,
      tenantId: TENANT,
    });
    await ipdSupportService.approveWardIndent({
      indentId: indent.id, approvedBy: PHARMACY_UID, tenantId: TENANT,
    });
    const issued = await ipdSupportService.issueWardIndent({
      indentId: indent.id, issuedBy: PHARMACY_UID, tenantId: TENANT,
    });
    expect(issued.status).toBe('issued');

    const order = await prisma.$queryRawUnsafe(
      `SELECT status, verified_by FROM clinical_orders WHERE id = $1::int`,
      clinicalOrderId,
    );
    expect(order[0].status).toBe('verified');
    expect(order[0].verified_by).toBe(PHARMACY_UID);

    const timeline = await prisma.$queryRawUnsafe(
      `SELECT patient_uid, event_type, event_status, actor_uid, payload
         FROM clinical_timeline_events
        WHERE idempotency_key = $1`,
      `ward_indents:${indent.id}:issued`,
    );
    expect(timeline).toHaveLength(1);
    expect(timeline[0].patient_uid).toBe(PATIENT_UID);
    expect(timeline[0].event_type).toBe('ward_indent.issued');
    expect(timeline[0].event_status).toBe('issued');
    expect(timeline[0].actor_uid).toBe(PHARMACY_UID);
    expect(timeline[0].payload.verified_clinical_order_ids).toContain(clinicalOrderId);

    const audit = await prisma.$queryRawUnsafe(
      `SELECT patient_uid, action, actor_uid
         FROM clinical_audit_events
        WHERE idempotency_key = $1`,
      `ward_indents:${indent.id}:audit:issued`,
    );
    expect(audit).toHaveLength(1);
    expect(audit[0].patient_uid).toBe(PATIENT_UID);
    expect(audit[0].action).toBe('ward_indent.issued');
    expect(audit[0].actor_uid).toBe(PHARMACY_UID);
  }, 60_000);

  it('issuing a ward-stock indent with no linked patient writes no canonical rows (not patient-facing)', async () => {
    const indent = await ipdSupportService.createWardIndent({
      wardId,
      indentType: 'consumables',
      items: [{ item_name: 'Bedsheet', quantity_requested: 10, pharmacy_catalog_id: stockCatalogId }],
      requestedBy: NURSE_UID,
      tenantId: TENANT,
    });
    await ipdSupportService.approveWardIndent({
      indentId: indent.id, approvedBy: PHARMACY_UID, tenantId: TENANT,
    });
    const issued = await ipdSupportService.issueWardIndent({
      indentId: indent.id, issuedBy: PHARMACY_UID, tenantId: TENANT,
    });
    expect(issued.status).toBe('issued');

    const rows = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n FROM clinical_timeline_events
        WHERE idempotency_key = $1`,
      `ward_indents:${indent.id}:issued`,
    );
    expect(rows[0].n).toBe(0);
  }, 60_000);
});
