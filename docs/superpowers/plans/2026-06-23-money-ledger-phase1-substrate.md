# Money Ledger — Phase 1 (Substrate Engine) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the double-entry ledger *engine* — four tables, three DB-enforced invariants (postings net to zero, no-negative balances, append-only), a paise value util, and the single `postLedgerEntry` posting chokepoint — proven end-to-end by deep tests that post entries directly. No billing wiring yet.

**Architecture:** Raw-SQL migrations (source of truth, recorded in `_migrations` by `name`) create `ledger_accounts` / `ledger_entries` / `ledger_postings` / `ledger_balances`, all `tenant_id` + RLS, postings/entries append-only. Invariant 1 = a `DEFERRABLE INITIALLY DEFERRED` constraint trigger that rejects any entry whose signed `amount_paise` don't sum to zero at commit. Invariant 2 = an `AFTER INSERT` trigger that maintains `ledger_balances` in each account's *normal direction* with a uniform `CHECK (balance_paise >= 0)`. The `postLedgerEntry(tx, …)` service is the only writer and runs inside the caller's `setTenantTx`.

**Tech Stack:** Node 22 / Express 5 / PostgreSQL 17 / Prisma `$executeRawUnsafe`/`$queryRawUnsafe` (spread params), Jest deep tests on the `postgres`-connected QA DB at `postgresql://postgres@127.0.0.1:55432/vhhealth_test`.

**Spec:** `docs/superpowers/specs/2026-06-23-double-entry-money-ledger-design.md`

---

## Conventions for the implementer (read first)

- **Migrations are raw SQL** in `apps/backend/src/migrations/NNN_*.sql`, applied once and recorded in `_migrations(name)`. The next free number is whatever follows the highest existing file — check with `ls apps/backend/src/migrations/ | sort | tail -3` (it is `341_*` at plan time, so start at **342**). If a higher number already exists, shift these up by the same offset; keep them contiguous and in this order.
- **Apply migrations as the `postgres` superuser** on the QA DB (DDL/CREATE TRIGGER need owner): `psql "postgresql://postgres@127.0.0.1:55432/vhhealth_test" -f <file>` then record it: `psql "postgresql://postgres@127.0.0.1:55432/vhhealth_test" -c "INSERT INTO _migrations(name) VALUES('342_ledger_accounts.sql') ON CONFLICT DO NOTHING;"`. (The boot runner + `ci-setup-db.mjs` will apply them the same way in CI.)
- **Default tenant id** is `00000000-0000-4000-8000-000000000001`. Tenant-scoped inserts outside a `setTenant` context use the literal-default pattern: `COALESCE($N::uuid, (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid, '00000000-0000-4000-8000-000000000001'::uuid)`.
- **Raw params are spread**, never an array: `prisma.$executeRawUnsafe(sql, ...params)`. Bare params inside `jsonb_build_*` need `::type` casts. Run `npm run lint:raw-params` before committing.
- **After all migrations** that touch a Prisma-modelled table, regenerate: `npx prisma db pull --schema=prisma/schema.prisma` then `node scripts/check-schema-drift.mjs`. (Ledger tables are new models → they appear in the pull.)
- **Run the targeted deep test** with: `DATABASE_URL="postgresql://postgres@127.0.0.1:55432/vhhealth_test" NODE_ENV=test node --experimental-vm-modules node_modules/jest/bin/jest.js <pattern> --forceExit` from `apps/backend`.
- **Final gate** before merge: `DATABASE_URL="postgresql://postgres@127.0.0.1:55432/vhhealth_test" NODE_ENV=test node scripts/run-ci-jest.mjs` — scan for `All chunks passed` + zero `FAIL src/`.
- Work on a branch `feat/money-ledger-phase1`; commit per task; merge `--no-ff` to main + push both remotes (`origin`=Forgejo, `github`=GitHub) at the end.

---

## File Structure

- Create `apps/backend/src/migrations/342_ledger_accounts.sql` — chart-of-accounts table + seed + RLS.
- Create `apps/backend/src/migrations/343_ledger_entries_postings.sql` — entries + postings tables, indexes, RLS, append-only guards.
- Create `apps/backend/src/migrations/344_ledger_balanced_trigger.sql` — Invariant 1 (deferred net-to-zero constraint trigger).
- Create `apps/backend/src/migrations/345_ledger_balances.sql` — `ledger_balances` + maintenance trigger + no-negative CHECKs (Invariant 2).
- Create `apps/backend/src/utils/money.js` — paise value util (rupees↔paise, integer-safe).
- Create `apps/backend/src/services/billing/ledger/ledgerService.js` — `postLedgerEntry` chokepoint + `getAccountBalancePaise` reader.
- Create `apps/backend/src/tests/unit/money.test.js` — paise util unit tests.
- Create `apps/backend/src/tests/money-ledger-substrate.deep.test.js` — invariant deep tests (real DB).

---

## Task 1: Paise value util

**Files:**
- Create: `apps/backend/src/utils/money.js`
- Test: `apps/backend/src/tests/unit/money.test.js`

- [ ] **Step 1: Write the failing test**

```js
// apps/backend/src/tests/unit/money.test.js
import { toPaise, fromPaise, assertWholePaise } from '../../utils/money.js';

describe('money paise util', () => {
  it('converts rupees (number or string) to integer paise without float drift', () => {
    expect(toPaise('1000.00')).toBe(100000);
    expect(toPaise(1000)).toBe(100000);
    expect(toPaise('0.1')).toBe(10);
    expect(toPaise('19.99')).toBe(1999);
    // the classic float trap: 0.1 + 0.2 in rupees must not lose a paisa
    expect(toPaise('0.3')).toBe(30);
    expect(toPaise('1234567.89')).toBe(123456789);
  });

  it('rejects sub-paisa precision rather than silently rounding', () => {
    expect(() => toPaise('1.234')).toThrow(/paisa/i);
  });

  it('round-trips paise back to a 2dp rupee string', () => {
    expect(fromPaise(100000)).toBe('1000.00');
    expect(fromPaise(1999)).toBe('19.99');
    expect(fromPaise(-2500)).toBe('-25.00');
    expect(fromPaise(5)).toBe('0.05');
  });

  it('assertWholePaise rejects non-integers', () => {
    expect(() => assertWholePaise(10.5)).toThrow();
    expect(assertWholePaise(10)).toBe(10);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `DATABASE_URL="postgresql://postgres@127.0.0.1:55432/vhhealth_test" NODE_ENV=test node --experimental-vm-modules node_modules/jest/bin/jest.js money.test --forceExit`
Expected: FAIL — `Cannot find module '../../utils/money.js'`.

- [ ] **Step 3: Write minimal implementation**

```js
// apps/backend/src/utils/money.js
//
// Integer-paise money util. The DB stores ledger amounts as BIGINT paise and
// all ledger arithmetic is exact integer math — JS floats never touch a money
// value. Rupee<->paise conversion parses the decimal STRING digit-wise so
// 0.1/0.3/19.99 never lose a paisa to binary-float representation.

/** Throw if n is not a safe integer; return it otherwise. */
export function assertWholePaise(n) {
  if (!Number.isInteger(n)) {
    throw new Error(`Expected whole paise (integer), got ${n}`);
  }
  if (!Number.isSafeInteger(n)) {
    throw new Error(`Paise value ${n} exceeds safe integer range`);
  }
  return n;
}

/**
 * Convert a rupee amount (number or string like "19.99") to integer paise.
 * Parses the string form to avoid float drift; rejects >2 decimal places.
 */
export function toPaise(rupees) {
  const str = typeof rupees === 'number' ? rupees.toFixed(2) : String(rupees).trim();
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(str);
  if (!m) {
    // allow more dp only if they are zeros; otherwise reject sub-paisa
    const m2 = /^(-?)(\d+)\.(\d+)$/.exec(str);
    if (m2 && /^0+$/.test(m2[3].slice(2))) {
      return signed(m2[1], m2[2], m2[3].slice(0, 2));
    }
    throw new Error(`Invalid rupee amount (sub-paisa precision?): ${rupees}`);
  }
  return signed(m[1], m[2], m[3] || '0');
}

function signed(sign, whole, frac) {
  const paise = Number(whole) * 100 + Number((frac + '00').slice(0, 2));
  const value = sign === '-' ? -paise : paise;
  return assertWholePaise(value);
}

/** Convert integer paise back to a 2dp rupee string. */
export function fromPaise(paise) {
  assertWholePaise(paise);
  const neg = paise < 0;
  const abs = Math.abs(paise);
  const rupees = Math.floor(abs / 100);
  const p = abs % 100;
  return `${neg ? '-' : ''}${rupees}.${String(p).padStart(2, '0')}`;
}

export default { toPaise, fromPaise, assertWholePaise };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `DATABASE_URL="postgresql://postgres@127.0.0.1:55432/vhhealth_test" NODE_ENV=test node --experimental-vm-modules node_modules/jest/bin/jest.js money.test --forceExit`
Expected: PASS (all 4 tests).

- [ ] **Step 5: Lint + commit**

```bash
cd apps/backend && npx eslint src/utils/money.js src/tests/unit/money.test.js
cd ../.. && git add apps/backend/src/utils/money.js apps/backend/src/tests/unit/money.test.js
git commit -m "feat(ledger): integer-paise money util (toPaise/fromPaise)"
```

---

## Task 2: Migration 342 — `ledger_accounts` chart of accounts

**Files:**
- Create: `apps/backend/src/migrations/342_ledger_accounts.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 342_ledger_accounts.sql
-- Double-entry ledger Phase 1: the chart of accounts (small, fixed per tenant).
-- See docs/superpowers/specs/2026-06-23-double-entry-money-ledger-design.md §3.1.
CREATE TABLE IF NOT EXISTS ledger_accounts (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  code        VARCHAR(40) NOT NULL,
  -- ASSET / CONTRA accumulate +debit/-credit in normal direction;
  -- LIABILITY / REVENUE / EQUITY accumulate +credit/-debit.
  type        VARCHAR(20) NOT NULL CHECK (type IN ('ASSET','LIABILITY','REVENUE','CONTRA','EQUITY')),
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, code)
);

-- normal_side helper used by the balance-maintenance trigger (migration 345).
-- +1 = debit-normal (asset/contra), -1 = credit-normal (liability/revenue/equity).
CREATE OR REPLACE FUNCTION ledger_account_normal_side(p_type VARCHAR)
RETURNS INTEGER LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_type IN ('ASSET','CONTRA') THEN 1 ELSE -1 END
$$;

-- Seed the fixed chart for the default tenant. Per-tenant seeding for other
-- tenants happens in the onboarding flow (out of scope here).
INSERT INTO ledger_accounts (tenant_id, code, type, description) VALUES
  ('00000000-0000-4000-8000-000000000001'::uuid, 'PATIENT_AR',      'ASSET',     'Patient accounts receivable'),
  ('00000000-0000-4000-8000-000000000001'::uuid, 'CASH',            'ASSET',     'Physical cash (by drawer session)'),
  ('00000000-0000-4000-8000-000000000001'::uuid, 'BANK',            'ASSET',     'Electronic receipts (by mode)'),
  ('00000000-0000-4000-8000-000000000001'::uuid, 'PATIENT_ADVANCE', 'LIABILITY', 'Unapplied patient advances/deposits'),
  ('00000000-0000-4000-8000-000000000001'::uuid, 'INSURANCE_AR',    'ASSET',     'Insurer/TPA receivable'),
  ('00000000-0000-4000-8000-000000000001'::uuid, 'TAX_PAYABLE',     'LIABILITY', 'GST collected, owed to authority'),
  ('00000000-0000-4000-8000-000000000001'::uuid, 'REFUNDS_PAYABLE', 'LIABILITY', 'Approved refunds not yet paid'),
  ('00000000-0000-4000-8000-000000000001'::uuid, 'WRITE_OFF',       'CONTRA',    'Bad-debt / discount write-offs'),
  ('00000000-0000-4000-8000-000000000001'::uuid, 'REVENUE',         'REVENUE',   'Billed services revenue'),
  ('00000000-0000-4000-8000-000000000001'::uuid, 'OPENING_EQUITY',  'EQUITY',    'Cutover opening-balance counter-account')
ON CONFLICT (tenant_id, code) DO NOTHING;

-- RLS (mig-075 tenant_isolation pattern). Permissive when the GUC is unset.
ALTER TABLE ledger_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_accounts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ledger_accounts;
CREATE POLICY tenant_isolation ON ledger_accounts
  USING (
    tenant_id = COALESCE(
      NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass')::uuid,
      tenant_id)
  );
```

- [ ] **Step 2: Apply as postgres + record + verify the seed**

```bash
psql "postgresql://postgres@127.0.0.1:55432/vhhealth_test" -f apps/backend/src/migrations/342_ledger_accounts.sql
psql "postgresql://postgres@127.0.0.1:55432/vhhealth_test" -c "INSERT INTO _migrations(name) VALUES('342_ledger_accounts.sql') ON CONFLICT DO NOTHING;"
psql "postgresql://postgres@127.0.0.1:55432/vhhealth_test" -tAc "SELECT count(*) FROM ledger_accounts WHERE tenant_id='00000000-0000-4000-8000-000000000001';"
```
Expected: `10`.

- [ ] **Step 3: Commit**

```bash
git add apps/backend/src/migrations/342_ledger_accounts.sql
git commit -m "feat(ledger): mig 342 chart of accounts + normal_side helper + RLS"
```

---

## Task 3: Migration 343 — `ledger_entries` + `ledger_postings` (append-only)

**Files:**
- Create: `apps/backend/src/migrations/343_ledger_entries_postings.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 343_ledger_entries_postings.sql
-- Journal headers + balanced posting lines. Append-only (mig-324 pattern):
-- corrections are reversal entries, never UPDATE/DELETE. §3.2/§3.3/§4.3.
CREATE TABLE IF NOT EXISTS ledger_entries (
  id               BIGSERIAL PRIMARY KEY,
  -- tenant_id defaults to the active-tenant GUC (set by setTenantTx) so a
  -- tenant-B movement stamps tenant-B; falls back to the default tenant when no
  -- GUC is set (single-tenant / migrations). M8 / FORCE-RLS pattern.
  tenant_id        UUID NOT NULL DEFAULT COALESCE((NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid, '00000000-0000-4000-8000-000000000001'::uuid),
  entry_type       VARCHAR(30) NOT NULL,
  occurred_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by       UUID,
  idempotency_key  VARCHAR(120),
  reverses_entry_id BIGINT REFERENCES ledger_entries(id),
  metadata         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS ledger_postings (
  id                     BIGSERIAL PRIMARY KEY,
  entry_id               BIGINT NOT NULL REFERENCES ledger_entries(id),
  -- same active-tenant-GUC default as ledger_entries (M8 / FORCE-RLS pattern);
  -- the balance-maintenance trigger copies NEW.tenant_id into ledger_balances.
  tenant_id              UUID NOT NULL DEFAULT COALESCE((NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid, '00000000-0000-4000-8000-000000000001'::uuid),
  account_id             BIGINT NOT NULL REFERENCES ledger_accounts(id),
  amount_paise           BIGINT NOT NULL,   -- signed: +debit / -credit
  patient_uid            UUID,
  invoice_id             INTEGER,
  advance_id             INTEGER,
  payment_id             INTEGER,
  cash_drawer_session_id BIGINT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (amount_paise <> 0)
);

CREATE INDEX IF NOT EXISTS idx_ledger_postings_entry   ON ledger_postings (entry_id);
CREATE INDEX IF NOT EXISTS idx_ledger_postings_account ON ledger_postings (tenant_id, account_id);
CREATE INDEX IF NOT EXISTS idx_ledger_postings_patient ON ledger_postings (tenant_id, patient_uid) WHERE patient_uid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ledger_postings_invoice ON ledger_postings (tenant_id, invoice_id) WHERE invoice_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ledger_postings_advance ON ledger_postings (tenant_id, advance_id) WHERE advance_id IS NOT NULL;

-- Append-only guard. Allows the app.audit_bypass escape hatch ONLY (used by the
-- same test-teardown convention as audit_logs); normal UPDATE/DELETE aborts.
CREATE OR REPLACE FUNCTION ledger_block_mutation() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.audit_bypass', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  RAISE EXCEPTION 'ledger is append-only: % on % is not permitted (use a reversal entry)', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'P0001';
END $$;

DROP TRIGGER IF EXISTS ledger_entries_append_only ON ledger_entries;
CREATE TRIGGER ledger_entries_append_only
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_block_mutation();

DROP TRIGGER IF EXISTS ledger_postings_append_only ON ledger_postings;
CREATE TRIGGER ledger_postings_append_only
  BEFORE UPDATE OR DELETE ON ledger_postings
  FOR EACH ROW EXECUTE FUNCTION ledger_block_mutation();

-- RLS for both.
ALTER TABLE ledger_entries  ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_entries  FORCE  ROW LEVEL SECURITY;
ALTER TABLE ledger_postings ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_postings FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ledger_entries;
CREATE POLICY tenant_isolation ON ledger_entries
  USING (tenant_id = COALESCE(NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass')::uuid, tenant_id));
DROP POLICY IF EXISTS tenant_isolation ON ledger_postings;
CREATE POLICY tenant_isolation ON ledger_postings
  USING (tenant_id = COALESCE(NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass')::uuid, tenant_id));
```

- [ ] **Step 2: Apply + record**

```bash
psql "postgresql://postgres@127.0.0.1:55432/vhhealth_test" -f apps/backend/src/migrations/343_ledger_entries_postings.sql
psql "postgresql://postgres@127.0.0.1:55432/vhhealth_test" -c "INSERT INTO _migrations(name) VALUES('343_ledger_entries_postings.sql') ON CONFLICT DO NOTHING;"
```
Expected: `CREATE TABLE` / `CREATE TRIGGER` with no error.

- [ ] **Step 3: Commit**

```bash
git add apps/backend/src/migrations/343_ledger_entries_postings.sql
git commit -m "feat(ledger): mig 343 entries + postings tables, append-only guard, RLS"
```

---

## Task 4: Migration 344 — Invariant 1 (postings net to zero, deferred)

**Files:**
- Create: `apps/backend/src/migrations/344_ledger_balanced_trigger.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 344_ledger_balanced_trigger.sql
-- Invariant 1 (§4.1): every journal entry's signed postings sum to ZERO.
-- DEFERRABLE INITIALLY DEFERRED so the check runs at COMMIT, after all of an
-- entry's posting lines have been inserted within the transaction.
CREATE OR REPLACE FUNCTION ledger_assert_entry_balanced() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  v_sum BIGINT;
BEGIN
  SELECT COALESCE(SUM(amount_paise), 0) INTO v_sum
    FROM ledger_postings WHERE entry_id = NEW.entry_id;
  IF v_sum <> 0 THEN
    RAISE EXCEPTION 'ledger entry % is unbalanced: postings sum to % paise (must be 0)', NEW.entry_id, v_sum
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS ledger_postings_balanced ON ledger_postings;
CREATE CONSTRAINT TRIGGER ledger_postings_balanced
  AFTER INSERT ON ledger_postings
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_assert_entry_balanced();
```

- [ ] **Step 2: Apply + record**

```bash
psql "postgresql://postgres@127.0.0.1:55432/vhhealth_test" -f apps/backend/src/migrations/344_ledger_balanced_trigger.sql
psql "postgresql://postgres@127.0.0.1:55432/vhhealth_test" -c "INSERT INTO _migrations(name) VALUES('344_ledger_balanced_trigger.sql') ON CONFLICT DO NOTHING;"
```

- [ ] **Step 3: Commit**

```bash
git add apps/backend/src/migrations/344_ledger_balanced_trigger.sql
git commit -m "feat(ledger): mig 344 deferred net-to-zero balanced-entry trigger"
```

---

## Task 5: Migration 345 — `ledger_balances` + maintenance trigger + no-negative CHECK (Invariant 2)

**Files:**
- Create: `apps/backend/src/migrations/345_ledger_balances.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 345_ledger_balances.sql
-- Invariant 2 (§4.2): running balance per (account, dimension) maintained in the
-- account's NORMAL direction; uniform CHECK (balance_paise >= 0) on the
-- constrained accounts makes overpayment / advance-overdraw / over-refund
-- UNCOMMITTABLE. The per-row upsert lock also closes the lost-update race.
CREATE TABLE IF NOT EXISTS ledger_balances (
  id           BIGSERIAL PRIMARY KEY,
  tenant_id    UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  account_id   BIGINT NOT NULL REFERENCES ledger_accounts(id),
  patient_uid  UUID,
  invoice_id   INTEGER,
  advance_id   INTEGER,
  balance_paise BIGINT NOT NULL DEFAULT 0,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- one balance row per (account, dimension-tuple). NULLS NOT DISTINCT (PG15+)
  -- is LOAD-BEARING: dimension columns are nullable (e.g. CASH has all three
  -- NULL), and without it the default NULLS-DISTINCT semantics would treat each
  -- NULL-dimension posting as a new row, so the ON CONFLICT upsert below would
  -- fragment the balance instead of aggregating it.
  UNIQUE NULLS NOT DISTINCT (tenant_id, account_id, patient_uid, invoice_id, advance_id)
);

CREATE INDEX IF NOT EXISTS idx_ledger_balances_account ON ledger_balances (tenant_id, account_id);

-- Maintenance (IMMEDIATE): on each posting, add the NORMAL-direction delta to
-- the matching balance row (creating it if absent). normal-direction delta =
-- amount_paise * normal_side(account.type). The upsert takes the balance row
-- lock, which serializes concurrent movements on the same dimension and closes
-- the lost-update race.
CREATE OR REPLACE FUNCTION ledger_maintain_balance() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  v_side INTEGER;
  v_delta BIGINT;
BEGIN
  SELECT ledger_account_normal_side(a.type) INTO v_side
    FROM ledger_accounts a WHERE a.id = NEW.account_id;
  v_delta := NEW.amount_paise * v_side;

  INSERT INTO ledger_balances (tenant_id, account_id, patient_uid, invoice_id, advance_id, balance_paise, updated_at)
  VALUES (NEW.tenant_id, NEW.account_id, NEW.patient_uid, NEW.invoice_id, NEW.advance_id, v_delta, NOW())
  ON CONFLICT (tenant_id, account_id, patient_uid, invoice_id, advance_id)
  DO UPDATE SET balance_paise = ledger_balances.balance_paise + EXCLUDED.balance_paise,
                updated_at = NOW();
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS ledger_postings_maintain_balance ON ledger_postings;
CREATE TRIGGER ledger_postings_maintain_balance
  AFTER INSERT ON ledger_postings
  FOR EACH ROW EXECUTE FUNCTION ledger_maintain_balance();

-- No-negative (DEFERRED, at COMMIT): assert the FINAL balance of each touched
-- (constrained account, dimension) is >= 0. Deferred + final-state means line
-- insertion order within an entry is irrelevant, and a standalone movement that
-- nets fine is never spuriously rejected mid-entry. Constrained set per spec
-- §4.2: PATIENT_AR / PATIENT_ADVANCE / REFUNDS_PAYABLE.
CREATE OR REPLACE FUNCTION ledger_assert_balance_non_negative() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  v_code VARCHAR;
  v_bal  BIGINT;
BEGIN
  SELECT a.code INTO v_code FROM ledger_accounts a WHERE a.id = NEW.account_id;
  IF v_code NOT IN ('PATIENT_AR','PATIENT_ADVANCE','REFUNDS_PAYABLE') THEN
    RETURN NULL;
  END IF;
  SELECT b.balance_paise INTO v_bal
    FROM ledger_balances b
   WHERE b.tenant_id = NEW.tenant_id AND b.account_id = NEW.account_id
     AND b.patient_uid IS NOT DISTINCT FROM NEW.patient_uid
     AND b.invoice_id  IS NOT DISTINCT FROM NEW.invoice_id
     AND b.advance_id  IS NOT DISTINCT FROM NEW.advance_id;
  IF v_bal < 0 THEN
    RAISE EXCEPTION 'ledger no-negative violation: % balance would be % paise (overpayment/overdraw/over-refund blocked)', v_code, v_bal
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS ledger_postings_non_negative ON ledger_postings;
CREATE CONSTRAINT TRIGGER ledger_postings_non_negative
  AFTER INSERT ON ledger_postings
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_assert_balance_non_negative();

-- RLS.
ALTER TABLE ledger_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_balances FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ledger_balances;
CREATE POLICY tenant_isolation ON ledger_balances
  USING (tenant_id = COALESCE(NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass')::uuid, tenant_id));
```

> **Implementer note:** no-negative is a **deferred constraint trigger** (final-state, at commit), NOT a table CHECK — Postgres CHECKs can't be deferred and would fire per-row, spuriously rejecting valid entries whose decreasing line is inserted before the increasing one. It is scoped to `PATIENT_AR / PATIENT_ADVANCE / REFUNDS_PAYABLE` (spec §4.2). The maintenance trigger is immediate (so the deferred check sees the final balance) and its upsert row-lock is what closes the lost-update race.

- [ ] **Step 2: Apply + record + regenerate Prisma schema**

```bash
psql "postgresql://postgres@127.0.0.1:55432/vhhealth_test" -f apps/backend/src/migrations/345_ledger_balances.sql
psql "postgresql://postgres@127.0.0.1:55432/vhhealth_test" -c "INSERT INTO _migrations(name) VALUES('345_ledger_balances.sql') ON CONFLICT DO NOTHING;"
cd apps/backend && npx prisma db pull --schema=prisma/schema.prisma && node scripts/check-schema-drift.mjs && cd ../..
```
Expected: drift check passes (the 4 new tables now appear in `schema.prisma`).

- [ ] **Step 3: Commit**

```bash
git add apps/backend/src/migrations/345_ledger_balances.sql apps/backend/prisma/schema.prisma
git commit -m "feat(ledger): mig 345 ledger_balances + normal-direction maintenance trigger + no-negative CHECK"
```

---

## Task 6: `postLedgerEntry` service (the posting chokepoint)

**Files:**
- Create: `apps/backend/src/services/billing/ledger/ledgerService.js`

- [ ] **Step 1: Write the service** (its behaviour is proven by the Task 7 deep tests — the engine has no unit-mockable surface worth isolating, so the failing test lives in Task 7)

```js
// apps/backend/src/services/billing/ledger/ledgerService.js
//
// The ONE writer into the double-entry ledger. Every money movement calls
// postLedgerEntry INSIDE its existing setTenantTx so the posting is atomic with
// the legacy billing write. Amounts are integer paise. The DB enforces
// balance/no-negative/append-only; this layer validates app-side (defense in
// depth) and resolves account codes to ids.
//
// Spec: docs/superpowers/specs/2026-06-23-double-entry-money-ledger-design.md
import prisma from '../../../lib/prisma.js';
import { AppError } from '../../../utils/AppError.js';
import { assertWholePaise } from '../../../utils/money.js';

const DIMENSION_COLS = ['patient_uid', 'invoice_id', 'advance_id', 'payment_id', 'cash_drawer_session_id'];

async function resolveAccountId(tx, accountCode) {
  const rows = await tx.$queryRawUnsafe(
    'SELECT id FROM ledger_accounts WHERE code = $1 LIMIT 1',
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
 * @param {string} args.entryType
 * @param {Array<{accountCode:string, amountPaise:number, patient_uid?:string, invoice_id?:number, advance_id?:number, payment_id?:number, cash_drawer_session_id?:number}>} args.lines
 * @param {string} [args.idempotencyKey]
 * @param {string} [args.createdBy]
 * @param {Date|string} [args.occurredAt]
 * @param {object} [args.metadata]
 * @returns {Promise<{entryId:number}>}
 */
export async function postLedgerEntry(tx, { entryType, lines, idempotencyKey = null, createdBy = null, occurredAt = null, metadata = {} }) {
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
      `INSERT INTO ledger_entries (entry_type, occurred_at, created_by, idempotency_key, metadata)
       VALUES ($1, COALESCE($2::timestamptz, NOW()), $3::uuid, $4, $5::jsonb)
       RETURNING id`,
      entryType,
      occurredAt ? new Date(occurredAt).toISOString() : null,
      createdBy,
      idempotencyKey,
      JSON.stringify(metadata || {}),
    );
  } catch (err) {
    if (String(err?.meta?.code || err?.code) === '23505') {
      throw AppError.conflict('Duplicate ledger entry (idempotency key already posted)', 'LEDGER_DUPLICATE');
    }
    throw err;
  }
  const entryId = Number(entryRows[0].id);

  for (const l of lines) {
    const accountId = await resolveAccountId(tx, l.accountCode);
    const dimVals = DIMENSION_COLS.map((c) => (l[c] === undefined ? null : l[c]));
    await tx.$executeRawUnsafe(
      `INSERT INTO ledger_postings
         (entry_id, account_id, amount_paise, patient_uid, invoice_id, advance_id, payment_id, cash_drawer_session_id)
       VALUES ($1::bigint, $2::bigint, $3::bigint, $4::uuid, $5::int, $6::int, $7::int, $8::bigint)`,
      entryId, accountId, l.amountPaise, ...dimVals,
    );
  }
  return { entryId };
}

/** Read a normal-direction balance (paise) for an account code + optional dimensions. */
export async function getAccountBalancePaise(tx, accountCode, { patient_uid = null, invoice_id = null, advance_id = null } = {}) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT COALESCE(SUM(b.balance_paise), 0)::bigint AS bal
       FROM ledger_balances b JOIN ledger_accounts a ON a.id = b.account_id
      WHERE a.code = $1
        AND ($2::uuid IS NULL OR b.patient_uid = $2::uuid)
        AND ($3::int  IS NULL OR b.invoice_id  = $3::int)
        AND ($4::int  IS NULL OR b.advance_id  = $4::int)`,
    accountCode, patient_uid, invoice_id, advance_id,
  );
  return Number(rows[0].bal);
}

export default { postLedgerEntry, getAccountBalancePaise };
```

- [ ] **Step 2: Lint**

Run: `cd apps/backend && npx eslint src/services/billing/ledger/ledgerService.js && npm run lint:raw-params && cd ../..`
Expected: 0 errors; raw-params clean.

- [ ] **Step 3: Commit**

```bash
git add apps/backend/src/services/billing/ledger/ledgerService.js
git commit -m "feat(ledger): postLedgerEntry chokepoint + getAccountBalancePaise"
```

---

## Task 7: Deep tests — prove every invariant against the real DB

**Files:**
- Create: `apps/backend/src/tests/money-ledger-substrate.deep.test.js`

- [ ] **Step 1: Write the failing test**

```js
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
      entryType: 'PAYMENT', idempotencyKey: `op-${randomUUID()}`,
      lines: [
        { accountCode: 'CASH', amountPaise: 120000 },
        { accountCode: 'PATIENT_AR', amountPaise: -120000, patient_uid: patient, invoice_id: invoice },
      ],
    }))).rejects.toThrow(/no-negative|overpayment/i);
    // and the receivable is untouched (the whole tx rolled back)
    const bal = await inTx((tx) => getAccountBalancePaise(tx, 'PATIENT_AR', { patient_uid: patient, invoice_id: invoice }));
    expect(bal).toBe(100000);
  });

  it('concurrent full payments cannot both succeed (lost-update closed by the balance row-lock)', async () => {
    const patient = randomUUID();
    const invoice = Math.floor(1e8 + Math.random() * 1e8);
    await issueAr(patient, invoice, 50000); // owe 500.00
    const pay = () => inTx((tx) => postLedgerEntry(tx, {
      entryType: 'PAYMENT', idempotencyKey: `c-${randomUUID()}`,
      lines: [
        { accountCode: 'CASH', amountPaise: 50000 },
        { accountCode: 'PATIENT_AR', amountPaise: -50000, patient_uid: patient, invoice_id: invoice },
      ],
    }));
    const results = await Promise.allSettled([pay(), pay()]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const bal = await inTx((tx) => getAccountBalancePaise(tx, 'PATIENT_AR', { patient_uid: patient, invoice_id: invoice }));
    expect(bal).toBe(0); // exactly paid off, never negative
  });
});

describe('Invariant 3 — append-only', () => {
  it('UPDATE and DELETE on postings are blocked', async () => {
    const { entryId } = await inTx((tx) => postLedgerEntry(tx, {
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
    await inTx((tx) => postLedgerEntry(tx, { entryType: 'PAYMENT', idempotencyKey: key, lines }));
    await expect(inTx((tx) => postLedgerEntry(tx, { entryType: 'PAYMENT', idempotencyKey: key, lines })))
      .rejects.toMatchObject({ code: 'LEDGER_DUPLICATE' });
  });
});
```

- [ ] **Step 2: Run to verify the suite passes against the applied migrations**

Run: `DATABASE_URL="postgresql://postgres@127.0.0.1:55432/vhhealth_test" NODE_ENV=test node --experimental-vm-modules node_modules/jest/bin/jest.js money-ledger-substrate --forceExit`
Expected: PASS — all describe blocks green. If "overpayment" fails because the CHECK didn't fire, verify migration 345's maintenance trigger + CHECK are applied (the `ledger_balances_non_negative` constraint exists).

- [ ] **Step 3: Commit**

```bash
git add apps/backend/src/tests/money-ledger-substrate.deep.test.js
git commit -m "test(ledger): deep invariant proofs — balanced/no-negative/append-only/idempotency"
```

---

## Task 8: ci-setup-db ordering + full gate + merge

**Files:**
- Verify: `apps/backend/scripts/ci-setup-db.mjs` (no edit expected — it applies `src/migrations/*.sql` in numeric order and records by name; the four new files slot in automatically).

- [ ] **Step 1: Confirm CI applies the new migrations on a clean DB**

Run: `cd apps/backend && node scripts/smoke-migration-runner.mjs && cd ../..`
Expected: fresh-apply / re-run / truncate-tracker paths all pass (the new migrations apply once and are idempotent on re-run).

- [ ] **Step 2: Full authoritative gate**

Run: `cd apps/backend && DATABASE_URL="postgresql://postgres@127.0.0.1:55432/vhhealth_test" NODE_ENV=test node scripts/run-ci-jest.mjs 2>&1 | tee /tmp/ledger-p1-gate.log; cd ../..`
Expected: `All chunks passed` and zero `FAIL src/` lines. (Arm a stall-aware monitor — the gate is ~65 min and the box can idle-suspend.)

- [ ] **Step 3: Merge + push both remotes**

```bash
git checkout main
git merge --no-ff feat/money-ledger-phase1 -m "Merge money ledger Phase 1 (substrate engine): tables + invariants + postLedgerEntry"
git push origin main && git push github main
git branch -d feat/money-ledger-phase1
```

- [ ] **Step 4: Update ROADMAP + memory**

Tick the ledger epic Phase 1 in `docs/ROADMAP.md §0` and note the next plan (Phase 2: wire `collectPayment` dual-write + reconciliation job + AR opening-balance cutover).

---

## Self-review (done at plan-author time)

- **Spec coverage:** §3 tables → Tasks 2/3/5; §4.1 Invariant 1 → Task 4 + test; §4.2 Invariant 2 (overpayment/overdraw/lost-update) → Task 5 + tests; §4.3 append-only → Task 3 + test; §4.4 idempotency+tenancy → Task 3/6 + test; integer paise → Task 1 + BIGINT columns. **Deferred to Phase 2 (explicitly):** §5 cache sync + reconciliation, §6 cutover, wiring `collectPayment`. **Deferred to later phases:** §7 phases 2–5, §8 reconciliation/cutover tests.
- **No placeholders:** all SQL/JS/test code is complete and self-contained.
- **Type consistency:** `postLedgerEntry(tx, {entryType, lines, idempotencyKey, …})`, `getAccountBalancePaise(tx, code, dims)`, `toPaise/fromPaise/assertWholePaise`, account codes match the migration-342 seed, dimension column names match across migration 343 / service / tests.
- **Known follow-up:** the uniform `balance_paise >= 0` CHECK (Task 5 note) is correct for Phase-1 movements; revisit only if a later phase needs a legitimately-negative normal balance on an exempt account.
