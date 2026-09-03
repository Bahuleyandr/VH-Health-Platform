import { jest } from '@jest/globals';

import {
  getAccountBalancePaise,
  postLedgerEntry,
} from '../../services/billing/ledger/ledgerService.js';

const TENANT = '00000000-0000-4000-8000-0000000003a1';

function compactSql(value) {
  return String(value).replace(/\s+/g, ' ').trim();
}

describe('ledgerService explicit tenant scope', () => {
  it('binds the tenant on the entry, account lookup, and every posting', async () => {
    let nextAccountId = 40n;
    const queryRawUnsafe = jest.fn(async (sql) => {
      if (String(sql).includes('INSERT INTO ledger_entries')) return [{ id: 31n }];
      if (String(sql).includes('SELECT id FROM ledger_accounts')) {
        nextAccountId += 1n;
        return [{ id: nextAccountId }];
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
    const executeRawUnsafe = jest.fn(async () => 1);
    const tx = { $queryRawUnsafe: queryRawUnsafe, $executeRawUnsafe: executeRawUnsafe };

    await postLedgerEntry(tx, {
      tenantId: TENANT,
      entryType: 'PAYMENT',
      idempotencyKey: 'tenant-bound-payment',
      lines: [
        { accountCode: 'BANK', amountPaise: 30000 },
        { accountCode: 'PATIENT_AR', amountPaise: -30000, invoice_id: 71 },
      ],
    });

    expect(compactSql(queryRawUnsafe.mock.calls[0][0])).toContain(
      'INSERT INTO ledger_entries (tenant_id, entry_type, occurred_at, created_by, idempotency_key, metadata)',
    );
    expect(queryRawUnsafe.mock.calls[0].slice(1)).toEqual([
      TENANT, 'PAYMENT', null, null, 'tenant-bound-payment', '{}',
    ]);
    for (const call of queryRawUnsafe.mock.calls.slice(1)) {
      expect(compactSql(call[0])).toContain(
        'WHERE tenant_id = $1::uuid AND code = $2',
      );
      expect(call[1]).toBe(TENANT);
    }
    expect(executeRawUnsafe).toHaveBeenCalledTimes(2);
    for (const call of executeRawUnsafe.mock.calls) {
      expect(compactSql(call[0])).toContain(
        '(tenant_id, entry_id, account_id, amount_paise, patient_uid, invoice_id, advance_id, payment_id, cash_drawer_session_id)',
      );
      expect(call[1]).toBe(TENANT);
    }
  });

  it('aggregates only balances whose balance and account tenants match the requested tenant', async () => {
    const queryRawUnsafe = jest.fn(async () => [{ bal: 30000n }]);
    const tx = { $queryRawUnsafe: queryRawUnsafe };

    await expect(getAccountBalancePaise(tx, TENANT, 'BANK')).resolves.toBe(30000);

    const [sql, ...params] = queryRawUnsafe.mock.calls[0];
    const compact = compactSql(sql);
    expect(compact).toContain('a.tenant_id = b.tenant_id');
    expect(compact).toContain('b.tenant_id = $1::uuid');
    expect(compact).toContain('a.tenant_id = $1::uuid');
    expect(params).toEqual([TENANT, 'BANK', null, null, null]);
  });

  it('rejects an omitted tenant before issuing any query', async () => {
    const tx = {
      $queryRawUnsafe: jest.fn(),
      $executeRawUnsafe: jest.fn(),
    };
    const lines = [
      { accountCode: 'BANK', amountPaise: 1 },
      { accountCode: 'PATIENT_AR', amountPaise: -1 },
    ];

    await expect(postLedgerEntry(tx, { entryType: 'PAYMENT', lines }))
      .rejects.toMatchObject({ code: 'TENANT_CONTEXT_REQUIRED' });
    await expect(getAccountBalancePaise(tx, null, 'BANK'))
      .rejects.toMatchObject({ code: 'TENANT_CONTEXT_REQUIRED' });
    expect(tx.$queryRawUnsafe).not.toHaveBeenCalled();
    expect(tx.$executeRawUnsafe).not.toHaveBeenCalled();
  });
});
