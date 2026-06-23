// apps/backend/scripts/ledger-opening-balance-cutover.mjs
//
// One-time operator cutover: seed opening AR balances into the ledger for every
// active tenant's pre-existing outstanding invoices. Idempotent — safe to re-run
// (each invoice's opening entry has a stable idempotency key). Run AFTER the
// Phase-2a wiring is deployed.
//
//   DATABASE_URL=... node apps/backend/scripts/ledger-opening-balance-cutover.mjs
import prisma from '../src/lib/prisma.js';
import { applyArOpeningBalances } from '../src/services/billing/ledger/ledgerReconciliation.js';

async function main() {
  const tenants = await prisma.$queryRawUnsafe(`SELECT id FROM tenants ORDER BY id`);
  let totalSeeded = 0;
  for (const t of tenants) {
    const tenantId = String(t.id);
    try {
      const { seeded, skipped } = await applyArOpeningBalances(tenantId);
      totalSeeded += seeded;
      console.log(`[cutover] tenant ${tenantId}: seeded=${seeded} skipped=${skipped}`);
    } catch (err) {
      console.error(`[cutover] tenant ${tenantId} FAILED: ${err.message}`);
    }
  }
  console.log(`[cutover] done. total opening AR entries seeded: ${totalSeeded}`);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error('[cutover] fatal:', err);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
