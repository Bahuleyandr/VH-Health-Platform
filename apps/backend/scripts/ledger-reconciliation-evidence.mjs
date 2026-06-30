// apps/backend/scripts/ledger-reconciliation-evidence.mjs
//
// Operator evidence report for the money-ledger Phase-4 flip. Summarizes the
// reconciliation_checks history per tenant and prints a FLIP-READY / NOT-READY
// verdict — the objective gate for setting a tenant's ledger_authoritative_mode
// to 'enforce'. Read-only.
//
//   DATABASE_URL=... node apps/backend/scripts/ledger-reconciliation-evidence.mjs [tenantId]
//
// Thresholds (env): LEDGER_FLIP_MIN_CLEAN_STREAK (default 48 sweeps ≈ 24h at the
// 30-min reconcile cadence), LEDGER_FLIP_MIN_SPAN_DAYS (default 7).
import prisma from '../src/lib/prisma.js';

const MIN_CLEAN_STREAK = Number(process.env.LEDGER_FLIP_MIN_CLEAN_STREAK || 48);
const MIN_SPAN_DAYS = Number(process.env.LEDGER_FLIP_MIN_SPAN_DAYS || 7);

async function main() {
  const onlyTenant = process.argv[2] ? String(process.argv[2]) : null;
  const rows = await prisma.$queryRawUnsafe(
    `SELECT tenant_id, swept_at, passed, mode, mismatch_count, unwired_count, events_drift_count, trial_balance_paise
       FROM reconciliation_checks
      ${onlyTenant ? 'WHERE tenant_id = $1::uuid' : ''}
      ORDER BY tenant_id, swept_at DESC`,
    ...(onlyTenant ? [onlyTenant] : []),
  );
  if (!rows.length) {
    console.log('[evidence] no reconciliation_checks rows yet — the reconcile cron has not recorded any sweeps.');
    await prisma.$disconnect();
    return;
  }
  const byTenant = new Map();
  for (const r of rows) {
    const t = String(r.tenant_id);
    if (!byTenant.has(t)) byTenant.set(t, []);
    byTenant.get(t).push(r); // already ordered swept_at DESC
  }
  let allReady = true;
  for (const [tenantId, list] of byTenant) {
    let streak = 0;
    for (const r of list) { if (r.passed) streak += 1; else break; }
    const mostRecent = new Date(list[0].swept_at);
    const streakOldest = streak > 0 ? new Date(list[streak - 1].swept_at) : mostRecent;
    const spanDays = streak > 0 ? (mostRecent.getTime() - streakOldest.getTime()) / 86400000 : 0;
    const lastDrift = list.find((r) => !r.passed);
    const ready = streak >= MIN_CLEAN_STREAK && spanDays >= MIN_SPAN_DAYS;
    if (!ready) allReady = false;
    console.log(`\n[tenant ${tenantId}]`);
    console.log(`  sweeps recorded : ${list.length}`);
    console.log(`  clean streak    : ${streak} (latest ${mostRecent.toISOString()})`);
    console.log(`  streak span     : ${spanDays.toFixed(2)} days`);
    console.log(`  last drift      : ${lastDrift
      ? `${new Date(lastDrift.swept_at).toISOString()} (mismatch=${lastDrift.mismatch_count} unwired=${lastDrift.unwired_count} events=${lastDrift.events_drift_count} tb=${lastDrift.trial_balance_paise})`
      : 'none on record'}`);
    console.log(`  verdict         : ${ready ? 'FLIP-READY' : 'NOT-READY'} (need clean streak >= ${MIN_CLEAN_STREAK} over >= ${MIN_SPAN_DAYS}d)`);
  }
  console.log(`\n[evidence] overall: ${allReady ? 'all reported tenants FLIP-READY' : 'some tenants NOT-READY'}`);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error('[evidence] fatal:', err);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
