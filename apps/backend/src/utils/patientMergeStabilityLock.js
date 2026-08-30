const PATIENT_MERGE_LOCK_NAMESPACE = 'vhhealth:patient-merge-tenant:';
export const PATIENT_MERGE_STABILITY_TIMEOUT_MS = 300_000;

/**
 * Keep a tenant-wide merge-survivor snapshot stable while allowing unrelated
 * workflows to run concurrently. The caller must hold the supplied transaction
 * open for the full workflow.
 */
export async function lockTenantPatientMergeStability(tx, tenantId) {
  await tx.$queryRawUnsafe(
    `SELECT 1 AS locked
       FROM pg_advisory_xact_lock_shared(hashtextextended($1::text, 0))`,
    `${PATIENT_MERGE_LOCK_NAMESPACE}${tenantId}`,
  );
}

/**
 * Exclude every merge-stability reader while committing a patient merge.
 * This must be the first domain lock acquired by the merge transaction.
 */
export async function lockTenantPatientMergeExecutionExclusive(tx, tenantId) {
  await tx.$queryRawUnsafe(
    `SELECT 1 AS locked
       FROM pg_advisory_xact_lock(hashtextextended($1::text, 0))`,
    `${PATIENT_MERGE_LOCK_NAMESPACE}${tenantId}`,
  );
}
