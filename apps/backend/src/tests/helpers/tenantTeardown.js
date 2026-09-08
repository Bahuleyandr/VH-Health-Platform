// Two-phase teardown for deep suites that own a tenant, or that add fixture
// users to the seeded tenant. This is the split PR #1048 applied to
// document-integrity.deep.test.js, written once so its siblings share it.
//
// WHY TWO PHASES. A Prisma interactive transaction carries a 5 000 ms budget
// (the client default; nothing in this repo raises it). Deleting one `users`
// row fires one referential-integrity trigger per foreign key that references
// users (466 on this schema) and one `tenants` row fires 791, and each check
// costs roughly 2-5 ms of per-session plan building even when the child table
// is empty. Measured on a fresh CI-shaped database (2026-09-08): ~2 s for two
// users, ~3 s for one tenant, 7.1 s for 27 users. Run inside the same
// transaction as the evidence deletes they expire the budget; Prisma then
// rolls the WHOLE transaction back, so every earlier delete is undone and the
// fixture survives into the next suite of the worker. Four sibling suites did
// exactly that while reporting green, because their teardown swallowed the
// error.
//
// Phase 1 runs the caller's evidence deletes in ONE short interactive
// transaction under the transaction-local `app.audit_bypass` GUC, which the
// append-only guards on the clinical evidence tables (migrations 324/599)
// read. Every statement there is a narrow, indexed delete on the fixture:
// hundreds of milliseconds in total, never seconds.
//
// Phase 2 deletes the fixture users and tenants as plain single-statement
// (autocommit) transactions OUTSIDE any interactive transaction. There is no
// Prisma budget to expire; each statement is bounded only by the primary
// client's statement_timeout (STATEMENT_TIMEOUT_MS, 30 s default) and the
// calling hook's own timeout, so give the hook an explicit timeout
// (document-integrity uses 120 s). Neither table carries an append-only guard,
// so no bypass GUC is needed. `session_replication_role = 'replica'` is
// deliberately NOT used: the fan-out is real work the schema asks for, and a
// replica-role tenant delete also skips the cascades, leaving children behind.
//
// Errors are NOT swallowed. A teardown that fails must fail the suite: a green
// suite whose teardown was swallowed proves nothing about the database it
// leaves behind. The one recoverable case is a late writer (trigger-written
// audit rows, post-response loggers, outbox rows) committing a child between a
// phase-1 delete and the tenant delete, which surfaces as 23503; that is
// retried from the top a bounded number of times and then thrown. Every
// statement is idempotent, so re-running both phases is safe, and a failure
// between the two phase-2 statements leaves nothing a retry cannot finish.

import { withAuditBypass } from './auditBypass.js';

const LATE_CHILD_RETRIES = 3;

function isLateChild(error) {
  return (
    String(error?.meta?.code || '') === '23503' ||
    String(error?.message || '').includes('23503')
  );
}

function uniqueIds(ids) {
  return [...new Set((ids || []).filter(Boolean))];
}

async function teardownOnce(prisma, { evidence, tenantIds, userUids }) {
  // Phase 1 - evidence and every other child row, in one short transaction.
  if (evidence) {
    await withAuditBypass(prisma, evidence);
  }

  // Phase 2 - the fan-out deletes, one autocommit statement each.
  if (userUids.length > 0) {
    await prisma.$executeRawUnsafe(
      `DELETE FROM users WHERE uid = ANY($1::uuid[])`,
      userUids,
    );
  }
  if (tenantIds.length > 0) {
    await prisma.$executeRawUnsafe(
      `DELETE FROM users WHERE tenant_id = ANY($1::uuid[])`,
      tenantIds,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM tenants WHERE id = ANY($1::uuid[])`,
      tenantIds,
    );
  }
}

/**
 * Delete a suite's fixture in two phases (see the file comment).
 *
 * Call it from `afterAll`, and from `beforeAll` too when the suite pre-cleans:
 * both phases are no-ops on ids that own nothing.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {object} fixture
 * @param {(tx: import('@prisma/client').Prisma.TransactionClient) => Promise<void>} [fixture.evidence]
 *   Phase 1: the suite's child/evidence deletes, children before parents, run
 *   inside one interactive transaction under `app.audit_bypass`. Must not
 *   delete from `users` or `tenants`; those belong to phase 2.
 * @param {string[]} [fixture.tenantIds]
 *   Tenants the suite created. Phase 2 deletes their users, then the tenants.
 * @param {string[]} [fixture.userUids]
 *   Fixture users not owned by one of `tenantIds` (for example rows the suite
 *   added to the seeded tenant). Phase 2 deletes them by uid.
 */
export async function teardownTenantFixture(prisma, fixture = {}) {
  const plan = {
    evidence: fixture.evidence || null,
    tenantIds: uniqueIds(fixture.tenantIds),
    userUids: uniqueIds(fixture.userUids),
  };
  for (let attempt = 1; ; attempt += 1) {
    try {
      await teardownOnce(prisma, plan);
      return;
    } catch (error) {
      if (!isLateChild(error) || attempt >= LATE_CHILD_RETRIES) throw error;
      // A child reappeared after we deleted it. Let the writer commit, then
      // delete again from the top - every statement is idempotent.
      await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
    }
  }
}

export default { teardownTenantFixture };
