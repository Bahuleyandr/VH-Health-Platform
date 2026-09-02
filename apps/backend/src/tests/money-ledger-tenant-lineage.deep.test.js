import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

async function withRollback(callback) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    await callback(client);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await client.end();
  }
}

async function seedLedgerParents(client) {
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const accountCode = `TL_${randomUUID().slice(0, 8)}`;
  const accountA = await client.query(
    `INSERT INTO ledger_accounts (tenant_id, code, type)
     VALUES ($1::uuid, $2::text, 'ASSET')
     RETURNING id`,
    [tenantA, `${accountCode}_A`]
  );
  const accountB = await client.query(
    `INSERT INTO ledger_accounts (tenant_id, code, type)
     VALUES ($1::uuid, $2::text, 'ASSET')
     RETURNING id`,
    [tenantB, `${accountCode}_B`]
  );
  const entryA = await client.query(
    `INSERT INTO ledger_entries (tenant_id, entry_type, idempotency_key)
     VALUES ($1::uuid, 'TENANT_LINEAGE_TEST', $2::text)
     RETURNING id`,
    [tenantA, randomUUID()]
  );
  const entryB = await client.query(
    `INSERT INTO ledger_entries (tenant_id, entry_type, idempotency_key)
     VALUES ($1::uuid, 'TENANT_LINEAGE_TEST', $2::text)
     RETURNING id`,
    [tenantB, randomUUID()]
  );

  return {
    tenantA,
    tenantB,
    accountA: accountA.rows[0].id,
    accountB: accountB.rows[0].id,
    entryA: entryA.rows[0].id,
    entryB: entryB.rows[0].id
  };
}

async function expectForeignKeyViolation(client, query, params, constraint) {
  await client.query('SAVEPOINT expected_fk_violation');
  try {
    await client.query(query, params);
    throw new Error(`expected ${constraint} to reject cross-tenant lineage`);
  } catch (error) {
    expect(error).toMatchObject({ code: '23503', constraint });
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT expected_fk_violation');
    await client.query('RELEASE SAVEPOINT expected_fk_violation');
  }
}

describe('ledger tenant-lineage constraints', () => {
  test('the tenant-qualified parent keys and four foreign keys are installed and validated', async () => {
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      const result = await client.query(
        `SELECT conname, convalidated,
                pg_get_constraintdef(oid) AS definition
           FROM pg_constraint
          WHERE conname = ANY($1::text[])
          ORDER BY conname`,
        [
          [
            'fk_ledger_balances_account_tenant',
            'fk_ledger_entries_reverses_entry_tenant',
            'fk_ledger_postings_account_tenant',
            'fk_ledger_postings_entry_tenant',
            'uq_ledger_accounts_tenant_id_id',
            'uq_ledger_entries_tenant_id_id'
          ]
        ]
      );

      expect(result.rows).toHaveLength(6);
      expect(result.rows.every(row => row.convalidated)).toBe(true);
      for (const row of result.rows.filter(({ conname }) => conname.startsWith('fk_'))) {
        expect(row.definition).toMatch(/FOREIGN KEY \(tenant_id, /);
        expect(row.definition).toMatch(/REFERENCES ledger_(?:accounts|entries)\(tenant_id, id\)/);
      }
      for (const row of result.rows.filter(({ conname }) => conname.startsWith('uq_'))) {
        expect(row.definition).toBe('UNIQUE (tenant_id, id)');
      }
    } finally {
      await client.end();
    }
  });

  test('cross-tenant reversal, posting, and balance links fail closed', async () => {
    await withRollback(async client => {
      const parents = await seedLedgerParents(client);

      await expectForeignKeyViolation(
        client,
        `INSERT INTO ledger_entries
           (tenant_id, entry_type, idempotency_key, reverses_entry_id)
         VALUES ($1::uuid, 'TENANT_LINEAGE_TEST', $2::text, $3::bigint)`,
        [parents.tenantB, randomUUID(), parents.entryA],
        'fk_ledger_entries_reverses_entry_tenant'
      );

      await expectForeignKeyViolation(
        client,
        `INSERT INTO ledger_postings
           (tenant_id, entry_id, account_id, amount_paise)
         VALUES ($1::uuid, $2::bigint, $3::bigint, 1)`,
        [parents.tenantB, parents.entryA, parents.accountB],
        'fk_ledger_postings_entry_tenant'
      );

      await expectForeignKeyViolation(
        client,
        `INSERT INTO ledger_postings
           (tenant_id, entry_id, account_id, amount_paise)
         VALUES ($1::uuid, $2::bigint, $3::bigint, 1)`,
        [parents.tenantB, parents.entryB, parents.accountA],
        'fk_ledger_postings_account_tenant'
      );

      await expectForeignKeyViolation(
        client,
        `INSERT INTO ledger_balances
           (tenant_id, account_id, patient_uid, balance_paise)
         VALUES ($1::uuid, $2::bigint, $3::uuid, 0)`,
        [parents.tenantB, parents.accountA, randomUUID()],
        'fk_ledger_balances_account_tenant'
      );
    });
  });

  test('same-tenant reversal, posting, and balance links remain accepted', async () => {
    await withRollback(async client => {
      const parents = await seedLedgerParents(client);

      const reversal = await client.query(
        `INSERT INTO ledger_entries
           (tenant_id, entry_type, idempotency_key, reverses_entry_id)
         VALUES ($1::uuid, 'TENANT_LINEAGE_TEST', $2::text, $3::bigint)
         RETURNING id`,
        [parents.tenantA, randomUUID(), parents.entryA]
      );
      expect(reversal.rows).toHaveLength(1);

      const postings = await client.query(
        `INSERT INTO ledger_postings
           (tenant_id, entry_id, account_id, amount_paise)
         VALUES
           ($1::uuid, $2::bigint, $3::bigint, 100),
           ($1::uuid, $2::bigint, $3::bigint, -100)
         RETURNING id`,
        [parents.tenantA, parents.entryA, parents.accountA]
      );
      expect(postings.rows).toHaveLength(2);

      const balance = await client.query(
        `INSERT INTO ledger_balances
           (tenant_id, account_id, patient_uid, balance_paise)
         VALUES ($1::uuid, $2::bigint, $3::uuid, 0)
         RETURNING id`,
        [parents.tenantA, parents.accountA, randomUUID()]
      );
      expect(balance.rows).toHaveLength(1);

      await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    });
  });
});
