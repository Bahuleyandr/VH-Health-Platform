// Regression for swarm D58 / f9007a9c.
//
// Issued IPD ward pharmacy indents have item-level quantity + price, but
// the admission invoice itemizer skipped ward_indents entirely. A final
// IPD bill could therefore miss medicines/consumables issued from stores
// to the ward. This suite keeps that billing link traceable via
// source_ref_type='ward_indent'.

import prisma from '../lib/prisma.js';
import { itemizeAdmissionInvoice } from '../services/billing/billingV2Service.js';
import { deleteWithAuditBypass } from './helpers/auditBypass.js';

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = 'd5800000-0000-4000-8000-000000000001';
const STAFF_UID = 'd5800000-0000-4000-8000-000000000002';
const ENCOUNTER_ID = 'd5800000-0000-4000-8000-000000000003';
const RECEIVER_UID = 'd5800000-0000-4000-8000-000000000004';
const RUN_SUFFIX = String(Date.now() % 100000).padStart(5, '0');

let admissionId;
let invoiceId;
let indentId;

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM billing_invoices WHERE patient_uid = $1::uuid`,
    PATIENT_UID,
  ).catch(() => {});
  await deleteWithAuditBypass(
    prisma,
    `DELETE FROM ward_indent_events event
      USING ward_indents indent
      WHERE event.tenant_id = indent.tenant_id
        AND event.ward_indent_id = indent.id
        AND indent.tenant_id = $1::uuid
        AND indent.patient_uid = $2::uuid`,
    TENANT,
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
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE tenant_id = $1::uuid AND uid = $2::uuid`,
    TENANT,
    PATIENT_UID,
  ).catch(() => {});
}

describe('billing admission itemizer — issued ward indent charges (D58)', () => {
  beforeAll(async () => {
    await cleanup();

    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, tenant_id, name, role, is_active, status, updated_at)
       VALUES ($1::uuid, $2::uuid, 'D58 Patient', 'PATIENT', TRUE, 'active', NOW())`,
      PATIENT_UID,
      TENANT,
    );

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

    indentId = await prisma.$transaction(async (tx) => {
      const indentRows = await tx.$queryRawUnsafe(
        `INSERT INTO ward_indents
           (indent_number, ward_name, admission_id, encounter_id, patient_uid,
            indent_type, status, requested_by, approved_by, approved_at,
            issued_by, issued_at, tenant_id)
         VALUES ($1, 'D58 Medical Ward', $2::int, $3::uuid, $4::uuid,
                 'pharmacy', 'issued', $5::uuid, $5::uuid, NOW() - INTERVAL '30 minutes',
                 $5::uuid, NOW() - INTERVAL '20 minutes', $6::uuid)
         RETURNING id, state_version, status, owner_role_codes`,
        `WI-D58-${RUN_SUFFIX}`,
        admissionId,
        ENCOUNTER_ID,
        PATIENT_UID,
        STAFF_UID,
        TENANT,
      );
      const row = indentRows[0];
      await tx.$executeRawUnsafe(
        `INSERT INTO ward_indent_events
           (tenant_id, ward_indent_id, state_version, action, to_status,
            actor_uid, owner_role_codes, details)
         VALUES ($1::uuid, $2::int, $3::int, 'billing_fixture_issued', $4,
                 $5::uuid, $6::text[], '{"test_fixture":true}'::jsonb)`,
        TENANT,
        Number(row.id),
        Number(row.state_version),
        row.status,
        STAFF_UID,
        row.owner_role_codes,
      );
      return Number(row.id);
    });

    await prisma.$executeRawUnsafe(
      `INSERT INTO ward_indent_items
         (ward_indent_id, item_name, quantity_requested, quantity_reserved,
          quantity_approved, quantity_issued, fulfilment_status, unit, unit_price,
          tenant_id)
       VALUES
         ($1::int, 'Pantoprazole 40mg Injection', 2, 2, 2, 2, 'issued',
          'vial', 45, $2::uuid),
         ($1::int, 'Normal Saline 500ml', 1, 1, 1, 1, 'issued',
          'bottle', 35, $2::uuid)`,
      indentId,
      TENANT,
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

    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `UPDATE ward_indent_items
            SET quantity_received = quantity_issued,
                fulfilment_status = 'received',
                updated_at = NOW()
          WHERE ward_indent_id = $1::int`,
        indentId,
      );
      const received = (await tx.$queryRawUnsafe(
        `UPDATE ward_indents
            SET status = 'received',
                state_version = state_version + 1,
                active_sla_source_id = CONCAT('ward-indent:', id, ':v', state_version + 1),
                received_by = $1::uuid,
                received_at = NOW(),
                last_transition_at = NOW(),
                updated_at = NOW()
          WHERE id = $2::int
        RETURNING id, state_version, status, owner_role_codes`,
        RECEIVER_UID,
        indentId,
      ))[0];
      await tx.$executeRawUnsafe(
        `INSERT INTO ward_indent_events
           (tenant_id, ward_indent_id, state_version, action, from_status,
             to_status, actor_uid, owner_role_codes, details)
          VALUES ($1::uuid, $2::int, $3::int, 'billing_fixture_received', 'issued',
                  $4, $5::uuid, $6::text[], '{"test_fixture":true}'::jsonb)`,
        TENANT,
        indentId,
        Number(received.state_version),
        received.status,
        RECEIVER_UID,
        received.owner_role_codes,
      );

      await tx.$executeRawUnsafe(
        `UPDATE ward_indent_items
            SET quantity_return_requested = 1,
                fulfilment_status = 'return_pending',
                updated_at = NOW()
          WHERE ward_indent_id = $1::int
            AND item_name = 'Pantoprazole 40mg Injection'`,
        indentId,
      );
      const returnPending = (await tx.$queryRawUnsafe(
        `UPDATE ward_indents
            SET status = 'return_pending',
                state_version = state_version + 1,
                active_sla_source_id = CONCAT('ward-indent:', id, ':v', state_version + 1),
                return_requested_by = $1::uuid,
                return_requested_at = NOW(),
                reconciliation_reason = 'One unused vial returned',
                last_transition_at = NOW(),
                updated_at = NOW()
          WHERE id = $2::int
        RETURNING id, state_version, status, owner_role_codes`,
        STAFF_UID,
        indentId,
      ))[0];
      await tx.$executeRawUnsafe(
        `INSERT INTO ward_indent_events
           (tenant_id, ward_indent_id, state_version, action, from_status,
            to_status, actor_uid, owner_role_codes, details)
         VALUES ($1::uuid, $2::int, $3::int, 'billing_fixture_return_requested', 'received',
                 $4, $5::uuid, $6::text[], '{"test_fixture":true}'::jsonb)`,
        TENANT,
        indentId,
        Number(returnPending.state_version),
        returnPending.status,
        STAFF_UID,
        returnPending.owner_role_codes,
      );

      await tx.$executeRawUnsafe(
        `UPDATE ward_indent_items
            SET quantity_returned = quantity_return_requested,
                fulfilment_status = 'reconciled',
                updated_at = NOW()
          WHERE ward_indent_id = $1::int`,
        indentId,
      );
      const transitioned = (await tx.$queryRawUnsafe(
        `UPDATE ward_indents
            SET status = 'reconciled',
                state_version = state_version + 1,
                active_sla_source_id = CONCAT('ward-indent:', id, ':v', state_version + 1),
                reconciled_by = $1::uuid,
                reconciled_at = NOW(),
                last_transition_at = NOW(),
                updated_at = NOW()
          WHERE id = $2::int
        RETURNING id, state_version, status, owner_role_codes`,
        STAFF_UID,
        indentId,
      ))[0];
      await tx.$executeRawUnsafe(
        `INSERT INTO ward_indent_events
           (tenant_id, ward_indent_id, state_version, action, from_status,
            to_status, actor_uid, owner_role_codes, details)
         VALUES ($1::uuid, $2::int, $3::int, 'billing_fixture_reconciled', 'return_pending',
                 $4, $5::uuid, $6::text[], '{"test_fixture":true}'::jsonb)`,
        TENANT,
        indentId,
        Number(transitioned.state_version),
        transitioned.status,
        STAFF_UID,
        transitioned.owner_role_codes,
      );
    });

    const synchronized = await itemizeAdmissionInvoice(invoiceId, {
      emit_package: false,
      emit_pharmacy: false,
      emit_ward_indents: true,
      emit_lab: false,
      emit_consults: false,
      emit_theatre: false,
    });
    expect(synchronized.summary).toMatchObject({
      ward_indents: 0,
      ward_indents_updated: 1,
    });
    const synchronizedRows = await prisma.$queryRawUnsafe(
      `SELECT id, unit_price, line_total, notes, tpa_decision
         FROM billing_invoice_items
        WHERE invoice_id = $1::int
          AND source_ref_type = 'ward_indent'
          AND source_ref_id = $2::bigint`,
      invoiceId,
      indentId,
    );
    expect(synchronizedRows).toHaveLength(1);
    expect(synchronizedRows[0].id).toBe(rows[0].id);
    expect(Number(synchronizedRows[0].unit_price)).toBe(80);
    expect(Number(synchronizedRows[0].line_total)).toBe(80);
    expect(synchronizedRows[0].notes).toContain('Pantoprazole 40mg Injection x 1');
    expect(synchronizedRows[0].tpa_decision).toBe('pending');

    const synchronizedInvoice = await prisma.$queryRawUnsafe(
      `SELECT subtotal, total_amount, amount_due
         FROM billing_invoices
        WHERE id = $1::int`,
      invoiceId,
    );
    expect(Number(synchronizedInvoice[0].subtotal)).toBe(80);
    expect(Number(synchronizedInvoice[0].total_amount)).toBe(80);
    expect(Number(synchronizedInvoice[0].amount_due)).toBe(80);
  });
});
