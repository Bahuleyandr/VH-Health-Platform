import { Client } from 'pg';

import prisma from '../lib/prisma.js';
import {
  addInvoiceItem,
  createDraftInvoice,
  issueInvoice,
  voidInvoice,
} from '../services/billing/billingV2Service.js';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;
const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT = '56600000-0000-4000-8000-00000000a0f1';
const ACTOR = '56600000-0000-4000-8000-00000000a0f2';

describeIfDb('billing item add versus invoice void atomicity', () => {
  beforeAll(async () => {
    await prisma.$executeRawUnsafe(
      `DELETE FROM billing_invoice_items
        WHERE invoice_id IN (
          SELECT id FROM billing_invoices WHERE patient_uid = $1::uuid
        )`,
      PATIENT,
    );
    await prisma.$executeRawUnsafe(
      'DELETE FROM billing_invoices WHERE patient_uid = $1::uuid',
      PATIENT,
    );
    await prisma.$executeRawUnsafe('DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)', PATIENT, ACTOR);
    await prisma.$queryRawUnsafe(
      `INSERT INTO users
         (tenant_id, uid, phone, name, role, is_active, status, updated_at)
       VALUES
         ($1::uuid, $2::uuid, '9011776501', 'Billing race patient',
          'PATIENT', TRUE, 'active', NOW()),
         ($1::uuid, $3::uuid, '9011776502', 'Billing race actor',
          'BILLING_STAFF', TRUE, 'active', NOW())`,
      TENANT,
      PATIENT,
      ACTOR,
    );
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      `DELETE FROM billing_invoice_items
        WHERE invoice_id IN (
          SELECT id FROM billing_invoices WHERE patient_uid = $1::uuid
        )`,
      PATIENT,
    );
    await prisma.$executeRawUnsafe(
      'DELETE FROM billing_invoices WHERE patient_uid = $1::uuid',
      PATIENT,
    );
    await prisma.$executeRawUnsafe('DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)', PATIENT, ACTOR);
  });

  test('a queued add cannot create an active line after void commits', async () => {
    const invoice = await createDraftInvoice({
      tenantId: TENANT,
      patient_uid: PATIENT,
      patient_name: 'Billing race patient',
      department: 'Cath Lab',
      invoice_type: 'OP',
      created_by: ACTOR,
    });
    const blocker = new Client({ connectionString: databaseUrl });
    await blocker.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query(
        'SELECT id FROM billing_invoices WHERE id = $1::int FOR UPDATE',
        [invoice.id],
      );

      const voidPromise = voidInvoice(invoice.id, {
        tenantId: TENANT,
        reason: 'Concurrent void regression',
        voided_by: ACTOR,
      });
      await new Promise(resolve => setTimeout(resolve, 100));
      const addPromise = addInvoiceItem(invoice.id, {
        tenantId: TENANT,
        description: 'Must not land after void',
        unit_price: 100,
        gst_rate: 0,
      }).then(
        value => ({ ok: true, value }),
        error => ({ ok: false, error }),
      );
      await new Promise(resolve => setTimeout(resolve, 100));
      await blocker.query('COMMIT');

      await expect(voidPromise).resolves.toMatchObject({ status: 'VOID' });
      await expect(addPromise).resolves.toMatchObject({
        ok: false,
        error: { statusCode: 400 },
      });
      const [state] = await prisma.$queryRawUnsafe(
        `SELECT invoice.status,
                COUNT(item.id) FILTER (WHERE item.source_ref_active)::int AS active_lines
           FROM billing_invoices invoice
           LEFT JOIN billing_invoice_items item
             ON item.invoice_id = invoice.id
            AND item.tenant_id = invoice.tenant_id
          WHERE invoice.id = $1::int
            AND invoice.tenant_id = $2::uuid
          GROUP BY invoice.status`,
        invoice.id,
        TENANT,
      );
      expect(state).toEqual({ status: 'VOID', active_lines: 0 });
    } finally {
      await blocker.query('ROLLBACK').catch(() => {});
      await blocker.end();
    }
  }, 30_000);

  test('a queued issue cannot resurrect an invoice after void commits', async () => {
    const invoice = await createDraftInvoice({
      tenantId: TENANT,
      patient_uid: PATIENT,
      patient_name: 'Billing race patient',
      department: 'Cath Lab',
      invoice_type: 'OP',
      created_by: ACTOR,
    });
    await addInvoiceItem(invoice.id, {
      tenantId: TENANT,
      description: 'Issue versus void line',
      unit_price: 100,
      gst_rate: 0,
    });
    const blocker = new Client({ connectionString: databaseUrl });
    await blocker.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query(
        'SELECT id FROM billing_invoices WHERE id = $1::int FOR UPDATE',
        [invoice.id],
      );

      const voidPromise = voidInvoice(invoice.id, {
        tenantId: TENANT,
        reason: 'Concurrent issue regression',
        voided_by: ACTOR,
      });
      await new Promise(resolve => setTimeout(resolve, 100));
      const issuePromise = issueInvoice(invoice.id, { tenantId: TENANT }).then(
        value => ({ ok: true, value }),
        error => ({ ok: false, error }),
      );
      await new Promise(resolve => setTimeout(resolve, 100));
      await blocker.query('COMMIT');

      await expect(voidPromise).resolves.toMatchObject({ status: 'VOID' });
      await expect(issuePromise).resolves.toMatchObject({
        ok: false,
        error: { statusCode: 400 },
      });
      const [state] = await prisma.$queryRawUnsafe(
        `SELECT invoice.status, invoice.issued_at,
                COUNT(item.id) FILTER (WHERE item.source_ref_active)::int AS active_lines
           FROM billing_invoices invoice
           LEFT JOIN billing_invoice_items item
             ON item.invoice_id = invoice.id
            AND item.tenant_id = invoice.tenant_id
          WHERE invoice.id = $1::int
            AND invoice.tenant_id = $2::uuid
          GROUP BY invoice.status, invoice.issued_at`,
        invoice.id,
        TENANT,
      );
      expect(state).toEqual({ status: 'VOID', issued_at: null, active_lines: 0 });
    } finally {
      await blocker.query('ROLLBACK').catch(() => {});
      await blocker.end();
    }
  }, 30_000);
});
