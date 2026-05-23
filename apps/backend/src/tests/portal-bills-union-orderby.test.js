// Regression test for finding 2026-05-22-tpa-insurance-claim-patient-40651441.
//
// `GET /api/v1/portal/bills` returned a generic 500 with Postgres
// 0A000 "invalid UNION/INTERSECT/EXCEPT ORDER BY clause / Only result
// column names can be used, not expressions or functions". Root cause:
// `ORDER BY COALESCE(issued_at, created_at) DESC, id DESC` was
// attached directly to a UNION ALL — Postgres does not allow
// expressions in the outer ORDER BY of a set-op query.
//
// Fix: wrap the UNION ALL in a subquery so the COALESCE-expression
// order is legal on the outer SELECT. The query then returns the
// patient's billing_invoices + un-invoiced pharmacy_orders union,
// ordered by issued_at (or created_at) DESC.

import prisma from '../lib/prisma.js';
import { listMyBills } from '../services/portal/patientPortalService.js';

const TENANT = 'cbf00000-0000-4000-8000-bbbbbbbb1001';
const PATIENT_UID = 'cbf11111-1111-4111-8111-bbbbbbbb1001';
let patientIntId;
const createdInvoiceIds = [];
const createdPharmacyOrderIds = [];

describe('listMyBills — UNION ORDER BY expression fix (40651441)', () => {
  beforeAll(async () => {
    // Cleanup any prior failed-run rows.
    await prisma.$executeRawUnsafe(`DELETE FROM billing_invoices WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM pharmacy_orders WHERE patient_phone = '9000770010'`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid = $1::uuid`, PATIENT_UID).catch(() => {});

    const p = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, '9000770010', 'Bills Union Test Patient', 'PATIENT', true, NOW())
       RETURNING id`, PATIENT_UID);
    patientIntId = p[0].id;

    // 1) A formal billing_invoices row (older issued_at).
    const inv = await prisma.$queryRawUnsafe(
      `INSERT INTO billing_invoices
         (tenant_id, patient_uid, invoice_number, issued_at, created_at,
          invoice_type, status, subtotal, total_amount, amount_paid, amount_due)
       VALUES ($1::uuid, $2::uuid, 'INV-BILLS-UNION-1',
               (NOW() - INTERVAL '2 days'), (NOW() - INTERVAL '2 days'),
               'OPD', 'ISSUED', 500, 500, 0, 500)
       RETURNING id`, TENANT, PATIENT_UID);
    createdInvoiceIds.push(inv[0].id);

    // 2) An un-invoiced unpaid pharmacy_orders row (newer ordered_at) —
    //    must appear via the UNION ALL branch + sort FIRST.
    const ord = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_orders
         (patient_id, phone, patient_phone, order_number, status, payment_status,
          total_amount, order_note, ordered_at, created_at, updated_at)
       VALUES ($1::int, '9000770010', '9000770010', 'PO-BILLS-UNION-1',
               'DISPENSED', 'pending', 320, 'test order',
               NOW(), NOW(), NOW())
       RETURNING id`, patientIntId);
    createdPharmacyOrderIds.push(ord[0].id);
  });

  afterAll(async () => {
    for (const id of createdInvoiceIds) {
      await prisma.$executeRawUnsafe(`DELETE FROM billing_invoices WHERE id = $1::int`, id).catch(() => {});
    }
    for (const id of createdPharmacyOrderIds) {
      await prisma.$executeRawUnsafe(`DELETE FROM pharmacy_orders WHERE id = $1::int`, id).catch(() => {});
    }
    await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  });

  it('does NOT throw a Postgres 0A000 (the repro) and returns both invoice + pharmacy_order rows', async () => {
    const bills = await listMyBills({ tenantId: TENANT, patient_uid: PATIENT_UID });
    expect(Array.isArray(bills)).toBe(true);
    // Both rows visible: 1 formal invoice + 1 un-invoiced pharmacy order.
    const sources = bills.map(b => b.source).sort();
    expect(sources).toEqual(['invoice', 'pharmacy_order']);
  });

  it('orders by COALESCE(issued_at, created_at) DESC — the pharmacy order (newer) comes first', async () => {
    const bills = await listMyBills({ tenantId: TENANT, patient_uid: PATIENT_UID });
    expect(bills[0].source).toBe('pharmacy_order');
    expect(bills[1].source).toBe('invoice');
  });

  it('returns an empty array (not a 500) for a patient with no bills', async () => {
    const otherPatientUid = 'cbf22222-2222-4222-8222-bbbbbbbb2002';
    const bills = await listMyBills({ tenantId: TENANT, patient_uid: otherPatientUid });
    expect(Array.isArray(bills)).toBe(true);
    expect(bills.length).toBe(0);
  });
});
