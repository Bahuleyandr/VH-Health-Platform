const PATIENT_MERGE_LOCK_NAMESPACE = 'vhhealth:patient-merge-tenant:';
export const PATIENT_MERGE_STABILITY_TIMEOUT_MS = 300_000;

/**
 * Serialize patient-identity merge commits with workflows that must keep one
 * tenant-wide merge-survivor snapshot stable across more than one transaction.
 * The caller must hold the supplied transaction open for the full workflow.
 */
export async function lockTenantPatientMergeStability(tx, tenantId) {
  await tx.$queryRawUnsafe(
    `SELECT 1 AS locked
       FROM pg_advisory_xact_lock(hashtextextended($1::text, 0))`,
    `${PATIENT_MERGE_LOCK_NAMESPACE}${tenantId}`,
  );
}
