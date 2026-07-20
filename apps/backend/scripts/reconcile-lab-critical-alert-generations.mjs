#!/usr/bin/env node
// One-time rolling-upgrade closeout for migration 581.
//
// Mandatory order:
//   1. apply migration 581;
//   2. drain every replica running pre-581 lab sign-off code;
//   3. run this script with --old-replicas-drained before rollout completion.
//
// Use the migration-owner DATABASE_URL. A runtime role can have tenant rows
// hidden by RLS and is therefore not allowed to declare a global clean pass.

import prisma from '../src/lib/prisma.js';
import { reconcileLateLegacyLabCriticalAlerts } from '../src/services/lab/labCriticalAlertReconciliationService.js';

const CONFIRMATION = '--old-replicas-drained';

async function assertMigrationOwnerPosture() {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT role.rolsuper,
            role.rolbypassrls,
            owner.rolname = CURRENT_USER AS owns_alert_table
       FROM pg_roles AS role
       JOIN pg_class AS relation
         ON relation.oid = 'lab_critical_alerts'::regclass
       JOIN pg_roles AS owner
         ON owner.oid = relation.relowner
      WHERE role.rolname = CURRENT_USER`,
  );
  const posture = rows[0];
  if (
    !posture
    || (!posture.rolsuper && !posture.rolbypassrls && !posture.owns_alert_table)
  ) {
    throw new Error(
      'Post-drain lab reconciliation requires the migration owner or a BYPASSRLS role',
    );
  }
}

async function main() {
  if (!process.argv.includes(CONFIRMATION)) {
    throw new Error(
      `Refusing to reconcile before replica drain; rerun with ${CONFIRMATION} only after every pre-581 replica is stopped`,
    );
  }
  await assertMigrationOwnerPosture();
  const result = await reconcileLateLegacyLabCriticalAlerts({ db: prisma });
  console.log(
    `[lab-alert-reconcile] complete: observed=${result.observed} represented=${result.reconciled} alerts=${result.alertGenerations} receipts=${result.receipts} historical_gaps=${result.historicalGaps} remaining=0`,
  );
}

main()
  .catch((err) => {
    console.error(`[lab-alert-reconcile] fatal: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
  });
