// apps/backend/src/tests/money-ledger-substrate.deep.test.js
//
// Phase-1 invariant proofs against the real Postgres engine (the concurrency +
// trigger + CHECK behaviour needs a real DB — prisma is NOT mocked).
import { randomUUID } from 'node:crypto';
import prisma, { setTenantTx } from '../lib/prisma.js';
import { postLedgerEntry, getAccountBalancePaise } from '../services/billing/ledger/ledgerService.js';

const TENANT = '00000000-0000-4000-8000-000000000001';

// helper: run a fn inside a default-tenant tx
const inTx = (fn) => setTenantTx(TENANT, fn);

afterAll(async () => {
  await prisma.$disconnect().catch(() => {});
});

describe('Invariant 1 — postings net to zero', () => {
  it('accepts a balanced entry', async () => {
    // CASH debit + REVENUE credit: both increase in normal direction, so this
    // proves balanced-acceptance without needing a prior receivable (a standalone
    // credit to PATIENT_AR would correctly trip the no-negative trigger).
    const { entryId } = await inTx((tx) => postLedgerEntry(tx, {
      tenantId: TENANT,
      entryType: 'PAYMENT', idempotencyKey: `t-${randomUUID()}`,
      lines: [
        { accountCode: 'CASH', amountPaise: 100000 },
        { accountCode: 'REVENUE', amountPaise: -100000 },
      ],
    }));
    expect(entryId).toBeGreaterThan(0);
  });

  it('app-side rejects an unbalanced entry before it hits the DB', async () => {
    await expect(inTx((tx) => postLedgerEntry(tx, {
      tenantId: TENANT,
      entryType: 'PAYMENT', idempotencyKey: `t-${randomUUID()}`,
      lines: [
        { accountCode: 'CASH', amountPaise: 100000 },
        { accountCode: 'PATIENT_AR', amountPaise: -90000, patient_uid: randomUUID(), invoice_id: 1 },
      ],
    }))).rejects.toMatchObject({ code: 'LEDGER_UNBALANCED' });
  });

  it('the DB deferred trigger rejects an unbalanced entry inserted directly (bypassing the helper)', async () => {
    await expect(inTx(async (tx) => {
      const e = await tx.$queryRawUnsafe(
        `INSERT INTO ledger_entries (entry_type, idempotency_key) VALUES ('RAW', $1) RETURNING id`,
        `raw-${randomUUID()}`,
      );
      const eid = Number(e[0].id);
      const cash = await tx.$queryRawUnsafe(`SELECT id FROM ledger_accounts WHERE code='CASH'`);
      // single unbalanced posting (sum = 100000 != 0) — must fail at COMMIT
      await tx.$executeRawUnsafe(
        `INSERT INTO ledger_postings (entry_id, account_id, amount_paise) VALUES ($1::bigint, $2::bigint, 100000)`,
        eid, Number(cash[0].id),
      );
    })).rejects.toThrow(/unbalanced/i);
  });
});

describe('Invariant 2 — no-negative (bug-class killers)', () => {
  async function issueAr(patient, invoiceId, paise) {
    // debit PATIENT_AR (receivable up), credit REVENUE
    return inTx((tx) => postLedgerEntry(tx, {
      tenantId: TENANT,
      entryType: 'INVOICE_ISSUE', idempotencyKey: `iss-${randomUUID()}`,
      lines: [
        { accountCode: 'PATIENT_AR', amountPaise: paise, patient_uid: patient, invoice_id: invoiceId },
        { accountCode: 'REVENUE', amountPaise: -paise },
      ],
    }));
  }

  it('overpayment is uncommittable (PATIENT_AR cannot go below zero)', async () => {
    const patient = randomUUID();
    const invoice = Math.floor(1e8 + Math.random() * 1e8);
    await issueAr(patient, invoice, 100000); // owe 1000.00
    // pay 1200.00 against a 1000.00 receivable → AR normal balance would be -200.00
    await expect(inTx((tx) => postLedgerEntry(tx, {
      tenantId: TENANT,
      entryType: 'PAYMENT', idempotencyKey: `op-${randomUUID()}`,
      lines: [
        { accountCode: 'CASH', amountPaise: 120000 },
        { accountCode: 'PATIENT_AR', amountPaise: -120000, patient_uid: patient, invoice_id: invoice },
      ],
    }))).rejects.toThrow(/no-negative|overpayment/i);
    // and the receivable is untouched (the whole tx rolled back)
    const bal = await inTx((tx) => getAccountBalancePaise(tx, TENANT, 'PATIENT_AR', { patient_uid: patient, invoice_id: invoice }));
    expect(bal).toBe(100000);
  });

  it('concurrent full payments cannot both succeed (lost-update closed by the balance row-lock)', async () => {
    const patient = randomUUID();
    const invoice = Math.floor(1e8 + Math.random() * 1e8);
    await issueAr(patient, invoice, 50000); // owe 500.00
    const pay = () => inTx((tx) => postLedgerEntry(tx, {
      tenantId: TENANT,
      entryType: 'PAYMENT', idempotencyKey: `c-${randomUUID()}`,
      lines: [
        { accountCode: 'CASH', amountPaise: 50000 },
        { accountCode: 'PATIENT_AR', amountPaise: -50000, patient_uid: patient, invoice_id: invoice },
      ],
    }));
    const results = await Promise.allSettled([pay(), pay()]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const bal = await inTx((tx) => getAccountBalancePaise(tx, TENANT, 'PATIENT_AR', { patient_uid: patient, invoice_id: invoice }));
    expect(bal).toBe(0); // exactly paid off, never negative
  });
});

describe('Invariant 3 — append-only', () => {
  it('UPDATE and DELETE on postings are blocked', async () => {
    const { entryId } = await inTx((tx) => postLedgerEntry(tx, {
      tenantId: TENANT,
      entryType: 'PAYMENT', idempotencyKey: `ao-${randomUUID()}`,
      lines: [
        { accountCode: 'CASH', amountPaise: 1000 },
        { accountCode: 'REVENUE', amountPaise: -1000 },
      ],
    }));
    await expect(
      prisma.$executeRawUnsafe(`UPDATE ledger_postings SET amount_paise = 1 WHERE entry_id = $1::bigint`, entryId),
    ).rejects.toThrow(/append-only/i);
    await expect(
      prisma.$executeRawUnsafe(`DELETE FROM ledger_entries WHERE id = $1::bigint`, entryId),
    ).rejects.toThrow(/append-only/i);
  });
});

describe('idempotency', () => {
  it('replaying the same idempotency_key is a conflict, not a double-post', async () => {
    const key = `idem-${randomUUID()}`;
    const lines = [
      { accountCode: 'CASH', amountPaise: 2500 },
      { accountCode: 'REVENUE', amountPaise: -2500 },
    ];
    await inTx((tx) => postLedgerEntry(tx, { tenantId: TENANT, entryType: 'PAYMENT', idempotencyKey: key, lines }));
    await expect(inTx((tx) => postLedgerEntry(tx, { tenantId: TENANT, entryType: 'PAYMENT', idempotencyKey: key, lines })))
      .rejects.toMatchObject({ code: 'LEDGER_DUPLICATE' });
  });
});
