// apps/backend/src/services/billing/ledger/ledgerService.js
//
// The ONE writer into the double-entry ledger. Every money movement calls
// postLedgerEntry INSIDE its existing setTenantTx so the posting is atomic with
// the legacy billing write. Amounts are integer paise. The DB enforces
// balance/no-negative/append-only; this layer validates app-side (defense in
// depth) and resolves account codes to ids.
//
// Spec: docs/superpowers/specs/2026-06-23-double-entry-money-ledger-design.md
import { AppError } from '../../../utils/AppError.js';
import { assertWholePaise } from '../../../utils/money.js';

const DIMENSION_COLS = ['patient_uid', 'invoice_id', 'advance_id', 'payment_id', 'cash_drawer_session_id'];

function requireLedgerTenantId(tenantId) {
  if (!tenantId) {
    throw AppError.forbidden('Tenant context required', 'TENANT_CONTEXT_REQUIRED');
  }
  return String(tenantId);
}

async function resolveAccountId(tx, tenantId, accountCode) {
  const rows = await tx.$queryRawUnsafe(
    'SELECT id FROM ledger_accounts WHERE tenant_id = $1::uuid AND code = $2 LIMIT 1',
    tenantId,
    accountCode,
  );
  if (!rows.length) throw AppError.badRequest(`Unknown ledger account code: ${accountCode}`, 'LEDGER_BAD_ACCOUNT');
  return Number(rows[0].id);
}

/**
 * Post one balanced journal entry. `lines[].amountPaise` is signed (+debit /
 * -credit) integer paise and MUST sum to zero. Runs inside the caller's tx.
 *
 * @param {object} tx  - a setTenantTx transaction client
 * @param {object} args
 * @param {string} args.tenantId
 * @param {string} args.entryType
 * @param {Array<{accountCode:string, amountPaise:number, patient_uid?:string, invoice_id?:number, advance_id?:number, payment_id?:number, cash_drawer_session_id?:number}>} args.lines
 * @param {string} [args.idempotencyKey]
 * @param {string} [args.createdBy]
 * @param {Date|string} [args.occurredAt]
 * @param {object} [args.metadata]
 * @returns {Promise<{entryId:number}>}
 */
export async function postLedgerEntry(tx, { tenantId, entryType, lines, idempotencyKey = null, createdBy = null, occurredAt = null, metadata = {} }) {
  const tenant = requireLedgerTenantId(tenantId);
  if (!entryType) throw AppError.badRequest('postLedgerEntry: entryType required', 'LEDGER_BAD_ENTRY');
  if (!Array.isArray(lines) || lines.length < 2) {
    throw AppError.badRequest('postLedgerEntry: at least two posting lines required', 'LEDGER_BAD_ENTRY');
  }
  let sum = 0;
  for (const l of lines) {
    assertWholePaise(l.amountPaise);
    if (l.amountPaise === 0) throw AppError.badRequest('postLedgerEntry: a posting line cannot be zero', 'LEDGER_BAD_ENTRY');
    sum += l.amountPaise;
  }
  if (sum !== 0) throw AppError.badRequest(`postLedgerEntry: lines unbalanced (sum=${sum} paise)`, 'LEDGER_UNBALANCED');

  // Insert the header. UNIQUE (tenant_id, idempotency_key) makes a replay a 409.
  let entryRows;
  try {
    entryRows = await tx.$queryRawUnsafe(
      `INSERT INTO ledger_entries (tenant_id, entry_type, occurred_at, created_by, idempotency_key, metadata)
       VALUES ($1::uuid, $2, COALESCE($3::timestamptz, NOW()), $4::uuid, $5, $6::jsonb)
       RETURNING id`,
      tenant,
      entryType,
      occurredAt ? new Date(occurredAt).toISOString() : null,
      createdBy,
      idempotencyKey,
      JSON.stringify(metadata || {}),
    );
  } catch (err) {
    // 23505 = unique_violation. With the pg driver adapter Prisma surfaces the
    // raw failure as P2010 and the real pg code lives under
    // meta.driverAdapterError.cause.originalCode (matches billingV2Service's
    // isUniqueViolation). Check all three shapes.
    const pgCode = err?.meta?.code
      || err?.meta?.driverAdapterError?.cause?.originalCode
      || err?.code;
    if (String(pgCode) === '23505') {
      throw AppError.conflict('Duplicate ledger entry (idempotency key already posted)', 'LEDGER_DUPLICATE');
    }
    throw err;
  }
  const entryId = Number(entryRows[0].id);

  for (const l of lines) {
    const accountId = await resolveAccountId(tx, tenant, l.accountCode);
    const dimVals = DIMENSION_COLS.map((c) => (l[c] === undefined ? null : l[c]));
    await tx.$executeRawUnsafe(
      `INSERT INTO ledger_postings
         (tenant_id, entry_id, account_id, amount_paise, patient_uid, invoice_id, advance_id, payment_id, cash_drawer_session_id)
       VALUES ($1::uuid, $2::bigint, $3::bigint, $4::bigint, $5::uuid, $6::int, $7::int, $8::int, $9::bigint)`,
      tenant, entryId, accountId, l.amountPaise, ...dimVals,
    );
  }
  return { entryId };
}

/** Read a normal-direction balance (paise) for an account code + optional dimensions. */
export async function getAccountBalancePaise(tx, tenantId, accountCode, { patient_uid = null, invoice_id = null, advance_id = null } = {}) {
  const tenant = requireLedgerTenantId(tenantId);
  const rows = await tx.$queryRawUnsafe(
    `SELECT COALESCE(SUM(b.balance_paise), 0)::bigint AS bal
       FROM ledger_balances b
       JOIN ledger_accounts a
         ON a.id = b.account_id
        AND a.tenant_id = b.tenant_id
      WHERE b.tenant_id = $1::uuid
        AND a.tenant_id = $1::uuid
        AND a.code = $2
        AND ($3::uuid IS NULL OR b.patient_uid = $3::uuid)
        AND ($4::int  IS NULL OR b.invoice_id  = $4::int)
        AND ($5::int  IS NULL OR b.advance_id  = $5::int)`,
    tenant, accountCode, patient_uid, invoice_id, advance_id,
  );
  return Number(rows[0].bal);
}

export default { postLedgerEntry, getAccountBalancePaise };
