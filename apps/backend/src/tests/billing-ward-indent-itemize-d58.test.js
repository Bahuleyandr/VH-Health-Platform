// Regression for swarm D58 / f9007a9c.
//
// Issued IPD ward pharmacy indents have item-level quantity + price, but
// the admission invoice itemizer skipped ward_indents entirely. A final
// IPD bill could therefore miss medicines/consumables issued from stores
// to the ward. This suite keeps that billing link traceable via
// source_ref_type='ward_indent'.

import prisma from '../lib/prisma.js';
import { itemizeAdmissionInvoice } from '../services/billing/billingV2Service.js';

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = 'd5800000-0000-4000-8000-000000000001';
const STAFF_UID = 'd5800000-0000-4000-8000-000000000002';
const ENCOUNTER_ID = 'd5800000-0000-4000-8000-000000000003';
const RUN_SUFFIX = String(Date.now() % 100000).padStart(5, '0');

let admissionId;
let invoiceId;
let indentId;

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM billing_invoices WHERE patient_uid = $1::uuid`,
    PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM ward_indents WHERE patient_uid = $1::uuid`,
    PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM admissions WHERE patient_uid = $1::uuid`,
    PATIENT_UID,
  ).catch(() => {});
}

describe('billing admission itemizer — issued ward indent charges (D58)', () => {
  beforeAll(async () => {
    await cleanup();

    const admissionRows = await prisma.$queryRawUnsafe(
      `INSERT INTO admissions
         (patient_uid, encounter_id, status, admitted_at, ward, tenant_id)
       VALUES ($1::uuid, $2::uuid, 'admitted', NOW() - INTERVAL '2 hours',
               'D58 Medical Ward', $3::uuid)
       RETURNING id`,
      PATIENT_UID,
      ENCOUNTER_ID,
      TENANT,
    );
    admissionId = admissionRows[0].id;

    const invoiceRows = await prisma.$queryRawUnsafe(
      `INSERT INTO billing_invoices
         (invoice_number, patient_uid, admission_id, invoice_type, status, tenant_id)
       VALUES ($1, $2::uuid, $3::int, 'IP', 'DRAFT', $4::uuid)
       RETURNING id`,
      `INV-D58-${RUN_SUFFIX}`,
      PATIENT_UID,
      admissionId,
      TENANT,
    );
    invoiceId = invoiceRows[0].id;

    const indentRows = await prisma.$queryRawUnsafe(
      `INSERT INTO ward_indents
         (indent_number, ward_name, admission_id, encounter_id, patient_uid,
          indent_type, status, requested_by, approved_by, approved_at,
          issued_by, issued_at, tenant_id)
       VALUES ($1, 'D58 Medical Ward', $2::int, $3::uuid, $4::uuid,
               'pharmacy', 'issued', $5::uuid, $5::uuid, NOW() - INTERVAL '30 minutes',
               $5::uuid, NOW() - INTERVAL '20 minutes', $6::uuid)
       RETURNING id`,
      `WI-D58-${RUN_SUFFIX}`,
      admissionId,
      ENCOUNTER_ID,
      PATIENT_UID,
      STAFF_UID,
      TENANT,
    );
    indentId = indentRows[0].id;

    await prisma.$executeRawUnsafe(
      `INSERT INTO ward_indent_items
         (ward_indent_id, item_name, quantity_requested, quantity_issued, unit, unit_price)
       VALUES
         ($1::int, 'Pantoprazole 40mg Injection', 2, 2, 'vial', 45),
         ($1::int, 'Normal Saline 500ml', 1, 1, 'bottle', 35)`,
      indentId,
    );
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  });

  it('creates one traceable pharmacy invoice line for an issued ward indent and stays idempotent', async () => {
    const first = await itemizeAdmissionInvoice(invoiceId, {
      decided_by: STAFF_UID,
      emit_package: false,
      emit_pharmacy: false,
      emit_ward_indents: true,
      emit_lab: false,
      emit_consults: false,
      emit_theatre: false,
    });

    expect(first.summary.ward_indents).toBe(1);

    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, category, description, quantity, unit_price, line_subtotal,
              line_total, notes, source_ref_type, source_ref_id, tpa_decision
         FROM billing_invoice_items
        WHERE invoice_id = $1::int
          AND source_ref_type = 'ward_indent'
          AND source_ref_id = $2::bigint`,
      invoiceId,
      indentId,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      category: 'pharmacy',
      source_ref_type: 'ward_indent',
      source_ref_id: BigInt(indentId),
      tpa_decision: 'pending',
    });
    expect(rows[0].description).toContain('Pharmacy ward indent');
    expect(rows[0].notes).toContain('Pantoprazole 40mg Injection x 2');
    expect(rows[0].notes).toContain('Normal Saline 500ml x 1');
    expect(Number(rows[0].quantity)).toBe(1);
    expect(Number(rows[0].unit_price)).toBe(125);
    expect(Number(rows[0].line_subtotal)).toBe(125);
    expect(Number(rows[0].line_total)).toBe(125);

    const invoiceRows = await prisma.$queryRawUnsafe(
      `SELECT subtotal, total_amount, amount_due
         FROM billing_invoices
        WHERE id = $1::int`,
      invoiceId,
    );
    expect(Number(invoiceRows[0].subtotal)).toBe(125);
    expect(Number(invoiceRows[0].total_amount)).toBe(125);
    expect(Number(invoiceRows[0].amount_due)).toBe(125);

    const second = await itemizeAdmissionInvoice(invoiceId, {
      emit_package: false,
      emit_pharmacy: false,
      emit_ward_indents: true,
      emit_lab: false,
      emit_consults: false,
      emit_theatre: false,
    });
    expect(second.summary.ward_indents).toBe(0);
    expect(second.summary.skipped_existing).toBe(1);

    const countRows = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS count
         FROM billing_invoice_items
        WHERE invoice_id = $1::int
          AND source_ref_type = 'ward_indent'
          AND source_ref_id = $2::int`,
      invoiceId,
      indentId,
    );
    expect(countRows[0].count).toBe(1);
  });
});
