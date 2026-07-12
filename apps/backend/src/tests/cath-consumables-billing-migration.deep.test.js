import { readFileSync } from 'node:fs';

import { Client } from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;
const TENANT_A = '00000000-0000-4000-8000-000000000001';
const TENANT_B = '00000000-0000-4000-8000-000000005662';
const PATIENT_A = '56600000-0000-4000-8000-00000000a001';
const migrationSql = readFileSync(
  new URL('../migrations/566_cath_consumables_billing_hook.sql', import.meta.url),
  'utf8',
);

describeIfDb('NL-13 P1d billing migration 566', () => {
  test('repairs historical child-tenant drift before rebuilding idempotent source indexes', async () => {
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO tenants (id, slug, name)
         VALUES ($1::uuid, 'nl13-p1d-migration-566', 'NL13 P1d Migration 566')`,
        [TENANT_B],
      );
      await client.query(
        `INSERT INTO users
           (tenant_id, uid, phone, name, role, is_active, status, updated_at)
         VALUES
           ($1::uuid, $2::uuid, '9011776566', 'Migration 566 Patient',
            'PATIENT', TRUE, 'active', NOW())`,
        [TENANT_A, PATIENT_A],
      );
      const invoice = await client.query(
        `INSERT INTO billing_invoices
           (tenant_id, patient_uid, invoice_type, department, status)
         VALUES ($1::uuid, $2::uuid, 'OP', 'Cath Lab', 'VOID')
         RETURNING id`,
        [TENANT_A, PATIENT_A],
      );
      const item = await client.query(
        `INSERT INTO billing_invoice_items
           (invoice_id, description, quantity, unit_price, line_subtotal,
            line_total, source_ref_type, tenant_id)
         VALUES ($1::int, 'Historical tenant drift', 1, 1, 1, 1, 'manual', $2::uuid)
         RETURNING id`,
        [invoice.rows[0].id, TENANT_B],
      );
      const issuedInvoice = await client.query(
        `INSERT INTO billing_invoices
           (tenant_id, patient_uid, invoice_type, department, status, issued_at)
         VALUES ($1::uuid, $2::uuid, 'OP', 'Cath Lab', 'VOID', NOW())
         RETURNING id`,
        [TENANT_A, PATIENT_A],
      );
      const issuedItem = await client.query(
        `INSERT INTO billing_invoice_items
           (invoice_id, description, quantity, unit_price, line_subtotal,
            line_total, source_ref_type, tenant_id)
         VALUES ($1::int, 'Historical issued source', 1, 1, 1, 1, 'manual', $2::uuid)
         RETURNING id`,
        [issuedInvoice.rows[0].id, TENANT_B],
      );

      const before = await client.query(
        'SELECT tenant_id FROM billing_invoice_items WHERE id = $1::int',
        [item.rows[0].id],
      );
      expect(before.rows[0].tenant_id).toBe(TENANT_B);

      await client.query(migrationSql);
      const repaired = await client.query(
        'SELECT tenant_id, source_ref_active FROM billing_invoice_items WHERE id = $1::int',
        [item.rows[0].id],
      );
      expect(repaired.rows[0].tenant_id).toBe(TENANT_A);
      expect(repaired.rows[0].source_ref_active).toBe(false);
      const issuedRepaired = await client.query(
        'SELECT tenant_id, source_ref_active FROM billing_invoice_items WHERE id = $1::int',
        [issuedItem.rows[0].id],
      );
      expect(issuedRepaired.rows[0].tenant_id).toBe(TENANT_A);
      expect(issuedRepaired.rows[0].source_ref_active).toBe(true);

      await client.query(migrationSql);
      const indexes = await client.query(
        `SELECT indexname, indexdef
           FROM pg_indexes
          WHERE schemaname = 'public'
            AND indexname IN (
              'ux_billing_invoice_items_dialysis_session',
              'ux_billing_invoice_items_cath_procedure',
              'ux_billing_invoice_items_cath_consumable'
            )
          ORDER BY indexname`,
      );
      expect(indexes.rows).toHaveLength(3);
      for (const row of indexes.rows) {
        expect(row.indexdef).toContain('(tenant_id, source_ref_type, source_ref_id)');
        expect(row.indexdef).toContain('source_ref_active');
      }
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      await client.end();
    }
  }, 30_000);
});
